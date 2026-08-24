#!/usr/bin/env node
/**
 * M3 证据链自动化 — 一键端到端：冒烟 → 视觉描述 → 证据拼接。
 *
 * 用法:
 *   node scripts/evidence_chain.mjs <artifactOrDir...> [--summary <text|file>]
 *       [--out <dir>] [--json] [--skip-describe]
 *
 * 串联三个脚本:
 *   scripts/smoke.mjs         (HTML/CDP + Node 冒烟, 输出 .smoke.json + 截图)
 *   scripts/describe_visual.mjs (mimo-v2.5 五维视觉描述, 输出 .describe.json)
 *   scripts/build_evidence.mjs  (拼接带来源标注的证据块, 输出 evidence.json)
 *
 * 产物落在 <out>/ 下, 最终 evidence.json 可直接交给 verifier select/compare 作为候选输入。
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { readdirSync, readFileSync, statSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = dirname(__dirname)
const OUT = resolve(process.argv[findArg('--out')] ?? join(process.cwd(), 'tmp_articles', 'chain'))
const AS_JSON = process.argv.includes('--json')
const SKIP_DESCRIBE = process.argv.includes('--skip-describe')
const VALUED_ARGS = new Set(['--out', '--summary'])
const INPUTS = process.argv.slice(2).filter((a, i, arr) => {
  if (a.startsWith('--')) return false
  return !VALUED_ARGS.has(arr[i - 1])
})

// vselftest-m4（身份钉扎）+ DH-F1（根因修复）：输入先对当前 cwd 绝对化，
// 子进程统一钉在插件根——四进程的 resolve() 身份哈希不再依赖继承巧合。
const ABS_INPUTS = INPUTS.map((p) => resolve(p))

/** DH-F1：目录输入展开为具体可冒烟文件后再交给 build_evidence——此前原始
 * 目录路径会以"目录名+哈希"铸造幽灵证据块，目录内文件被冒烟却永不参与
 * 排名（bestofn 全 unknown → 误导性零幸存者）。展开白名单与 smoke 一致。 */
const SMOKABLE = new Set(['.html', '.htm', '.js', '.mjs', '.cjs'])
function expandDirs(inputs) {
  const out = []
  for (const input of inputs) {
    try {
      if (statSync(input).isDirectory()) {
        for (const f of readdirSync(input)) {
          if (SMOKABLE.has('.' + f.split('.').pop().toLowerCase())) out.push(join(input, f))
        }
      } else {
        out.push(input)
      }
    } catch {
      out.push(input) // 不存在的路径原样转发，让下游给出自己的错误
    }
  }
  return out
}
const BUILD_INPUTS = expandDirs(ABS_INPUTS)

/** 收集所有 --summary 值（支持 "name=text" 逐候选与全局文本），原样转发给 build_evidence。 */
function collectSummaries() {
  const argv = process.argv
  const out = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--summary') continue
    const raw = argv[i + 1]
    if (raw !== undefined) out.push(raw)
  }
  return out
}

function findArg(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? i + 1 : -1
}

function run(script, args) {
  // vselftest-m4: cwd 钉扎在插件根（配合 ABS_INPUTS 绝对化，身份与 cwd 解耦）。
  const r = spawnSync(process.execPath, [join(__dirname, script), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: PLUGIN_ROOT })
  // Windows + undici: 子进程退出时 fetch 句柄清理竞态会打印无害的
  // "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" —— 过滤掉，不影响结果。
  const stderr = (r.stderr || '').split(/\r?\n/).filter((l) => !/Assertion failed: !\(handle->flags & UV_HANDLE_CLOSING\)/.test(l)).join('\n')
  return { code: r.status, stdout: r.stdout, stderr }
}

async function main() {
  if (INPUTS.length === 0) {
    console.error('usage: node scripts/evidence_chain.mjs <artifactOrDir...> [--summary <text|file>] [--out <dir>]')
    process.exit(2)
  }
  const smokeDir = join(OUT, 'smoke')
  const describeDir = join(OUT, 'describe')
  const evDir = join(OUT, 'evidence')

  console.log('[1/3] smoke ...')
  const s = run('smoke.mjs', [...ABS_INPUTS, '--out', smokeDir])
  if (s.code !== 0) console.log(s.stdout)
  if (s.stderr) process.stderr.write(s.stderr)

  console.log('[2/3] describe_visual ...')
  const smokeJsons = collectSmokeJsons(smokeDir)
  const shots = smokeJsons.map((j) => j.screenshot).filter(Boolean)
  if (SKIP_DESCRIBE || shots.length === 0) {
    console.log('  (skip describe: no screenshots or --skip-describe)')
  } else {
    const d = run('describe_visual.mjs', [...shots, '--out', describeDir])
    if (d.stderr) process.stderr.write(d.stderr)
  }

  console.log('[3/3] build_evidence ...')
  const summaries = collectSummaries()
  const summaryArgs = summaries.flatMap((s) => ['--summary', s])
  // DH-F1: 用展开后的文件清单（目录已在 expandDirs 展开）——幽灵目录块根除。
  const e = run('build_evidence.mjs', [...BUILD_INPUTS, ...summaryArgs, '--smoke-dir', smokeDir, '--describe-dir', describeDir, '--out', evDir])
  console.log(e.stdout)

  console.log(`\n证据链完成。最终证据: ${join(evDir, 'evidence.json')}`)
  if (!AS_JSON) console.log('下一步: 把 evidence.json 的候选块喂给 verifier select/compare 评分（可加 --summary 说明候选自述）。')
}

function collectSmokeJsons(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.smoke.json'))
      .map((f) => {
        try { return JSON.parse(readFileSync(join(dir, f), 'utf8')) } catch { return null }
      })
      .filter(Boolean)
  } catch { return [] }
}

main().catch((e) => { console.error('evidence_chain fatal:', e); process.exit(1) })