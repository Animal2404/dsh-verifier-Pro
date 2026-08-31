#!/usr/bin/env node
/**
 * audit_checks.mjs — dsh-verifier-Pro 可复现审计自检（Playbook 机械化）
 *
 * 对应 `AUDIT_PLAYBOOK-dsh-verifier-Pro.md` §1 十二类机械检测 + §2 四个延伸项：
 * 每条检查都是「声明 → 代码反查」（写方/读方配对、阈值代入、跨文件契约、
 * 入口覆盖盘点、安全四问+第五问、文档×实现×打包三方对照）。
 *
 * 用法:
 *   node scripts/audit_checks.mjs          # 静态检测（零依赖、只读、<1s）
 *   node scripts/audit_checks.mjs --full   # 追加 npm test 运行基线
 *
 * 发布前必跑（RELEASING.md 发布流程第 2 步）。退出码：0 = 全部通过；1 = 有失败。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const count = (text, re) => (text.match(re) ?? []).length

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const info = (name, detail) => {
  results.push({ name, ok: true })
  console.log(`ℹ️  ${name} — ${detail}`)
}

console.log('=== dsh-verifier-Pro audit_checks（Playbook 机械化）===\n')

// ---------- §1.1 A1 类：写方/读方配对（声称的修复不是死代码） ----------
{
  const tools = read('src/tools.ts')
  // 写方 = appendHistory 行以 `cached: k1WasCached })` 收尾（返回对象是 `,` 结尾，不误计）。
  const writers = count(tools, /cached: k1WasCached \}\)/g)
  check('A1 写方：history 记录带 cached 标记（appendHistory×cached ≥4）', writers >= 4, `命中 ${writers} 处`)
  const readers = count(tools, /cached !== true/g)
  check('A1 读方：过滤器条件 cached !== true（costGuard/estimateCallMs ≥2）', readers >= 2, `命中 ${readers} 处`)
}

// ---------- §1.2 A1b + §2 R2-3：costGuard 与控制流次序 ----------
{
  const tools = read('src/tools.ts')
  const skipWhenCached = count(tools, /if \(!k1WasCached\) await costGuard/g)
  check('A1b：k1 未命中才守卫（缓存命中跳过 costGuard ≥2：compare/select）', skipWhenCached >= 2, `命中 ${skipWhenCached} 处`)
  const guardBeforeEscalation = count(tools, /if \(k1WasCached\) await costGuard/g)
  check('R2-3：k1 命中但将升级时补守卫（升级轮是真实付费 ≥2）', guardBeforeEscalation >= 2, `命中 ${guardBeforeEscalation} 处`)
}

// ---------- §1.3 A2 类：阈值极值代入 ----------
{
  const tools = read('src/tools.ts')
  const ok = tools.includes('Math.floor(kUsed / 2) + 1')
  check('A2：unstable 阈值 floor(k/2)+1（K=2 需两轮一致）', ok)
}

// ---------- §1.4 A3 类：异常值归因 ----------
{
  const tools = read('src/tools.ts')
  check('A3：clamp01 缺失归因（missing 字段）', /missing: true/.test(tools))
  check('A3：scoreWarning 区分缺失/越界文案', tools.includes('function scoreWarning'))
}

// ---------- §1.5 A4 类：同函数分支字段一致性 ----------
{
  const tools = read('src/tools.ts')
  const n = count(tools, /duration_ms: Date\.now\(\) - started/g)
  check('A4：非升级/升级全分支带 duration_ms（≥10）', n >= 10, `命中 ${n} 处`)
}

// ---------- §1.6 A5 类：跨文件契约（哈希宽度） ----------
{
  const files = { 'src/tools.ts': 'candTag', 'scripts/smoke.mjs': 'artifactName', 'scripts/build_evidence.mjs': 'shortHash' }
  let ok = true
  const details = []
  for (const [p, label] of Object.entries(files)) {
    const t = read(p)
    const has12 = /slice\(0, 12\)/.test(t)
    const has8 = /slice\(0, 8\)/.test(t)
    ok = ok && has12 && !has8
    details.push(`${label}:${has12 && !has8 ? '12-hex ✅' : (has12 ? '12-hex ✅ 但残留 8' : '❌ 非 12-hex')}`)
  }
  check('A5：三处哈希宽度均 12-hex 且无 8-hex 残留', ok, details.join(' / '))
}

// ---------- §1.7 A6 类：typeof 陷阱（数组形态） ----------
{
  const tools = read('src/tools.ts')
  check('A6：criteria 数组形态显式拒绝（Array.isArray(parsed)）', /Array\.isArray\(parsed\)/.test(tools))
}

// ---------- §1.8 A10 类 + §2 R2-4-7：入口覆盖盘点 + kind 桶 ----------
{
  const tools = read('src/tools.ts')
  const n = count(tools, /costGuard\(deps, /g)
  check('A10：成本守卫覆盖全部评分入口（≥9：compare×2/select×2/track/decompose/evaluate/progress×2/runner）', n >= 9, `命中 ${n} 处`)
  const progressKind = count(tools, /costGuard\(deps, 'progress'\)/g)
  check('R2-4-7：progress_update 守卫用 kind=\'progress\'（与 history 桶一致 ≥2）', progressKind >= 2, `命中 ${progressKind} 处`)
  const historyKind = count(tools, /kind: 'progress'/g)
  check('R2-4-7：history 记录 kind=\'progress\'（写入侧存在）', historyKind >= 1, `命中 ${historyKind} 处`)
}

// ---------- §1.9 B1 类：安全四问 + 第五问（symlink） ----------
{
  const tools = read('src/tools.ts')
  const bridge = read('bridge/verifier_brain_bridge.py')
  const readme = read('README.md')
  const security = read('SECURITY.md')
  const inTs = tools.includes('LLM_VERIFIER_IMAGE_ROOTS')
  const inBridge = bridge.includes('LLM_VERIFIER_IMAGE_ROOTS')
  const inReadme = readme.includes('LLM_VERIFIER_IMAGE_ROOTS')
  const inSecurity = security.includes('LLM_VERIFIER_IMAGE_ROOTS')
  check('B1：白名单 env 四侧一致（TS/桥/README/SECURITY）', inTs && inBridge && inReadme && inSecurity,
    `TS=${inTs} 桥=${inBridge} README=${inReadme} SECURITY=${inSecurity}`)
  check('B1：默认剥离门控（LLM_VERIFIER_ALLOW_IMAGES）', bridge.includes('LLM_VERIFIER_ALLOW_IMAGES'))
  check('B1 第五问：TS 侧 realpath 解析符号链接', tools.includes('realpathSync'))
  check('B1 第五问：桥侧 os.path.realpath 解析符号链接', bridge.includes('os.path.realpath'))
}

// ---------- §1.10 B2 类：重复解析器盘点（已知可接受，记录计数） ----------
{
  const files = ['src', 'scripts']
  const hits = []
  // N8（2026-08-29 第二轮，改版 DSHR2X）：清点排除自身与「仅字符串提及」的文件——
  // audit_checks/mutation_check 含 'credentials.yaml' 字样（检测代码）、index.ts 仅
  // 在告警文案提及，均不是手写 YAML 解析器（旧清点报 7 实 5，口径自污染）。
  const SKIP = new Set(['scripts/audit_checks.mjs', 'scripts/mutation_check.mjs', 'src/index.ts'])
  for (const dir of files) {
    for (const f of readdirSync(join(ROOT, dir))) {
      if (!/\.(ts|mjs|py|cjs)$/.test(f)) continue
      const rel = `${dir}/${f}`
      if (SKIP.has(rel)) continue
      try {
        if (read(join(dir, f)).includes('credentials.yaml')) hits.push(rel)
      } catch { /* skip */ }
    }
  }
  info('B2：手写 YAML 凭据解析器盘点（记录不修；N8：排除自身与仅字符串提及的文件）', hits.join(', '))
}

// ---------- §1.11 D2/D3 类：文档 × 实现 × 打包三方对照 ----------
{
  const tools = read('src/tools.ts')
  const enumMatch = /enum:\s*\[([^\]]+)\]/.exec(tools)
  const actions = enumMatch
    ? [...enumMatch[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
    : []
  const expected = ['select', 'compare', 'track', 'decompose', 'evaluate_session', 'progress_start',
    'progress_update', 'progress_close', 'task_start', 'task_status', 'usage', 'config']
  check('D2：action enum 恰好 12 个', actions.length === 12 && expected.every((a) => actions.includes(a)),
    `enum ${actions.length} 个`)
  const promptFirstLine = read('src/prompt.ts').split('\n')[16] ?? ''
  const missing = expected.filter((a) => !promptFirstLine.includes(a))
  check('D2：prompt 首句列出全部 12 个 action', missing.length === 0, missing.length ? `缺: ${missing.join(',')}` : '')
  // D3：README 引用的 scripts/* 必须都在 npm files 白名单
  const pkg = read('package.json')
  const filesWhitelist = [...pkg.matchAll(/"scripts\/[^"]+"/g)].map((m) => m[0].replace(/"/g, ''))
  const readmeRefs = [...new Set(
    [...read('README.md').matchAll(/scripts\/[A-Za-z0-9_.-]+/g)].map((m) => m[0])
      .concat([...read('README.en.md').matchAll(/scripts\/[A-Za-z0-9_.-]+/g)].map((m) => m[0])),
  )]
  const notPacked = readmeRefs.filter((r) => !filesWhitelist.includes(r))
  check('D3：README 文档化的脚本全部在 npm files 白名单', notPacked.length === 0,
    notPacked.length ? `未打包: ${notPacked.join(', ')}` : `README 引用 ${readmeRefs.length} 个脚本全部在列`)
}

// ---------- §1.12 E1/E2/E3/E4 类：CI 与测试覆盖盘点 ----------
{
  const ci = read('.github/workflows/ci.yml')
  check('E1：CI 全项目 typecheck（--noEmit）', ci.includes('--noEmit'))
  check('E2：CI pip 钉扎 <0.3.0 上界', ci.includes('llm-verifier>=0.2.0,<0.3.0'))
  const tests = readdirSync(join(ROOT, 'tests'))
  const needed = ['bridge.test.mjs', 'test_bridge_handlers.py', 'smoke-lock.test.mjs',
    'prompt-hygiene.test.mjs', 'images-whitelist.test.mjs']
  const missing = needed.filter((f) => !tests.includes(f))
  check('E3/E4：高风险模块回归测试在位（5 个文件）', missing.length === 0,
    missing.length ? `缺: ${missing.join(', ')}` : '')
}

// ---------- §2 R2-1：handler 集成路径盘点（D4 噪音） ----------
{
  const bridge = read('bridge/verifier_brain_bridge.py')
  const pops = bridge.includes('kwargs.pop("tracker_id", None)') && bridge.includes('kwargs.pop("step", None)')
  const noRawFilter = !/_filter_kwargs\(dict\(params\)/.test(bridge)
  check('R2-1：progress_update 先 pop 已消费参数再过滤', pops && noRawFilter)
}

// ---------- 2026-08-29 公平审计修复批（F1/F2/F7） ----------
{
  const tools = read('src/tools.ts')
  check('F2：criteria 描述值过传输层净化（expandCriteria 唯一收口内 sanitize）',
    tools.includes("out[k] = typeof v === 'string' ? sanitizeForVerifier(v) : v"))
  check('F1/F3：数组拒绝位于唯一收口 expandCriteria（异步/服务缝同堵）',
    tools.includes('if (Array.isArray(criteria)) {'))
  check('N1：字符串 criteria 白名单封堵路径形态（任意文件读取通道）',
    tools.includes('if (!/^[A-Za-z0-9_-]+$/.test(name)) {'))
  const pyTests = read('tests/test_bridge_handlers.py')
  check('F7：R2-1 集成测试驱动真实 _handle_progress_update（非模拟构造，变异敏感）',
    pyTests.includes('_handle_progress_update'))
}

console.log('')
const failed = results.filter((r) => !r.ok)
console.log(`=== ${results.length - failed.length}/${results.length} 项通过 ===`)

// ---------- 运行基线（--full） ----------
if (process.argv.includes('--full')) {
  console.log('\n=== 运行基线：npm test ===')
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  // Windows 上 .cmd 必须 shell:true（否则 spawn EINVAL、status=null）。
  const r = spawnSync(npm, ['test'], { encoding: 'utf8', cwd: ROOT, timeout: 600_000, shell: process.platform === 'win32' })
  const summary = (r.stdout || '').split('\n').filter((l) => /^# (tests|pass|fail)/.test(l)).join(' | ')
  if (summary) console.log(summary)
  if (r.status !== 0) {
    console.error(`npm test 失败（exit ${String(r.status)}）${r.error ? '：' + r.error.message : ''}`)
    process.exit(1)
  }
  console.log('npm test ✅ exit 0')
}

process.exit(failed.length ? 1 : 0)
