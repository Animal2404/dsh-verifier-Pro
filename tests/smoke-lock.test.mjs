// P1-1（2026-08-28 审计）：smoke.mjs 排他锁回归测试——
// ① 正常完成后锁必须释放（同 --out 第二次运行成功）；
// ② 陈旧锁（>15min）自动接管；
// ③ evidence_chain.mjs 在 smoke 无新鲜产出（锁冲突）时清理 smokeDir 并中止，
//    杜绝陈旧 .smoke.json 被当作本次新鲜证据。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(here, '..')
const GOOD_FIXTURE = resolve(join(PLUGIN_ROOT, 'scripts', '__fixtures__', 'good.cjs'))

function runSmoke(outDir) {
  return spawnSync(process.execPath, [join(PLUGIN_ROOT, 'scripts', 'smoke.mjs'), GOOD_FIXTURE, '--out', outDir], {
    encoding: 'utf8', timeout: 60_000, cwd: PLUGIN_ROOT,
  })
}

test('P1-1: 同 --out 连跑两次，第二次必须成功（锁已释放）', () => {
  const out = mkdtempSync(join(tmpdir(), 'smoke-lock-'))
  try {
    const first = runSmoke(out)
    assert.equal(first.status, 0, `第一次冒烟应成功: ${first.stderr}`)
    assert.ok(!existsSync(join(out, '.smoke.lock')), '正常结束后锁文件必须被删除')
    const second = runSmoke(out)
    assert.equal(second.status, 0, `第二次冒烟必须成功（此前锁泄漏必 exit 3）: ${second.stderr}`)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('P1-1: 陈旧锁（>15min，进程被杀残留）自动接管', () => {
  const out = mkdtempSync(join(tmpdir(), 'smoke-stale-'))
  try {
    const lockPath = join(out, '.smoke.lock')
    writeFileSync(lockPath, '999999\n', 'utf8')
    const old = new Date(Date.now() - 20 * 60_000)
    utimesSync(lockPath, old, old)
    const r = runSmoke(out)
    assert.equal(r.status, 0, `陈旧锁应被接管并成功: ${r.stderr}`)
    assert.ok(!existsSync(lockPath), '接管后锁文件应随 finally 删除')
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('P1-1: 新鲜锁（活跃实例）仍拒绝并发（exit 3）', () => {
  const out = mkdtempSync(join(tmpdir(), 'smoke-live-'))
  try {
    writeFileSync(join(out, '.smoke.lock'), String(process.pid) + '\n', 'utf8')
    const r = runSmoke(out)
    assert.equal(r.status, 3, '活跃锁必须拒绝第二个实例')
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('N7: 锁 pid 存活（长跑活跃实例）→ mtime 超龄也绝不接管', () => {
  const out = mkdtempSync(join(tmpdir(), 'smoke-pid-'))
  try {
    const lockPath = join(out, '.smoke.lock')
    writeFileSync(lockPath, String(process.pid) + '\n', 'utf8') // 本进程 pid = 存活
    const old = new Date(Date.now() - 20 * 60_000)
    utimesSync(lockPath, old, old)
    const r = runSmoke(out)
    assert.equal(r.status, 3, '存活 pid 的锁即使 mtime 超龄也必须拒绝接管（R4 理由朽坏修复）')
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('P1-1/R3: evidence_chain 锁冲突时预存在的 smokeDir 保留不删（并发活跃实例保护）', () => {
  const out = mkdtempSync(join(tmpdir(), 'ec-stale-'))
  try {
    const smokeDir = join(out, 'smoke')
    mkdirSync(smokeDir, { recursive: true })
    // 上次运行遗留的陈旧证据 + 本次模拟另一个活跃实例的新鲜锁。
    writeFileSync(join(smokeDir, 'good-aaaaaaaaaaaa.smoke.json'), JSON.stringify({ file: GOOD_FIXTURE, ok: true }), 'utf8')
    writeFileSync(join(smokeDir, '.smoke.lock'), String(process.pid) + '\n', 'utf8')
    const r = spawnSync(process.execPath, [join(PLUGIN_ROOT, 'scripts', 'evidence_chain.mjs'), GOOD_FIXTURE, '--out', out], {
      encoding: 'utf8', timeout: 60_000, cwd: PLUGIN_ROOT,
    })
    assert.notEqual(r.status, 0, '锁冲突且无新鲜产出时必须中止（exit != 0）')
    // R3（2026-08-28 二次审计）：目录运行前已存在（可能是活跃实例输出）→ 保留不删。
    assert.ok(existsSync(smokeDir), `R3: 预存在的 smokeDir 必须保留（不能删并发活跃实例的输出）: ${r.stdout}`)
    assert.ok(existsSync(join(smokeDir, 'good-aaaaaaaaaaaa.smoke.json')), '陈旧证据文件保留（目录未被动）')
    assert.ok(!existsSync(join(out, 'evidence', 'evidence.json')), '中止后不得产出本次 evidence.json')
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('P1-1/R3: evidence_chain 输入不可冒烟（smoke exit 2）时中止，本次新建目录无残留', () => {
  const out = mkdtempSync(join(tmpdir(), 'ec-usage-'))
  try {
    const smokeDir = join(out, 'smoke')
    // 不预建 smokeDir；传一个不存在的输入 → smoke collectFiles 零文件 → exit 2。
    const missing = join(out, 'no-such-artifact.html')
    const r = spawnSync(process.execPath, [join(PLUGIN_ROOT, 'scripts', 'evidence_chain.mjs'), missing, '--out', out], {
      encoding: 'utf8', timeout: 60_000, cwd: PLUGIN_ROOT,
    })
    assert.notEqual(r.status, 0, 'smoke exit 2 时必须中止（exit != 0）')
    assert.ok(!existsSync(smokeDir), `本次新建目录无残留: ${r.stdout}`)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})
