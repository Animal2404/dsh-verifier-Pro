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
import { tmpdir } from 'node:os'
import { existsSync, unlinkSync } from 'node:fs'
import { defineTool, type JsonValue } from '@deepseek-ai/dsh-tools'
import { LRUCache, Semaphore } from './concurrency.js'
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

/**
 * 传输层加固（v0.5.0 落地，替代早前 SECURITY.md 的虚构声明）。
 *
 * 诚实的覆盖范围：本插件无法修改 vendored 官方包的提示词构造，因此这里做
 * **运输层防御**而非"提示词注入根治"——
 *  1. 长度上限（10k，超出截断并标注）；
 *  2. 剥离 JSONL 帧破坏字符（除 \n \t 外的 C0 控制符）——防止候选文本打断
 *     stdio 协议行帧或注入不可见字符；
 *  3. 对已知"指令劫持"短语做中性化替换（defense-in-depth，明确非完备）。
 *
 * 断言给 SECURITY.md 的措辞：这是运输层加固，不声称已消除提示词注入。
 */
const MAX_INPUT_LENGTH = 10_000
const INJECTION_PHRASES: Array<[RegExp, string]> = [
  [/\bignore\s+(all\s+)?previous\s+instructions?\b/gi, '[ignored phrase]'],
  [/\bdisregard\s+(the\s+)?(above|prior|earlier)\s+instructions?\b/gi, '[ignored phrase]'],
  [/\byou\s+are\s+now\s+(a|an|the)\b/gi, '[role claim]'],
  [/\bsystem\s*:\s*$/gim, '[system marker]'],
]

function sanitizeForVerifier(text: string): string {
  let out = text
  if (out.length > MAX_INPUT_LENGTH) out = out.slice(0, MAX_INPUT_LENGTH) + '\n…[truncated]'
  // 剥 C0 控制符（保留 \n \t）。
  out = out.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  for (const [re, replacement] of INJECTION_PHRASES) out = out.replace(re, replacement)
  return out
}

function parseCriteria(raw: string | undefined): Criteria | undefined {
  if (raw === undefined || raw === '') return undefined
  const trimmed = raw.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>
        // Check if it's a weight object (all values are numbers)
        const values = Object.values(obj)
        if (values.length > 0 && values.every(v => typeof v === 'number')) {
          // Validate weights: non-negative and sum to 1.0 (±0.001)
          const sum = values.reduce((acc, v) => acc + (v as number), 0)
          if (values.some(v => (v as number) < 0)) {
            throw new Error('criteria weights must be non-negative')
          }
          if (Math.abs(sum - 1.0) > 0.001) {
            throw new Error(`criteria weights must sum to 1.0 (got ${sum.toFixed(3)})`)
          }
        }
        return obj as Criteria
      }
    } catch {
      // Fall through: send the raw string and let llm-verifier decide.
    }
  }
  return trimmed
}

/**
 * Bounded in-process result cache: identical requests are free; k1 and
 * escalated results coexist. Replaces the former unbounded Map, which leaked
 * memory in long-lived DSH sessions and served stale entries forever.
 * Bounds: 500 entries / 30min TTL — enough to dedupe a full Best-of-N round,
 * small enough that a leak is bounded.
 */
const resultCache = new LRUCache<string, Promise<unknown>>(500, 30 * 60_000)

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

/**
 * P0-5 hardening: clamp a verifier reward into [0,1].
 * A compromised/injected scoring model could emit e.g. 42.7 to force a win;
 * downstream gates compare rewards, so out-of-range values must never leak
 * through. Returns NaN unchanged (callers treat NaN as tie/degraded already);
 * flags clamping via the returned marker so results can surface the anomaly.
 */
function clamp01(value: unknown): { value: number; clamped: boolean } {
  const n = Number(value)
  if (!Number.isFinite(n)) return { value: NaN, clamped: false }
  const c = Math.min(1, Math.max(0, n))
  return { value: c, clamped: c !== n }
}

export interface EscalationDeps {
  getBridge: () => Promise<PythonBridge>
  store: VerifierStore
  esc: EscalationOptions
  /** Timeout budget for the current call context (sync or async task). */
  budgetMs: () => number
  /**
   * Bounds concurrent scoring calls into the Python bridge (P0-3 hardening).
   * Without it, N parallel verifier tools fire N simultaneous tournament
   * scorings → provider rate-limit storms + cost spikes. Undefined = unbounded.
   */
  scoringGate?: Semaphore
}

/**
 * Bridge request under the scoring semaphore (when configured).
 * All expensive select/compare/tournament calls must go through this.
 */
async function gatedRequest<T>(
  deps: EscalationDeps,
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const bridge = await deps.getBridge()
  const exec = () => bridge.request<T>(method, params, deps.budgetMs(), signal)
  return deps.scoringGate ? deps.scoringGate.run(exec, signal) : exec()
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
async function runCompare(deps: EscalationDeps, p: CompareParams, signal?: AbortSignal): Promise<Record<string, unknown>> {
  // 传输层加固：候选/问题过 sanitize（长度上限 + 控制符剥离 + 注入短语中性化）。
  const safeProblem = sanitizeForVerifier(p.problem)
  const safeA = sanitizeForVerifier(p.candidate_a)
  const safeB = sanitizeForVerifier(p.candidate_b)
  const mkParams = (swap: boolean): Record<string, unknown> => ({
    problem: safeProblem,
    candidate_a: swap ? safeB : safeA,
    candidate_b: swap ? safeA : safeB,
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
  const k1 = await cached(baseKey + ':k1', () =>
    gatedRequest<Record<string, unknown>>(deps, 'compare', mkParams(false), signal)) as Record<string, unknown>
  // P0-5: clamp rewards into [0,1]; surface anomaly when clipping occurred.
  const ca = clamp01(k1.reward_a)
  const cb = clamp01(k1.reward_b)
  if (ca.clamped || cb.clamped) {
    k1.anomaly = 'reward_out_of_range'
    k1.warning = `⚠️ 评分返回越界值已被裁剪到 [0,1]（raw reward_a=${String(k1.reward_a)}, raw reward_b=${String(k1.reward_b)}）—— 疑似评分模型异常或被注入，请人工复核。`
  }
  k1.reward_a = ca.value
  k1.reward_b = cb.value

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
      let r = await gatedRequest<Record<string, unknown>>(deps, 'compare', mkRepParams(swap), signal)
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
async function runSelect(deps: EscalationDeps, p: SelectParams, signal?: AbortSignal): Promise<Record<string, unknown>> {
  // 传输层加固：问题与每个候选过 sanitize。
  const safeProblem = sanitizeForVerifier(p.problem)
  const safeCandidates = p.candidates.map((c) => sanitizeForVerifier(c))
  const mkParams = (nEval?: number): Record<string, unknown> => ({
    problem: safeProblem,
    candidates: safeCandidates,
    ...(p.criteria !== undefined ? { criteria: p.criteria } : {}),
    ...(p.model ? { model: p.model } : {}),
    ...(nEval !== undefined ? { n_evaluations: nEval } : {}),
    ...(p.pivots !== undefined ? { pivots: p.pivots } : {}),
    ...(p.seed !== undefined ? { seed: p.seed } : {}),
    ...(p.max_workers !== undefined ? { max_workers: p.max_workers } : {}),
  })

  const baseKey = JSON.stringify({ type: 'select', problem: p.problem, candidates: p.candidates, criteria: p.criteria, model: p.model, n: p.n_evaluations ?? 1, pivots: p.pivots, seed: p.seed })
  const started = Date.now()
  // 官方 score cache（降本1，第二轮审计修正）：官方 cache_key = crit|task|索引|rep，
  // 不含 problem/候选内容/model —— 全局持久化会造成跨任务投毒（audit2 report-b 实证）。
  // 修正：cache 文件改为【每次调用独立临时文件】——只保留单次锦标赛内
  // warm-up/fan-out 的复用收益，绝不跨任务。供应商前缀缓存已覆盖跨运行节省。
  const selectCachePath = join(tmpdir(), `llv-cache-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`)
  try {
    if (existsSync(selectCachePath)) unlinkSync(selectCachePath)
  } catch { /* best-effort */ }

  const escCached = resultCache.get(baseKey + ':esc')
  if (escCached) return { ...(await escCached as Record<string, unknown>), cached: true }

  const k1WasCached = resultCache.has(baseKey + ':k1')
  const k1 = await cached(baseKey + ':k1', () =>
    gatedRequest<Record<string, unknown>>(deps, 'select',
      { ...mkParams(p.n_evaluations ?? 1), cache: selectCachePath }, signal)) as Record<string, unknown>
  // P0-5: clamp all candidate scores into [0,1]; flag anomaly on clipping.
  if (Array.isArray(k1.scores)) {
    const rawScores = k1.scores as unknown[]
    const clamped = rawScores.map((s) => clamp01(s))
    if (clamped.some((c) => c.clamped)) {
      k1.anomaly = 'score_out_of_range'
      k1.warning = `⚠️ 部分候选评分越界，已裁剪到 [0,1]（raw: ${JSON.stringify(rawScores)}）—— 疑似评分模型异常或被注入，请人工复核。`
    }
    k1.scores = clamped.map((c) => c.value)
  }

  // exact-flat 护栏（降本3，审计二修正版）：全分量精确 =0.5 有两种成因——
  //   a) on_error="tie" 掩蔽批量失败（候选互不相同 → 可疑 → degraded）
  //   b) 候选完全相同时的对称真实打分（合法 flat，验收用例 #3 场景）
  // 用候选串是否相同来区分，避免误伤真实平局（解决与验收 #3 的逻辑冲突）。
  const k1Scores = Array.isArray(k1.scores) ? k1.scores as unknown[] : []
  const identicalCandidates = new Set(p.candidates.map((c) => String(c))).size === 1
  const exactFlat = !identicalCandidates && k1Scores.length > 0 && k1Scores.every((s) => Number(s) === 0.5)

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
    // 分级评分（降本4，审计二修正）：升级用更强模型时，cache 文件按模型隔离——
    // 官方 cache_key 不含 model，共用文件会让升级 rep-0 命中首评模型的缓存分数。
    const escModel = deps.esc.escalationModel ?? p.model
    const escCachePath = escModel === p.model
      ? selectCachePath
      : join(tmpdir(), `llv-cache-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`)
    escalated = await gatedRequest<Record<string, unknown>>(deps, 'select',
      { ...mkParams(3), ...(escModel ? { model: escModel } : {}), cache: escCachePath }, signal)
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

  // Same winner: average scores element-wise when shapes match — but ONLY when
  // first pass and escalation used the SAME model (审计二修正：跨模型条件期望
  // 不可平均)。Tiered scoring 时以强模型的升级结果为准，不与首评混合。
  const tiered = Boolean(deps.esc.escalationModel) && deps.esc.escalationModel !== p.model
  const s1 = Array.isArray(k1.scores) ? k1.scores as number[] : []
  const s3 = Array.isArray(escalated.scores) ? escalated.scores as number[] : []
  const averaged = (!tiered && s1.length === s3.length && s1.every((v) => typeof v === 'number'))
    ? s3.map((v, i) => (v + Number(s1[i])) / 2)
    : s3
  const marginAfter = topGap(averaged)
  const composite: Record<string, unknown> = {
    ...escalated,
    scores: averaged,
    escalated: true,
    k_used: 3,
    ...(tiered ? { escalation_model: deps.esc.escalationModel, note: '分级评分：升级结果来自更强模型，未与首评平均' } : {}),
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
    return gatedRequest(deps, method, params)
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
  /** Max concurrent scoring calls into the bridge (P0-3; default 4, mirrors maxWorkers). */
  maxConcurrentScoring?: number
}

interface VerifierToolArgs {
  action: 'select' | 'compare' | 'track' | 'progress_start' | 'progress_update' | 'progress_close' | 'task_start' | 'task_status' | 'usage'
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
  // P0-3 hardening: bound concurrent scoring calls (default mirrors maxWorkers=4).
  const scoringGate = new Semaphore(options.maxConcurrentScoring ?? 4)
  const deps: EscalationDeps = {
    getBridge,
    store,
    esc: {
      autoEscalate: escalation?.autoEscalate ?? true,
      escalateThreshold: escalation?.escalateThreshold ?? 0.15,
      maxEscalateK: escalation?.maxEscalateK ?? 3,
    },
    budgetMs: () => syncBudgetMs ?? 300_000,
    scoringGate,
  }

  ctx.effect(() => {
    const dispose = ctx.tools.register(defineTool({
      name: 'verifier',
      description:
        'LLM-as-a-Verifier: fine-grained verification with logprob-based rewards in [0,1]. Actions: select (best of N candidates; returns index/ranking/scores), compare (pairwise rewards; quality gate), track (score a finished trajectory per step), progress_start/update/close (live progress sensor; a score persistently below ~0.05 after real work means: stop and change strategy), task_start (run select/compare/track async with a 30min budget; use for 3+ candidates or large payloads), task_status (poll; pass wait_seconds=120 instead of blind-polling). Required args — select: problem, candidates, criteria; compare: problem, candidate_a, candidate_b, criteria; track: problem, steps; progress_start: problem; progress_update: tracker_id, step; task_start: method, params (JSON string); task_status: task_id. Keep n_evaluations=1, pivots=2 unless accuracy matters more than cost; close margins are auto-re-evaluated and averaged.',
      parameters: {
        action: {
          type: 'string',
          enum: ['select', 'compare', 'track', 'progress_start', 'progress_update', 'progress_close', 'task_start', 'task_status', 'usage'],
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
        // Official presentation channel (mirrors read/web tools): a compact
        // UI-facing projection persisted with the session log, surfacing at
        // block.meta for the keyed client card — the model never sees it.
        presentationMeta: (args: unknown, value: Record<string, unknown>) => ({
          verifier: {
            action: (args as { action?: string })?.action ?? 'verifier',
            ...value,
          },
        }),
      },
      async execute(args: VerifierToolArgs, context?: { signal?: AbortSignal }): Promise<Record<string, JsonValue>> {
        const bridge = await getBridge()
        const model = withDefaultModel(args.model)
        const signal = context?.signal
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
            }, signal)
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
            }, signal)
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
            }, undefined, signal)
            store.appendHistory({ ts: new Date().toISOString(), kind: 'track', problem: args.problem, model, scores: result.scores, duration_ms: Date.now() - started })
            return asToolResult(result)
          }
          case 'progress_start': {
            if (!args.problem) throw new Error('verifier progress_start requires `problem`')
            const result = await bridge.request<Record<string, unknown>>('progress_start', {
              problem: args.problem,
              ...(model ? { model } : {}),
              ...(args.n_evaluations !== undefined ? { n_evaluations: args.n_evaluations } : {}),
            }, undefined, signal)
            store.appendHistory({ ts: new Date().toISOString(), kind: 'progress', problem: args.problem, model, tracker_id: result.tracker_id as string, scores: [] })
            return asToolResult(result)
          }
          case 'progress_update': {
            if (!args.tracker_id) throw new Error('verifier progress_update requires `tracker_id`')
            if (!args.step) throw new Error('verifier progress_update requires `step`')
            const result = await bridge.request<Record<string, unknown>>('progress_update', {
              tracker_id: args.tracker_id,
              step: args.step,
            }, undefined, signal)
            store.appendHistory({ ts: new Date().toISOString(), kind: 'progress', tracker_id: args.tracker_id, step: args.step, model, scores: [result.score] })
            return asToolResult(result)
          }
          case 'progress_close': {
            if (!args.tracker_id) throw new Error('verifier progress_close requires `tracker_id`')
            return asToolResult(await bridge.request<Record<string, unknown>>('progress_close', { tracker_id: args.tracker_id }, undefined, signal))
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
          case 'usage': {
            const result = await bridge.request<Record<string, unknown>>('usage', {}, undefined, signal)
            return asToolResult(result)
          }
        }
      },
    }))
    return () => dispose()
  }, 'verifier-brain: verifier tool')
}
