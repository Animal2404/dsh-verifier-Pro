// /vrank 纯函数回归（parseVRankInput / buildVRankOutput / 参数构造）。
// vrank.ts 零宿主依赖——CI core job 独立编译本模块后即可测试。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseVRankInput, buildVRankOutput, buildVRankRunnerParams, buildVRankConfirmParams } from '../lib/vrank.js'

test('parse: problem + 候选切分（| 分隔）', () => {
  const p = parseVRankInput('哪个更好 | 方案甲内容 | 方案乙内容', '/tmp')
  assert.equal(p.error, undefined)
  assert.equal(p.problem, '哪个更好')
  assert.deepEqual(p.texts, ['方案甲内容', '方案乙内容'])
  assert.deepEqual(p.labels, ['候选1', '候选2'])
})

test('parse: 文件路径候选自动读文本并标注', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vrank-'))
  try {
    const f = join(dir, 'a.txt')
    writeFileSync(f, '文件内容甲', 'utf8')
    const p = parseVRankInput(`问题 | ${f} | 内联候选乙`, dir)
    assert.equal(p.error, undefined)
    assert.equal(p.texts[0], '文件内容甲')
    assert.match(p.labels[0], /文件:/)
    assert.equal(p.texts[1], '内联候选乙')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parse: 候选不足 2 报错 / 文件不存在不误读', () => {
  const p1 = parseVRankInput('只有问题', '/tmp')
  assert.ok(p1.error)
  const p2 = parseVRankInput('问题 | 甲', '/tmp')
  assert.ok(p2.error)
  // 不存在的路径按字面文本处理（不误判为文件）
  const p3 = parseVRankInput('问题 | C:/no/such/file.md | 乙', '/tmp')
  assert.equal(p3.error, undefined)
  assert.equal(p3.texts[0], 'C:/no/such/file.md')
})

test('params: N=2 → compare，N>=3 → select（n_evaluations=1 省成本）', () => {
  const c = buildVRankRunnerParams('compare', 'p', ['a', 'b'])
  assert.equal(c.criteria, 'deep_review')
  assert.equal(c.candidate_a, 'a')
  const s = buildVRankRunnerParams('select', 'p', ['a', 'b', 'c'])
  assert.equal(s.n_evaluations, 1)
  assert.deepEqual(s.candidates, ['a', 'b', 'c'])
})

test('confirm: select flat → 前二 compare 参数；非 flat → null', () => {
  const flat = { signal: 'flat', ranking: [1, 0, 2] }
  const cf = buildVRankConfirmParams('p', ['甲', '乙', '丙'], flat)
  assert.equal(cf.candidate_a, '乙')
  assert.equal(cf.candidate_b, '甲')
  assert.equal(buildVRankConfirmParams('p', ['甲'], { signal: 'ok', ranking: [0] }), null)
})

test('output: compare 胜者 / 噪声带并列（判别纪律）', () => {
  const win = buildVRankOutput('compare', ['甲', '乙'], { reward_a: 0.9, reward_b: 0.2, tag_a: 'aa', tag_b: 'bb' })
  assert.match(win, /胜者：甲/)
  const tie = buildVRankOutput('compare', ['甲', '乙'], { reward_a: 0.501, reward_b: 0.499 })
  assert.match(tie, /无可靠胜者，两个候选视为并列/)
})

test('output: select flat 自动复核 / unstable 如实呈现', () => {
  const flat = buildVRankOutput(
    'select', ['甲', '乙', '丙'],
    { signal: 'flat', ranking: [0, 1, 2], scores: [0.5, 0.5, 0.5], tags: ['t0', 't1', 't2'] },
    { reward_a: 0.9, reward_b: 0.1 },
  )
  assert.match(flat, /flat（无排名信号）/)
  assert.match(flat, /复核胜者：甲/)
  const unstable = buildVRankOutput(
    'select', ['甲', '乙'],
    { signal: 'unstable', ranking: [0, 1], scores: [0.6, 0.4] },
  )
  assert.match(unstable, /unstable.*人工复核|人工复核.*unstable|不要采信名义排名/s)
})
