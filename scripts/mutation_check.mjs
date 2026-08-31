#!/usr/bin/env node
/**
 * mutation_check.mjs — 回归测试保真度检测（变异验证，改版独有防线）。
 *
 * 动因（F7，2026-08-29 公平审计）：R2-1 的『模拟构造』测试在测试体内重写修复
 * 逻辑——把 handler 里的 pop 删掉它照样绿。原版审计员靠人眼看穿这种假测试；
 * 本脚本把这件事机械化：对每条「修复声明 ↔ 回归测试」对，临时把修复代码
 * **变异**（替换/删除），跑对应回归测试——
 *   测试变红（失败） = 测试真实驱动修复 ✅
 *   测试仍然绿       = 假测试 ❌（回归保护是假的，必须重写）
 *
 * 用法: node scripts/mutation_check.mjs [--only <名称子串>]
 * 安全: 每次变异前备份文件字节，finally 精确恢复并逐字节校验；进程被杀后
 *       可用 git checkout -- <file> 恢复（所有变异目标都在 git 管理内）。
 * 依赖: TS 项变异的是 lib/tools.js（编译产物）——先 `npm run build`。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PY = process.env.VB_PYTHON
  || join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts\\python.exe' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python')
const NODE = process.execPath

/**
 * 变异清单：每条 = 一条修复声明 + 驱动它的回归测试。
 * find 必须在目标文件中恰好命中（编译后形态）；replace 是等位变异体。
 * TS 项变异 lib/tools.js（测试 import 的是编译产物）；py 项直接变异源文件。
 */
const MUTATIONS = [
  {
    name: 'R2-1 progress_update pop（py 真集成）',
    file: 'bridge/verifier_brain_bridge.py',
    find: 'kwargs.pop("tracker_id", None)',
    replace: 'kwargs.pop("tracker_id_MUTATED", None)',
    test: [PY, 'tests/test_bridge_handlers.py'],
  },
  {
    name: 'A2 unstable 阈值（K=2 需两轮一致）',
    file: 'lib/tools.js',
    find: 'Math.floor(kUsed / 2) + 1',
    replace: 'Math.ceil(kUsed / 2)',
    test: [NODE, '--test', 'tests/f1-escalation.test.mjs'],
  },
  {
    name: 'A6/F1 数组 criteria 拒绝（唯一收口）',
    file: 'lib/tools.js',
    find: 'if (Array.isArray(criteria)) {',
    replace: 'if (false && Array.isArray(criteria)) {',
    test: [NODE, '--test', 'tests/f1-escalation.test.mjs'],
  },
  {
    name: 'F2 criteria 描述值净化',
    file: 'lib/tools.js',
    find: "out[k] = typeof v === 'string' ? sanitizeForVerifier(v) : v",
    replace: "out[k] = v",
    test: [NODE, '--test', 'tests/f1-escalation.test.mjs'],
  },
  {
    name: 'R2-2 realpath（symlink 白名单）',
    file: 'lib/tools.js',
    find: 'p = realpathSync(resolved)',
    replace: 'p = resolved',
    test: [NODE, '--test', 'tests/images-whitelist.test.mjs'],
    note: 'symlink 用例在无权限环境会 skip → 此时本条记 SKIPPED 而非 FAKE',
  },
  {
    name: 'F4/A3 fall-through 缺失归因',
    file: 'lib/tools.js',
    find: 'scoreWarning(`${method} raw: ${JSON.stringify(out.scores)}`, clamped.some((c) => c.missing))',
    replace: '`⚠️ ${method} 返回越界分已裁剪到 [0,1]（raw: ${JSON.stringify(out.scores)}）`',
    test: [NODE, '--test', 'tests/f1-escalation.test.mjs'],
  },
  // ---- 2026-08-29 第二轮（PROA/DSHR2X）新登记对 ----
  {
    name: 'N1 criteria 字符串白名单（任意文件读取通道封堵）',
    file: 'lib/tools.js',
    find: 'if (!/^[A-Za-z0-9_-]+$/.test(name)) {',
    replace: 'if (false && !/^[A-Za-z0-9_-]+$/.test(name)) {',
    test: [NODE, '--test', 'tests/f1-escalation.test.mjs'],
  },
  {
    name: 'N4 compare degraded duration_ms（A4 漏补分支）',
    file: 'lib/tools.js',
    find: "                duration_ms: Date.now() - started,\n                signal: 'degraded',\n                // F12（复盘 R-refcomp）",
    replace: "                signal: 'degraded',\n                // F12（复盘 R-refcomp）",
    test: [NODE, '--test', 'tests/f1-escalation.test.mjs'],
  },
  {
    name: 'N2 P3-8 投递计数（crash 只投 1 次）',
    file: 'lib/bridge.js',
    find: "error.type === 'PythonBridgeExit' && !written",
    replace: "error.type === 'PythonBridgeExit'",
    test: [NODE, '--test', 'tests/bridge.test.mjs'],
  },
  {
    name: 'N3 F9 大小写规范化（win32 小写配置根）',
    file: 'lib/tools.js',
    find: "const norm = process.platform === 'win32' ? (s) => s.toLowerCase() : (s) => s;",
    replace: 'const norm = (s) => s;',
    test: [NODE, '--test', 'tests/images-whitelist.test.mjs'],
    platform: 'win32',
    note: 'norm 仅 win32 生效；非 win32 环境记 SKIPPED',
  },
]

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null
const list = only ? MUTATIONS.filter((m) => m.name.includes(only)) : MUTATIONS

console.log('=== dsh-verifier-Pro mutation_check（测试保真度/变异验证）===\n')
const results = []
for (const m of list) {
  if (m.platform && process.platform !== m.platform) {
    results.push({ name: m.name, verdict: 'SKIPPED' })
    console.log(`⏭️  SKIPPED ${m.name}（平台 ${m.platform} 限定）`)
    continue
  }
  const path = join(ROOT, m.file)
  const original = readFileSync(path, 'utf8')
  const hits = original.split(m.find).length - 1
  if (hits !== 1) {
    results.push({ name: m.name, verdict: 'ERROR' })
    console.log(`⚠️  ERROR ${m.name} — find 串命中 ${hits} 次（需恰好 1 次；lib 未构建或源码漂移？先 npm run build）`)
    continue
  }
  let verdict
  try {
    writeFileSync(path, original.replace(m.find, m.replace))
    const r = spawnSync(m.test[0], m.test.slice(1), { encoding: 'utf8', cwd: ROOT, timeout: 300_000 })
    // 预期：变异后测试必须失败（红）= 测试真实驱动修复。
    // SKIPPED 识别：全部用例 skip 时 node --test 也可能 exit 0——粗略用输出判断。
    const out = (r.stdout || '') + (r.stderr || '')
    if (r.status !== 0) verdict = 'OK'
    else if (/ skl?ipped|0 fail/i.test(out) && /tests \d+|pass \d+/i.test(out)) verdict = 'FAKE'
    else verdict = 'FAKE'
  } catch (e) {
    verdict = 'ERROR'
    console.error(`  变异执行异常: ${e.message}`)
  } finally {
    writeFileSync(path, original)
  }
  const restored = readFileSync(path, 'utf8')
  if (restored !== original) {
    console.error(`❌ 致命：${m.file} 恢复失败——请立即 git checkout -- ${m.file}`)
    process.exit(2)
  }
  results.push({ name: m.name, verdict })
  const mark = verdict === 'OK' ? '✅' : verdict === 'FAKE' ? '❌' : '⚠️ '
  console.log(`${mark} ${verdict.padEnd(6)} ${m.name}${m.note && verdict !== 'OK' ? `（${m.note}）` : ''}`)
}

console.log('')
const ok = results.filter((r) => r.verdict === 'OK').length
const fake = results.filter((r) => r.verdict === 'FAKE').length
const err = results.filter((r) => r.verdict === 'ERROR').length
const skipped = results.filter((r) => r.verdict === 'SKIPPED').length
console.log(`=== 保真度：${ok} 真 / ${fake} 假 / ${err} 错误 / ${skipped} 平台跳过（共 ${results.length}）===`)
if (fake > 0) {
  console.log('\n❌ 存在假测试：回归测试没有真正驱动修复——重写测试直到变异后变红。')
  process.exit(1)
}
if (err > 0) process.exit(2)
console.log('\n✅ 全部回归测试对修复代码变异敏感（无假测试）。')
