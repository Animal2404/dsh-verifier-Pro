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
import { readdirSync, readFileSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(process.argv[findArg('--out')] ?? join(process.cwd(), 'tmp_articles', 'chain'))
const SUMMARY = process.argv[findArg('--summary')]
const AS_JSON = process.argv.includes('--json')
const SKIP_DESCRIBE = process.argv.includes('--skip-describe')
const VALUED_ARGS = new Set(['--out', '--summary'])
const INPUTS = process.argv.slice(2).filter((a, i, arr) => {
  if (a.startsWith('--')) return false
  return !VALUED_ARGS.has(arr[i - 1])
})

function findArg(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? i + 1 : -1
}

function run(script, args) {
  const r = spawnSync(process.execPath, [join(__dirname, script), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
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
  const s = run('smoke.mjs', [...INPUTS, '--out', smokeDir])
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
  const summaryArgs = SUMMARY ? ['--summary', SUMMARY] : []
  const e = run('build_evidence.mjs', [...INPUTS, ...summaryArgs, '--smoke-dir', smokeDir, '--describe-dir', describeDir, '--out', evDir])
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