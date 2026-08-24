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
import { createHash } from 'node:crypto'
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

/**
 * 稳定候选标签（用户反馈：连续多轮评选时 A/B/C 字母标会换指代——第二轮的
 * "A" 到底是第一轮的谁无从判断）。标签 = 候选文本 sha256 前 8 位十六进制：
 * 同一候选在任何一轮评估里都是同一个标签，不同候选必不同；跨轮拼子集时
 * 按标签即可对回原始身份。
 */
export function candTag(text: unknown): string {
  const s = typeof text === 'string' ? text : JSON.stringify(text) ?? ''
  return createHash('sha256').update(s).digest('hex').slice(0, 8)
}

/** Below this margin a score pair counts as flat (handled by existing logic). */
const FLAT_EPSILON = 0.03

// F15: hard upper bounds — n_evaluations multiplies into every tournament
// pair × criterion (real cost-explosion vector); pivots/max_workers scale
// similarly. The official package clamps pivots via min(k,n) but nothing
// bounded n_evaluations.
const MAX_N_EVALUATIONS = 8
const MAX_PIVOTS = 20
const MAX_MAX_WORKERS = 16

/** Clamp an optional numeric param into [min, max]; non-numbers → undefined. */
function boundParam(value: unknown, max: number, min = 1): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(min, Math.min(Math.floor(value), max))
}

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
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      // Malformed JSON string: fall through and send the raw string, letting
      // llm-verifier treat it as a preset name.
      return trimmed
    }
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>
      // D-2: the official llm-verifier package has NO weight concept —
      // normalize_criteria stringifies numeric values into descriptions
      // (0.5 → "0.5"), so an all-numeric criteria object silently produces
      // nonsense criteria ("score by criteria A described as 0.5"). The old
      // R3-6 sum-to-1 validation enforced a constraint on a phantom feature;
      // reject numeric objects outright with guidance toward the supported
      // description-object form.
      const values = Object.values(obj)
      if (values.length > 0 && values.every(v => typeof v === 'number')) {
        throw new Error(
          'criteria as a numeric/weight object is not supported: the llm-verifier backend treats criteria values as descriptions, so weights would silently become meaningless strings. Use a description object instead, e.g. {"Correctness": "checks the output is factually right"}',
        )
      }
      return obj as Criteria
    }
  }
  return trimmed
}

/**
 * 深度导向内置 criteria 预设：通用 Correctness/Completeness/Clarity 三件套
 * 奖励广度、惩罚洞察——LLM 评委天然偏袒「面面俱到的浅层候选」，压过
 * 「钉死根因的深刻候选」。这些预设把评分标准显式锚定到 根因+证据 上，
 * 是对「team 分析看似很多、实则浮于表面」的结构性对策（协议层，非提示词恳求）。
 * 官方包不认识这些名字，因此在进桥前展开成描述对象。
 */
const CRITERIA_PRESETS: Record<string, Record<string, string>> = {
  deep_review: {
    RootCause: 'Does it identify the ACTUAL root cause, pinning its specific location (code excerpt / log line / metric / step number)? Restating symptoms, or a generic list of possible causes without one pinned location, scores LOW.',
    Evidence: 'Are the key claims backed by QUOTED evidence — exact code lines, raw command output, measured numbers — rather than paraphrase? Any load-bearing claim without a quotable anchor scores LOW.',
    FailureModes: 'Name at least one NON-OBVIOUS edge case or failure mode (races, resource limits, security, encoding…) AND show concretely how the design handles it. A bare "edge cases are handled" claim with no named instance scores LOW.',
    Tradeoffs: 'Name the STRONGEST alternative approach and explain concretely why it loses. "Tradeoffs were considered" without naming one scores LOW.',
    Actionability: 'Are the next steps executable AND verifiable exactly as written (precise change, precise check)? Generic advice ("add more tests", "improve error handling") scores LOW.',
  },
  root_cause: {
    RootCause: 'Does it identify the ACTUAL root cause, pinning its specific location (code excerpt / log line / metric / step reference)? Symptom restatement scores LOW.',
    Evidence: 'Are the key claims backed by QUOTED evidence rather than paraphrase?',
    Impact: 'Does it assess what the defect actually breaks, for whom, and how badly?',
  },
}

/** Expand built-in criteria preset names ("deep_review" / "root_cause") into
 * description objects. Called at the top of runSelect/runCompare — the single
 * choke point shared by sync tools, async task_start, the service seam and
 * /bestofn — so the presets work on EVERY path. Unknown names pass through
 * unchanged (official package presets like terminal_bench still work). */
export function expandCriteria(criteria: Criteria | undefined): Criteria | undefined {
  if (typeof criteria === 'string') {
    const preset = CRITERIA_PRESETS[criteria.trim()]
    if (preset) return { ...preset }
  }
  return criteria
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
  // R3-13 (documented tradeoff): in-flight dedup couples concurrent callers
  // of the SAME key — an abort/timeout of the FIRST caller rejects the shared
  // promise, so later callers receive "aborted by caller" even though their
  // own signal never fired. Fixing this properly needs per-signal cache keys
  // (a real change); the current behavior is acceptable for the tool's
  // request model and is deliberately left documented rather than silently
  // surprising multi-session users.
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
 * R3-8: `null` is treated like NaN — the Python bridge washes non-finite
 * floats to null (F3); Number(null)===0 would otherwise turn an upstream
 * scoring failure into a confident 0.0 "bad score" instead of a tie/degraded
 * signal.
 */
function clamp01(value: unknown): { value: number; clamped: boolean } {
  if (value === null || value === undefined) return { value: NaN, clamped: true }
  const n = Number(value)
  if (!Number.isFinite(n)) return { value: NaN, clamped: false }
  const c = Math.min(1, Math.max(0, n))
  return { value: c, clamped: c !== n }
}

/** P2-2: clamp a single numeric `score` result (progress_update) — exported
 * for offline regression. Mirrors the multi-score clamp used elsewhere:
 * out-of-range rewards are clipped and flagged as an anomaly so the caller
 * never mistakes a compromised score for a clean one. */
export function clampSingleScore(result: Record<string, unknown>): void {
  if (result && typeof result.score === 'number') {
    const c = clamp01(result.score)
    if (c.clamped) {
      result.anomaly = 'score_out_of_range'
      result.warning = `⚠️ 评分返回越界分已裁剪到 [0,1]（raw: ${String(result.score)}）—— 疑似评分模型异常或被注入，请人工复核。`
    }
    result.score = c.value
  }
}

/**
 * 异常分数形态检测（自研护栏——受 CompassVerifier「C=INVALID 响应」理念启发，
 * 但实现维度不同：它检测响应文本（截断/重复/拒绝），这里检测分数数字形态，
 * 是对 exact-flat 单一护栏的扩展。注意：文本级检测见桥侧 response-shape 检查）。
 * 基于 clamp 后的分数数组做机械检测（诚实范围——只从分数结构推断）：
 *   1. 存在 NaN/非有限 → 评分器输出异常（clamp01 已把 null 洗成 NaN）
 *   2. 全 0.5 → 批量失败被 tie 掩蔽（已有 degraded 护栏，这里统一返回形态名）
 *   3. 全挤极端（全部 ≥0.95 或全部 ≤0.05）且候选数 ≥2 → 「无区分」疑似
 *      给分随意/退化（不是合法 flat，flat 是分散的相近）
 * 返回 null = 形态正常；否则 { shape, hint }。
 */
function detectAnomalousShape(scores: unknown[], kind: 'compare' | 'select'): { shape: string; hint: string } | null {
  const nums = scores.map((s) => Number(s)).filter((n) => Number.isFinite(n))
  // 1) NaN 泄漏（非有限值存在）
  if (nums.length !== scores.length) {
    return { shape: 'non_finite', hint: '评分包含 NaN/非有限值——评分器输出异常，结果不可用' }
  }
  if (nums.length === 0) return null
  // 2) 全 0.5（tie 掩蔽批量失败，compare/select 均适用）
  if (nums.every((n) => n === 0.5)) {
    return { shape: 'exact_flat', hint: '全部候选精确等于 0.5——评估批量失败被 on_error="tie" 掩蔽的特征，不是真实平局' }
  }
  // 3) 全挤极端（≥2 个候选且全部 ≥0.95 或全部 ≤0.05）——「给分随意」退化
  if (nums.length >= 2 && (nums.every((n) => n >= 0.95) || nums.every((n) => n <= 0.05))) {
    return { shape: 'degenerate_extreme', hint: '所有分数挤在同一极端（≥0.95 或 ≤0.05）——疑似评分器给分随意/退化，区分度存疑' }
  }
  return null
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
  /** #11: hard USD budget per verification (0/unset = unlimited). Enforced by
   * estimating spend from real persisted durations × configured rates before
   * each scoring call. Lives on EscalationDeps so runSelect/runCompare guard
   * EVERY path (sync tools, async task_start, service seam, /bestofn) — the
   * old tool-handler-only guard let async tasks spend unbounded. */
  maxCostPerVerification?: number
  costPer1kInputTokens?: number
  costPer1kOutputTokens?: number
}

/** #11: reject a scoring call when recent real spend × rates already exceeds
 * the configured budget. kind-specific (select/compare/track have different
 * per-call costs). Called from runSelect/runCompare/track — the single choke
 * points every path flows through. */
async function costGuard(deps: EscalationDeps, kind: 'select' | 'compare' | 'track'): Promise<void> {
  const maxCost = deps.maxCostPerVerification
  const costInRate = deps.costPer1kInputTokens ?? 0
  const costOutRate = deps.costPer1kOutputTokens ?? 0
  if (!maxCost || maxCost <= 0 || (costInRate <= 0 && costOutRate <= 0)) return
  const recent = deps.store.readHistory(20)
    .filter((r) => r.kind === kind && typeof r.duration_ms === 'number' && (r.duration_ms as number) > 0)
  if (recent.length === 0) return
  const medianMs = recent.map((r) => r.duration_ms as number).sort((a, b) => a - b)[Math.floor(recent.length / 2)]
  // 粗估：1 秒 ≈ 300 input token + 100 output token（保守量级），按费率折现。
  const rate = (300 * costInRate + 100 * costOutRate) / 1000
  const estUsd = (medianMs / 1000) * rate
  const spentUsd = (recent.reduce((s, r) => s + (r.duration_ms as number), 0) / 1000) * rate
  if (spentUsd + estUsd > maxCost) {
    throw new Error(`verifier 成本预算拦截：本次估算 ~$${estUsd.toFixed(4)}，累计 ~$${spentUsd.toFixed(4)} 超预算 $${maxCost}。提高 maxCostPerVerification 或改用便宜模型。`)
  }
}

/**
 * 审查 #6: literal-mc（采样近似）路径的成本与置信提示。
 * score_mode 由桥在 compare/select 结果里透传（'logprobs' | 'literal-mc'）。
 * literal-mc 默认 K=5 次采样（mc_n_evaluations=5）——单次结果方差大，
 * 临界分差下不可靠；且成本 ≈ 5× 单次调用。返回的 note/warning 让模型和
 * 用户都对「采样近似 + 成本」有预期，临界场景建议换 logprobs 模型复核。
 */
function literalMcNotes(scoreMode: unknown, margin: number): { note?: string; warning?: string } {
  if (scoreMode !== 'literal-mc') return {}
  const note = '评分路径：literal-mc（采样近似，默认 K=5 次调用）——精细判别请用 logprobs 模型'
  const warning = Number.isFinite(margin) && margin < 0.15
    ? '⚠️ 采样近似分在临界分差（<0.15）下不可靠——建议用 logprobs 模型复核'
    : ''
  return warning ? { note, warning } : { note }
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

/** Median duration of recent scoring calls OF THE SAME KIND, from persisted
 * history (P2-3: mixing select/track durations into a compare budget skewed
 * the estimate — select tournaments are ~4× slower than compares). */
async function estimateCallMs(deps: EscalationDeps, kind: 'select' | 'compare'): Promise<number> {
  const durs = deps.store.readHistory(50)
    .filter((r) => r.kind === kind && typeof r.duration_ms === 'number' && (r.duration_ms as number) > 0)
    .map((r) => r.duration_ms as number)
    .sort((a, b) => a - b)
  if (!durs.length) return kind === 'select' ? 37_000 : 11_000
  return durs[Math.floor(durs.length / 2)]
}

/** compare with adaptive escalation + manual slot alternation on even reps. */
async function runCompare(deps: EscalationDeps, p: CompareParams, signal?: AbortSignal): Promise<Record<string, unknown>> {
  // F15: bound the cost-scaling knob (single choke point for every path).
  p.n_evaluations = boundParam(p.n_evaluations, MAX_N_EVALUATIONS)
  // 深度预设：criteria 名称（deep_review/root_cause）在此统一展开——
  // 同步工具/异步 task_start/服务缝/bestofn 全路径共用这一处。
  p.criteria = expandCriteria(p.criteria)
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
  // 稳定候选标签：跨轮评估时 A/B 字母会换指代，内容哈希标签不变。
  const tagA = candTag(p.candidate_a)
  const tagB = candTag(p.candidate_b)

  // F4: images participate in cache identity — different images must never
  // share an entry within the LRU TTL (cross-result contamination).
  const baseKey = JSON.stringify({ type: 'compare', problem: p.problem, a: p.candidate_a, b: p.candidate_b, criteria: p.criteria, model: p.model, n: p.n_evaluations ?? 1, images: p.images ?? null })
  const started = Date.now()

  // Escalated composite cache first (repeat calls hit this without new API spend).
  const escCached = resultCache.get(baseKey + ':esc')
  if (escCached) return { ...(await escCached as Record<string, unknown>), cached: true }

  // #11: budget guard lives here (not the tool handler) so async task_start,
  // the service seam and /bestofn — all of which flow through runCompare —
  // are covered too.
  await costGuard(deps, 'compare')

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
  // P2-③ 异常响应形态检测（扩展 exact-flat 单一护栏）：NaN / 全 0.5 /
  // 全挤极端等退化形态统一识别并打 anomaly 警告。
  const shapeIssue = detectAnomalousShape([k1.reward_a, k1.reward_b], 'compare')
  if (shapeIssue && k1.anomaly === undefined) {
    k1.anomaly = 'anomalous_shape'
    k1.warning = `⚠️ 响应形态异常（${shapeIssue.shape}）：${shapeIssue.hint}——请人工复核或更换评分模型。`
  }
  const compareExactFlat = shapeIssue?.shape === 'exact_flat'
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
        tag_a: tagA,
        tag_b: tagB,
        cached: k1WasCached,
        escalated: false,
        signal: 'degraded',
        warning: '⚠️ 双侧得分精确等于 0.5 —— 这是评估失败被 on_error="tie" 掩蔽的特征，不是真实平局。建议换模型重试或人工复核。',
      }
    }
    const flat = Number.isFinite(marginBefore) && marginBefore <= FLAT_EPSILON
    const mc = literalMcNotes(k1.score_mode, marginBefore)
    // P1-2: the flat branch must MERGE k1's anomaly/clip warning instead of
    // replacing it with the generic flat text (select's flat branch already
    // merged; compare used to clobber the ⚠️ warning the model and panel rely
    // on to distrust a clipped score).
    let flatWarning = k1.warning
    if (mc.warning) flatWarning = flatWarning ? `${flatWarning}；${mc.warning}` : mc.warning
    return {
      ...k1,
      tag_a: tagA,
      tag_b: tagB,
      cached: k1WasCached,
      escalated: false,
      // 审查 #4: flat/degraded 结果也携带耗时（用户需要知道花了多久）。
      duration_ms: Date.now() - started,
      // 审查 #6: literal-mc 采样路径的成本/置信提示（临界分差建议 logprobs 复核）。
      ...(mc.note ? { note: mc.note } : {}),
      ...(flatWarning !== undefined ? { warning: flatWarning } : {}),
      ...(flat
        ? {
            signal: 'flat',
            warning: flatWarning
              ? `${flatWarning} 且：两候选得分相同或接近，无可靠信号，建议细化标准或人工复核`
              : '两候选得分相同或接近，无可靠信号，建议细化标准或人工复核',
          }
        : {}),
    }
  }

  // Budget watermark: estimate upgrade cost from real persisted durations.
  const est = await estimateCallMs(deps, 'compare')
  const avail = deps.budgetMs() - (Date.now() - started)
  const extraAffordable = Math.floor((avail * 0.9) / Math.max(est, 1000))
  const extraReps = Math.min(deps.esc.maxEscalateK - 1, extraAffordable)
  if (extraReps < 1) {
    // U-B3: budget-skip must land in history — estimateCallMs reads this file.
    deps.store.appendHistory({ ts: new Date().toISOString(), kind: 'compare', problem: p.problem, model: p.model, scores: [k1.reward_a, k1.reward_b], duration_ms: Date.now() - started, note: 'budget_skipped_escalation' })
    return { ...k1, tag_a: tagA, tag_b: tagB, cached: k1WasCached, escalated: false, note: '分差接近但剩余预算不足以升级评估次数，未升级' }
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
      // F1: escalation reps pass the same clamp01/anomaly gate as k1 —
      // a compromised model cannot smuggle out-of-range rewards through the
      // later rounds just because round one happened to be sane.
      const ra = clamp01(r.reward_a)
      const rb = clamp01(r.reward_b)
      if (ra.clamped || rb.clamped) {
        r.anomaly = 'reward_out_of_range'
        r.warning = `⚠️ 升级评估第 ${i} 轮返回越界值已裁剪到 [0,1]（raw a=${String(r.reward_a)}, b=${String(r.reward_b)}）`
      }
      r.reward_a = ra.value
      r.reward_b = rb.value
      reps.push(r)
    } catch (error) {
      // F13: k1 is already clamped and usable — a failed escalation rep must
      // degrade to the first-pass result (like select), never discard it.
      if (reps.length < 2) {
        const msg = error instanceof Error ? error.message : String(error)
        deps.store.appendHistory({ ts: new Date().toISOString(), kind: 'compare', problem: p.problem, model: deps.esc.escalationModel ?? p.model, scores: [k1.reward_a, k1.reward_b], duration_ms: Date.now() - started, note: 'escalation_failed' })
        return { ...k1, tag_a: tagA, tag_b: tagB, cached: k1WasCached, escalated: false, note: `升级评估失败，保留首评结果：${msg}` }
      }
      process.stderr.write(`[verifier-brain] escalation rep ${i} failed, continuing with ${reps.length} reps: ${error instanceof Error ? error.message : String(error)}\n`)
      break
    }
  }

  const kUsed = reps.length
  const w1 = winnerOf(k1)
  const winners = reps.map(winnerOf)
  const agreeing = winners.filter((w) => w === w1 && w !== 'tie').length

  // F1: unstable 分支同样只回传裁剪后的分数，并保留任一轮的异常标记。
  const anyAnomaly = reps.some((r) => r.anomaly === 'reward_out_of_range')
  const anomalyWarning = reps.find((r) => typeof r.warning === 'string' && r.anomaly === 'reward_out_of_range')?.warning as string | undefined

  // Direction-inconsistent: report raw, never silently average.
  if (agreeing < Math.ceil(kUsed / 2)) {
    // U-B2: unstable results must be persisted for audit/cost accounting.
    deps.store.appendHistory({ ts: new Date().toISOString(), kind: 'compare', problem: p.problem, model: deps.esc.escalationModel ?? p.model, scores: [k1.reward_a, k1.reward_b], duration_ms: Date.now() - started, note: 'unstable' })
    const mcUnstable = literalMcNotes(k1.score_mode, marginBefore)
    return {
      signal: 'unstable',
      escalated: true,
      k_used: kUsed,
      tag_a: tagA,
      tag_b: tagB,
      message: '多次评估胜者不一致，信号不稳定，建议人工复核',
      ...(anyAnomaly ? { anomaly: 'reward_out_of_range', warning: anomalyWarning } : {}),
      // 审查 #6: literal-mc 采样在临界分差下尤其不稳——如实标注路径与建议。
      ...(mcUnstable.note ? { note: mcUnstable.note } : {}),
      ...(mcUnstable.warning ? { warning: mcUnstable.warning } : {}),
      reps: reps.map((r) => ({ reward_a: r.reward_a, reward_b: r.reward_b })),
    }
  }

  const avg = (key: string): number => reps.reduce((s, r) => s + Number(r[key]), 0) / kUsed
  const mc = literalMcNotes(k1.score_mode, marginBefore)
  const composite: Record<string, unknown> = {
    reward_a: avg('reward_a'),
    reward_b: avg('reward_b'),
    escalated: true,
    k_used: kUsed,
    tag_a: tagA,
    tag_b: tagB,
    margin_before: marginBefore,
    margin_after: Math.abs(avg('reward_a') - avg('reward_b')),
    consistency: `${agreeing}/${kUsed}${agreeing < kUsed ? '，建议谨慎参考' : ''}`,
    cached: false,
    // 审查 #4: 结果携带真实耗时，让调用方/面板对成本有预期（history 中
    // compare 中位 ~10.8s，升级时 ×k_used）。
    duration_ms: Date.now() - started,
    // 审查 #6: literal-mc 采样路径的成本/置信提示。
    ...(mc.note ? { note: mc.note } : {}),
  }
  // F1: composite 不能丢掉 k1/reps 的异常标记——否则越界警告在升级后凭空消失。
  if (k1.anomaly !== undefined) {
    composite.anomaly = k1.anomaly
    if (typeof k1.warning === 'string') composite.warning = k1.warning
  } else if (anyAnomaly) {
    composite.anomaly = 'reward_out_of_range'
    composite.warning = anomalyWarning
  }
  // 审查 #6: 临界分差的 literal-mc 采样分建议 logprobs 复核（无其他 warning 时）。
  if (mc.warning && composite.warning === undefined) {
    composite.warning = mc.warning
  }
  // R3-12: history must record the model that actually produced the scores —
  // tiered escalation spent the STRONGER model, and estimateCallMs reads this
  // file to size the escalation budget.
  const historyModel = (deps.esc.escalationModel && deps.esc.escalationModel !== p.model)
    ? deps.esc.escalationModel
    : p.model
  deps.store.appendHistory({ ts: new Date().toISOString(), kind: 'compare', problem: p.problem, model: historyModel, scores: [composite.reward_a, composite.reward_b], duration_ms: Date.now() - started })
  resultCache.set(baseKey + ':esc', Promise.resolve(composite))
  return composite
}

/** select with adaptive escalation (official tournament handles reps internally). */
async function runSelect(deps: EscalationDeps, p: SelectParams, signal?: AbortSignal): Promise<Record<string, unknown>> {
  // F15: bound the cost-scaling knobs at the single choke point every path
  // (tool / task_start / service seam) flows through.
  p.n_evaluations = boundParam(p.n_evaluations, MAX_N_EVALUATIONS)
  p.pivots = boundParam(p.pivots, MAX_PIVOTS)
  p.max_workers = boundParam(p.max_workers, MAX_MAX_WORKERS)
  // 深度预设：同 runCompare。
  p.criteria = expandCriteria(p.criteria)
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
    // F4: official contract is "every entry point accepts images" — the tool
    // layer used to silently drop them before they even reached the bridge.
    ...(p.images ? { images: p.images.split(',').map((s: string) => s.trim()).filter(Boolean) } : {}),
  })

  // F4: images in the key — same reason as compare (no TTL-window contamination).
  const baseKey = JSON.stringify({ type: 'select', problem: p.problem, candidates: p.candidates, criteria: p.criteria, model: p.model, n: p.n_evaluations ?? 1, pivots: p.pivots, seed: p.seed, images: p.images ?? null })
  const started = Date.now()

  // 官方 score cache（降本1，第二轮审计修正）：官方 cache_key = crit|task|索引|rep，
  // 不含 problem/候选内容/model —— 全局持久化会造成跨任务投毒（audit2 report-b 实证）。
  // 修正：cache 文件改为【每次调用独立临时文件】——只保留单次锦标赛内
  // warm-up/fan-out 的复用收益，绝不跨任务。供应商前缀缓存已覆盖跨运行节省。
  const selectCachePath = join(tmpdir(), `llv-cache-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`)
  // F12: every temp cache file this call creates is deleted when the call
  // settles — success, error, or early return. %TEMP% used to accumulate one
  // orphan file per invocation (escalation created a second one).
  const tempCacheFiles: string[] = [selectCachePath]
  // 稳定候选标签：跨轮拼子集时字母换指代的问题（用户反馈）——按内容哈希对回身份。
  const candTags = p.candidates.map((c) => candTag(c))
  const cleanupTempCaches = (): void => {
    for (const file of tempCacheFiles) {
      try {
        if (existsSync(file)) unlinkSync(file)
      } catch { /* best-effort */ }
    }
  }
  try {
    // —— runSelect 主体：所有 return/throw 都会经过底部 finally 清理 ——

  const escCached = resultCache.get(baseKey + ':esc')
  if (escCached) return { ...(await escCached as Record<string, unknown>), cached: true }

  // #11: budget guard lives here (not the tool handler) so async task_start,
  // the service seam and /bestofn — all of which flow through runSelect —
  // are covered too.
  await costGuard(deps, 'select')

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
    // P2-③ 异常响应形态检测（扩展 exact-flat 单一护栏）：NaN / 全 0.5 /
    // 全挤极端等退化形态统一识别并打 anomaly 警告。
    const shapeIssue = detectAnomalousShape(clamped.map((c) => c.value), 'select')
    if (shapeIssue && k1.anomaly === undefined) {
      k1.anomaly = 'anomalous_shape'
      k1.warning = `⚠️ 响应形态异常（${shapeIssue.shape}）：${shapeIssue.hint}——请人工复核或更换评分模型。`
    }
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
        tags: candTags,
        cached: k1WasCached,
        escalated: false,
        signal: 'degraded',
        warning: '⚠️ 全部候选精确等于 0.5 —— 这是评估批量失败被 on_error="tie" 掩蔽的特征（如上游 logprobs 故障），不是真实平局。本结果不可用于排名；建议换模型重试或人工复核。',
      }
    }
    const flat = Number.isFinite(marginBefore) && marginBefore <= FLAT_EPSILON
    if (flat) {
      // P2-③: flat（无排名信号）与 anomaly（形态异常）可共存——异常警告
      // 不能被平局文案覆盖（此前全挤极端的分被 flat 分支吞掉警告）。
      return {
        ...k1,
        tags: candTags,
        cached: k1WasCached,
        escalated: false,
        signal: 'flat',
        warning: k1.anomaly !== undefined
          ? `${String(k1.warning ?? '')} 且：所有候选得分相同或接近，排名无信号，必须用 compare 复核`
          : '所有候选得分相同或接近，排名无信号，必须用 compare 复核',
      }
    }
    const mc = literalMcNotes(k1.score_mode, marginBefore)
    return {
      ...k1,
      tags: candTags,
      cached: k1WasCached,
      escalated: false,
      // 审查 #6: literal-mc 采样路径的成本/置信提示。
      ...(mc.note ? { note: mc.note } : {}),
      ...(mc.warning ? { warning: typeof k1.warning === 'string' ? `${k1.warning}；${mc.warning}` : mc.warning } : {}),
    }
  }

  // One tournament pass cost ~= elapsed; the escalated tournament runs
  // n_evaluations=escK passes. P1-3: honor the CONFIGURED K — the old code
  // hardcoded 3 and silently ignored maxEscalateK on the select path (only
  // compare respected it). K=1 would not be an "escalation" at all.
  const escK = Math.max(2, Math.min(deps.esc.maxEscalateK, MAX_N_EVALUATIONS))
  const elapsed = Date.now() - started
  const avail = deps.budgetMs() - elapsed
  if (avail < elapsed * escK * 1.1 || deps.esc.maxEscalateK < 2) {
    // U-B3: budget-skip must land in history — estimateCallMs reads this file.
    deps.store.appendHistory({ ts: new Date().toISOString(), kind: 'select', problem: p.problem, model: p.model, index: k1.index as number, scores: k1.scores, duration_ms: Date.now() - started, note: 'budget_skipped_escalation' })
    return { ...k1, tags: candTags, cached: k1WasCached, escalated: false, note: '分差接近但剩余预算不足以升级评估次数，未升级' }
  }

  let escalated: Record<string, unknown>
  try {
    // 分级评分（降本4，审计二修正）：升级用更强模型时，cache 文件按模型隔离——
    // 官方 cache_key 不含 model，共用文件会让升级 rep-0 命中首评模型的缓存分数。
    // R3-14: ALWAYS use a fresh cache file, same model or not — the official
    // cache_key(crit|task|a,b,rep) would otherwise hit k1's rep-0 in the
    // shared file, so "K=3 escalation" silently averaged (k1 + r1 + r2)/2
    // with k1 weighted 2/3 and k_used=3 overstated. Independent reps only.
    const escCachePath = join(tmpdir(), `llv-cache-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`)
    tempCacheFiles.push(escCachePath)
    const escModel = deps.esc.escalationModel ?? p.model
    // P1-3: escalate with the CONFIGURED K (was hardcoded 3).
    // P2-1: the escalation rep must NOT reuse the caller's seed — the official
    // tournament shuffles with the same RNG, so a shared seed would make the
    // "independent re-evaluation" trivially correlated with k1.
    const escParams = mkParams(escK)
    delete escParams.seed
    escalated = await gatedRequest<Record<string, unknown>>(deps, 'select',
      { ...escParams, ...(escModel ? { model: escModel } : {}), cache: escCachePath }, signal)
  } catch (error) {
    // U-B3: degraded-to-k1 is still a real scored call — log it.
    deps.store.appendHistory({ ts: new Date().toISOString(), kind: 'select', problem: p.problem, model: deps.esc.escalationModel ?? p.model, index: k1.index as number, scores: k1.scores, duration_ms: Date.now() - started, note: 'escalation_failed' })
    return { ...k1, tags: candTags, cached: k1WasCached, escalated: false, note: `升级评估失败，保留首评结果：${error instanceof Error ? error.message : String(error)}` }
  }

  // R3-2: clamp escalated scores IMMEDIATELY (before the unstable branch) —
  // the unstable early-return previously shipped `escalated_result.scores`
  // raw (unclamped), letting out-of-range rewards leak past the P0-5
  // invariant into the model context and the panel. Same-model-first as the
  // compare path: every returned score must already be in [0,1].
  let s3 = Array.isArray(escalated.scores) ? escalated.scores as number[] : []
  const escClamped = s3.map((v) => clamp01(v))
  if (escClamped.some((c) => c.clamped)) {
    escalated.anomaly = escalated.anomaly ?? 'score_out_of_range'
    escalated.warning = `⚠️ 升级评估返回越界分已裁剪到 [0,1]（raw: ${JSON.stringify(s3)}）`
  }
  s3 = escClamped.map((c) => c.value)
  escalated.scores = s3

  if (escalated.index !== k1.index) {
    // U-B2: unstable results must be persisted for audit/cost accounting.
    deps.store.appendHistory({ ts: new Date().toISOString(), kind: 'select', problem: p.problem, model: deps.esc.escalationModel ?? p.model, index: k1.index as number, scores: k1.scores, duration_ms: Date.now() - started, note: 'unstable' })
    const mcUnstable = literalMcNotes(k1.score_mode, marginBefore)
    return {
      signal: 'unstable',
      escalated: true,
      k_used: escK,
      tags: candTags,
      message: '两次评估第一名不一致，信号不稳定，建议人工复核',
      ...(k1.anomaly !== undefined ? { anomaly: k1.anomaly, warning: k1.warning } : {}),
      ...(escalated.anomaly !== undefined ? { anomaly: escalated.anomaly, warning: escalated.warning } : {}),
      // 审查 #6: literal-mc 采样在临界分差下尤其不稳——如实标注路径与建议。
      ...(mcUnstable.note ? { note: mcUnstable.note } : {}),
      ...(mcUnstable.warning ? { warning: mcUnstable.warning } : {}),
      initial: { index: k1.index, scores: k1.scores },
      escalated_result: { index: escalated.index, scores: escalated.scores },
    }
  }

  // Same winner: average scores element-wise when shapes match — but ONLY when
  // first pass and escalation used the SAME model (审计二修正：跨模型条件期望
  // 不可平均)。Tiered scoring 时以强模型的升级结果为准，不与首评混合。
  // F1/R3-2: escalated scores already clamped above.
  const tiered = Boolean(deps.esc.escalationModel) && deps.esc.escalationModel !== p.model
  const s1 = Array.isArray(k1.scores) ? k1.scores as number[] : []
  const averaged = (!tiered && s1.length === s3.length && s1.every((v) => typeof v === 'number'))
    ? s3.map((v, i) => (v + Number(s1[i])) / 2)
    : s3
  const marginAfter = topGap(averaged)
  const mc = literalMcNotes(k1.score_mode, marginBefore)
  const composite: Record<string, unknown> = {
    ...escalated,
    scores: averaged,
    escalated: true,
    k_used: escK,
    tags: candTags,
    ...(tiered ? { escalation_model: deps.esc.escalationModel, note: '分级评分：升级结果来自更强模型，未与首评平均' } : {}),
    margin_before: marginBefore,
    margin_after: marginAfter,
    consistency: 'top1 一致',
    cached: false,
    // 审查 #4: 真实耗时 + 候选数，供 renderResult 展示与大 N 异步提示。
    duration_ms: Date.now() - started,
    candidates_count: p.candidates.length,
    // 审查 #6: literal-mc 采样路径的成本提示。
    ...(mc.note ? { note: mc.note } : {}),
  }
  // F1: k1 的异常标记不因升级而丢失（escalated 自身的已在 spread 中带上）。
  if (composite.anomaly === undefined && k1.anomaly !== undefined) {
    composite.anomaly = k1.anomaly
    if (typeof k1.warning === 'string') composite.warning = k1.warning
  }
  // 审查 #6: 临界分差的 literal-mc 采样分建议 logprobs 复核。
  if (mc.warning && composite.warning === undefined) {
    composite.warning = mc.warning
  }
  // R3-12: record the model that actually scored (tiered escalation spent the
  // stronger tier; estimateCallMs sizes budgets from this file).
  const historyModel = tiered ? (deps.esc.escalationModel as string) : p.model
  deps.store.appendHistory({ ts: new Date().toISOString(), kind: 'select', problem: p.problem, model: historyModel, index: composite.index as number, scores: averaged, duration_ms: Date.now() - started })
  resultCache.set(baseKey + ':esc', Promise.resolve(composite))
  return composite
  } finally {
    // F12: guaranteed temp-cache cleanup on every settle path.
    cleanupTempCaches()
  }
}

/** Async-task runner: routes select/compare through adaptive escalation. */
export function createEscalationRunner(deps: EscalationDeps) {
  return async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    // D-1x: cheap per-model preflight for async/service paths too — a model
    // without token-level logprobs used to burn the full 32K budget here.
    const modelParam = typeof params.model === 'string' ? params.model : undefined
    if (modelParam) {
      const probe = await (await deps.getBridge()).request<{ ok: boolean; logprobs_supported: boolean; score_mode?: string | null; logprobs_error?: string | null }>(
        'probe_model', { model: modelParam }, 30_000,
      )
      // E2-fix (Round E): literal-mc (no-logprobs text-tag) models are also
      // scoreable — admit them alongside true-logprobs models.
      const scoreMode = probe.score_mode
      if (!probe.ok || (probe.logprobs_supported !== true && scoreMode !== 'literal-mc')) {
        if (scoreMode === 'degraded') {
          // 审查 #1：档案模型被观测到连续无 <score_X> 标签输出——fail-closed 拒绝。
          throw new Error(`verifier 模型 ${modelParam} 已降级：${String(probe.logprobs_error ?? '连续评分未返回 score 标签')} [model ${modelParam} is DEGRADED — upstream format drift or stale profile; re-probe to recheck or use another model]`)
        }
        throw new Error(`verifier 无法用模型 ${modelParam} 评分：${String(probe.logprobs_error ?? '该模型在此后端不返回 token 级 logprobs')}。请使用支持 logprobs 的模型、literal-mc 模型，或去掉 model 参数。 [verifier cannot score with model ${modelParam}: ${String(probe.logprobs_error ?? 'no token-level logprobs from this backend')} — use a logprobs-capable or literal-mc model, or drop the model arg]`)
      }
    }
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
    // R3-3/R3-4: fall-through methods (track / progress_*) bypass runSelect/
    // runCompare, so the transport hardening and the F15 bounds must be
    // applied HERE — task_start(track) and the service seam used to reach the
    // bridge with raw n_evaluations, unsanitized text and no gate coverage.
    const fallThroughParams: Record<string, unknown> = { ...params }
    if (typeof fallThroughParams.n_evaluations === 'number') {
      const bounded = boundParam(fallThroughParams.n_evaluations, MAX_N_EVALUATIONS)
      if (bounded === undefined) delete fallThroughParams.n_evaluations
      else fallThroughParams.n_evaluations = bounded
    }
    for (const textKey of ['problem', 'step'] as const) {
      if (typeof fallThroughParams[textKey] === 'string') {
        fallThroughParams[textKey] = sanitizeForVerifier(fallThroughParams[textKey] as string)
      }
    }
    if (Array.isArray(fallThroughParams.steps)) {
      fallThroughParams.steps = (fallThroughParams.steps as unknown[])
        .map((s) => (typeof s === 'string' ? sanitizeForVerifier(s) : s))
    }
    // #11: track via task_start / service seam must respect the budget too
    // (runSelect/runCompare guard themselves; the fall-through does not).
    if (method === 'track') await costGuard(deps, 'track')
    const raw = await gatedRequest<Record<string, unknown>>(deps, method, fallThroughParams)
    // D-4: track/progress results are scores too — the async task path and
    // the service seam used to return them RAW (unclamped), letting
    // out-of-range rewards leak past the P0-5 invariant (the sync tool path
    // already clamps; the runner fall-through did not).
    if (raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).scores)) {
      const out = raw as Record<string, unknown>
      const clamped = (out.scores as unknown[]).map((v) => clamp01(v))
      if (clamped.some((c) => c.clamped)) {
        out.anomaly = out.anomaly ?? 'score_out_of_range'
        out.warning = `⚠️ ${method} 返回越界分已裁剪到 [0,1]（raw: ${JSON.stringify(out.scores)}）`
      }
      out.scores = clamped.map((c) => c.value)
      return out
    }
    if (raw && typeof raw === 'object' && typeof (raw as Record<string, unknown>).score === 'number') {
      const out = raw as Record<string, unknown>
      const c = clamp01(out.score)
      if (c.clamped) {
        out.anomaly = out.anomaly ?? 'score_out_of_range'
        out.warning = `⚠️ ${method} 返回越界分已裁剪到 [0,1]（raw: ${String(out.score)}）`
      }
      out.score = c.value
      return out
    }
    return raw
  }
}

/** Async verifier task table (memory) + durable transitions via VerifierStore. */
export interface VerifierTaskManager {
  start(method: string, params: Record<string, unknown>, timeoutMs?: number): string
  status(taskId: string): { task_id: string; status: string; result?: unknown; error?: string }
  /** Long-poll: resolves as soon as the task settles, or after waitSeconds. */
  statusWait(taskId: string, waitSeconds: number, signal?: AbortSignal): Promise<{ task_id: string; status: string; result?: unknown; error?: string }>
}

export function createVerifierTaskManager(
  getBridge: () => Promise<PythonBridge>,
  store: VerifierStore,
  defaultTimeoutMs?: number,
  runner?: (method: string, params: Record<string, unknown>) => Promise<unknown>,
): VerifierTaskManager {
  const records = new Map<string, VerifierTaskRecord>()
  let seq = 0

  // F11 cold recovery: tasks left `running` by a previous process can never
  // finish (the worker died with the host) — they used to poll forever. Mark
  // them interrupted, and resume the id sequence past any existing ids so a
  // restart cannot mint colliding `verifier-N` ids.
  try {
    const previous = store.readLatestTasks()
    for (const record of previous) {
      const m = /^verifier-(\d+)$/.exec(record.task_id)
      if (m) seq = Math.max(seq, Number(m[1]))
      if (record.status === 'running') {
        store.appendTask({
          ...record,
          status: 'error',
          ts: new Date().toISOString(),
          error: 'interrupted: host/plugin restarted while the task was running',
        })
      }
    }
  } catch { /* best-effort — recovery must never block startup */ }

  /** F11/U-N3: bound the in-memory table (long sessions grew it forever). */
  const MAX_MEMORY_TASKS = 200

  return {
    start(method: string, params: Record<string, unknown>, timeoutMs?: number): string {
      const taskId = `verifier-${++seq}`
      const now = () => new Date().toISOString()
      const record: VerifierTaskRecord = { task_id: taskId, method, params, status: 'running', ts: now() }
      records.set(taskId, { ...record })
      store.appendTask(record)
      // F11/U-N3: evict oldest in-memory records beyond the cap (disk keeps
      // everything; this only bounds long-session memory growth).
      while (records.size > MAX_MEMORY_TASKS) {
        const oldest = records.keys().next().value
        if (oldest === undefined) break
        records.delete(oldest)
      }
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
          // R3-16: keep the original params in the persisted record — it used
          // to be REPLACED by { duration_ms }, so disk-side audit could no
          // longer tell what the task had scored. Duration moves to its own
          // field on the done transition.
          store.appendTask({ ...done, duration_ms: Date.now() - started })
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
    async statusWait(taskId: string, waitSeconds: number, signal?: AbortSignal) {
      const deadline = Date.now() + Math.min(Math.max(waitSeconds, 0), 300) * 1000
      for (;;) {
        // R3-17: honor the caller's abort — a cancelled poll used to spin
        // for the full 300s (2s snapshots + disk reads every iteration).
        if (signal?.aborted) return { task_id: taskId, status: 'cancelled' }
        // #13: status() is memory-first (records.values()) — running tasks
        // poll in-memory only, no disk reads per 2s tick; disk fallback is
        // only for cold-start recovery of previously-persisted tasks.
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
  /**
   * F6: shared concurrency gate. When provided (by index.ts), the SAME gate
   * also bounds the async runner and service seam — one cap across every
   * scoring path instead of a tool-only limit.
   */
  scoringGate?: Semaphore
  /** #11: hard USD budget per verification (0 = unlimited). Enforced by
   * estimating spend from real persisted durations × configured rates before
   * each scoring call. */
  maxCostPerVerification?: number
  costPer1kInputTokens?: number
  costPer1kOutputTokens?: number
}

interface VerifierToolArgs {
  action: 'select' | 'compare' | 'track' | 'decompose' | 'evaluate_session' | 'progress_start' | 'progress_update' | 'progress_close' | 'task_start' | 'task_status' | 'usage'
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
/** ⚠️ 前缀幂等：warning 已带 ⚠️ 时不再重复（#6 的 mc.warning 自带 ⚠️）。 */
function warnText(w: unknown): string {
  const s = typeof w === 'string' ? w : ''
  return s.startsWith('⚠️') ? s : `⚠️ ${s}`
}

/** 候选分数渲染：有标签时逐个显示「字母·tag=分」，跨轮身份可对回；无标签
 * （旧数据/进度类）退回 JSON。 */
function renderTaggedScores(scores: unknown, tags: unknown): string {
  if (!Array.isArray(scores)) return JSON.stringify(scores)
  const tagList = Array.isArray(tags) ? tags as unknown[] : null
  if (!tagList) return JSON.stringify(scores)
  return scores.map((s, i) => `${'ABCDEFGH'[i] ?? i + 1}·${String(tagList[i] ?? '?')}=${s}`).join('  ')
}

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
    const secs = typeof value.duration_ms === 'number' ? ` ⏱ ${(value.duration_ms / 1000).toFixed(1)}s` : ''
    if (value.reward_a !== undefined) {
      return { type: 'text', text: `${prefix}reward_a=${value.reward_a}${value.tag_a ? ` [${String(value.tag_a)}]` : ''}\nreward_b=${value.reward_b}${value.tag_b ? ` [${String(value.tag_b)}]` : ''}${secs}${value.warning ? `\n⚠️ ${value.warning}` : ''}` }
    }
    return { type: 'text', text: `${prefix}Best candidate index: ${value.index}${secs}\nScores: ${renderTaggedScores(value.scores, value.tags)}\nRanking: ${JSON.stringify(value.ranking)}${value.warning ? `\n⚠️ ${value.warning}` : ''}` }
  }
  if (value.index !== undefined || value.ranking !== undefined) {
    // 审查 #4: 展示真实耗时；大候选数时提示异步路径（select 中位 ~37.8s）。
    const secs = typeof value.duration_ms === 'number' ? ` ⏱ ${(value.duration_ms / 1000).toFixed(1)}s` : ''
    const n = typeof value.candidates_count === 'number' ? value.candidates_count : null
    const asyncHint = n !== null && n >= 8
      ? `\n💡 ${n} 候选锦标赛耗时较大，可改用 task_start 异步执行（select 中位 ~37.8s）`
      : ''
    return { type: 'text', text: `${prefix}Best candidate index: ${value.index}${secs}\nScores: ${renderTaggedScores(value.scores, value.tags)}\nRanking: ${JSON.stringify(value.ranking)}${typeof value.warning === 'string' ? `\n${warnText(value.warning)}` : ''}${asyncHint}` }
  }
  if (value.reward_a !== undefined) {
    const flags = [
      value.escalated !== undefined ? `escalated=${value.escalated}` : null,
      value.cached !== undefined ? `cached=${value.cached}` : null,
      typeof value.note === 'string' ? `note: ${value.note}` : null,
      // 审查 #4: 真实耗时（history 中 compare 中位 ~10.8s）。
      typeof value.duration_ms === 'number' ? `⏱ ${(value.duration_ms / 1000).toFixed(1)}s` : null,
      // F1: anomaly/warning must stay visible on ok/escalated results too —
      // a silently-clipped score must never render as a clean green result.
      typeof value.warning === 'string' ? warnText(value.warning) : null,
    ].filter(Boolean).join(', ')
    return { type: 'text', text: `${prefix}reward_a=${value.reward_a}${value.tag_a ? ` [${String(value.tag_a)}]` : ''}\nreward_b=${value.reward_b}${value.tag_b ? ` [${String(value.tag_b)}]` : ''}${flags ? `\n[${flags}]` : ''}` }
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
  // F6: prefer the shared gate from index.ts so tool calls, async tasks,
  // /bestofn and the service seam all draw from one concurrency budget.
  const scoringGate = options.scoringGate ?? new Semaphore(options.maxConcurrentScoring ?? 4)
  const deps: EscalationDeps = {
    getBridge,
    store,
    esc: {
      autoEscalate: escalation?.autoEscalate ?? true,
      escalateThreshold: escalation?.escalateThreshold ?? 0.15,
      maxEscalateK: escalation?.maxEscalateK ?? 3,
      // U-B1: escalationModel 必须透传到同步工具路径——此前这里重建 esc 时
      // 丢掉了它，分级评分（降本4）对最常用的同步 select/compare 静默失效。
      escalationModel: escalation?.escalationModel,
    },
    budgetMs: () => syncBudgetMs ?? 300_000,
    scoringGate,
    // #11: 成本预算挂进 deps —— costGuard 在 runSelect/runCompare/track 内
    // 统一调用，同步工具 / 异步 task_start / 服务缝 / /bestofn 全路径生效。
    maxCostPerVerification: options.maxCostPerVerification,
    costPer1kInputTokens: options.costPer1kInputTokens,
    costPer1kOutputTokens: options.costPer1kOutputTokens,
  }

  ctx.effect(() => {
    const dispose = ctx.tools.register(defineTool({
      name: 'verifier',
      description:
        'LLM-as-a-Verifier: fine-grained verification with logprob-based rewards in [0,1]. Actions: select (best of N candidates; returns index/ranking/scores), compare (pairwise rewards; quality gate), track (score a finished trajectory; returns checkpoint scores — count may be fewer than steps, official prefix-scoring semantics), decompose (deep-review a trajectory: step summaries + failure classification + check questions for manual verification), evaluate_session (track + structured export: checkpoint table, trend, JSONL-ready string), progress_start/update/close (live progress sensor; a score persistently below ~0.05 after real work means: stop and change strategy), task_start (run select/compare/track async with a 30min budget; use for 3+ candidates or large payloads — select can take ~40s, compare ~11s, so async avoids blocking), task_status (poll; pass wait_seconds=120 instead of blind-polling; returns running/done/error/unknown/cancelled). Required args — select: problem, candidates, criteria; compare: problem, candidate_a, candidate_b, criteria; track: problem, steps; decompose/evaluate_session: problem, steps; progress_start: problem; progress_update: tracker_id, step; task_start: method, params (JSON string); task_status: task_id. Keep n_evaluations=1, pivots=2 unless accuracy matters more than cost; close margins are auto-re-evaluated and averaged.',
      parameters: {
        action: {
          type: 'string',
          enum: ['select', 'compare', 'track', 'decompose', 'evaluate_session', 'progress_start', 'progress_update', 'progress_close', 'task_start', 'task_status', 'usage'],
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
        criteria: { type: 'string', description: 'Preset name (e.g. "terminal_bench") or JSON object string like {"Correctness":"..."}. Built-in depth presets: "deep_review" (root cause + evidence over coverage), "root_cause". select/compare.' },
        model: { type: 'string', description: 'Verifier model id; defaults to the configured backend model.' },
        n_evaluations: { type: 'number', description: 'Repeated evaluations per criterion (default 1; hard cap 8).' },
        pivots: { type: 'number', description: 'Tournament pivots (default 2; more = more accurate, more costly; hard cap 20). select.' },
        images: { type: 'string', description: 'Comma-separated image paths/URLs; multimodal backends only.' },
        seed: { type: 'number', description: 'Random seed. select.' },
        max_workers: { type: 'number', description: 'Max parallel verifier workers (hard cap 16). select.' },
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
        // D-1x: cheap per-model logprobs preflight. A non-default model that
        // cannot return token-level logprobs used to burn the FULL 32K
        // max_tokens budget before the bridge raised "no answer logprobs".
        // probe_model answers in ~1-2 tokens — fail fast with a clear error
        // instead of paying for 32K of wasted reasoning.
        if (model && args.model && model !== defaultModel) {
          const probe = await bridge.request<{ ok: boolean; logprobs_supported: boolean; score_mode?: string | null; logprobs_error?: string | null }>(
            'probe_model', { model: args.model }, 30_000, signal,
          )
          // E2-fix (Round E): literal-mc (no-logprobs text-tag) models are
          // also scoreable — admit them alongside true-logprobs models.
          const scoreMode = probe.score_mode
          if (!probe.ok || (probe.logprobs_supported !== true && scoreMode !== 'literal-mc')) {
            if (scoreMode === 'degraded') {
              // 审查 #1：档案模型被观测到连续无 <score_X> 标签输出——fail-closed 拒绝。
              return { error: `verifier 模型 ${String(args.model)} 已降级：${String(probe.logprobs_error ?? '连续评分未返回 score 标签')} [model ${String(args.model)} is DEGRADED — upstream format drift or stale profile; re-probe to recheck or use another model]` }
            }
            return { error: `verifier 无法用模型 ${String(args.model)} 评分：${String(probe.logprobs_error ?? '该模型在此后端不返回 token 级 logprobs')}。请使用支持 logprobs 的模型（如配置的默认模型）、literal-mc 模型，或去掉 model 参数。 [verifier cannot score with model ${String(args.model)}: ${String(probe.logprobs_error ?? 'no token-level logprobs')} — use a logprobs-capable or literal-mc model, or drop the model arg]` }
          }
        }
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
            // U-N4: validate checkpoint_steps before they hit the official
            // package (undefined behavior on empty/out-of-order/non-integers).
            if (args.checkpoint_steps !== undefined) {
              const cs = args.checkpoint_steps as unknown[]
              const valid = Array.isArray(cs) && cs.length > 0
                && cs.every((n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 1)
              if (!valid) throw new Error('verifier track `checkpoint_steps` must be a non-empty array of positive integers (1-based step indices)')
            }
            const started = Date.now()
            // Hoist after guards: TS drops property narrowing inside closures.
            const trackProblem = args.problem as string
            const trackSteps = args.steps as string[]
            // #11: sync track goes through the same budget guard as select/compare.
            await costGuard(deps, 'track')
            // R3-4: track text is model-visible scoring input — same transport
            // hardening as select/compare (length cap, control-char strip,
            // injection neutralization). R3-3: n_evaluations goes through the
            // same hard bound as every other scoring path.
            const trackN = boundParam(args.n_evaluations, MAX_N_EVALUATIONS)
            // U-N4: track goes through the shared concurrency gate like every
            // other scoring call (it spawns real tournament work upstream).
            const trackExec = (): Promise<Record<string, unknown>> => bridge.request<Record<string, unknown>>('track', {
              problem: sanitizeForVerifier(trackProblem),
              steps: trackSteps.map((s) => sanitizeForVerifier(s)),
              ...(args.checkpoint_steps !== undefined ? { checkpoint_steps: args.checkpoint_steps } : {}),
              ...(model ? { model } : {}),
              ...(trackN !== undefined ? { n_evaluations: trackN } : {}),
              ...(args.images ? { images: args.images.split(',').map((s: string) => s.trim()).filter(Boolean) } : {}),
            }, undefined, signal)
            const result = await (scoringGate ? scoringGate.run(trackExec, signal) : trackExec())
            // R3-2: track results are scores too — clamp before they reach the
            // caller (P0-5 invariant covers every numeric reward).
            if (result && Array.isArray(result.scores)) {
              const clampedScores = (result.scores as unknown[]).map((v) => clamp01(v))
              if (clampedScores.some((c) => c.clamped)) {
                result.anomaly = 'score_out_of_range'
                result.warning = `⚠️ track 返回越界分已裁剪到 [0,1]（raw: ${JSON.stringify(result.scores)}）`
              }
              result.scores = clampedScores.map((c) => c.value)
            }
            store.appendHistory({ ts: new Date().toISOString(), kind: 'track', problem: args.problem, model, scores: result.scores, duration_ms: Date.now() - started })
            return asToolResult(result)
          }
          case 'decompose': {
            // rubric 分解验证（DeepVerifier 移植，诚实适配）：把轨迹摊开成
            // 步骤摘要 + 可疑行为映射失败分类 + 核查问题清单。核查问题的
            // 【执行】留给调用方（我们没有 rollout 实查能力）。
            if (!args.problem) throw new Error('verifier decompose requires `problem`')
            if (!args.steps?.length) throw new Error('verifier decompose requires `steps`')
            const decProblem = args.problem as string
            const decSteps = args.steps as string[]
            const decExec = (): Promise<Record<string, unknown>> => bridge.request<Record<string, unknown>>('decompose', {
              problem: sanitizeForVerifier(decProblem),
              steps: decSteps.map((s) => sanitizeForVerifier(s)),
              ...(model ? { model } : {}),
            }, undefined, signal)
            let result = await (scoringGate ? scoringGate.run(decExec, signal) : decExec())
            // #14: decompose 偶发空响应/JSON 截断（模型隐藏推理吃光预算）——
            // 桥侧有重试，TS 侧补一次，避免用户手动重试。
            if (result && typeof result.error === 'string') {
              result = await (scoringGate ? scoringGate.run(decExec, signal) : decExec())
            }
            return asToolResult(result)
          }
          case 'evaluate_session': {
            // lanbaolu /evaluate-session 移植（深读其 PROGRESS/ROADMAP，诚实适配）：
            // 对一条会话轨迹做 track 评分并导出为结构化分数表（每步分数 + 总览 +
            // JSONL 就绪串），供 RL 数据筛选 / 轨迹评估等复用——对应 lanbaolu P2
            // 「轨迹评分与数据导出」目标。会话文件提取是 DSH 宿主的事，本工具接收
            // 步骤数组（团队/调用方提供轨迹）。
            if (!args.problem) throw new Error('verifier evaluate_session requires `problem`')
            if (!args.steps?.length) throw new Error('verifier evaluate_session requires `steps`')
            const esStarted = Date.now()
            const esProblem = args.problem as string
            const esSteps = args.steps as string[]
            const esExec = (): Promise<Record<string, unknown>> => bridge.request<Record<string, unknown>>('track', {
              problem: sanitizeForVerifier(esProblem),
              steps: esSteps.map((s) => sanitizeForVerifier(s)),
              ...(model ? { model } : {}),
              ...(args.n_evaluations !== undefined ? { n_evaluations: boundParam(args.n_evaluations, MAX_N_EVALUATIONS) } : {}),
            }, undefined, signal)
            const raw = await (scoringGate ? scoringGate.run(esExec, signal) : esExec())
            if (raw && Array.isArray(raw.scores)) {
              const clamped = (raw.scores as unknown[]).map((v) => clamp01(v))
              if (clamped.some((c) => c.clamped)) {
                raw.anomaly = 'score_out_of_range'
                raw.warning = `⚠️ track 返回越界分已裁剪到 [0,1]（raw: ${JSON.stringify(raw.scores)}）`
              }
              raw.scores = clamped.map((c) => c.value)
            }
            // 结构化导出：每步分数表 + 趋势 + JSONL 就绪串（lanbaolu 导出格式）。
            const scores = Array.isArray(raw.scores) ? raw.scores as number[] : []
            // 结构化导出：checkpoint 分数表（诚实标注——官方 track 对 N 步轨迹
            // 返回的是前缀评分的 checkpoint 分数，数量 ≤ 步骤数，不逐一对位）。
            const table = scores.map((s, i) => ({ checkpoint: i + 1, score: s }))
            const trend = scores.length >= 2 ? Number((scores[scores.length - 1] - scores[0]).toFixed(4)) : 0
            const exportable = {
              problem: esProblem,
              model,
              scored_at: new Date().toISOString(),
              // 官方 track 语义：checkpoint 分数（前缀轨迹评分），非每步对位
              checkpoints: table,
              note: 'track 返回前缀评分的 checkpoint 分数，数量 ≤ 输入步骤数',
              trend,
              summary: scores.length ? Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(4)) : 0,
            }
            store.appendHistory({ ts: new Date().toISOString(), kind: 'track', problem: esProblem, model, scores, duration_ms: Date.now() - esStarted })
            return asToolResult({ ...raw, export: exportable, export_jsonl: JSON.stringify(exportable) })
          }
          case 'progress_start': {
            if (!args.problem) throw new Error('verifier progress_start requires `problem`')
            // Hoist after guard (closure narrowing).
            const psProblem = args.problem as string
            // R3-3/R3-4/R3-5: bound n_evaluations, sanitize the problem text,
            // and go through the shared gate (ProgressTracker.update scores).
            const psN = boundParam(args.n_evaluations, MAX_N_EVALUATIONS)
            const psExec = (): Promise<Record<string, unknown>> => bridge.request<Record<string, unknown>>('progress_start', {
              problem: sanitizeForVerifier(psProblem),
              ...(model ? { model } : {}),
              ...(psN !== undefined ? { n_evaluations: psN } : {}),
              ...(args.images ? { images: args.images.split(',').map((s: string) => s.trim()).filter(Boolean) } : {}),
            }, undefined, signal)
            const result = await (scoringGate ? scoringGate.run(psExec, signal) : psExec())
            // P3-3: progress_start confirms a tracker — it produces no score,
            // so history must not record a misleading empty scores array.
            store.appendHistory({ ts: new Date().toISOString(), kind: 'progress', problem: args.problem, model, tracker_id: result.tracker_id as string })
            return asToolResult(result)
          }
          case 'progress_update': {
            if (!args.tracker_id) throw new Error('verifier progress_update requires `tracker_id`')
            if (!args.step) throw new Error('verifier progress_update requires `step`')
            // Hoist after guards (closure narrowing).
            const puTracker = args.tracker_id as string
            const puStep = args.step as string
            // R3-4/R3-5: sanitize the step text; the update itself scores.
            const puExec = (): Promise<Record<string, unknown>> => bridge.request<Record<string, unknown>>('progress_update', {
              tracker_id: puTracker,
              step: sanitizeForVerifier(puStep),
            }, undefined, signal)
            const result = await (scoringGate ? scoringGate.run(puExec, signal) : puExec())
            // P2-2: progress scores are rewards too — the P0-5 invariant
            // (clamp + anomaly flag) must cover progress_update like every
            // other numeric score (previously returned raw, bypassing clamp).
            clampSingleScore(result)
            store.appendHistory({ ts: new Date().toISOString(), kind: 'progress', tracker_id: args.tracker_id, step: args.step, model, scores: [result.score] })
            return asToolResult(result)
          }
          case 'progress_close': {
            if (!args.tracker_id) throw new Error('verifier progress_close requires `tracker_id`')
            return asToolResult(await bridge.request<Record<string, unknown>>('progress_close', { tracker_id: args.tracker_id }, undefined, signal))
          }
          case 'task_start': {
            // U-N1: only the three scoring methods may be scheduled.
            const asyncMethod = String(args.method ?? 'select')
            if (asyncMethod !== 'select' && asyncMethod !== 'compare' && asyncMethod !== 'track') {
              return { error: `task_start method must be select, compare or track (got "${asyncMethod}")` }
            }
            let params: Record<string, unknown>
            try {
              const parsed: unknown = JSON.parse(String(args.params ?? '').trim())
              // U-N1: arrays/null would previously be persisted into
              // tasks.jsonl verbatim and explode downstream — reject early.
              if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                return { error: 'task_start requires `params` as a JSON object string like "{\\"problem\\": ...}"' }
              }
              params = parsed as Record<string, unknown>
            } catch {
              return { error: 'task_start requires `params` as a valid JSON object string' }
            }
            // U-N1: criteria is REQUIRED for scoring methods — the bridge
            // would otherwise silently swap in its DEFAULT_CRITERIA (silent
            // semantic drift + part of the injection surface).
            if (asyncMethod !== 'track') {
              const c = params.criteria
              if (c === undefined || c === null || (typeof c === 'string' && !c.trim())) {
                return { error: `task_start ${asyncMethod} requires \`criteria\` inside params (a preset name or a JSON object string of criteria)` }
              }
            }
            if (typeof params.criteria === 'string' && /^[[{]/.test(params.criteria.trim())) {
              try {
                params.criteria = JSON.parse(params.criteria as string)
              } catch {
                // Keep the raw string; llm-verifier may accept a preset name.
              }
            }
            // D-3: the async path must apply the same numeric-criteria
            // rejection as the sync path (D-2) — it used to bypass parseCriteria
            // entirely and silently ship weight objects to the phantom feature.
            if (params.criteria && typeof params.criteria === 'object' && !Array.isArray(params.criteria)) {
              const cvals = Object.values(params.criteria as Record<string, unknown>)
              if (cvals.length > 0 && cvals.every(v => typeof v === 'number')) {
                return { error: 'task_start: criteria as a numeric/weight object is not supported (the backend treats values as descriptions). Use a description object like {"Correctness": "checks the output"}' }
              }
            }
            if (defaultModel && params.model === undefined) params.model = defaultModel
            const taskId = tasks.start(asyncMethod, params, taskTimeoutMs)
            return { task_id: taskId, status: 'running', hint: `poll verifier task_status with task_id=${taskId} (wait_seconds=120 avoids blind polling; a select with pivots typically takes 2+ minutes)` }
          }
          case 'task_status': {
            if (!args.task_id) throw new Error('verifier task_status requires `task_id`')
            const wait = Number(args.wait_seconds ?? 0)
            return asToolResult(await tasks.statusWait(String(args.task_id), Number.isFinite(wait) ? wait : 0, signal))
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
