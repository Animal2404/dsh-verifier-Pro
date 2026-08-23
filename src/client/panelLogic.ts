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
  /** VAL 验证自主等级：L0=LLM 判断 / L1=确定性规则介入。 */
  valLevel: 'L0' | 'L1'
  valNote: string
  /** literal-mc 采样近似分提示（无则 null）。 */
  mcNote: string | null
  /** 说明卡文案（无则 null）。 */
  noticeText: string | null
  /** 宿主原始细节行（无则 null）。 */
  hostDetail: string | null
  /** 展开 JSON 的原始数据（供测试断言）。 */
  data: Record<string, unknown> | null
}

const ACTION_LABELS: Record<string, string> = {
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
  const hasAnomaly = data?.anomaly === 'reward_out_of_range' || data?.anomaly === 'score_out_of_range'
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

  // VAL：L0=LLM 判断 / L1=确定性规则介入（clamp/护栏/anomaly/exact-flat=degraded）
  const valLevel: 'L0' | 'L1' = (hasAnomaly || stateKey === 'degraded') ? 'L1' : 'L0'
  const valNote = `验证锚定: ${valLevel}（${valLevel === 'L1' ? '确定性规则介入——机器规则已生效' : 'LLM 判断——无外部锚定，仅供参考'}）`

  const noticeText = STATE_NOTES[stateKey]
    ?? (hasAnomaly
      ? '⚠️ 评分返回过越界值，已被自动裁剪到 [0,1]——疑似评分模型异常或被注入，请人工复核本次结果。'
      : null)
  const hostDetail = typeof data?.warning === 'string'
    ? data.warning
    : typeof data?.message === 'string'
      ? data.message
      : null

  return { stateKey, badgeText, isWarn, valLevel, valNote, mcNote, noticeText, hostDetail, data }
}
