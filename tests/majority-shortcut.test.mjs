// 深挖后补充的机制测试：
// ① uson1x majority-voting 短路（engine.js:375-384）——字节多数候选直接判胜
// ② lanbaolu /evaluate-session 移植（PROGRESS/ROADMAP）——轨迹评分结构化导出
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEscalationRunner } from '../lib/tools.js'

function fakeBridge(script) {
  const calls = []
  return {
    calls,
    async request(method, params) {
      if (method === 'probe_model') return { ok: true, logprobs_supported: true }
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

test('uson1x majority shortcut: 多数候选字节相同 → 直接判胜，不调桥', async () => {
  const bridge = fakeBridge([]) // 无脚本 —— 若被调用会抛错
  const run = createEscalationRunner(baseDeps(bridge))
  const out = await run('select', {
    problem: 'p-maj', candidates: ['same', 'same', 'same', 'different'],
  })
  assert.equal(out.index, 0, '多数候选（same×3）应判胜')
  assert.equal(out.scores[0], 1, '多数候选得 1 分')
  assert.equal(bridge.calls.length, 0, '不应调用桥（短路）')
  assert.equal(out.note ?? out.warning?.includes('多数'), undefined || true, '有说明')
  assert.match(out.warning ?? '', /多数/, '应带多数短路说明')
})

test('无多数时正常走桥', async () => {
  const bridge = fakeBridge([{ index: 1, scores: [0.3, 0.8, 0.5] }])
  const run = createEscalationRunner(baseDeps(bridge))
  const out = await run('select', { problem: 'p-nomaj', candidates: ['a', 'b', 'c'] })
  assert.equal(bridge.calls.length, 1, '无多数应正常调用桥')
  assert.equal(out.index, 1)
})
