/**
 * Thin stdio JSON-Lines client for the verifier-brain Python bridge.
 *
 * The bridge process is spawned lazily on first request and kept alive for
 * the plugin lifetime. Requests are correlated by incrementing ids. Unlike
 * the reference implementation, an unexpected bridge exit marks the process
 * dead so the next request transparently respawns it instead of staying
 * broken until plugin reload.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import type { BridgeErrorResponse, BridgeResponse } from './types.js'

export interface ProbeResult {
  model: string
  base_url: string
  logprobs_supported: boolean
  logprobs_error: string | null
  llm_verifier_version: string
}

export class BridgeError extends Error {
  readonly type: string

  constructor(type: string, message: string) {
    super(message)
    this.name = 'BridgeError'
    this.type = type
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  abortHandler?: () => void
  /**
   * F5: removes the abort listener from the caller's signal and clears the
   * timeout. Must run on EVERY settle path (success, error, timeout, abort,
   * write failure) — leaked closures used to hold the pending map alive.
   */
  cleanup: () => void
}

export class PythonBridge {
  private child?: ChildProcessWithoutNullStreams
  private lines?: Interface
  private readonly pending = new Map<string, PendingRequest>()
  private seq = 0
  private spawned = false
  private closed = false
  private readonly stderrTail: string[] = []

  constructor(
    private readonly scriptPath: string,
    private readonly pythonBin: string,
    private readonly timeoutMs: number,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly onRestart?: (reason: string) => void,
  ) {}

  get isRunning(): boolean {
    return this.spawned && !this.closed && this.child !== undefined && !this.child.killed
  }

  start(): void {
    if (this.isRunning) return
    if (this.closed) throw new BridgeError('BridgeClosed', 'python bridge was closed')
    this.spawned = true
    try {
      this.child = spawn(this.pythonBin, ['-u', '-X', 'utf8', this.scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.env,
      })
    } catch (error) {
      this.spawned = false
      throw new BridgeError(
        'PythonBridgeError',
        `failed to start Python bridge with "${this.pythonBin}": ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    this.child.on('error', (error) => {
      this.failAllPending(new BridgeError('PythonBridgeError', `python bridge process error: ${error.message}`))
      this.spawned = false
    })
    this.child.on('exit', (code, signal) => {
      this.failAllPending(new BridgeError(
        'PythonBridgeExit',
        `python bridge exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'}); it will restart on the next request`,
      ))
      this.child = undefined
      const wasRunning = this.spawned
      this.spawned = false
      if (wasRunning && !this.closed) this.onRestart?.(`exit code=${code ?? 'null'} signal=${signal ?? 'null'}`)
    })
    this.child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      this.stderrTail.push(text)
      if (this.stderrTail.length > 20) this.stderrTail.shift()
      process.stderr.write(`[verifier-brain:python] ${text.trimEnd()}\n`)
    })

    this.lines = createInterface({ input: this.child.stdout })
    this.lines.on('line', (line) => this.handleLine(line))
  }

  async request<T>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number, signal?: AbortSignal): Promise<T> {
    // Retry once if the bridge died between requests (crash auto-restart).
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.requestOnce<T>(method, params, timeoutMs, signal)
      } catch (error) {
        const recoverable = error instanceof BridgeError
          && (error.type === 'PythonBridgeExit' || error.type === 'BridgeWriteError' || error.type === 'BridgeClosed')
        if (!recoverable || attempt === 1 || this.closed) throw error
      }
    }
    throw new BridgeError('PythonBridgeError', 'unreachable') // appease the compiler
  }

  private requestOnce<T>(method: string, params: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal): Promise<T> {
    this.start()
    const id = String(++this.seq)
    const payload = JSON.stringify({ id, method, params })
    // Per-call budget: sync tools use the plugin default; async verifier tasks
    // pass a much larger taskTimeoutMs so long tournament scorings survive.
    const budget = timeoutMs ?? this.timeoutMs

    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined
      let abortHandler: (() => void) | undefined
      // F5: one cleanup shared by every settle path — the caller's signal must
      // never accumulate dead listeners across long-lived plugin sessions.
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer)
        if (abortHandler && signal) signal.removeEventListener('abort', abortHandler)
      }

      timer = setTimeout(() => {
        this.pending.delete(id)
        cleanup()
        reject(new BridgeError('BridgeTimeout', `python bridge timed out after ${budget}ms (method=${method})`))
      }, budget)

      const pending: PendingRequest = {
        resolve: resolve as (value: unknown) => void,
        reject,
        cleanup,
      }

      // Handle AbortSignal
      if (signal) {
        abortHandler = () => {
          this.pending.delete(id)
          cleanup()
          reject(new BridgeError('BridgeAborted', 'request aborted by caller'))
        }
        signal.addEventListener('abort', abortHandler)
        // Handle case where signal is already aborted
        if (signal.aborted) {
          abortHandler()
          return
        }
      }
      pending.abortHandler = abortHandler

      this.pending.set(id, pending)

      if (!this.child?.stdin.writable) {
        this.pending.delete(id)
        cleanup()
        reject(new BridgeError('BridgeWriteError', 'python bridge stdin is not writable'))
        return
      }
      this.child.stdin.write(payload + '\n', (error) => {
        if (error) {
          this.pending.delete(id)
          cleanup()
          reject(new BridgeError('BridgeWriteError', `failed to write to python bridge: ${error.message}`))
        }
      })
    })
  }

  async probe(signal?: AbortSignal): Promise<ProbeResult> {
    return this.request<ProbeResult>('probe', {}, 30_000, signal)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.failAllPending(new BridgeError('BridgeClosed', 'python bridge was closed'))
    this.lines?.close()
    this.child?.kill()
    this.child = undefined
    this.spawned = false
  }

  private handleLine(line: string): void {
    let parsed: BridgeResponse<unknown> | BridgeErrorResponse
    try {
      parsed = JSON.parse(line) as BridgeResponse<unknown> | BridgeErrorResponse
    } catch {
      process.stderr.write(`[verifier-brain:python] non-JSON stdout: ${line}\n`)
      // F3 defense-in-depth: a malformed frame may be a corrupted response for
      // a pending request. Correlate by id when possible and fail fast instead
      // of letting the request dangle until its full budget timeout.
      const m = /"id"\s*:\s*(\d+)/.exec(line)
      const id = m ? m[1] : undefined
      const pending = id ? this.pending.get(id) : undefined
      if (pending && id) {
        this.pending.delete(id)
        pending.cleanup()
        pending.reject(new BridgeError('BridgeProtocolError', `malformed JSON frame from bridge (correlated id=${id})`))
      }
      return
    }
    if (parsed.id === null || parsed.id === undefined) return
    const id = String(parsed.id)
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    pending.cleanup()
    if (parsed.ok) {
      pending.resolve((parsed as BridgeResponse<unknown>).result)
    } else {
      const error = (parsed as BridgeErrorResponse).error
      pending.reject(new BridgeError(error.type, error.message))
    }
  }

  private failAllPending(error: Error): void {
    for (const [, pending] of this.pending) {
      pending.cleanup()
      pending.reject(error)
    }
    this.pending.clear()
  }

  /** Last stderr lines for diagnostics (useful when the bridge fails at startup). */
  get diagnostics(): string {
    return this.stderrTail.join('').trim()
  }
}
