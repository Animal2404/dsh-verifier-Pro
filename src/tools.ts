/**
 * Model-facing tools bridging DSH to the official llm-verifier via the
 * Python stdio bridge. Descriptions stay short on purpose: the tool catalog
 * is billed into every first-turn prefill.
 *
 * One unified `verifier` tool with an `action` enum instead of six separate
 * tools: shorter to say/type ("verifier select"), and one schema row instead
 * of six in the first-turn prefill.
 *
 * Adaptive verification scaling (v0.2.0): when a K=1 score margin falls in
 * the noise band, the score is automatically re-evaluated (K=3) and averaged.
 * Compare escalation alternates candidate slots manually on even reps (the
 * official package only does this inside select's tournament), so position
 * bias is cancelled at any K. Direction-inconsistent escalations are reported
 * raw instead of silently averaged.
 */
import type { Context } from 'cordis'
import { join } from 'node:path'
import { defineTool, type JsonValue } from '@deepseek-ai/dsh-tools'
import type { PythonBridge } from './bridge.js'
import type { VerifierStore } from './persist.js'
import type {
  Criteria,
  VerifierTaskRecord,
} from './types.js'

const LOOSE_OBJECT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {},
} as const

/** Below this margin a score pair counts as flat (handled by existing logic). */
const FLAT_EPSILON = 0.03

/** Bridge payloads are JSON by protocol; satisfy the tool result contract. */
const asToolResult = (value: unknown): Record<string, JsonValue> => value as Record<string, JsonValue>

function parseCriteria(raw: string | undefined): Criteria | undefined {
  if (raw === undefined || raw === '') return undefined
  const trimmed = raw.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object') return parsed as Record<string, string>
    } catch {
      // Fall through: send the raw string and let llm-verifier decide.
    }
  }
  return trimmed
}

/** In-process result cache: identical requests are free; k1 and escalated results coexist. */
const resultCache = new Map<string, Promise<unknown>>()

function cached<T>(key: string, request: () => Promise<T>): Promise<T> {
  const existing = resultCache.get(key)
  if (existing !== undefined) return existing as Promise<T>
  const promise = request().catch((error) => {
    resultCache.delete(key)
    throw error
  })
  resultCache.set(key, promise)
  return promise
}

/** Adaptive-scaling configuration. */
export interface EscalationOptions {
  autoEscalate: boolean
  /** Margins at or below this (but above flat) trigger re-evaluation. */
  escalateThreshold: number
  /** Total evaluation count after escalation (3 => two extra reps). */
  maxEscalateK: number
  /**
   * Optional stronger model used ONLY for escalation reps (close-margin
   * re-evaluations). Tiered scoring: keep the first pass on a cheap tier,
   * spend the strong tier only where it matters. Unset = same as primary.
   */
  escalationModel?: string
}

interface CompareParams {
  problem: string
  candidate_a: string
  candidate_b: string
  criteria?: Criteria
  model?: string
  n_evaluations?: number
  images?: string
}

interface SelectParams {
  problem: string
  candidates: string[]
  criteria?: Criteria
  model?: string
  n_evaluations?: number
  pivots?: number
  seed?: number
  max_workers?: number
  images?: string
}

const winnerOf = (r: Record<string, unknown>): 'a' | 'b' | 'tie' => {
  const ra = Number(r.reward_a)
  const rb = Number(r.reward_b)
  if (!Number.isFinite(ra) || !Number.isFinite(rb) || ra === rb) return 'tie'
  return ra > rb ? 'a' : 'b'
}

const topGap = (scores: unknown): number => {
  if (!Array.isArray(scores)) return NaN
  const nums = scores.filter((s): s is number => typeof s === 'number').sort((a, b) => b - a)
  return nums.length >= 2 ? nums[0] - nums[1] : NaN
}

export interface EscalationDeps {
  getBridge: () => Promise<PythonBridge>
  store: VerifierStore
  esc: EscalationOptions
  /** Timeout budget for the current call context (sync or async task). */
  budgetMs: () => number
}

/** Median duration of recent scoring calls, from persisted history. */
async function estimateCallMs(deps: EscalationDeps): Promise<number> {
  const durs = deps.store.readHistory(50)
    .map((r) => r.duration_ms)
    .filter((d): d is number => typeof d === 'number' && d > 0)
    .sort((a, b) => a - b)
  if (!durs.length) return 60_000
  return durs[Math.floor(durs.length / 2)]
}

/** compare with adaptive escalation + manual slot alternation on even reps. */
async function runCompare(deps: EscalationDeps, p: CompareParams): Promise<Record<string, unknown>> {
  const mkParams = (swap: boolean): Record<string, unknown> => ({
    problem: p.problem,
    candidate_a: swap ? p.candidate_b : p.candidate_a,
    candidate_b: swap ? p.candidate_a : p.candidate_b,
    ...(p.criteria !== undefined ? { criteria: p.criteria } : {}),
    ...(p.model ? { model: p.model } : {}),
    ...(p.n_evaluations !== undefined ? { n_evaluations: p.n_evaluations } : {}),
    ...(p.images ? { images: p.images.split(',').map((s: string) => s.trim()).filter(Boolean) } : {}),
  })

  const baseKey = JSON.stringify({ type: 'compare', problem: p.problem, a: p.candidate_a, b: p.candidate_b, criteria: p.criteria, model: p.model, n: p.n_evaluations ?? 1 })
  const started = Date.now()

  // Escalated composite cache first (repeat calls hit this without new API spend).
  const escCached = resultCache.get(baseKey + ':esc')
  if (escCached) return { ...(await escCached as Record<string, unknown>), cached: true }

  const k1WasCached = resultCache.has(baseKey + ':k1')
  const k1 = await cached(baseKey + ':k1', async () =>
    (await deps.getBridge()).request<Record<string, unknown>>('compare', mkParams(false), deps.budgetMs())) as Record<string, unknown>

  const marginBefore = Math.abs(Number(k1.reward_a) - Number(k1.reward_b))
  // exact-flat 护栏（降本3）：双侧精确 0.5 是 tie 掩蔽批量失败的特征签名。
  const compareExactFlat = Number(k1.reward_a) === 0.5 && Number(k1.reward_b) === 0.5
  const doEscalate = deps.esc.autoEscalate
    && !compareExactFlat
    && Number.isFinite(marginBefore)
    && marginBefore > FLAT_EPSILON
    && marginBefore <= deps.esc.escalateThreshold

  if (!doEscalate) {
    deps.store.appendHistory({ ts: new Date().toISOString(), kind: 'compare', problem: p.problem, model: p.model, scores: [k1.reward_a, k1.reward_b], duration_ms: Date.now() - started })
    if (compareExactFlat) {
      return {
        ...k1,
        cached: k1WasCached,
        escalated: false,
        signal: 'degraded',
        warning: '⚠️ 双侧得分精确等于 0.5 —— 这是评估失败被 on_error="tie" 掩蔽的特征，不是真实平局。建议换模型重试或人工复核。',
      }
    }
    const flat = Number.isFinite(marginBefore) && marginBefore <= FLAT_EPSILON
    return {
      ...k1,
      cached: k1WasCached,
      escalated: false,
      ...(flat ? { signal: 'flat', warning: '两候选得分相同或接近，无可靠信号，建议细化标准或人工复核' } : {}),
    }
  }

  // Budget watermark: estimate upgrade cost from real persisted durations.
  const est = await estimateCallMs(deps)
  const avail = deps.budgetMs() - (Date.now() - started)
  const extraAffordable = Math.floor((avail * 0.9) / Math.max(est, 1000))
  const extraReps = Math.min(deps.esc.maxEscalateK - 1, extraAffordable)
  if (extraReps < 1) {
    return { ...k1, cached: k1WasCached, escalated: false, note: '分差接近但剩余预算不足以升级评估次数，未升级' }
  }

  // Extra reps with manual slot alternation (even reps swap, rewards swapped back).
  // Tiered scoring (降本4): escalation reps may use a stronger model — the strong
  // tier is only spent on close-margin cases that actually need it.
  const repModel = deps.esc.escalationModel ?? p.model
  const mkRepParams = (swap: boolean): Record<string, unknown> => ({
    ...mkParams(swap),
    ...(repModel ? { model: repModel } : {}),
  })
  const reps: Record<string, unknown>[] = [k1]
  for (let i = 2; i <= 1 + extraReps; i++) {
    const swap = i % 2 === 0
    try {
      let r = await (await deps.getBridge()).request<Record<string, unknown>>('compare', mkRepParams(swap), deps.budgetMs())
      if (swap) r = { reward_a: r.reward_b, reward_b: r.reward_a }
      reps.push(r)
    } catch (error) {
      if (reps.length < 2) throw error
      process.stderr.write(`[verifier-brain] escalation rep ${i} failed, continuing with ${reps.length} reps: ${error instanceof Error ? error.message : String(error)}\n`)
      break
    }
  }

  const kUsed = reps.length
  const w1 = winnerOf(k1)
  const winners = reps.map(winnerOf)
  const agreeing = winners.filter((w) => w === w1 && w !== 'tie').length

  // Direction-inconsistent: report raw, never silently average.
  if (agreeing < Math.ceil(kUsed / 2)) {
    return {
      signal: 'unstable',
      escalated: true,
      k_used: kUsed,
      message: '多次评估胜者不一致，信号不稳定，建议人工复核',
      reps: reps.map((r) => ({ reward_a: r.reward_a, reward_b: r.reward_b })),
    }
  }

  const avg = (key: string): number => reps.reduce((s, r) => s + Number(r[key]), 0) / kUsed
  const composite: Record<string, unknown> = {
    reward_a: avg('reward_a'),
    reward_b: avg('reward_b'),
    escalated: true,
    k_used: kUsed,
    margin_before: marginBefore,
    margin_after: Math.abs(avg('reward_a') - avg('reward_b')),
    consistency: `${agreeing}/${kUsed}${agreeing < kUsed ? '，建议谨慎参考' : ''}`,
    cached: false,
  }
  deps.store.appendHistory({ ts: new Date().toISOString(), kind: 'compare', problem: p.problem, model: p.model, scores: [composite.reward_a, composite.reward_b], duration_ms: Date.now() - started })
  resultCache.set(baseKey + ':esc', Promise.resolve(composite))
  return composite
}

/** select with adaptive escalation (official tournament handles reps internally). */
async function runSelect(deps: EscalationDeps, p: SelectParams): Promise<Record<string, unknown>> {
  const mkParams = (nEval?: number): Record<string, unknown> => ({
    problem: p.problem,
    candidates: p.candidates,
    ...(p.criteria !== undefined ? { criteria: p.criteria } : {}),
    ...(p.model ? { model: p.model } : {}),
    ...(nEval !== undefined ? { n_evaluations: nEval } : {}),
    ...(p.pivots !== undefined ? { pivots: p.pivots } : {}),
    ...(p.seed !== undefined ? { seed: p.seed } : {}),
    ...(p.max_workers !== undefined ? { max_workers: p.max_workers } : {}),
  })

  const baseKey = JSON.stringify({ type: 'select', problem: p.problem, candidates: p.candidates, criteria: p.criteria, model: p.model, n: p.n_evaluations ?? 1, pivots: p.pivots, seed: p.seed })
  const started = Date.now()
  // 官方 score cache 落盘（降本1）：跨重启/跨会话的相同 (problem,candidates,criteria,model)
  // 组合直接命中，不重付打分费用。compare 无 cache 参数（官方 API 不支持）不受影响。
  const selectCachePath = join(deps.store.stateDir, 'score-cache.json')

  const escCached = resultCache.get(baseKey + ':esc')
  if (escCached) return { ...(await escCached as Record<string, unknown>), cached: true }

  const k1WasCached = resultCache.has(baseKey + ':k1')
  const k1 = await cached(baseKey + ':k1', async () =>
    (await deps.getBridge()).request<Record<string, unknown>>('select',
      { ...mkParams(p.n_evaluations ?? 1), cache: selectCachePath }, deps.budgetMs())) as Record<string, unknown>

  // exact-flat 护栏（降本3）：全分量精确 =0.5 是 on_error="tie" 掩蔽批量失败的
  // 特征签名（调查报告 report-a/b/c 一致结论），不是真实评估。标记 degraded，
  // 让调用方（bestofn/agent）知道这份结果不可用于排名，而不是继续为它烧钱。
  const k1Scores = Array.isArray(k1.scores) ? k1.scores as unknown[] : []
  const exactFlat = k1Scores.length > 0 && k1Scores.every((s) => Number(s) === 0.5)

  const marginBefore = topGap(k1.scores)
  const doEscalate = deps.esc.autoEscalate
    && !exactFlat
    && Number.isFinite(marginBefore)
    && marginBefore > FLAT_EPSILON
    && marginBefore <= deps.esc.escalateThreshold

  if (!doEscalate) {
    deps.store.appendHistory({ ts: new Date().toISOString(), kind: 'select', problem: p.problem, model: p.model, index: k1.index as number, scores: k1.scores, duration_ms: Date.now() - started })
    if (exactFlat) {
      return {
        ...k1,
        cached: k1WasCached,
        escalated: false,
        signal: 'degraded',
        warning: '⚠️ 全部候选精确等于 0.5 —— 这是评估批量失败被 on_error="tie" 掩蔽的特征（如上游 logprobs 故障），不是真实平局。本结果不可用于排名；建议换模型重试或人工复核。',
      }
    }
    const flat = Number.isFinite(marginBefore) && marginBefore <= FLAT_EPSILON
    return {
      ...k1,
      cached: k1WasCached,
      escalated: false,
      ...(flat ? { signal: 'flat', warning: '所有候选得分相同或接近，排名无信号，必须用 compare 复核' } : {}),
    }
  }

  // One tournament pass cost ~= elapsed; total-3 needs ~2 more passes.
  const elapsed = Date.now() - started
  const avail = deps.budgetMs() - elapsed
  if (avail < elapsed * 2 * 1.1 || deps.esc.maxEscalateK < 3) {
    return { ...k1, cached: k1WasCached, escalated: false, note: '分差接近但剩余预算不足以升级评估次数，未升级' }
  }

  let escalated: Record<string, unknown>
  try {
    // 分级评分（降本4）：升级重评用更强模型（若配置），强模型只花在噪声带边缘。
    const escModel = deps.esc.escalationModel ?? p.model
    escalated = await (await deps.getBridge()).request<Record<string, unknown>>('select',
      { ...mkParams(3), ...(escModel ? { model: escModel } : {}), cache: selectCachePath }, deps.budgetMs())
  } catch (error) {
    return { ...k1, cached: k1WasCached, escalated: false, note: `升级评估失败，保留首评结果：${error instanceof Error ? error.message : String(error)}` }
  }

  if (escalated.index !== k1.index) {
    return {
      signal: 'unstable',
      escalated: true,
      k_used: 3,
      message: '两次评估第一名不一致，信号不稳定，建议人工复核',
      initial: { index: k1.index, scores: k1.scores },
      escalated_result: { index: escalated.index, scores: escalated.scores },
    }
  }

  // Same winner: average scores element-wise when shapes match.
  const s1 = Array.isArray(k1.scores) ? k1.scores as number[] : []
  const s3 = Array.isArray(escalated.scores) ? escalated.scores as number[] : []
  const averaged = (s1.length === s3.length && s1.every((v) => typeof v === 'number'))
    ? s3.map((v, i) => (v + Number(s1[i])) / 2)
    : s3
  const marginAfter = topGap(averaged)
  const composite: Record<string, unknown> = {
    ...escalated,
    scores: averaged,
    escalated: true,
    k_used: 3,
    margin_before: marginBefore,
    margin_after: marginAfter,
    consistency: 'top1 一致',
    cached: false,
  }
  deps.store.appendHistory({ ts: new Date().toISOString(), kind: 'select', problem: p.problem, model: p.model, index: composite.index as number, scores: averaged, duration_ms: Date.now() - started })
  resultCache.set(baseKey + ':esc', Promise.resolve(composite))
  return composite
}

/** Async-task runner: routes select/compare through adaptive escalation. */
export function createEscalationRunner(deps: EscalationDeps) {
  return async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (method === 'compare') {
      return runCompare(deps, {
        problem: String(params.problem ?? ''),
        candidate_a: String(params.candidate_a ?? ''),
        candidate_b: String(params.candidate_b ?? ''),
        criteria: params.criteria as Criteria | undefined,
        model: params.model as string | undefined,
        n_evaluations: params.n_evaluations as number | undefined,
        images: params.images as string | undefined,
      })
    }
    if (method === 'select') {
      return runSelect(deps, {
        problem: String(params.problem ?? ''),
        candidates: (params.candidates as string[]) ?? [],
        criteria: params.criteria as Criteria | undefined,
        model: params.model as string | undefined,
        n_evaluations: params.n_evaluations as number | undefined,
        pivots: params.pivots as number | undefined,
        seed: params.seed as number | undefined,
        max_workers: params.max_workers as number | undefined,
      })
    }
    return (await deps.getBridge()).request(method, params)
  }
}

/** Async verifier task table (memory) + durable transitions via VerifierStore. */
export interface VerifierTaskManager {
  start(method: string, params: Record<string, unknown>, timeoutMs?: number): string
  status(taskId: string): { task_id: string; status: string; result?: unknown; error?: string }
  /** Long-poll: resolves as soon as the task settles, or after waitSeconds. */
  statusWait(taskId: string, waitSeconds: number): Promise<{ task_id: string; status: string; result?: unknown; error?: string }>
}

export function createVerifierTaskManager(
  getBridge: () => Promise<PythonBridge>,
  store: VerifierStore,
  defaultTimeoutMs?: number,
  runner?: (method: string, params: Record<string, unknown>) => Promise<unknown>,
): VerifierTaskManager {
  const records = new Map<string, VerifierTaskRecord>()
  let seq = 0

  return {
    start(method: string, params: Record<string, unknown>, timeoutMs?: number): string {
      const taskId = `verifier-${++seq}`
      const now = () => new Date().toISOString()
      const record: VerifierTaskRecord = { task_id: taskId, method, params, status: 'running', ts: now() }
      records.set(taskId, { ...record })
      store.appendTask(record)
      void (async () => {
        const started = Date.now()
        try {
          // Async tasks get their own (much larger) budget: the sync 300s
          // bridgeTimeoutMs must not kill a long tournament scoring.
          const result = runner && (method === 'select' || method === 'compare')
            ? await runner(method, params)
            : await (await getBridge()).request<unknown>(method, params, timeoutMs ?? defaultTimeoutMs)
          const done: VerifierTaskRecord = { ...record, status: 'done', ts: now(), result }
          records.set(taskId, done)
          store.appendTask({ ...done, params: { duration_ms: Date.now() - started } })
        } catch (error) {
          const failed: VerifierTaskRecord = {
            ...record,
            status: 'error',
            ts: now(),
            error: error instanceof Error ? error.message : String(error),
          }
          records.set(taskId, failed)
          store.appendTask(failed)
        }
      })()
      return taskId
    },
    status(taskId: string) {
      const record = store.findTask(taskId, records.values())
      if (!record) return { task_id: taskId, status: 'unknown' }
      if (record.status === 'running') return { task_id: taskId, status: 'running' }
      if (record.status === 'error') return { task_id: taskId, status: 'error', error: record.error }
      return { task_id: taskId, status: 'done', result: record.result }
    },
    async statusWait(taskId: string, waitSeconds: number) {
      const deadline = Date.now() + Math.min(Math.max(waitSeconds, 0), 300) * 1000
      for (;;) {
        const snapshot = this.status(taskId)
        if (snapshot.status !== 'running' || Date.now() >= deadline) return snapshot
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
    },
  }
}

export interface ToolsOptions {
  getBridge: () => Promise<PythonBridge>
  store: VerifierStore
  tasks: VerifierTaskManager
  /** Default verifier model injected when the caller does not specify one. */
  defaultModel?: string
  /** Timeout budget for async verifier tasks (long tournament scorings). */
  taskTimeoutMs?: number
  /** Sync-call timeout budget (mirrors bridgeTimeoutMs, used by escalation watermark). */
  syncBudgetMs?: number
  /** Adaptive verification scaling options. */
  escalation?: EscalationOptions
}

interface VerifierToolArgs {
  action: 'select' | 'compare' | 'track' | 'progress_start' | 'progress_update' | 'progress_close' | 'task_start' | 'task_status'
  problem?: string
  candidates?: string[]
  candidate_a?: string
  candidate_b?: string
  steps?: string[]
  checkpoint_steps?: number[]
  tracker_id?: string
  step?: string
  method?: 'select' | 'compare' | 'track'
  params?: string
  task_id?: string
  wait_seconds?: number
  criteria?: string
  model?: string
  n_evaluations?: number
  pivots?: number
  images?: string
  seed?: number
  max_workers?: number
}

/** Render a tool result based on its shape (one tool serves many actions). */
function renderResult(value: Record<string, unknown>): { type: 'text'; text: string } {
  let prefix = ''
  if (value.escalated === true && value.k_used !== undefined) {
    prefix += `📈 自适应升级：${value.k_used} 次评估取平均`
    if (value.margin_before !== undefined) prefix += `（margin ${Number(value.margin_before).toFixed(3)} → ${Number(value.margin_after).toFixed(3)}）`
    if (typeof value.consistency === 'string') prefix += `，${value.consistency}`
    prefix += '\n'
  }
  if (value.signal === 'degraded') {
    return { type: 'text', text: `⚠️ 信号不可信（degraded）：${String(value.warning ?? '全部分量精确等于 0.5，评估疑似批量失败')}。本结果不可用于排名。` }
  }
  if (value.signal === 'flat') {
    if (value.reward_a !== undefined) {
      return { type: 'text', text: `${prefix}reward_a=${value.reward_a}\nreward_b=${value.reward_b}${value.warning ? `\n⚠️ ${value.warning}` : ''}` }
    }
    return { type: 'text', text: `${prefix}Best candidate index: ${value.index}\nScores: ${JSON.stringify(value.scores)}\nRanking: ${JSON.stringify(value.ranking)}${value.warning ? `\n⚠️ ${value.warning}` : ''}` }
  }
  if (value.index !== undefined || value.ranking !== undefined) {
    return { type: 'text', text: `${prefix}Best candidate index: ${value.index}\nScores: ${JSON.stringify(value.scores)}\nRanking: ${JSON.stringify(value.ranking)}` }
  }
  if (value.reward_a !== undefined) {
    const flags = [
      value.escalated !== undefined ? `escalated=${value.escalated}` : null,
      value.cached !== undefined ? `cached=${value.cached}` : null,
      typeof value.note === 'string' ? `note: ${value.note}` : null,
    ].filter(Boolean).join(', ')
    return { type: 'text', text: `${prefix}reward_a=${value.reward_a}\nreward_b=${value.reward_b}${flags ? `\n[${flags}]` : ''}` }
  }
  if (value.tracker_id !== undefined && value.score === undefined && value.closed === undefined) {
    return { type: 'text', text: `tracker_id: ${value.tracker_id}` }
  }
  if (value.score !== undefined) {
    return { type: 'text', text: `progress score: ${value.score}` }
  }
  if (value.task_id !== undefined && value.status !== undefined) {
    return { type: 'text', text: JSON.stringify(value) }
  }
  if (value.scores !== undefined) {
    return { type: 'text', text: `Progress scores: ${JSON.stringify(value.scores)}` }
  }
  return { type: 'text', text: prefix + JSON.stringify(value) }
}

export function registerVerifierTools(ctx: Context, options: ToolsOptions): void {
  const { getBridge, store, tasks, defaultModel, taskTimeoutMs, syncBudgetMs, escalation } = options
  const withDefaultModel = (model?: string): string | undefined => model ?? defaultModel
  const deps: EscalationDeps = {
    getBridge,
    store,
    esc: {
      autoEscalate: escalation?.autoEscalate ?? true,
      escalateThreshold: escalation?.escalateThreshold ?? 0.15,
      maxEscalateK: escalation?.maxEscalateK ?? 3,
    },
    budgetMs: () => syncBudgetMs ?? 300_000,
  }

  ctx.effect(() => {
    const dispose = ctx.tools.register(defineTool({
      name: 'verifier',
      description:
        'LLM-as-a-Verifier: fine-grained verification with logprob-based rewards in [0,1]. Actions: select (best of N candidates; returns index/ranking/scores), compare (pairwise rewards; quality gate), track (score a finished trajectory per step), progress_start/update/close (live progress sensor; a score persistently below ~0.05 after real work means: stop and change strategy), task_start (run select/compare/track async with a 30min budget; use for 3+ candidates or large payloads), task_status (poll; pass wait_seconds=120 instead of blind-polling). Required args — select: problem, candidates, criteria; compare: problem, candidate_a, candidate_b, criteria; track: problem, steps; progress_start: problem; progress_update: tracker_id, step; task_start: method, params (JSON string); task_status: task_id. Keep n_evaluations=1, pivots=2 unless accuracy matters more than cost; close margins are auto-re-evaluated and averaged.',
      parameters: {
        action: {
          type: 'string',
          enum: ['select', 'compare', 'track', 'progress_start', 'progress_update', 'progress_close', 'task_start', 'task_status'],
          required: true,
          description: 'What to do.',
        },
        problem: { type: 'string', description: 'Task statement. select/compare/track/progress_start.' },
        candidates: { type: 'array', items: { type: 'string' }, description: 'Candidate answers/trajectories. select.' },
        candidate_a: { type: 'string', description: 'First candidate. compare.' },
        candidate_b: { type: 'string', description: 'Second candidate. compare.' },
        steps: { type: 'array', items: { type: 'string' }, description: 'Ordered trajectory steps. track.' },
        checkpoint_steps: { type: 'array', items: { type: 'number' }, description: '1-based indices to score; defaults to every step. track.' },
        tracker_id: { type: 'string', description: 'From progress_start. progress_update/close.' },
        step: { type: 'string', description: 'Completed step text. progress_update.' },
        method: { type: 'string', enum: ['select', 'compare', 'track'], description: 'Async method. task_start.' },
        params: { type: 'string', description: 'JSON object string with the method arguments. task_start.' },
        task_id: { type: 'string', description: 'From task_start. task_status.' },
        wait_seconds: { type: 'number', description: 'Block up to N seconds (cap 300) for task completion; recommended 120. task_status.' },
        criteria: { type: 'string', description: 'Preset name (e.g. "terminal_bench") or JSON object string like {"Correctness":"..."}. select/compare.' },
        model: { type: 'string', description: 'Verifier model id; defaults to the configured backend model.' },
        n_evaluations: { type: 'number', description: 'Repeated evaluations per criterion (default 1).' },
        pivots: { type: 'number', description: 'Tournament pivots (default 2; more = more accurate, more costly). select.' },
        images: { type: 'string', description: 'Comma-separated image paths/URLs; multimodal backends only.' },
        seed: { type: 'number', description: 'Random seed. select.' },
        max_workers: { type: 'number', description: 'Max parallel verifier workers. select.' },
      },
      output: {
        schema: LOOSE_OBJECT_SCHEMA,
        render: (_args: unknown, value: Record<string, unknown>) => [renderResult(value)],
      },
      async execute(args: VerifierToolArgs): Promise<Record<string, JsonValue>> {
        const bridge = await getBridge()
        const model = withDefaultModel(args.model)
        switch (args.action) {
          case 'select': {
            if (!args.problem) throw new Error('verifier select requires `problem`')
            if (!args.candidates?.length) throw new Error('verifier select requires `candidates`')
            if (!args.criteria) throw new Error('verifier select requires `criteria`')
            const criteria = parseCriteria(args.criteria)
            const result = await runSelect(deps, {
              problem: args.problem,
              candidates: args.candidates,
              criteria,
              model,
              n_evaluations: args.n_evaluations,
              pivots: args.pivots,
              images: args.images,
              seed: args.seed,
              max_workers: args.max_workers,
            })
            return asToolResult(result)
          }
          case 'compare': {
            if (!args.problem) throw new Error('verifier compare requires `problem`')
            if (typeof args.candidate_a !== 'string') throw new Error('verifier compare requires `candidate_a`')
            if (typeof args.candidate_b !== 'string') throw new Error('verifier compare requires `candidate_b`')
            if (!args.criteria) throw new Error('verifier compare requires `criteria`')
            const criteria = parseCriteria(args.criteria)
            const result = await runCompare(deps, {
              problem: args.problem,
              candidate_a: args.candidate_a,
              candidate_b: args.candidate_b,
              criteria,
              model,
              n_evaluations: args.n_evaluations,
              images: args.images,
            })
            return asToolResult(result)
          }
          case 'track': {
            if (!args.problem) throw new Error('verifier track requires `problem`')
            if (!args.steps?.length) throw new Error('verifier track requires `steps`')
            const started = Date.now()
            const result = await bridge.request<Record<string, unknown>>('track', {
              problem: args.problem,
              steps: args.steps,
              ...(args.checkpoint_steps !== undefined ? { checkpoint_steps: args.checkpoint_steps } : {}),
              ...(model ? { model } : {}),
              ...(args.n_evaluations !== undefined ? { n_evaluations: args.n_evaluations } : {}),
            })
            store.appendHistory({ ts: new Date().toISOString(), kind: 'track', problem: args.problem, model, scores: result.scores, duration_ms: Date.now() - started })
            return asToolResult(result)
          }
          case 'progress_start': {
            if (!args.problem) throw new Error('verifier progress_start requires `problem`')
            const result = await bridge.request<Record<string, unknown>>('progress_start', {
              problem: args.problem,
              ...(model ? { model } : {}),
              ...(args.n_evaluations !== undefined ? { n_evaluations: args.n_evaluations } : {}),
            })
            store.appendHistory({ ts: new Date().toISOString(), kind: 'progress', problem: args.problem, model, tracker_id: result.tracker_id as string, scores: [] })
            return asToolResult(result)
          }
          case 'progress_update': {
            if (!args.tracker_id) throw new Error('verifier progress_update requires `tracker_id`')
            if (!args.step) throw new Error('verifier progress_update requires `step`')
            const result = await bridge.request<Record<string, unknown>>('progress_update', {
              tracker_id: args.tracker_id,
              step: args.step,
            })
            store.appendHistory({ ts: new Date().toISOString(), kind: 'progress', tracker_id: args.tracker_id, step: args.step, model, scores: [result.score] })
            return asToolResult(result)
          }
          case 'progress_close': {
            if (!args.tracker_id) throw new Error('verifier progress_close requires `tracker_id`')
            return asToolResult(await bridge.request<Record<string, unknown>>('progress_close', { tracker_id: args.tracker_id }))
          }
          case 'task_start': {
            let params: Record<string, unknown>
            try {
              params = JSON.parse(String(args.params ?? '').trim())
            } catch {
              return { error: 'task_start requires `params` as a valid JSON object string' }
            }
            if (typeof params.criteria === 'string' && /^[[{]/.test(params.criteria.trim())) {
              try {
                params.criteria = JSON.parse(params.criteria as string)
              } catch {
                // Keep the raw string; llm-verifier may accept a preset name.
              }
            }
            if (defaultModel && params.model === undefined) params.model = defaultModel
            const taskId = tasks.start(String(args.method ?? 'select'), params, taskTimeoutMs)
            return { task_id: taskId, status: 'running', hint: `poll verifier task_status with task_id=${taskId} (wait_seconds=120 avoids blind polling; a select with pivots typically takes 2+ minutes)` }
          }
          case 'task_status': {
            if (!args.task_id) throw new Error('verifier task_status requires `task_id`')
            const wait = Number(args.wait_seconds ?? 0)
            return asToolResult(await tasks.statusWait(String(args.task_id), Number.isFinite(wait) ? wait : 0))
          }
        }
      },
    }))
    return () => dispose()
  }, 'verifier-brain: verifier tool')
}
