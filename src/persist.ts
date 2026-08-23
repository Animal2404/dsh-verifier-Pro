/**
 * Durable state for verifier-brain: score history and async-task records as
 * JSON Lines under `~/.dsh/verifier-brain/`. Everything survives DSH
 * restarts and plugin reloads — fixing the reference implementation's
 * "in-memory only" limitation.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { VerifierHistoryRecord, VerifierTaskRecord } from './types.js'

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

  private appendLine(file: string, value: unknown): void {
    try {
      appendFileSync(file, JSON.stringify(value) + '\n', 'utf8')
    } catch {
      // Persistence is best-effort; verification results still return.
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
