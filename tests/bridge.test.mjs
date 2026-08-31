// E4（2026-08-28 审计）：PythonBridge 协议路径回归测试（此前零自动化测试）。
// 用 tests/fixtures/bridge_stub.py 桩桥覆盖：请求/响应 id 关联、错误帧、
// 畸形帧关联、超时、崩溃后自动重启、close 语义。
// 需要 lib/bridge.js（先 npm run build）；需要 python 解释器（PYTHON 可覆盖）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const libBridge = join(here, '..', 'lib', 'bridge.js')
// Windows：动态 import 需要 file:// URL（裸盘符路径会 ERR_UNSUPPORTED_ESM_URL_SCHEME）。
const libBridgeUrl = pathToFileURL(libBridge).href
const stubScript = join(here, 'fixtures', 'bridge_stub.py')

const libMissing = !existsSync(libBridge)
const skipNote = libMissing ? 'lib/ not built — run npm run build first' : undefined

function pickPython() {
  for (const cand of [process.env.PYTHON, 'python', 'python3']) {
    if (!cand) continue
    const r = spawnSync(cand, ['--version'], { encoding: 'utf8', timeout: 10_000 })
    if (r.status === 0) return cand
  }
  return null
}

const pythonBin = pickPython()
const noPython = pythonBin === null
const skipReason = skipNote ?? (noPython ? 'no python interpreter on PATH' : undefined)

test('E4: echo 请求/响应 id 关联（同步时序）', { skip: skipReason }, async () => {
  const { PythonBridge } = await import(libBridgeUrl)
  const bridge = new PythonBridge(stubScript, pythonBin, 10_000)
  try {
    const r = await bridge.request('echo', { a: 1, b: 'x' })
    assert.deepEqual(r, { a: 1, b: 'x' })
  } finally {
    bridge.close()
  }
})

test('E4: 桥返回错误帧 → BridgeError 带 type', { skip: skipReason }, async () => {
  const { PythonBridge, BridgeError } = await import(libBridgeUrl)
  const bridge = new PythonBridge(stubScript, pythonBin, 10_000)
  try {
    await assert.rejects(bridge.request('err'), (e) => e instanceof BridgeError && e.type === 'TestError' && /boom/.test(e.message))
  } finally {
    bridge.close()
  }
})

test('E4: 畸形帧按 id 关联并快速失败（不等到预算超时）', { skip: skipReason }, async () => {
  const { PythonBridge, BridgeError } = await import(libBridgeUrl)
  const bridge = new PythonBridge(stubScript, pythonBin, 10_000)
  try {
    await assert.rejects(
      bridge.request('badframe', {}, 8_000),
      (e) => e instanceof BridgeError && e.type === 'BridgeProtocolError',
    )
  } finally {
    bridge.close()
  }
})

test('E4: 超时 → BridgeTimeout（30s 慢桩 + 1.5s 预算）', { skip: skipReason }, async () => {
  const { PythonBridge, BridgeError } = await import(libBridgeUrl)
  const bridge = new PythonBridge(stubScript, pythonBin, 1_500)
  try {
    await assert.rejects(bridge.request('slow'), (e) => e instanceof BridgeError && e.type === 'BridgeTimeout')
  } finally {
    bridge.close()
  }
})

test('E4: 崩溃后已写入的请求失败（不重发=不双计费），下一请求自动重启', { skip: skipReason }, async () => {
  const { PythonBridge, BridgeError } = await import(libBridgeUrl)
  const bridge = new PythonBridge(stubScript, pythonBin, 10_000)
  try {
    // P3-8：载荷已写入桥后崩溃 → 不重试同一请求（避免同一评分请求计费两次）。
    await assert.rejects(bridge.request('crash'), (e) => e instanceof BridgeError && e.type === 'PythonBridgeExit')
    // 下一请求透明重启新桥进程。
    const r = await bridge.request('echo', { after: 'restart' })
    assert.deepEqual(r, { after: 'restart' })
  } finally {
    bridge.close()
  }
})

test('N2: P3-8 投递计数——crash 只投递 1 次（双计费护栏行为断言，原版 PROA 假护栏修复）', { skip: skipReason }, async () => {
  const { PythonBridge, BridgeError } = await import(libBridgeUrl)
  const bridge = new PythonBridge(stubScript, pythonBin, 10_000)
  try {
    await assert.rejects(bridge.request('crash'), (e) => e instanceof BridgeError && e.type === 'PythonBridgeExit')
    const deliveries = (bridge.diagnostics.match(/DELIVERY:crash/g) ?? []).length
    assert.equal(deliveries, 1, `已写入后崩溃必须只投递 1 次（双计费护栏）: ${bridge.diagnostics}`)
  } finally {
    bridge.close()
  }
})

test('E4: close 后请求 → BridgeClosed', { skip: skipReason }, async () => {
  const { PythonBridge, BridgeError } = await import(libBridgeUrl)
  const bridge = new PythonBridge(stubScript, pythonBin, 10_000)
  bridge.close()
  await assert.rejects(bridge.request('echo'), (e) => e instanceof BridgeError && e.type === 'BridgeClosed')
})
