// R5（2026-08-28 二次审计）：TS 侧 sanitizeImagesParam 白名单回归测试
// （Python 侧有 9 个用例，TS 侧此前零覆盖）。
// 经 runner（runCompare/runSelect）间接驱动：images 在 mkParams 里被白名单化，
// 违规路径响亮报错。需要 lib/tools.js（先 npm run build——CI harness job 覆盖）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const libToolsUrl = pathToFileURL(join(here, '..', 'lib', 'tools.js')).href

function fakeBridge() {
  const calls = []
  return {
    calls,
    async request(method, params) {
      if (method === 'probe_model') return { ok: true, logprobs_supported: true }
      if (method === 'usage') return { usage: { input_tokens: 0, output_tokens: 0 } }
      calls.push({ method, params })
      // 0.5/0.5 → flat，不触发升级（测试只需观察 images 是否到达桥）。
      return { reward_a: 0.5, reward_b: 0.5, index: 0, scores: [0.5, 0.5] }
    },
  }
}

const fakeStore = () => ({ appendHistory() {}, readHistory() { return [] } })
const baseDeps = (bridge) => ({
  getBridge: async () => bridge,
  store: fakeStore(),
  esc: { autoEscalate: false, escalateThreshold: 0.15, maxEscalateK: 3 },
  budgetMs: () => 1_800_000,
})

/** 临时改环境变量，fn 结束后恢复（支持 async）。 */
async function withEnv(patch, fn) {
  const saved = {}
  for (const [k, v] of Object.entries(patch)) {
    saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return await fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

test('R5: 白名单内文件放行并转发绝对路径', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'img-in-'))
  const img = join(dir, 'a.png')
  writeFileSync(img, 'x'.repeat(32))
  try {
    const bridge = fakeBridge()
    const run = (await import(libToolsUrl)).createEscalationRunner(baseDeps(bridge))
    await run('compare', { problem: 'p', candidate_a: 'a', candidate_b: 'b', images: img })
    const sent = bridge.calls.find((c) => c.method === 'compare').params
    assert.deepEqual(sent.images, [resolve(img)])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('R5: 白名单外路径响亮拒绝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'img-out-'))
  const img = join(dir, 'a.png')
  writeFileSync(img, 'x'.repeat(32))
  try {
    const bridge = fakeBridge()
    const run = (await import(libToolsUrl)).createEscalationRunner(baseDeps(bridge))
    // 白名单根显式指到插件根（cwd）——系统临时目录文件必然越界。
    await assert.rejects(
      withEnv({ LLM_VERIFIER_IMAGE_ROOTS: process.cwd() }, () =>
        run('compare', { problem: 'p', candidate_a: 'a', candidate_b: 'b', images: img })),
      /白名单/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('R5: 白名单根内 symlink 指向根外被拒（R2-2）', async (t) => {
  const outside = mkdtempSync(join(tmpdir(), 'img-sym-out-'))
  const target = join(outside, 'secret.png')
  writeFileSync(target, 'x'.repeat(16))
  const root = mkdtempSync(join(tmpdir(), 'img-sym-root-'))
  const link = join(root, 'evil.png')
  try {
    try {
      symlinkSync(target, link)
    } catch {
      t.skip('symlink 不可用（Windows 无开发者模式/无权限）')
      return
    }
    const bridge = fakeBridge()
    const run = (await import(libToolsUrl)).createEscalationRunner(baseDeps(bridge))
    await assert.rejects(
      withEnv({ LLM_VERIFIER_IMAGE_ROOTS: root }, () =>
        run('compare', { problem: 'p', candidate_a: 'a', candidate_b: 'b', images: link })),
      /白名单/,
    )
  } finally {
    rmSync(outside, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

test('R5: 超过 LLM_VERIFIER_IMAGE_MAX_MB 拒绝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'img-big-'))
  const img = join(dir, 'big.png')
  writeFileSync(img, 'x'.repeat(4096))
  try {
    const bridge = fakeBridge()
    const run = (await import(libToolsUrl)).createEscalationRunner(baseDeps(bridge))
    await assert.rejects(
      withEnv({ LLM_VERIFIER_IMAGE_MAX_MB: '0.001' }, () =>
        run('compare', { problem: 'p', candidate_a: 'a', candidate_b: 'b', images: img })),
      /过大/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('R5+: P1-2 select 路径 images 转发与白名单（此前仅 compare 被测——F7 覆盖缺口）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'img-sel-'))
  const img = join(dir, 'a.png')
  writeFileSync(img, 'x'.repeat(32))
  try {
    const bridge = fakeBridge()
    const run = (await import(libToolsUrl)).createEscalationRunner(baseDeps(bridge))
    await run('select', { problem: 'p', candidates: ['a', 'b'], images: img })
    const sent = bridge.calls.find((c) => c.method === 'select').params
    assert.deepEqual(sent.images, [resolve(img)])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('N3: F9 大小写规范化（win32 小写配置根放行真实大小写路径）', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('F9 norm 仅 win32 生效')
    return
  }
  const dir = mkdtempSync(join(tmpdir(), 'F9Case-'))
  const img = join(dir, 'a.png')
  writeFileSync(img, 'x'.repeat(32))
  try {
    const bridge = fakeBridge()
    const run = (await import(libToolsUrl)).createEscalationRunner(baseDeps(bridge))
    // 配置根用全小写形态（用户手写配置常见）——无 norm 时前缀比较大小写敏感必拒。
    const lowercaseRoot = dir.toLowerCase()
    await withEnv({ LLM_VERIFIER_IMAGE_ROOTS: lowercaseRoot }, () =>
      run('compare', { problem: 'p', candidate_a: 'a', candidate_b: 'b', images: img }))
    const sent = bridge.calls.find((c) => c.method === 'compare').params
    assert.ok(Array.isArray(sent.images) && sent.images.length === 1, 'win32 小写配置根必须放行')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('N10: LLM_VERIFIER_IMAGE_MAX_MB=0 语义——拒绝任何文件（不回落 8，原版 PROA）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'img-zero-'))
  const img = join(dir, 'a.png')
  writeFileSync(img, 'x'.repeat(32))
  try {
    const bridge = fakeBridge()
    const run = (await import(libToolsUrl)).createEscalationRunner(baseDeps(bridge))
    await assert.rejects(
      withEnv({ LLM_VERIFIER_IMAGE_MAX_MB: '0' }, () =>
        run('compare', { problem: 'p', candidate_a: 'a', candidate_b: 'b', images: img })),
      /过大/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('R5: 不存在路径拒绝', async () => {
  const bridge = fakeBridge()
  const run = (await import(libToolsUrl)).createEscalationRunner(baseDeps(bridge))
  await assert.rejects(
    run('compare', { problem: 'p', candidate_a: 'a', candidate_b: 'b', images: join(tmpdir(), 'no-such-file.png') }),
    /不存在/,
  )
})
