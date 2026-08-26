// P2-③ 异常响应形态检测回归（扩展 exact-flat 护栏）：NaN / 全 0.5 /
// 全挤极端等退化形态必须被识别并透传 anomaly 警告；正常形态不误报。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEscalationRunner } from '../lib/tools.js'

function fakeBridge(script) {
  const calls = []
  return {
    calls,
    async request(method, params) {
      if (method === 'probe_model') return { ok: true, logprobs_supported: true }
      // G2: gatedRequest 会做前后 usage 读数（本地查询，不消费脚本）——与真实桥一致。
      if (method === 'usage') return { usage: { input_tokens: 0, output_tokens: 0 } }
      calls.push({ method, model: params.model, params })
      const next = script.shift()
      if (!next) throw new Error('unexpected call: ' + method)
      return typeof next === 'function' ? next(calls.length, params) : next
    },
  }
}
const fakeStore = () => ({ appendHistory() {}, readHistory() { return [] } })
const baseDeps = (bridge, esc = {}) => ({
  getBridge: async () => bridge,
  store: fakeStore(),
  esc: { autoEscalate: true, escalateThreshold: 0.15, maxEscalateK: 3, ...esc },
  budgetMs: () => 1_800_000,
})

test('P2-③ compare: NaN 分数 → anomaly 必须触发', async () => {
  const bridge = fakeBridge([{ reward_a: null, reward_b: 0.4 }]) // null → clamp01 → NaN
  const run = createEscalationRunner(baseDeps(bridge))
  const out = await run('compare', { problem: 'p-shape-1', candidate_a: 'a', candidate_b: 'b' })
  // NaN 会被 clamp 分支先标记（reward_out_of_range）或形态检测标记
  // （anomalous_shape）——两者都是有效的异常检测，必须至少命中一个。
  assert.ok(
    out.anomaly === 'reward_out_of_range' || out.anomaly === 'anomalous_shape',
    'NaN 分数必须触发异常检测，实际: ' + String(out.anomaly),
  )
})

test('P2-③ select: 全 0.5 → degraded 且 anomaly 标记', async () => {
  const bridge = fakeBridge([{ index: 0, scores: [0.5, 0.5, 0.5] }])
  const run = createEscalationRunner(baseDeps(bridge))
  const out = await run('select', { problem: 'p-shape-2', candidates: ['a', 'b', 'c'] })
  assert.equal(out.signal, 'degraded', '全 0.5 必须 degraded')
  assert.equal(out.anomaly, 'anomalous_shape')
})

test('P2-③ select: 全挤极端且无区分度（极差 <0.02）→ anomaly 警告', async () => {
  const bridge = fakeBridge([{ index: 0, scores: [0.99, 0.995, 0.985] }])
  const run = createEscalationRunner(baseDeps(bridge))
  const out = await run('select', { problem: 'p-shape-3', candidates: ['a', 'b', 'c'] })
  assert.equal(out.anomaly, 'anomalous_shape', '全挤极端必须打 anomaly')
  assert.match(out.warning, /degenerate_extreme/, '警告需指明极端形态')
})

test('P2-③ select: 双优但有区分度（全 ≥0.95 且极差 ≥0.02）→ 不误报（评审 #7）', async () => {
  const bridge = fakeBridge([{ index: 0, scores: [0.97, 0.99, 0.96] }])
  const run = createEscalationRunner(baseDeps(bridge))
  const out = await run('select', { problem: 'p-shape-3b', candidates: ['a', 'b', 'c'] })
  assert.notEqual(out.anomaly, 'anomalous_shape', '真实共识双优不应被打上退化警告')
})

test('P2-③ compare: 正常分散分数 → 不误报', async () => {
  const bridge = fakeBridge([{ reward_a: 0.7, reward_b: 0.3 }])
  const run = createEscalationRunner(baseDeps(bridge))
  const out = await run('compare', { problem: 'p-shape-4', candidate_a: 'a', candidate_b: 'b' })
  assert.ok(out.anomaly === undefined, '正常形态不得误报 anomaly: ' + String(out.anomaly))
  assert.ok(out.signal === undefined || out.signal !== 'degraded', '正常形态不得 degraded')
})
