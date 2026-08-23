#!/usr/bin/env node
/**
 * M3 证据链自动化 — 证据与摘要拼接器。
 *
 * 把三类证据拼成一个"带来源标注"的评分输入块:
 *   1) 冒烟结果（smoke.mjs 产出的 .smoke.json: 错误/退出码/stdout/stderr/截图路径）
 *   2) 视觉描述（describe_visual.mjs 产出的 .describe.json: 五维）
 *   3) 候选摘要（可选，`--summary <text>` 或 <file>）
 *
 * 用法:
 *   node scripts/build_evidence.mjs <artifactOrSmokeJson...> [--summary <text|file>]
 *       [--dir <dir>] [--json]
 *
 * 输入可以给:
 *   - 产物文件（HTML/JS），自动找同名 .smoke.json + .describe.json
 *   - 直接给 .smoke.json / .describe.json 路径
 *
 * 输出: 一个带来源标注的证据文本块（verifier 的 select/compare 候选输入）:
 *   ── candidate: <name> ──────────────────
 *   ## 功能摘要（候选自述）
 *   <summary>
 *   ## 运行时观察（冒烟测试，非候选自述）
 *   ok / errors / exitCode / stdoutTail / stderrTail
 *   ## 视觉观察（截图描述，非候选自述）
 *   color / mood / detail_density / stylization / first_impression
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const OUT_DIR = resolve(process.argv[findArg('--out')] ?? join(process.cwd(), 'tmp_articles', 'evidence'))
const SMOKE_DIR = process.argv[findArg('--smoke-dir')] ? resolve(process.argv[findArg('--smoke-dir')]) : undefined
const DESCRIBE_DIR = process.argv[findArg('--describe-dir')] ? resolve(process.argv[findArg('--describe-dir')]) : undefined
const AS_JSON = process.argv.includes('--json')
const VALUED_ARGS = new Set(['--out', '--summary', '--smoke-dir', '--describe-dir'])
const INPUTS = process.argv.slice(2).filter((a, i, arr) => {
  if (a.startsWith('--')) return false
  return !VALUED_ARGS.has(arr[i - 1])
})

/** 收集所有 --summary 值；支持 "name=text"（逐候选）与 "text"（全局 fallback）。 */
function collectSummaries() {
  const per = new Map()
  let global
  const argv = process.argv
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--summary') continue
    const raw = argv[i + 1]
    if (raw === undefined) continue
    const eq = raw.indexOf('=')
    if (eq > 0) per.set(raw.slice(0, eq).trim(), raw.slice(eq + 1))
    else global = raw
  }
  return { per, global }
}

function findArg(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? i + 1 : -1
}

function readJson(file) {
  if (!existsSync(file)) return null
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

function readText(input) {
  if (!input) return undefined
  if (existsSync(input)) return readFileSync(input, 'utf8').trim()
  return input
}

function resolveRelated(base) {
  const stem = basename(base).replace(/\.(smoke|describe)\.json$/, '').replace(/\.[^.]+$/, '')
  const candidates = {
    smoke: [
      SMOKE_DIR && join(SMOKE_DIR, stem + '.smoke.json'),
      join(dirname(base), stem + '.smoke.json'),
      base.endsWith('.smoke.json') ? base : null,
    ].filter(Boolean),
    describe: [
      DESCRIBE_DIR && join(DESCRIBE_DIR, stem + '.describe.json'),
      join(dirname(base), stem + '.describe.json'),
      base.endsWith('.describe.json') ? base : null,
    ].filter(Boolean),
  }
  return {
    smoke: candidates.smoke.map(readJson).find(Boolean) ?? null,
    describe: candidates.describe.map(readJson).find(Boolean) ?? null,
  }
}

function renderSmoke(s) {
  if (!s) return '(无冒烟证据)'
  const lines = []
  lines.push(`冒烟: ${s.ok ? '✅ 通过' : '❌ 失败'} [${s.kind}]`)
  if (s.errors?.length) lines.push(`错误: ${s.errors.join('; ')}`)
  if (s.exitCode !== null && s.exitCode !== undefined) lines.push(`退出码: ${s.exitCode}`)
  if (s.timeout) lines.push(`超时: true`)
  if (s.stdoutTail) lines.push(`stdout(尾): ${s.stdoutTail.slice(0, 400)}`)
  if (s.stderrTail) lines.push(`stderr(尾): ${s.stderrTail.slice(0, 400)}`)
  if (s.screenshot) lines.push(`截图: ${s.screenshot}`)
  if (s.state) lines.push(`状态: ${JSON.stringify(s.state)}`)
  return lines.join('\n')
}

function renderDescribe(d) {
  if (!d) return '(无视觉描述)'
  const dims = d.dimensions || {}
  const parts = []
  if (dims.color) parts.push(`色彩: ${dims.color}`)
  if (dims.mood) parts.push(`氛围: ${dims.mood}`)
  if (dims.detail_density) parts.push(`细节密度: ${dims.detail_density}`)
  if (dims.stylization) parts.push(`风格: ${dims.stylization}`)
  if (dims.first_impression) parts.push(`第一印象: ${dims.first_impression}`)
  return parts.length ? parts.join('\n') : `(描述: ${d.raw?.slice(0, 200) || '无'})`
}

// F10: must match smoke.mjs's artifactName() exactly — stem + short hash of
// the resolved ORIGINAL path — so same-basename candidates never collide.
import { createHash } from 'node:crypto'
const shortHash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 8)
function artifactName(input) {
  // R3-19: when the input IS a .smoke.json/.describe.json, the original
  // artifact path is recorded in its `file` field — hashing the json path
  // used to produce a DIFFERENT name than smoke.mjs wrote (mismatch).
  let base = input
  if (/\.(smoke|describe)\.json$/i.test(input)) {
    try {
      const rec = JSON.parse(readFileSync(input, 'utf8'))
      if (typeof rec.file === 'string' && rec.file) base = rec.file
    } catch { /* fall back to the input path */ }
  }
  const stem = basename(base).replace(/\.(html?|js|cjs|mjs|smoke\.json|describe\.json)$/i, '')
  return `${stem}-${shortHash(resolve(base))}`
}

function buildBlock(input, summary) {
  const { smoke, describe } = resolveRelated(input)
  const name = artifactName(input)
  const lines = []
  lines.push(`── candidate: ${name} ──`)
  if (summary) {
    lines.push('## 功能摘要（候选自述）')
    lines.push(summary)
  }
  lines.push('## 运行时观察（冒烟测试，非候选自述）')
  lines.push(renderSmoke(smoke))
  lines.push('## 视觉观察（截图描述，非候选自述）')
  lines.push(renderDescribe(describe))
  return { name, text: lines.join('\n'), smoke, describe }
}

async function main() {
  if (INPUTS.length === 0) {
    console.error('usage: node scripts/build_evidence.mjs <artifactOrJson...> [--summary <text|file> | --summary <name>=<text>]... [--json]')
    process.exit(2)
  }
  const { per, global } = collectSummaries()
  const globalText = readText(global)
  mkdirSync(OUT_DIR, { recursive: true })
  const blocks = INPUTS.map((input) => {
    const name = artifactName(input)
    // 逐候选 summary 优先（--summary name=text），否则全局
    const summary = per.has(name) ? per.get(name) : globalText
    return buildBlock(input, summary)
  })
  if (AS_JSON) {
    console.log(JSON.stringify(blocks, null, 2))
  } else {
    for (const b of blocks) {
      console.log(b.text)
      console.log('')
    }
  }
  // 落盘供 verifier 消费
  const payload = {
    generatedAt: new Date().toISOString(),
    blocks: blocks.map((b) => ({ name: b.name, text: b.text })),
  }
  writeFileSync(join(OUT_DIR, 'evidence.json'), JSON.stringify(payload, null, 2), 'utf8')
  console.log(`(evidence written to ${join(OUT_DIR, 'evidence.json')})`)
}

main().catch((e) => { console.error('build_evidence fatal:', e); process.exit(1) })