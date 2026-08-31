// G3 regression: criteria .md template hot-load — section parsing, override
// precedence over built-ins, and the filename whitelist against traversal.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expandCriteria, parseCriteriaDoc } from '../lib/tools.js'

test('parseCriteriaDoc: ## sections become descriptions; prose ignored', () => {
  const doc = parseCriteriaDoc('# title\n\nignored prose\n\n## A\nalpha body\n\n## B\nbeta\nbody')
  assert.deepEqual(doc, { A: 'alpha body', B: 'beta\nbody' })
})

test('parseCriteriaDoc: empty document yields no usable object', () => {
  assert.equal(parseCriteriaDoc('no sections here'), undefined)
})

test('expandCriteria: dir template overrides code preset; missing file falls back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crit-'))
  try {
    writeFileSync(join(dir, 'deep_review.md'), '## RootCause\nDIR OVERRIDE\n')
    assert.equal(expandCriteria('deep_review', dir).RootCause, 'DIR OVERRIDE')
    // 无目录 / 文件缺失 → 内置预设仍生效
    assert.ok(String(expandCriteria('root_cause', dir).RootCause).includes('ACTUAL root cause'))
    assert.ok(String(expandCriteria('root_cause').RootCause).includes('ACTUAL root cause'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('expandCriteria: template name whitelist blocks path traversal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crit-'))
  try {
    writeFileSync(join(dir, 'evil.md'), '## X\nbad\n')
    // N1（2026-08-29 第二轮）：路径形态字符串从「透传」改为「响亮拒绝」——
    // 旧契约（透传给官方包）正是任意文件读取通道的入口；throw 是安全失败。
    assert.throws(() => expandCriteria('../evil', dir), /not supported/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
