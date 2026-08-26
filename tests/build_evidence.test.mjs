// D-1 regression: evidence-chain key matching after F10 hash naming.
// build_evidence must find smoke/describe files under their HASHED names
// (`<stem>-<hash12>.smoke.json`) and attach per-candidate --summary keyed by
// the RAW user name — both used to silently miss, leaving empty-shell blocks.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
// S19: 哈希 12 hex，必须与 smoke.mjs / build_evidence.mjs 的 shortHash 一致（契约① 守护）
const shortHash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12)

function run(inputs, args = []) {
  return spawnSync(process.execPath, [
    join(ROOT, 'scripts', 'build_evidence.mjs'),
    ...inputs, '--json', ...args,
  ], { encoding: 'utf8', cwd: ROOT })
}

/** Parse blocks from the evidence.json the script writes to --out. */
function readBlocks(outDir) {
  return JSON.parse(readFileSync(join(outDir, 'evidence.json'), 'utf8')).blocks
}

test('D-1: smoke evidence found under the hashed name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ev-'))
  const html = join(dir, 'good.html')
  writeFileSync(html, '<html><body>hi</body></html>')
  const stem = 'good'
  const hashed = `${stem}-${shortHash(resolve(html))}`
  const smokeDir = join(dir, 'smoke')
  mkdirSync(smokeDir, { recursive: true })
  writeFileSync(join(smokeDir, `${hashed}.smoke.json`), JSON.stringify({
    file: html, kind: 'html', ok: true, errors: [], exitCode: null,
  }))

  const r = run([html], ['--smoke-dir', smokeDir, '--out', join(dir, 'out')])
  assert.equal(r.status, 0, r.stderr)
  const blocks = readBlocks(join(dir, 'out'))
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].name, hashed, 'block name carries the hash')
  assert.match(blocks[0].text, /冒烟: ✅ 通过/, 'smoke evidence must be in the block')
})

test('D-1: per-candidate --summary keyed by raw name attaches to hashed block', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ev-'))
  const html = join(dir, '甲.html')
  writeFileSync(html, '<html><body>hi</body></html>')
  const hashed = `甲-${shortHash(resolve(html))}`
  const smokeDir = join(dir, 'smoke')
  mkdirSync(smokeDir, { recursive: true })
  writeFileSync(join(smokeDir, `${hashed}.smoke.json`), JSON.stringify({
    file: html, kind: 'html', ok: true, errors: [], exitCode: null,
  }))

  const r = run([html], ['--smoke-dir', smokeDir, '--out', join(dir, 'out'), '--summary', '甲=这是候选自述说明'])
  assert.equal(r.status, 0, r.stderr)
  const blocks = readBlocks(join(dir, 'out'))
  assert.equal(blocks[0].name, hashed)
  assert.match(blocks[0].text, /这是候选自述说明/, 'raw-name summary must attach')
})

test('D-1: hashless legacy smoke file still found (fallback)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ev-'))
  const html = join(dir, 'legacy.html')
  writeFileSync(html, '<html><body>hi</body></html>')
  const smokeDir = join(dir, 'smoke')
  mkdirSync(smokeDir, { recursive: true })
  writeFileSync(join(smokeDir, 'legacy.smoke.json'), JSON.stringify({
    file: html, kind: 'html', ok: true, errors: [], exitCode: null,
  }))

  const r = run([html], ['--smoke-dir', smokeDir, '--out', join(dir, 'out')])
  assert.equal(r.status, 0, r.stderr)
  const blocks = readBlocks(join(dir, 'out'))
  assert.match(blocks[0].text, /冒烟: ✅ 通过/, 'legacy hashless file must still resolve')
})
