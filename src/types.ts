/** Shared types for the verifier-brain plugin. */

/** Bridge protocol envelope (JSON Lines over stdio). */
export interface BridgeResponse<T> {
  id: number | string | null
  ok: true
  result: T
}

export interface BridgeErrorResponse {
  id: number | string | null
  ok: false
  error: { type: string; message: string }
}

export type BridgeResult<T> = BridgeResponse<T> | BridgeErrorResponse

/** Criteria accepts a preset name ("terminal_bench") or a {name: description} object. */
export type Criteria = string | Record<string, string>

export interface VerifierSelectArgs {
  problem: string
  candidates: string[]
  criteria: string
  model?: string
  n_evaluations?: number
  pivots?: number
  /** Comma-separated image paths/URLs (multimodal backends only). */
  images?: string
  seed?: number
  max_workers?: number
}

export interface VerifierCompareArgs {
  problem: string
  candidate_a: string
  candidate_b: string
  criteria: string
  model?: string
  n_evaluations?: number
  images?: string
  seed?: number
}

export interface VerifierTrackArgs {
  problem: string
  steps: string[]
  checkpoint_steps?: number[]
  model?: string
  n_evaluations?: number
  images?: string
}

export interface VerifierProgressArgs {
  action: 'start' | 'update' | 'close'
  tracker_id?: string
  problem?: string
  step?: string
  model?: string
  n_evaluations?: number
  images?: string[]
}

export interface VerifierTaskArgs {
  method: 'select' | 'compare' | 'track'
  params: string
}

/** One persisted score-history record (history.jsonl). */
export interface VerifierHistoryRecord {
  ts: string
  kind: 'select' | 'compare' | 'track' | 'progress'
  problem?: string
  model?: string
  /** select: per-candidate scores; compare: [reward_a, reward_b]; track/progress: scores */
  scores?: unknown
  index?: number
  tracker_id?: string
  step?: string
  duration_ms?: number
  /** U-B2/U-B3: why a non-composite result was logged (unstable/budget/degraded). */
  note?: string
}

/** One persisted async-task record (tasks.jsonl transitions). */
export interface VerifierTaskRecord {
  task_id: string
  method: string
  params: unknown
  status: 'running' | 'done' | 'error'
  ts: string
  result?: unknown
  error?: string
  /** R3-16: wall-clock duration on the done transition (params stays intact). */
  duration_ms?: number
}
