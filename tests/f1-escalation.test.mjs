// F1 + U-B1 regression: escalation path must clamp out-of-range scores,
// propagate anomaly/warning into composites, and route escalation reps to
// esc.escalationModel (tiered scoring) on the runner shared by sync + async.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEscalationRunner } from '../lib/tools.js'

/** Fake bridge: scripted responses + request log. */
function fakeBridge(script) {
  const calls = []
  return {
    calls,
    async request(method, params) {
      calls.push({ method, model: params.model, params })
      const next = script.shift()
      if (!next) throw new Error('unexpected extra bridge call: ' + method)
      return typeof next === 'function' ? next(calls.length, params) : next
    },
  }
}

function fakeStore() {
  return { appendHistory() {}, readHistory() { return [] } }
}

const baseDeps = (bridge, esc) => ({
  getBridge: async () => bridge,
  store: fakeStore(),
  esc: { autoEscalate: true, escalateThreshold: 0.15, maxEscalateK: 3, ...esc },
  budgetMs: () => 1_800_000,
})

test('F1 compare: out-of-range escalation reps are clamped and anomaly reaches composite', async () => {
  const bridge = fakeBridge([
    { reward_a: 0.55, reward_b: 0.60 }, // k1: margin 0.05 → escalate
    { reward_a: 1.7, reward_b: -0.4 },  // rep 2 (swapped): out of range
    { reward_a: 2.5, reward_b: 0.61 },  // rep 3: out of range
  ])
  const run = createEscalationRunner(baseDeps(bridge, { escalationModel: 'strong-model' }))
  const out = await run('compare', {
    problem: 'p', candidate_a: 'a', candidate_b: 'b',
  })
  // All reported rewards inside [0,1]
  for (const rep of out.reps ?? []) {
    assert.ok(rep.reward_a >= 0 && rep.reward_a <= 1, 'rep reward_a clamped: ' + rep.reward_a)
    assert.ok(rep.reward_b >= 0 && rep.reward_b <= 1, 'rep reward_b clamped: ' + rep.reward_b)
  }
  assert.ok(out.reward_a >= 0 && out.reward_a <= 1, 'composite reward_a clamped')
  assert.ok(out.reward_b >= 0 && out.reward_b <= 1, 'composite reward_b clamped')
  // Anomaly must surface, never vanish after escalation
  assert.equal(out.anomaly, 'reward_out_of_range')
  assert.ok(typeof out.warning === 'string' && out.warning.includes('裁剪'), 'warning propagated')
})

test('F1 select: out-of-range escalation scores are clamped and anomaly reaches composite', async () => {
  const bridge = fakeBridge([
    { index: 0, scores: [0.55, 0.50] }, // k1: margin 0.05 → escalate (K=3)
    { index: 0, scores: [0.58, 1.9] },  // escalation: out of range
  ])
  const run = createEscalationRunner(baseDeps(bridge, {}))
  const out = await run('select', { problem: 'p', candidates: ['a', 'b'] })
  for (const s of out.scores ?? []) {
    assert.ok(s >= 0 && s <= 1, 'composite score clamped: ' + s)
  }
  assert.equal(out.anomaly, 'score_out_of_range')
  assert.ok(typeof out.warning === 'string' && out.warning.includes('裁剪'), 'warning propagated')
})

test('U-B1: escalation reps use esc.escalationModel; first pass keeps caller model', async () => {
  const bridge = fakeBridge([
    { reward_a: 0.55, reward_b: 0.60 }, // k1
    { reward_a: 0.56, reward_b: 0.61 },
    { reward_a: 0.57, reward_b: 0.62 },
  ])
  const run = createEscalationRunner(baseDeps(bridge, { escalationModel: 'strong-model' }))
  await run('compare', { problem: 'p', candidate_a: 'a', candidate_b: 'b', model: 'cheap-model' })
  assert.equal(bridge.calls[0].model, 'cheap-model', 'k1 keeps caller model')
  assert.equal(bridge.calls[1].model, 'strong-model', 'rep 2 uses escalationModel')
  assert.equal(bridge.calls[2].model, 'strong-model', 'rep 3 uses escalationModel')
})

test('U-B1 fallback: without escalationModel, reps keep caller model', async () => {
  const bridge = fakeBridge([
    { reward_a: 0.55, reward_b: 0.60 },
    { reward_a: 0.56, reward_b: 0.61 },
    { reward_a: 0.57, reward_b: 0.62 },
  ])
  const run = createEscalationRunner(baseDeps(bridge, {}))
  await run('compare', { problem: 'p', candidate_a: 'a', candidate_b: 'b', model: 'cheap-model' })
  assert.ok(bridge.calls.slice(1).every((c) => c.model === 'cheap-model'), 'reps fall back to caller model')
})
