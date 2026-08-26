// R2 审计 15 条修复回归测试（bestofn parseArgs / 声明-证据对照 / smoke 记录语义）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs, crossCheckClaimEvidence } from '../lib/bestofn.js'

// ---------- parseArgs ----------

test('N4: -n 0.5 不再取整为 0（保持默认 3；0.5 不被吞，留在 goal）', () => {
  const r = parseArgs('写个游戏 -n 0.5')
  assert.equal(r.n, 3)
  assert.equal(r.positionals.join(' '), '写个游戏 0.5')
})

test('N4: -n 2 正常生效', () => {
  const r = parseArgs('写个游戏 -n 2')
  assert.equal(r.n, 2)
})

test('N4: -n abc 忽略无效值（保持默认；abc 不被吞，留在 goal）', () => {
  const r = parseArgs('写个游戏 -n abc')
  assert.equal(r.n, 3)
  assert.equal(r.positionals.join(' '), '写个游戏 abc')
})

test('F-I: --summary 值前导空格被 trim', () => {
  const r = parseArgs('a.html b.html --summary foo = bar')
  assert.equal(r.summaries.get('foo'), 'bar')
})

test('F-F/N6: --summary 在文件前不再吞掉后续候选文件', () => {
  const r = parseArgs('--summary a=x y b.html')
  assert.equal(r.summaries.get('a'), 'x y')
  assert.deepEqual(r.positionals, ['b.html'])
})

test('N9: 重复 --summary key 后者覆盖（可断言值）', () => {
  const r = parseArgs('--summary a=1 --summary a=2')
  assert.equal(r.summaries.get('a'), '2')
})

test('N3: 尾部数字 9（>8）保留为 positional（P3-1 语义不变）', () => {
  const r = parseArgs('a.html b.html 9')
  assert.deepEqual(r.positionals, ['a.html', 'b.html', '9'])
})

test('F-B: 显式 --local 时尾部数字同样保留（由 handler 拒绝而非幻影候选）', () => {
  const r = parseArgs('--local a.html b.html 9')
  assert.equal(r.local, true)
  assert.deepEqual(r.positionals, ['a.html', 'b.html', '9'])
})

test('N6: summary 值含合法词不误断（"修复 bug 42" 全部入值）', () => {
  const r = parseArgs('--summary a=修复 bug 42 x.html')
  assert.equal(r.summaries.get('a'), '修复 bug 42')
  assert.deepEqual(r.positionals, ['x.html'])
})

test('N6: summary 值含小数（0.85）不误断', () => {
  const r = parseArgs('--summary a=得分 0.85 很稳定 x.html')
  assert.equal(r.summaries.get('a'), '得分 0.85 很稳定')
  assert.deepEqual(r.positionals, ['x.html'])
})

// ---------- vselftest R3 修复回归 ----------

test('B12: --summary 首个 token 即文件形（a=README.md）不被拒', () => {
  const r = parseArgs('--summary a=README.md x.html')
  assert.equal(r.summaries.get('a'), 'README.md')
  assert.deepEqual(r.positionals, ['x.html'])
})

test('B10/m10: 其余全像文件时尾数不吞为 N（a.html b.html 5）', () => {
  const r = parseArgs('a.html b.html 5')
  assert.equal(r.n, 3) // 默认，未被吞
  assert.deepEqual(r.positionals, ['a.html', 'b.html', '5'])
})

test('B1: 团队目标尾数仍吞为 N 且标记 nSource=trailing', () => {
  const r = parseArgs('写个游戏 3')
  assert.equal(r.n, 3)
  assert.equal(r.nSource, 'trailing')
  assert.deepEqual(r.positionals, ['写个游戏'])
})

test('B1: -n 显式标记 nSource=explicit', () => {
  const r = parseArgs('写个游戏 -n 5')
  assert.equal(r.n, 5)
  assert.equal(r.nSource, 'explicit')
})

test('B11: -n 0x10（十六进制）不再被接受', () => {
  const r = parseArgs('写个游戏 -n 0x10')
  assert.equal(r.n, 3)
  assert.equal(r.positionals.join(' '), '写个游戏 0x10')
})

test('B8: 诚实自述「未实现 X 功能」不再被误判矛盾', () => {
  const text = block('实现了核心循环，未实现音效功能', '冒烟: ✅ 通过 [node]\n退出码: 0')
  assert.equal(crossCheckClaimEvidence(text), null)
})

test('B8: 整体否定自述仍被命中', () => {
  const text = block('这个实现完全失败，启动即崩溃', '冒烟: ✅ 通过 [node]\n退出码: 0')
  const r = crossCheckClaimEvidence(text)
  assert.ok(r && r.includes('负面断言'), r)
})

test('m3: 多行 stdout 尾巴里的"错误:"不再伪造矛盾（转义后单行剔除）', () => {
  // 转义后整条尾巴只有一行：`stdout(尾): 第一行 ⏎ 第二行错误: 警告`
  const text = block('全部成功，无错误', '冒烟: ✅ 通过 [node]\n退出码: 0\nstdout(尾): 第一行 ⏎ 第二行 错误: 普通日志')
  assert.equal(crossCheckClaimEvidence(text), null)
})

// ---------- crossCheckClaimEvidence (F-H) ----------

const block = (summary, smoke) => [
  '── candidate: x-abc123 ──',
  '## 功能摘要（候选自述）',
  summary,
  '## 运行时观察（冒烟测试，非候选自述）',
  smoke,
  '## 视觉观察（截图描述，非候选自述）',
  '(无视觉描述)',
].join('\n')

test('F-H: 原始 stdout 尾巴里的"错误:"不再伪造矛盾', () => {
  const text = block('全部成功，无错误', '冒烟: ✅ 通过 [node]\n退出码: 0\nstdout(尾): 日志里提到 错误: 某处警告（非程序错误）')
  assert.equal(crossCheckClaimEvidence(text), null)
})

test('F-H: stderr 尾巴里的"❌"不再伪造矛盾', () => {
  const text = block('实现完整', '冒烟: ✅ 通过 [node]\n退出码: 0\nstderr(尾): ❌ 仅用于占位展示的日志')
  assert.equal(crossCheckClaimEvidence(text), null)
})

test('F-H: 结构化错误行仍正常命中矛盾', () => {
  const text = block('全部通过，无错误，完美实现', '冒烟: ❌ 失败 [node]\n错误: ReferenceError: x is not defined')
  const r = crossCheckClaimEvidence(text)
  assert.ok(r && r.includes('掩盖'), r)
})
