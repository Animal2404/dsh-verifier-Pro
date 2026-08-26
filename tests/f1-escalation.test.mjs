// F1 + U-B1 regression: escalation path must clamp out-of-range scores,
// propagate anomaly/warning into composites, and route escalation reps to
// esc.escalationModel (tiered scoring) on the runner shared by sync + async.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEscalationRunner, clampSingleScore } from '../lib/tools.js'

/** Fake bridge: scripted responses + request log. probe_model always passes
 * (the runner's D-1x per-model preflight must not consume scripted responses). */
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

test('F13: first escalation rep failure degrades to k1 instead of discarding it', async () => {
  const bridge = fakeBridge([
    { reward_a: 0.55, reward_b: 0.60 }, // k1: margin 0.05 → escalate
    () => { throw new Error('bridge exploded') }, // rep 2 fails
  ])
  const run = createEscalationRunner(baseDeps(bridge, {}))
  // distinct problem text — the module-level resultCache is shared across
  // tests in one process, and an identical key would return the cached
  // escalated composite from the first test instead of exercising the failure.
  const out = await run('compare', { problem: 'p-f13-degrade', candidate_a: 'a', candidate_b: 'b' })
  assert.equal(out.escalated, false)
  assert.equal(Number(out.reward_a), 0.55, 'k1 reward preserved')
  assert.equal(Number(out.reward_b), 0.60, 'k1 reward preserved')
  assert.ok(typeof out.note === 'string' && out.note.includes('保留首评'), 'degrade note present')
})

test('R3-2: select unstable branch returns CLAMPED escalated scores (no leak)', async () => {
  const bridge = fakeBridge([
    { index: 0, scores: [0.55, 0.50] }, // k1: margin 0.05 → escalate
    { index: 1, scores: [0.58, 42.7] }, // escalation: different winner + out of range
  ])
  const run = createEscalationRunner(baseDeps(bridge, {}))
  const out = await run('select', { problem: 'p-r3-2', candidates: ['a', 'b'] })
  assert.equal(out.signal, 'unstable', 'different winners ⇒ unstable')
  const escScores = out.escalated_result?.scores
  assert.ok(Array.isArray(escScores), 'escalated_result.scores present')
  for (const s of escScores) {
    assert.ok(typeof s === 'number' && s >= 0 && s <= 1, 'unstable escalated scores must be clamped: ' + String(s))
  }
})

test('P1-2: compare flat branch preserves the k1 clip/anomaly warning (no clobber)', async () => {
  const bridge = fakeBridge([
    { reward_a: 1.9, reward_b: 1.9 }, // k1: out of range → clamped 1.0/1.0 → margin 0 → flat
  ])
  const run = createEscalationRunner(baseDeps(bridge, {}))
  const out = await run('compare', { problem: 'p-p12-flat', candidate_a: 'a', candidate_b: 'b' })
  assert.equal(out.signal, 'flat')
  assert.ok(typeof out.warning === 'string' && out.warning.includes('裁剪'),
    'clip/anomaly warning must survive the flat branch: ' + String(out.warning))
  assert.ok(out.warning.includes('且：'), 'merged with the flat guidance instead of replaced')
})

test('P1-3: select escalation honors maxEscalateK (was hardcoded 3)', async () => {
  const bridge = fakeBridge([
    { index: 0, scores: [0.55, 0.50] }, // k1: margin 0.05 → escalate
    { index: 0, scores: [0.58, 0.52] }, // escalation tournament
  ])
  const run = createEscalationRunner(baseDeps(bridge, { maxEscalateK: 5 }))
  const out = await run('select', { problem: 'p-p13-k5', candidates: ['a', 'b'] })
  const escCall = bridge.calls.find((c) => c.method === 'select' && c.params.n_evaluations === 5)
  assert.ok(escCall, 'escalation call with n_evaluations=5 present')
  assert.equal(out.escalated, true)
  assert.equal(out.k_used, 5, 'k_used reports the configured K')
})

test('P2-1: select escalation strips the caller seed (independent re-evaluation)', async () => {
  const bridge = fakeBridge([
    { index: 0, scores: [0.55, 0.50] }, // k1
    { index: 0, scores: [0.58, 0.52] }, // escalation
  ])
  const run = createEscalationRunner(baseDeps(bridge, {}))
  const out = await run('select', { problem: 'p-p21-seed', candidates: ['a', 'b'], seed: 42 })
  assert.equal(out.escalated, true)
  const k1Call = bridge.calls.find((c) => c.method === 'select' && c.params.n_evaluations === 1)
  assert.equal(k1Call.params.seed, 42, 'k1 keeps the caller seed')
  const escCall = bridge.calls.find((c) => c.method === 'select' && c.params.n_evaluations === 3)
  assert.ok(escCall, 'escalation call present')
  assert.equal(escCall.params.seed, undefined, 'escalation must NOT reuse the caller seed')
})

test('P2-2: clampSingleScore clips out-of-range progress scores and flags anomaly', () => {
  const r = { score: 3.7 }
  clampSingleScore(r)
  assert.equal(r.score, 1, 'clamped to [0,1]')
  assert.equal(r.anomaly, 'score_out_of_range')
  assert.ok(String(r.warning).includes('裁剪'), 'clip warning present')
  const ok = { score: 0.42 }
  clampSingleScore(ok)
  assert.equal(ok.score, 0.42)
  assert.equal(ok.anomaly, undefined)
})

test('deep_review 预设：criteria 名称在进桥前展开为描述对象（全路径收口）', async () => {
  const bridge = fakeBridge([{ reward_a: 0.7, reward_b: 0.3 }])
  const run = createEscalationRunner(baseDeps(bridge))
  await run('compare', { problem: 'p-preset-dr', candidate_a: 'a', candidate_b: 'b', criteria: 'deep_review' })
  const sent = bridge.calls.find((c) => c.method === 'compare').params.criteria
  assert.ok(sent && typeof sent === 'object' && !Array.isArray(sent), '必须展开为描述对象: ' + JSON.stringify(sent))
  assert.ok('RootCause' in sent && 'Evidence' in sent && 'Actionability' in sent, '包含深度维度键')
})

test('未知预设名原样透传（官方预设 terminal_bench 不受影响）', async () => {
  const bridge = fakeBridge([{ reward_a: 0.7, reward_b: 0.3 }])
  const run = createEscalationRunner(baseDeps(bridge))
  await run('compare', { problem: 'p-preset-unk', candidate_a: 'a', candidate_b: 'b', criteria: 'terminal_bench' })
  const sent = bridge.calls.find((c) => c.method === 'compare').params.criteria
  assert.equal(sent, 'terminal_bench', '未知名不得被改动')
})

test('candTag：同一候选跨调用标签稳定，不同候选标签不同（用户反馈：字母换指代）', async () => {
  const bridge = fakeBridge([
    { reward_a: 0.7, reward_b: 0.3 },
    { reward_a: 0.7, reward_b: 0.3 },
  ])
  const run = createEscalationRunner(baseDeps(bridge))
  const r1 = await run('compare', { problem: 'p-tag-1', candidate_a: 'alpha-content', candidate_b: 'beta-content' })
  const r2 = await run('compare', { problem: 'p-tag-2', candidate_a: 'alpha-content', candidate_b: 'beta-content' })
  assert.ok(r1.tag_a && String(r1.tag_a).length === 8, '标签为 8 位十六进制')
  assert.equal(r2.tag_a, r1.tag_a, '同一候选跨调用标签必须稳定')
  assert.notEqual(r1.tag_a, r1.tag_b, '不同候选标签必不同')
})
