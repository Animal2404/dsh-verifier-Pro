// P1-① 声明-证据对照回归测试（bestofn 机械核对逻辑）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { crossCheckClaimEvidence } from '../lib/bestofn.js'

const block = (summary, smoke) => [
  '── candidate: x-abc123 ──',
  '## 功能摘要（候选自述）',
  summary,
  '## 运行时观察（冒烟测试，非候选自述）',
  smoke,
  '## 视觉观察（截图描述，非候选自述）',
  '(无视觉描述)',
].join('\n')

test('P1-①: 一致的自述与证据 → null', () => {
  const text = block('实现了求和函数，输出正确', '冒烟: ✅ 通过 [node]\n退出码: 0\nstdout(尾): sumTo(100) = 5050')
  assert.equal(crossCheckClaimEvidence(text), null)
})

test('P1-①: 负面自述 + 通过证据 → 矛盾', () => {
  const text = block('这个实现有问题，功能不完整', '冒烟: ✅ 通过 [node]\n退出码: 0')
  const r = crossCheckClaimEvidence(text)
  assert.ok(r && r.includes('负面断言'), r)
})

test('P1-①: 自述声称全对 + 证据有错误 → 矛盾', () => {
  const text = block('全部通过，无错误，完美实现', '冒烟: ❌ 失败 [node]\n错误: ReferenceError: x is not defined')
  const r = crossCheckClaimEvidence(text)
  assert.ok(r && r.includes('掩盖'), r)
})

test('P1-①: 无冒烟证据段 → 缺段无法核对 → null', () => {
  const text = block('功能正常', '(无冒烟证据)')
  // 冒烟段存在但无证据 → 命中第 3 类（无据背书）
  const r = crossCheckClaimEvidence(text)
  assert.ok(r && r.includes('无据背书'), r)
})

test('P1-①: 缺段（无自述）→ null', () => {
  const text = '── candidate: y ──\n## 运行时观察（冒烟测试，非候选自述）\n冒烟: ✅ 通过'
  assert.equal(crossCheckClaimEvidence(text), null)
})
