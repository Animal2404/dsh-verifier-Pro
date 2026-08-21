#!/usr/bin/env node
/** 降本项验证: ① exact-flat 护栏 ② cache 落盘 */
import { PythonBridge } from '../lib/bridge.js'
import { VerifierStore } from '../lib/persist.js'
import { createEscalationRunner } from '../lib/tools.js'
import { mkdtempSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const stateDir = mkdtempSync(join(tmpdir(), 'cost-test-'))
const store = new VerifierStore(stateDir)

// ---- 测试1: exact-flat 护栏（mock 桥返回全 0.5）----
let callCount = 0
const mockBridge = {
  request: async (method, params) => {
    callCount++
    if (method === 'select') return { index: 0, ranking: [0, 1], scores: [0.5, 0.5] }
    return { reward_a: 0.5, reward_b: 0.5 }
  },
}
const deps = {
  getBridge: async () => mockBridge,
  store,
  esc: { autoEscalate: true, escalateThreshold: 0.15, maxEscalateK: 3 },
  budgetMs: () => 60000,
}
const runner = createEscalationRunner(deps)

console.log('=== 测试1a: select 全 0.5 → degraded ===')
callCount = 0
const r1 = await runner('select', { problem: 'p', candidates: ['a', 'b'], criteria: { C: 'c' } })
console.log('signal:', r1.signal, '| escalated:', r1.escaped ?? r1.escalated, '| API调用数:', callCount)
if (r1.signal !== 'degraded') throw new Error('FAIL: 应标 degraded')
if (callCount !== 1) throw new Error(`FAIL: 护栏应阻止升级复评，实际 ${callCount} 次调用`)
console.log('✅ degraded 标记 + 未烧升级钱')

console.log('')
console.log('=== 测试1b: compare 双 0.5 → degraded ===')
callCount = 0
const r2 = await runner('compare', { problem: 'p', candidate_a: 'a', candidate_b: 'b' })
console.log('signal:', r2.signal, '| API调用数:', callCount)
if (r2.signal !== 'degraded') throw new Error('FAIL: 应标 degraded')
if (callCount !== 1) throw new Error('FAIL: 应阻止升级')
console.log('✅ compare 路径护栏生效')

// ---- 测试2: 真实桥的 cache 落盘（需要 env key，否则跳过）----
if (!process.env.OPENCODE_GO_API_KEY) {
  console.log('\n(跳过测试2: 无 OPENCODE_GO_API_KEY)')
} else {
  console.log('\n=== 测试2: 真实 select 后 score-cache.json 落盘 ===')
  const bridge = new PythonBridge(
    process.cwd() + '/bridge/verifier_brain_bridge.py',
    process.cwd() + '/.venv/Scripts/python.exe',
    300000,
    { ...process.env, DEEPSEEK_EFFORT: 'off', OPENAI_BASE_URL: 'https://opencode.ai/zen/go/v1', OPENAI_API_KEY: process.env.OPENCODE_GO_API_KEY },
  )
  const realDeps = { getBridge: async () => bridge, store, esc: { autoEscalate: true, escalateThreshold: 0.15, maxEscalateK: 3 }, budgetMs: () => 120000 }
  const runner2 = createEscalationRunner(realDeps)
  await runner2('select', { problem: 'cache wiring test', candidates: ['4', '5'], criteria: { Correctness: 'correct?' }, model: 'deepseek-v4-pro' })
  const cacheFile = join(store.stateDir, 'score-cache.json')
  if (existsSync(cacheFile)) {
    const content = readFileSync(cacheFile, 'utf8')
    console.log('✅ score-cache.json 已落盘,', content.length, 'bytes')
    console.log('片段:', content.slice(0, 150))
  } else {
    throw new Error('FAIL: score-cache.json 未生成')
  }
  bridge.close()
}

console.log('\n✅ 全部通过')
