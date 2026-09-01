/**
 * /vrank —— 不调用子代理的一键 Verifier 排名（纯函数层，2026-08-29 用户需求）。
 *
 * 与 /bestofn 团队模式的分工：团队模式派 N 个成员「生成」候选再优选；
 * /vrank 面向「候选已经在我手上」的场景——用户直接给 2-8 段文本或文件路径，
 * 当前 agent 自己调 runner（select/compare）出排名，零 spawn、零协议激活。
 * 判别纪律内建：N=2 用 compare（更便宜更有区分度）；select flat 自动 compare
 * 前二复核；仍 flat/unstable → 如实呈现"无可靠冠军"，绝不编造排名。
 *
 * 本文件零宿主依赖（仅 node 内置）——CI core job 可独立编译与测试
 * （bestofn.ts 依赖 dsh-llm/dsh-commands，无法在 core 编译）。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

export const VRANK_MAX_CANDIDATES = 8
export const VRANK_MAX_CANDIDATE_CHARS = 20_000
export const VRANK_FLAT_MARGIN = 0.03

export interface VRankPlan {
  problem: string
  texts: string[]
  labels: string[]
  error?: string
}

/** 解析 /vrank 输入：`<problem> | <候选1> | <候选2> ...`，候选可以是文件路径（读文本）。 */
export function parseVRankInput(raw: string, baseDir: string): VRankPlan {
  const parts = raw.split('|').map((s) => s.trim()).filter(Boolean)
  if (parts.length < 3) {
    return { problem: '', texts: [], labels: [], error: '至少需要 2 个候选：`/vrank <问题> | 候选1 | 候选2`（候选可以是文件路径，自动读取内容）' }
  }
  const problem = parts[0]
  const texts: string[] = []
  const labels: string[] = []
  for (const c of parts.slice(1)) {
    if (texts.length >= VRANK_MAX_CANDIDATES) break
    const abs = isAbsolute(c) ? c : resolve(baseDir, c)
    if (existsSync(abs) && statSync(abs).isFile()) {
      const text = readFileSync(abs, 'utf8')
      texts.push(text.length > VRANK_MAX_CANDIDATE_CHARS ? text.slice(0, VRANK_MAX_CANDIDATE_CHARS) + '\n…[truncated]' : text)
      labels.push(`文件:${c}`)
    } else {
      texts.push(c)
      labels.push(`候选${labels.length + 1}`)
    }
  }
  if (texts.length < 2) {
    return { problem, texts, labels, error: '有效候选不足 2 个（文件路径必须是已存在的文件）' }
  }
  return { problem, texts, labels }
}

/** 组装 /vrank 结果文本（纯函数，含判别纪律：flat 复核 / unstable 如实 / 不编造排名）。 */
export function buildVRankOutput(
  mode: 'select' | 'compare',
  labels: string[],
  result: Record<string, unknown>,
  confirm?: Record<string, unknown>,
): string {
  const lines: string[] = []
  const scoreOf = (v: unknown): string => (typeof v === 'number' ? v.toFixed(4) : String(v))
  const meta: string[] = []
  if (result.escalated === true) meta.push(`escalated K=${String(result.k_used)}`)
  if (result.cached === true) meta.push('cached')
  const metaLine = meta.length ? `（${meta.join('，')}）` : ''

  if (mode === 'compare') {
    const ra = Number(result.reward_a)
    const rb = Number(result.reward_b)
    lines.push(`🎯 /vrank（compare${metaLine}）`)
    lines.push(`A·${labels[0]} = ${scoreOf(result.reward_a)} [${String(result.tag_a ?? '')}]`)
    lines.push(`B·${labels[1]} = ${scoreOf(result.reward_b)} [${String(result.tag_b ?? '')}]`)
    if (Number.isFinite(ra) && Number.isFinite(rb)) {
      const margin = Math.abs(ra - rb)
      if (margin < VRANK_FLAT_MARGIN) {
        lines.push(`⚖️ margin ${margin.toFixed(4)} < 0.03 噪声带——**无可靠胜者，两个候选视为并列**（请人工复核或补充分辨维度）。`)
      } else {
        lines.push(`🏆 胜者：${ra > rb ? labels[0] : labels[1]}（margin ${margin.toFixed(4)}）`)
      }
    }
    return lines.join('\n')
  }

  // select 模式
  const ranking = Array.isArray(result.ranking) ? (result.ranking as number[]) : []
  const scores = Array.isArray(result.scores) ? (result.scores as unknown[]) : []
  const tags = Array.isArray(result.tags) ? (result.tags as string[]) : []
  const signal = typeof result.signal === 'string' ? result.signal : ''
  lines.push(`🎯 /vrank（select${metaLine}）`)
  const rankedLines = ranking.map((idx, pos) => {
    const label = labels[idx] ?? `候选${idx + 1}`
    const tag = tags[idx] ? ` [${tags[idx]}]` : ''
    return `${pos + 1}. ${label} (${scoreOf(scores[idx])})${tag}`
  })
  lines.push(...rankedLines)
  if (signal === 'flat') {
    lines.push('⚠️ select 信号 flat（无排名信号）——已自动用 compare 复核前二：')
    if (confirm) {
      const ra = Number(confirm.reward_a)
      const rb = Number(confirm.reward_b)
      lines.push(`  A·${labels[ranking[0]] ?? '?'} = ${scoreOf(confirm.reward_a)} vs B·${labels[ranking[1]] ?? '?'} = ${scoreOf(confirm.reward_b)}`)
      if (Number.isFinite(ra) && Number.isFinite(rb) && Math.abs(ra - rb) < VRANK_FLAT_MARGIN) {
        lines.push('  ⚖️ 复核 compare 仍在噪声带内——**无可靠冠军：候选视为并列，请人工复核或补充分辨维度**。')
      } else if (Number.isFinite(ra) && Number.isFinite(rb)) {
        lines.push(`  🏆 复核胜者：${ra > rb ? labels[ranking[0]] : labels[ranking[1]]}`)
      }
    }
  } else if (signal === 'unstable') {
    lines.push('⚠️ select 信号 unstable（升级评估后冠军翻转）——以上原始分数仅供参考，**建议人工复核**，不要采信名义排名。')
  }
  return lines.join('\n')
}

/** 组装 runner 调用参数（handler 按候选数选 select/compare 后调用）。 */
export function buildVRankRunnerParams(
  mode: 'select' | 'compare',
  problem: string,
  texts: string[],
  ranking?: number[],
): Record<string, unknown> {
  if (mode === 'compare') {
    return { problem, candidate_a: texts[0], candidate_b: texts[1], criteria: 'deep_review' }
  }
  return { problem, candidates: texts, criteria: 'deep_review', n_evaluations: 1 }
}

/** select flat 后的复核参数（前二候选 compare）。ranking 不足 2 项时返回 null。 */
export function buildVRankConfirmParams(
  problem: string,
  texts: string[],
  result: Record<string, unknown>,
): Record<string, unknown> | null {
  const ranking = Array.isArray(result.ranking) ? (result.ranking as number[]) : []
  if (result.signal !== 'flat' || ranking.length < 2) return null
  const a = texts[ranking[0]]
  const b = texts[ranking[1]]
  if (a === undefined || b === undefined) return null
  return { problem, candidate_a: a, candidate_b: b, criteria: 'deep_review' }
}
