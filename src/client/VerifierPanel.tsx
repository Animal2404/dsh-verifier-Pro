import React from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ToolCallOwnerProps } from '@deepseek-ai/dsh-client-ui-tool/client'

/**
 * Verifier result card — keyed `tool.call.toolview` view for the wire tool
 * named `verifier` (key domain = tool name; a keyed hit REPLACES the generic
 * row, per @deepseek-ai/dsh-client-ui-tool contract/slots.d.ts).
 *
 * Props are the standard owner currency: { callId, toolName, block, ... }.
 * Data extraction order for the settled node:
 *   1. block.meta                      (structured passthrough when present)
 *   2. JSON.parse(block.content text)  (our execute() returns a flat JSON
 *      record — index/scores/reward_a/reward_b/escalated/anomaly/warning)
 * Running state renders a live "scoring…" skeleton.
 *
 * Theming: colors reference host design tokens (--dsw-alias-*, mounted on
 * document.body; dark overrides under body[data-ds-dark-theme]) so the card
 * flips with the shell scheme automatically — zero hardcoded hex.
 */

interface Extracted {
  action: string
  data: Record<string, unknown> | null
  isError: boolean
  running: boolean
}

function extract(toolName: string, blockRaw: unknown): Extracted {
  // Guard: the framework spreads owner fields FLAT as props ({...owner}) — a
  // missing/odd block must bail out, never throw (a throw here blanks the
  // whole card via the error boundary).
  if (!blockRaw || typeof blockRaw !== 'object') {
    return { action: toolName, data: null, isError: false, running: false }
  }
  const block = blockRaw as Record<string, unknown>
  const running = !('kind' in block)
  const isError = block.isError === true

  // Action from call args (running form keeps argsRaw at top level).
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

/**
 * 中文界面文案：动作名与状态徽章均以中文为主，英文原词保留为小字注释，
 * 方便与 README/工具参数对照。映射缺失时回退英文原词。
 */
const ACTION_LABELS: Record<string, string> = {
  select: '择优评选',
  compare: '对比评审',
  track: '轨迹打分',
  progress_start: '进度追踪 · 开始',
  progress_update: '进度追踪 · 更新',
  progress_close: '进度追踪 · 结束',
  task_start: '异步任务 · 启动',
  task_status: '异步任务 · 查询',
  usage: '用量统计',
  ping: '连通探测',
}

const BADGE_LABELS: Record<string, string> = {
  ok: '正常',
  degraded: '信号不可信',
  flat: '无区分度',
  unstable: '信号不稳',
  error: '出错',
}

export function VerifierPanel(props: ToolCallOwnerProps & { ctx?: ClientContext }): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false)
  const { action, data, isError, running } = React.useMemo(
    () => extract(props.toolName, props.block),
    [props.toolName, props.block],
  )

  const escalated = data?.escalated === true
  const signal = typeof data?.signal === 'string' ? data.signal : null

  const index = typeof data?.index === 'number' ? data.index : null
  const scores = Array.isArray(data?.scores) ? (data.scores as number[]) : null
  const rewardA = typeof data?.reward_a === 'number' ? data.reward_a : null
  const rewardB = typeof data?.reward_b === 'number' ? data.reward_b : null

  type Badge = { text: string; colorToken: string }
  const badge: Badge =
    running ? { text: '评分中…', colorToken: 'var(--dsw-alias-label-tertiary)' }
    : isError ? { text: BADGE_LABELS.error!, colorToken: 'var(--dsw-alias-state-error-primary)' }
    : signal === 'degraded' ? { text: BADGE_LABELS.degraded!, colorToken: 'var(--dsw-alias-state-error-primary)' }
    : signal === 'flat' || signal === 'unstable' ? { text: BADGE_LABELS[signal] ?? signal, colorToken: 'var(--dsw-alias-state-warn-label)' }
    : escalated ? { text: `分差小 · 已评${String(data?.k_used ?? '?')}次`, colorToken: 'var(--dsw-alias-brand-primary)' }
    : data ? { text: BADGE_LABELS.ok!, colorToken: 'var(--dsw-alias-state-success-primary)' }
    : { text: ACTION_LABELS[action] ?? action, colorToken: 'var(--dsw-alias-label-tertiary)' }

  // 大白话解释：为什么会出现"分差小 · 已评N次"——单次评分有偶然性，接近时
  // 自动多评几次（每次交换 A/B 顺序消除偏向）再取平均，结果更可靠。
  const escalateNote = escalated
    ? `两个方案得分接近，单次评分可能有偶然性——已自动独立评审 ${String(data?.k_used ?? '?')} 次并取平均（每次交换先后顺序），结果更可靠。`
    : null

  const actionLabel = ACTION_LABELS[action] ?? action

  return (
    <div
      style={styles.card}
      onClick={() => setExpanded((e) => !e)}
      role="button"
      title={expanded ? '点击收起' : '点击展开原始 JSON'}
    >
      <div style={styles.row}>
        <span style={styles.title}>
          🔍 {actionLabel}
          <span style={styles.actionEn}> · {action}</span>
        </span>
        <span style={{ ...styles.badge, color: badge.colorToken, borderColor: badge.colorToken }}>
          {badge.text}
        </span>
      </div>

      {!running && index !== null && scores && (
        <div style={styles.scores}>
          {scores.map((s, i) => (
            <span key={i} style={i === index ? styles.scoreBest : styles.score}>
              方案{i + 1}: {Number.isFinite(s) ? s.toFixed(3) : '—'}{i === index ? ' 🏆 最优' : ''}
            </span>
          ))}
        </div>
      )}

      {!running && rewardA !== null && rewardB !== null && (
        <div style={styles.scores}>
          <span style={(rewardA ?? 0) >= (rewardB ?? 0) ? styles.scoreBest : styles.score}>方案A: {rewardA.toFixed(3)}</span>
          <span style={(rewardB ?? 0) > (rewardA ?? 0) ? styles.scoreBest : styles.score}>方案B: {rewardB.toFixed(3)}</span>
        </div>
      )}

      {!running && typeof data?.warning === 'string' && (
        <div style={styles.warning}>{data.warning}</div>
      )}

      {!running && escalateNote && (
        <div style={styles.note}>💡 {escalateNote}</div>
      )}

      {expanded && (
        <pre style={styles.pre}>
          {data
            ? JSON.stringify(data, null, 2)
            : isError
              ? '本次调用出错——展开轨迹查看详情。'
              : '无结构化数据（可能是 progress/task 类动作或旧会话记录）。'}
        </pre>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  // Typography: consume the shell's font tokens (--dsw-font-*) so the card
  // renders in exactly the host's typeface at the host's metric scale —
  // identical rendering to the surrounding UI in both themes.
  card: {
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: 8,
    padding: '8px 12px',
    margin: '4px 0',
    cursor: 'pointer',
    fontFamily: 'var(--dsw-font-family, inherit)',
    fontSize: 'var(--dsw-font-s-14-font-size, 14px)',
    fontWeight: 'var(--dsw-font-s-14-font-weight, 400)',
    lineHeight: 'var(--dsw-font-s-14-line-height, 1.5)',
    background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-primary)',
  },
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  title: {
    fontFamily: 'var(--dsw-font-s-strong-14-font-family, inherit)',
    fontSize: 'var(--dsw-font-s-strong-14-font-size, 14px)',
    fontWeight: 'var(--dsw-font-s-strong-14-font-weight, 600)',
    lineHeight: 'var(--dsw-font-s-strong-14-line-height, 1.5)',
  },
  actionEn: {
    fontWeight: 'var(--dsw-font-xs-13-font-weight, 400)',
    fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)',
    color: 'var(--dsw-alias-label-tertiary)',
  },
  badge: {
    fontFamily: 'var(--dsw-font-xxs-strong-12-font-family, inherit)',
    fontSize: 'var(--dsw-font-xxs-strong-12-font-size, 12px)',
    fontWeight: 'var(--dsw-font-xxs-strong-12-font-weight, 600)',
    lineHeight: 'var(--dsw-font-xxs-strong-12-line-height, 1.4)',
    padding: '1px 8px',
    borderRadius: 10,
    whiteSpace: 'nowrap',
    border: '1px solid transparent',
    background: 'color-mix(in srgb, currentColor 12%, transparent)',
  },
  scores: { display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 6 },
  score: { color: 'var(--dsw-alias-label-secondary)' },
  scoreBest: { color: 'var(--dsw-alias-state-success-primary)', fontWeight: 600 },
  warning: {
    marginTop: 6,
    padding: '4px 8px',
    borderRadius: 4,
    fontSize: 'var(--dsw-font-xs-13-font-size, 13px)',
    lineHeight: 'var(--dsw-font-xs-13-line-height, 1.5)',
    color: 'var(--dsw-alias-state-warn-label)',
    background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent)',
    border: '1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 35%, transparent)',
  },
  note: {
    marginTop: 6,
    padding: '4px 8px',
    borderRadius: 4,
    fontSize: 'var(--dsw-font-xs-13-font-size, 13px)',
    lineHeight: 'var(--dsw-font-xs-13-line-height, 1.5)',
    color: 'var(--dsw-alias-label-secondary)',
    background: 'var(--dsw-alias-bg-layer-2)',
    border: '1px solid var(--dsw-alias-border-l1)',
  },
  pre: {
    marginTop: 6,
    maxHeight: 240,
    overflow: 'auto',
    fontFamily: 'var(--dsw-font-markdown-code-block-font-family, ui-monospace, Consolas, monospace)',
    fontSize: 'var(--dsw-font-markdown-code-block-font-size, 12px)',
    fontWeight: 'var(--dsw-font-markdown-code-block-font-weight, 400)',
    lineHeight: 'var(--dsw-font-markdown-code-block-line-height, 1.55)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    color: 'var(--dsw-alias-label-secondary)',
    background: 'var(--dsw-alias-markdown-code-block)',
    borderRadius: 6,
    padding: 8,
  },
}
