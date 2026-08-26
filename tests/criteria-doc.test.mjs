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
    // ../evil.md 形态的名字不允许读盘 → 走内置/透传而非文件
    const out = expandCriteria('../evil', dir)
    assert.equal(out, '../evil')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
