/**
 * Durable state for verifier-brain: score history and async-task records as
 * JSON Lines under `~/.dsh/verifier-brain/`. Everything survives DSH
 * restarts and plugin reloads — fixing the reference implementation's
 * "in-memory only" limitation.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { VerifierHistoryRecord, VerifierTaskRecord } from './types.js'

/** JSONL rotation: rotate after this many appends; keep the newest tail. */
const ROTATE_THRESHOLD = 2000
const ROTATE_KEEP = 1000

export class VerifierStore {
  private readonly dir: string
  private readonly historyFile: string
  private readonly tasksFile: string

  constructor(dir?: string) {
    this.dir = dir ?? join(homedir(), '.dsh', 'verifier-brain')
    this.historyFile = join(this.dir, 'history.jsonl')
    this.tasksFile = join(this.dir, 'tasks.jsonl')
    try {
      mkdirSync(this.dir, { recursive: true })
    } catch {
      // Read-only home: persistence degrades to in-memory only.
    }
  }

  get stateDir(): string {
    return this.dir
  }

  appendHistory(record: VerifierHistoryRecord): void {
    this.appendLine(this.historyFile, record)
  }

  /** Read recent history records (newest last), capped. */
  readHistory(limit = 100): VerifierHistoryRecord[] {
    return this.readLines<VerifierHistoryRecord>(this.historyFile).slice(-limit)
  }

  /** Persist a task transition (running -> done|error). */
  appendTask(record: VerifierTaskRecord): void {
    this.appendLine(this.tasksFile, record)
  }

  /**
   * Look up the latest record for a task id. Memory-first via the provided
   * snapshot; falls back to the on-disk log so tasks survive restarts.
   */
  findTask(taskId: string, memory: Iterable<VerifierTaskRecord>): VerifierTaskRecord | undefined {
    let latest: VerifierTaskRecord | undefined
    for (const record of memory) {
      if (record.task_id === taskId) latest = record
    }
    if (latest) return latest
    for (const record of this.readLines<VerifierTaskRecord>(this.tasksFile)) {
      if (record.task_id === taskId) latest = record
    }
    return latest
  }

  /**
   * Latest record per task id from the on-disk log — used by the F11 cold
   * recovery shim to find tasks stranded in `running` by a host restart.
   */
  readLatestTasks(): VerifierTaskRecord[] {
    const latest = new Map<string, VerifierTaskRecord>()
    for (const record of this.readLines<VerifierTaskRecord>(this.tasksFile)) {
      latest.set(record.task_id, record)
    }
    return [...latest.values()]
  }

  /** Per-file append counters for line-based rotation (D-6, O(1) check). */
  private readonly appendCounts = new Map<string, number>()

  private appendLine(file: string, value: unknown): void {
    try {
      appendFileSync(file, JSON.stringify(value) + '\n', 'utf8')
      this.rotateIfNeeded(file)
    } catch {
      // Persistence is best-effort; verification results still return.
    }
  }

  /**
   * Cap unbounded JSONL growth: after ROTATE_THRESHOLD appends, keep only the
   * most recent ROTATE_KEEP lines. D-6: the R3-18 byte-precheck (256KB) was
   * inconsistent with the 2000-line threshold — 2000 history lines usually
   * stay under 256KB, so rotation silently never fired. A per-file append
   * counter is O(1), line-accurate, and needs no stat/read on the hot path.
   * Rewrite is atomic (tmp + rename) with 3 retries (Windows cross-process
   * races, mirroring agent-teams state.js); residue tmp files are cleaned up.
   */
  private rotateIfNeeded(file: string): void {
    try {
      const n = (this.appendCounts.get(file) ?? 0) + 1
      if (n < ROTATE_THRESHOLD) {
        this.appendCounts.set(file, n)
        return
      }
      this.appendCounts.set(file, 0)
      const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim())
      if (lines.length <= ROTATE_THRESHOLD) return
      const kept = lines.slice(-ROTATE_KEEP)
      const tmp = `${file}.rot-${process.pid}-${Date.now()}`
      writeFileSync(tmp, kept.join('\n') + '\n', 'utf8')
      let renamed = false
      for (let attempt = 0; attempt < 3 && !renamed; attempt++) {
        try {
          renameSync(tmp, file)
          renamed = true
        } catch {
          // Cross-process race: another worker rotated concurrently — retry.
        }
      }
      if (!renamed) {
        try { rmSync(tmp, { force: true }) } catch { /* best-effort */ }
      }
    } catch {
      // Rotation is best-effort; a failed rewrite must not lose the append.
    }
  }

  private readLines<T>(file: string): T[] {
    try {
      if (!existsSync(file)) return []
      const out: T[] = []
      for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          out.push(JSON.parse(line) as T)
        } catch {
          // Skip torn lines (e.g. crash mid-write).
        }
      }
      return out
    } catch {
      return []
    }
  }
}
