// 生成 verifier 卡片预览 HTML（用真实 panelLogic + 真实样式），供无头 Chrome 截图。
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

// 独立编译的面板逻辑（真实代码）
const { derivePanelState, extractPanel } = require('E:/DeepSeek/dsh-verifier-brain/lib/client/panelLogic.js')

// 5 个代表性状态（真实 wire 数据形态）
const cases = [
  { name: '择优评选 · select（正常排名）', tool: 'verifier', block: { kind: 'tool-call', call: { argsRaw: '{"action":"select"}' }, meta: { verifier: { action: 'select', index: 0, scores: [0.850, 0.720, 0.510], signal: undefined } } } },
  { name: '对比评审 · compare（分差小升级）', tool: 'verifier', block: { kind: 'tool-call', call: { argsRaw: '{"action":"compare"}' }, meta: { verifier: { action: 'compare', reward_a: 0.55, reward_b: 0.60, escalated: true, k_used: 3, margin_before: 0.05, margin_after: 0.02, consistency: '3/3', score_mode: 'logprobs' } } } },
  { name: '对比评审 · literal-mc（采样近似分）', tool: 'verifier', block: { kind: 'tool-call', call: { argsRaw: '{"action":"compare"}' }, meta: { verifier: { action: 'compare', reward_a: 0.52, reward_b: 0.88, score_mode: 'literal-mc', k_used: 5 } } } },
  { name: '择优评选 · degraded（全 0.5 批量失败）', tool: 'verifier', block: { kind: 'tool-call', call: { argsRaw: '{"action":"select"}' }, meta: { verifier: { action: 'select', index: 0, scores: [0.5, 0.5, 0.5], signal: 'degraded', warning: '⚠️ 全部候选精确等于 0.5 —— 这是评估批量失败被 on_error="tie" 掩蔽的特征（如上游 logprobs 故障），不是真实平局。本结果不可用于排名；建议换模型重试或人工复核。' } } } },
  { name: '对比评审 · anomaly（越界裁剪警告）', tool: 'verifier', block: { kind: 'tool-call', call: { argsRaw: '{"action":"compare"}' }, meta: { verifier: { action: 'compare', reward_a: 0.3, reward_b: 0.8, anomaly: 'reward_out_of_range', warning: '⚠️ 评分返回越界值已被裁剪到 [0,1]（raw reward_a=42.7）—— 疑似评分模型异常或被注入，请人工复核。' } } } },
]

const rows = cases.map((c) => {
  const ex = extractPanel(c.tool, c.block)
  const p = derivePanelState(ex, c.tool)
  const { data } = ex
  const index = typeof data?.index === 'number' ? data.index : null
  const scores = Array.isArray(data?.scores) ? data.scores : null
  const rewardA = typeof data?.reward_a === 'number' ? data.reward_a : null
  const rewardB = typeof data?.reward_b === 'number' ? data.reward_b : null
  const letterAt = (i) => 'ABCDEFGH'[i] ?? String(i + 1)

  // —— 与 VerifierPanel.tsx 渲染体一致的标记 ——
  const badgeColor = p.stateKey === 'error' || p.stateKey === 'degraded'
    ? 'var(--dsw-alias-state-error-primary, #e5484d)'
    : p.isWarn ? 'var(--dsw-alias-state-warn-label, #f5a623)'
    : p.stateKey === 'escalated' ? 'var(--dsw-alias-brand-primary, #4f8cff)'
    : data ? 'var(--dsw-alias-state-success-primary, #30a46c)'
    : 'var(--dsw-alias-label-tertiary, #8b8b8b)'

  const scoreRow = scores
    ? `<div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:6px">${scores.map((s, i) =>
        `<span style="color:${i === index ? 'var(--dsw-alias-state-success-primary,#30a46c)' : 'var(--dsw-alias-label-secondary,#b0b0b0)'};font-weight:${i === index ? 600 : 400}">${letterAt(i)}: ${Number.isFinite(s) ? s.toFixed(3) : '—'}${i === index ? ' 🏆' : ''}</span>`).join('')}</div>`
    : rewardA !== null && rewardB !== null
      ? `<div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:6px"><span style="color:${rewardA >= rewardB ? 'var(--dsw-alias-state-success-primary,#30a46c)' : 'var(--dsw-alias-label-secondary,#b0b0b0)'};font-weight:${rewardA >= rewardB ? 600 : 400}">A: ${rewardA.toFixed(3)}</span><span style="color:${rewardB > rewardA ? 'var(--dsw-alias-state-success-primary,#30a46c)' : 'var(--dsw-alias-label-secondary,#b0b0b0)'};font-weight:${rewardB > rewardA ? 600 : 400}">B: ${rewardB.toFixed(3)}</span></div>`
      : ''

  const notes = []
  if (p.noticeText) notes.push(p.noticeText)
  if (p.mcNote) notes.push(p.mcNote)
  notes.push(p.valNote)
  const noteBlock = notes.length
    ? `<div style="margin-top:6px;padding:4px 8px;border-radius:4px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary,#b0b0b0);background:var(--dsw-alias-bg-layer-1,#1c1c1e);border:1px solid ${p.isWarn ? 'var(--dsw-alias-border-l2,#3a3a3d)' : 'var(--dsw-alias-border-l1,#2c2c2e)'}">${notes.map((n) => `<div style="margin-top:${notes.indexOf(n) ? '4px' : '0'};padding-top:${notes.indexOf(n) ? '4px' : '0'};border-top:${notes.indexOf(n) ? '1px dashed rgba(176,176,176,.3)' : 'none'};opacity:.85">${n}</div>`).join('')}</div>`
    : ''

  return `<div style="border:1px solid var(--dsw-alias-border-l2,#3a3a3d);border-radius:8px;padding:8px 12px;margin:4px 0;cursor:pointer;font-family:var(--dsw-font-family,system-ui,sans-serif);font-size:14px;line-height:1.5;background:var(--dsw-alias-bg-layer-1,#1c1c1e);color:var(--dsw-alias-label-primary,#ececec)">
  <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
    <span style="font-size:14px;font-weight:600">🔍 ${c.name}</span>
    <span style="font-size:12px;font-weight:600;padding:1px 8px;border-radius:10px;white-space:nowrap;border:1px solid ${badgeColor};color:${badgeColor};background:color-mix(in srgb, ${badgeColor} 12%, transparent)">${p.badgeText}</span>
  </div>
  ${scoreRow}
  ${noteBlock}
</div>`
}).join('\n')

const html = `<!doctype html><html><head><meta charset="utf-8"><title>verifier card preview</title></head>
<body style="background:#141416;padding:20px;font-family:system-ui,sans-serif">
<h2 style="color:#ececec;font-size:16px;margin:0 0 12px">Verifier 面板卡片预览（真实 panelLogic + 真实样式）</h2>
${rows}
<p style="color:#666;font-size:12px;margin-top:16px">生成：node scripts/render_card_preview.mjs · 数据来自 lib/client/panelLogic.js 真实推导</p>
</body></html>`

writeFileSync('E:/DeepSeek/verifier-card-preview.html', html, 'utf8')
console.log('HTML written to E:/DeepSeek/verifier-card-preview.html')
