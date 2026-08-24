/**
 * VerifierPanel 纯逻辑（GUI 状态推导）——与 React / 宿主 client 包解耦，
 * 使面板的状态矩阵可在 CI 无浏览器测试（锐评指出的「E2E/GUI 测试层未建」）。
 * 两个导出函数是面板渲染的全部决策逻辑；组件只负责把这些结果画出来。
 */

export interface PanelExtracted {
  action: string
  data: Record<string, unknown> | null
  isError: boolean
  running: boolean
}

/** 从 wire block 提取卡片数据（meta 结构化通道 → JSON 文本回退）。 */
export function extractPanel(toolName: string, blockRaw: unknown): PanelExtracted {
  if (!blockRaw || typeof blockRaw !== 'object') {
    return { action: toolName, data: null, isError: false, running: false }
  }
  const block = blockRaw as Record<string, unknown>
  const running = !('kind' in block)
  const isError = block.isError === true

  let action = toolName
  try {
    const argsRaw = (running ? block.argsRaw : (block.call as { argsRaw?: string } | null)?.argsRaw) ?? ''
    if (typeof argsRaw === 'string' && argsRaw.trim().startsWith('{')) {
      const args = JSON.parse(argsRaw) as { action?: unknown }
      if (typeof args.action === 'string') action = args.action
    }
  } catch { /* args not JSON — keep default */ }

  if (running || isError) return { action, data: null, isError, running }

  // 1) structured meta passthrough
  const meta = block.meta
  if (meta && typeof meta === 'object') {
    const m = meta as Record<string, unknown>
    const candidate = (m.verifier ?? m.presentationMeta ?? m) as Record<string, unknown>
    if (candidate && (candidate.action !== undefined || candidate.index !== undefined || candidate.reward_a !== undefined)) {
      return { action: typeof candidate.action === 'string' ? candidate.action : action, data: candidate, isError, running }
    }
  }

  // 2) parse the persisted model-facing JSON record
  try {
    const content = block.content as readonly unknown[]
    const text = (content ?? [])
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : ''))
      .join('')
    const parsed = JSON.parse(text) as Record<string, unknown>
    if (parsed && typeof parsed === 'object') return { action, data: parsed, running, isError }
  } catch { /* content is human-readable text — no card data */ }

  return { action, data: null, isError, running }
}

export type PanelStateKey = 'running' | 'error' | 'degraded' | 'flat' | 'unstable' | 'escalated' | 'ok' | 'plain'

export interface PanelState {
  stateKey: PanelStateKey
  badgeText: string
  isWarn: boolean
  /** VAL 验证自主等级：L0=LLM 判断 / L1=确定性规则介入；非评分动作（任务/追踪器
   *  确认、统计）无 LLM 判断，为 null 且不渲染 VAL 行。 */
  valLevel: 'L0' | 'L1' | null
  valNote: string | null
  /** literal-mc 采样近似分提示（无则 null）。 */
  mcNote: string | null
  /** 说明卡文案（无则 null）。 */
  noticeText: string | null
  /** 宿主原始细节行（无则 null）。 */
  hostDetail: string | null
  /** 结构化 action（decompose/evaluate_session）的摘要行（无则 null）。 */
  summaryLine: string | null
  /** 展开 JSON 的原始数据（供测试断言）。 */
  data: Record<string, unknown> | null
}

export const ACTION_LABELS: Record<string, string> = {
  select: '择优评选', compare: '对比评审', track: '轨迹打分',
  decompose: '分解验证', evaluate_session: '会话评估',
  progress_start: '进度追踪 · 开始', progress_update: '进度追踪 · 更新',
  progress_close: '进度追踪 · 结束', task_start: '异步任务 · 启动',
  task_status: '异步任务 · 查询', usage: '用量统计', ping: '连通探测',
}
const BADGE_LABELS: Record<string, string> = {
  ok: '正常', degraded: '信号不可信', flat: '无区分度', unstable: '信号不稳', error: '出错',
}
const STATE_NOTES: Record<string, string> = {
  error: '这次调用失败了——可能是网络、后端余额或配置问题。点开卡片看错误详情，或展开会话轨迹排查。',
  degraded: '⚠️ 本次所有候选都得 0.5 分——这是评分批量失败的特征（常见原因：模型不支持 logprob 打分）。分数不可用于排名，请更换模型重试或人工复核。',
  flat: '几个方案得分几乎一样，排名没有参考意义——建议用「对比评审」对前两名单独复核，或细化评审标准。',
  unstable: '多次独立评审的赢家不一致，说明模型也拿不准——建议人工复核后再决定，不要自动采信本次结果。',
  escalated: '两个方案得分接近，单次评分可能有偶然性——已自动独立评审 K 次并取平均（每次交换先后顺序），结果更可靠。',
}

/** 从数据推导面板全部状态（纯函数，可测试）。 */
export function derivePanelState(
  extracted: PanelExtracted,
  action: string,
): PanelState {
  const { data, isError, running } = extracted
  const escalated = data?.escalated === true
  const signal = typeof data?.signal === 'string' ? data.signal : null
  // P2-5: anomaly 识别必须覆盖全部三类防护标记——越界裁剪（reward/score）、
  // 分数形态异常（anomalous_shape_*：NaN/全 0.5/全挤极端）、响应形态异常
  // （response_shape_*：截断/循环重复/拒绝回答）。此前只认裁剪类，后两类
  // 在面板上静默（不触发 L1 标注与说明卡）。
  const anomalyKind = typeof data?.anomaly === 'string' ? data.anomaly : null
  const hasAnomaly = anomalyKind === 'reward_out_of_range' || anomalyKind === 'score_out_of_range'
    || (anomalyKind !== null && anomalyKind.startsWith('anomalous_shape'))
    || (anomalyKind !== null && anomalyKind.startsWith('response_shape'))
    || (typeof data?.warning === 'string' && data.warning.includes('裁剪'))
  const scoreMode = typeof data?.score_mode === 'string' ? data.score_mode : null

  let stateKey: PanelStateKey
  let badgeText: string
  let isWarn = false
  if (running) { stateKey = 'running'; badgeText = '评分中…' }
  else if (isError) { stateKey = 'error'; badgeText = BADGE_LABELS.error!; isWarn = true }
  else if (signal === 'degraded') { stateKey = 'degraded'; badgeText = BADGE_LABELS.degraded!; isWarn = true }
  else if (signal === 'flat' || signal === 'unstable') { stateKey = signal; badgeText = BADGE_LABELS[signal] ?? signal; isWarn = true }
  else if (escalated) { stateKey = 'escalated'; badgeText = `分差小 · 已评${String(data?.k_used ?? '?')}次` }
  else if (data) { stateKey = 'ok'; badgeText = BADGE_LABELS.ok! }
  else { stateKey = 'plain'; badgeText = ACTION_LABELS[action] ?? action }

  const mcNote = scoreMode === 'literal-mc'
    ? `🎲 采样近似分：模型不返回 logprobs，本分是 ${String(data?.k_used ?? data?.n_evaluations ?? '多次')} 次评分标签采样平均——方向可信，精细分差请用 logprobs 模型复核。`
    : null

  // VAL：L0=LLM 判断 / L1=确定性规则介入（clamp/护栏/anomaly/exact-flat=degraded）。
  // 非评分动作（task_start/progress_start/progress_close/usage、无结果的
  // task_status）不产生 LLM 判断——valNote 置 null，卡片不渲染 VAL 行。
  const scoringActions = new Set(['select', 'compare', 'track', 'decompose', 'evaluate_session', 'progress_update'])
  const isScoring = scoringActions.has(action)
    || (action === 'task_status' && data !== null && (Array.isArray(data.scores) || data.reward_a !== undefined || data.index !== undefined))
  const valLevel: 'L0' | 'L1' | null = !isScoring
    ? null
    : ((hasAnomaly || stateKey === 'degraded') ? 'L1' : 'L0')
  const valNote = valLevel === null
    ? null
    : `验证锚定: ${valLevel}（${valLevel === 'L1' ? '确定性规则介入——机器规则已生效' : 'LLM 判断——无外部锚定，仅供参考'}）`

  const noticeText = STATE_NOTES[stateKey]
    ?? (hasAnomaly
      ? '⚠️ 本次评分触发了异常防护（越界裁剪 / 分数形态异常 / 响应形态异常）——疑似评分模型异常或被注入，请人工复核本次结果。'
      : null)
  const hostDetail = typeof data?.warning === 'string'
    ? data.warning
    : typeof data?.message === 'string'
      ? data.message
      : null

  // 结构化 action 摘要行：decompose（诊断）、evaluate_session（评分导出）、
  // progress/task/usage（进度分、任务状态、用量统计）——这些动作不产生
  // reward_a/b，面板应显示其实际内容而非空白「正常」卡。
  let summaryLine: string | null = null
  if (data && !running && !isError) {
    if (action === 'decompose') {
      const errs = Array.isArray(data.potential_errors) ? data.potential_errors.length : 0
      const qs = Array.isArray(data.check_questions) ? data.check_questions.length : 0
      const steps = Array.isArray(data.step_summary) ? data.step_summary.length : 0
      summaryLine = `🔬 轨迹 ${steps} 步 · 可疑行为 ${errs} 个 · 核查问题 ${qs} 个（展开查看详情）`
    } else if (action === 'evaluate_session') {
      const exp = data.export as Record<string, unknown> | undefined
      const cps = Array.isArray(exp?.checkpoints) ? exp.checkpoints.length : 0
      const trend = typeof exp?.trend === 'number' ? exp.trend : null
      const mean = typeof exp?.summary === 'number' ? exp.summary : null
      summaryLine = `📊 checkpoint ${cps} 个${mean !== null ? ` · 均分 ${mean.toFixed(3)}` : ''}${trend !== null ? ` · 趋势 ${trend >= 0 ? '+' : ''}${trend.toFixed(3)}` : ''}`
    } else if (action === 'progress_update') {
      summaryLine = typeof data.score === 'number'
        ? `📈 进度分: ${data.score.toFixed(3)}`
        : null
    } else if (action === 'progress_start') {
      summaryLine = typeof data.tracker_id === 'string'
        ? `🆕 tracker: ${data.tracker_id}（后续 progress_update 用此 id 上报进度）`
        : null
    } else if (action === 'progress_close') {
      summaryLine = data.closed === true ? '✅ 追踪已关闭' : null
    } else if (action === 'task_start') {
      summaryLine = `📤 任务 ${String(data.task_id ?? '?')} 已提交（${String(data.status ?? 'running')}）——用 task_status 轮询结果`
    } else if (action === 'task_status') {
      if (data.status === 'done') {
        const r = (data.result ?? data) as Record<string, unknown>
        const idx = typeof r.index === 'number' ? r.index : null
        const scores = Array.isArray(r.scores) ? (r.scores as unknown[]).map((s) => Number(s).toFixed(3)).join(', ') : null
        const reward = typeof r.reward_a === 'number' ? `reward_a=${Number(r.reward_a).toFixed(3)} / reward_b=${Number(r.reward_b).toFixed(3)}` : null
        const sig = typeof r.signal === 'string' ? ` · ${r.signal}` : ''
        summaryLine = `✅ 任务完成${idx !== null ? ` · 冠军 ${String.fromCharCode(65 + idx)}` : ''}${scores !== null ? ` · scores [${scores}]` : ''}${reward !== null ? ` · ${reward}` : ''}${sig}`
      } else {
        summaryLine = `⏳ 任务 ${String(data.task_id ?? '?')} ${String(data.status ?? '运行中')}——可用 wait_seconds 轮询等待`
      }
    } else if (action === 'usage') {
      const u = (data.usage ?? data) as Record<string, unknown>
      const calls = typeof u.calls === 'number' ? u.calls : null
      const inTok = typeof u.input_tokens === 'number' ? u.input_tokens : null
      const outTok = typeof u.output_tokens === 'number' ? u.output_tokens : null
      const hit = typeof u.cache_hit_rate === 'number' ? `${Math.round(u.cache_hit_rate * 100)}%` : null
      const parts = [
        calls !== null ? `${calls} 次调用` : null,
        inTok !== null && outTok !== null ? `${(inTok / 1000).toFixed(1)}K in / ${(outTok / 1000).toFixed(1)}K out tokens` : null,
        hit !== null ? `缓存命中 ${hit}` : null,
      ].filter(Boolean)
      summaryLine = parts.length ? `📊 ${parts.join(' · ')}` : null
    }
  }

  return { stateKey, badgeText, isWarn, valLevel, valNote, mcNote, noticeText, hostDetail, summaryLine, data }
}
