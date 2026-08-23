// GUI 逻辑回归（锐评「E2E/GUI 测试层未建」的补建）：
// 面板纯逻辑（extractPanel + derivePanelState）不依赖 React / 宿主 client 包，
// 可在 CI 无浏览器运行。覆盖状态矩阵：ok/degraded/flat/unstable/escalated/
// anomaly/literal-mc/VAL/plain。
// 注意：panelLogic.ts 被 tsdown 打进浏览器 bundle，node 无法直接 require——
// CI/本地先把它独立编译到 lib/client/panelLogic.js（harness-free）再测试。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractPanel, derivePanelState } from '../lib/client/panelLogic.js'

const extract = extractPanel
const derive = derivePanelState

/** 构造一个标准 wire block（meta 通道，与宿主 presentationMeta 契约一致）。 */
const block = (data, extra = {}) => ({
  kind: 'tool-call',
  call: { argsRaw: JSON.stringify({ action: 'compare' }) },
  meta: { verifier: data },
  ...extra,
})

const deriveOf = (data) => derive(extract('verifier', block(data)), 'compare')

test('ok：正常分数 → 徽章「正常」+ VAL L0', () => {
  const p = deriveOf({ action: 'compare', reward_a: 0.7, reward_b: 0.3, score_mode: 'logprobs' })
  assert.equal(p.stateKey, 'ok')
  assert.equal(p.badgeText, '正常')
  assert.equal(p.valLevel, 'L0')
  assert.equal(p.mcNote, null, 'logprobs 路径无采样提示')
})

test('literal-mc：采样近似分 → 徽章 ok + mcNote + VAL L0', () => {
  const p = deriveOf({ action: 'compare', reward_a: 0.5, reward_b: 0.9, score_mode: 'literal-mc', k_used: 5 })
  assert.equal(p.stateKey, 'ok')
  assert.match(p.mcNote ?? '', /采样近似分/, '必须标注采样近似')
  assert.match(p.mcNote ?? '', /5 次/, '必须标注 K 值')
})

test('degraded：全 0.5 → 「信号不可信」+ warn + VAL L1', () => {
  const p = deriveOf({ action: 'compare', reward_a: 0.5, reward_b: 0.5, signal: 'degraded', warning: '⚠️ 全部候选精确等于 0.5' })
  assert.equal(p.stateKey, 'degraded')
  assert.equal(p.badgeText, '信号不可信')
  assert.ok(p.isWarn)
  assert.equal(p.valLevel, 'L1', '规则护栏介入')
})

test('flat：无区分度 → 「无区分度」+ 建议 compare 复核', () => {
  const p = deriveOf({ action: 'select', index: 0, scores: [0.5, 0.5], signal: 'flat' })
  assert.equal(p.stateKey, 'flat')
  assert.equal(p.badgeText, '无区分度')
  assert.match(p.noticeText ?? '', /对比评审|compare/, '应建议复核')
})

test('unstable：信号不稳 → warn 徽章', () => {
  const p = deriveOf({ action: 'select', signal: 'unstable', index: 0, scores: [0.6, 0.4], initial: {}, escalated_result: {} })
  assert.equal(p.stateKey, 'unstable')
  assert.equal(p.badgeText, '信号不稳')
  assert.ok(p.isWarn)
})

test('escalated：分差小升级 → 徽章含已评次数', () => {
  const p = deriveOf({ action: 'compare', reward_a: 0.55, reward_b: 0.6, escalated: true, k_used: 3 })
  assert.equal(p.stateKey, 'escalated')
  assert.match(p.badgeText, /已评3次/)
})

test('anomaly：越界裁剪 → ok 态也必须显示警告 + VAL L1', () => {
  const p = deriveOf({ action: 'compare', reward_a: 0.3, reward_b: 0.8, anomaly: 'reward_out_of_range', warning: '⚠️ 评分返回越界值已被裁剪到 [0,1]' })
  assert.equal(p.stateKey, 'ok', '状态仍是正常')
  assert.ok(p.noticeText, '但必须有警告')
  assert.match(p.noticeText ?? '', /裁剪/, '警告指向裁剪')
  assert.equal(p.valLevel, 'L1', '规则介入')
})

test('plain：无数据 → 回退动作名徽章', () => {
  const p = derive(extract('verifier', null), 'select')
  assert.equal(p.stateKey, 'plain')
  assert.equal(p.badgeText, '择优评选')
})

test('extract：meta 通道优先于文本，异常 block 不抛', () => {
  assert.deepEqual(extract('verifier', null), { action: 'verifier', data: null, isError: false, running: false })
  const bad = extract('verifier', { kind: 'tool-call', content: ['not-json'] })
  assert.equal(bad.data, null)
  // 文本 JSON 回退
  const viaText = extract('verifier', { kind: 'tool-call', call: { argsRaw: '{"action":"compare"}' }, content: [{ type: 'text', text: '{"reward_a":0.9,"reward_b":0.1}' }] })
  assert.equal(viaText.data?.reward_a, 0.9)
})
