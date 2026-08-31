#!/usr/bin/env node
/**
 * M3 证据链自动化 — 五维视觉描述（多模态"眼睛"）。
 *
 * 用法:
 *   node scripts/describe_visual.mjs <image.png...> [--model mimo-v2.5-pro]
 *       [--base-url https://opencode.ai/zen/go/v1] [--api-key-env OPENCODE_GO_API_KEY]
 *       [--json] [--out <dir>]
 *
 * 输入: 一个或多个截图（smoke.mjs 的产物）
 * 输出: 每个截图一份五维结构化 JSON（色彩 / 氛围 / 细节密度 / 风格化 / 第一印象）:
 *   {
 *     "image": "...", "model": "...",
 *     "dimensions": {
 *       "color": "...", "mood": "...", "detail_density": "...",
 *       "stylization": "...", "first_impression": "..."
 *     },
 *     "raw": "完整描述文本"
 *   }
 *
 * 后端: OpenAI 兼容 chat/completions 多模态端点（默认 opencode-go 的 mimo-v2.5-pro，
 * 凭据键 OPENCODE_GO_API_KEY 自动读取 ~/.dsh/.credentials.yaml）。
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, basename } from 'node:path'

const OUT_DIR = resolve(process.argv[findArg('--out')] ?? join(process.cwd(), 'tmp_articles', 'describe'))
// D6（2026-08-28 审计）：默认模型名与桥侧模型档案（bridge_fix.py MODEL_PROFILES
// 的 'mimo-v2.5-pro'）对齐——此前 'mimo-v2.5' 与档案漂移，读者无法判断是否为同一模型。
const MODEL = process.argv[findArg('--model')] ?? 'mimo-v2.5-pro'
const BASE_URL = process.argv[findArg('--base-url')] ?? 'https://opencode.ai/zen/go/v1'
const API_KEY_ENV = process.argv[findArg('--api-key-env')] ?? 'OPENCODE_GO_API_KEY'
const AS_JSON = process.argv.includes('--json')

const VALUED_ARGS = new Set(['--out', '--model', '--base-url', '--api-key-env'])
const IMAGES = process.argv.slice(2).filter((a, i, arr) => {
  if (a.startsWith('--')) return false
  return !VALUED_ARGS.has(arr[i - 1])
})

function findArg(name) {
  const i = process.argv.indexOf(name)
  // N8: valued flag 后紧跟另一个 flag 时，flag 不被当作值吞掉（返回缺省）。
  if (i < 0 || i + 1 >= process.argv.length) return -1
  const val = process.argv[i + 1]
  if (val.startsWith('--')) return -1
  return i + 1
}

function apiKey() {
  if (process.env[API_KEY_ENV]) return process.env[API_KEY_ENV]
  try {
    const text = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
    // P3-4（2026-08-28 审计）：① 注释行（# KEY: ...）不得当凭据；② 行内注释
    // （sk-x # note）此前混进 key 导致鉴权失败——取值后先剥行内注释；
    // 引号值（"sk-x" / 'sk-x'）保留支持；refs: 节下缩进键经 trim 兼容。
    const m = text.split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => !l.startsWith('#') && l.startsWith(API_KEY_ENV + ':'))
    if (m) {
      const value = m.slice(API_KEY_ENV.length + 1).replace(/\s+#.*$/, '').trim()
      return value.replace(/^["']|["']$/g, '')
    }
  } catch { /* best-effort */ }
  return undefined
}

const PROMPT = `You are a precise visual observer for an AI verification pipeline. Describe the screenshot across exactly five dimensions, each in 1-2 short sentences. Be objective and factual; report only what is visible.

1) color: dominant colors and overall palette
2) mood: overall atmosphere or emotional tone conveyed
3) detail_density: how much visual detail / information density the frame has
4) stylization: art style, rendering style, or visual language (e.g. pixel art, vector, photo-real, flat)
5) first_impression: one-line first impression of what this screen shows

Reply with ONLY a JSON object like:
{"color":"...","mood":"...","detail_density":"...","stylization":"...","first_impression":"..."}`

async function describeOne(imagePath) {
  const b64 = readFileSync(imagePath).toString('base64')
  const mime = imagePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg'
  const resp = await fetch(`${BASE_URL.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey()}` },
    // P3-3（2026-08-28 审计）：fetch 无超时——挂死的端点会让 evidence_chain
    // 的 spawnSync 一起卡住（最坏拖到 bestofn 外层 10min 硬超时）。30s 上限。
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      model: MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
        ],
      }],
    }),
  })
  const text = await resp.text()
  if (!resp.ok) throw new Error(`describe_visual: HTTP ${resp.status}: ${text.slice(0, 500)}`)
  const body = JSON.parse(text)
  const content = body.choices?.[0]?.message?.content ?? ''
  // 提取 JSON 对象（模型可能包在 ```json 块里或混有说明文字）
  const jsonMatch = content.match(/\{[\s\S]*\}/)
  let dimensions
  try {
    dimensions = JSON.parse(jsonMatch?.[0] ?? '{}')
  } catch {
    dimensions = { raw: content }
  }
  return { image: imagePath, model: MODEL, dimensions, raw: content }
}

async function main() {
  if (IMAGES.length === 0) {
    console.error('usage: node scripts/describe_visual.mjs <image.png...> [--model mimo-v2.5-pro] [--json]')
    process.exit(2)
  }
  if (!apiKey()) {
    console.error(`describe_visual: no API key for ${API_KEY_ENV}`)
    process.exit(2)
  }
  mkdirSync(OUT_DIR, { recursive: true })
  const results = []
  for (const img of IMAGES) {
    if (!existsSync(img)) { console.error(`describe_visual: not found: ${img}`); continue }
    try {
      const r = await describeOne(img)
      results.push(r)
      writeFileSync(join(OUT_DIR, basename(img).replace(/\.[^.]+$/, '') + '.describe.json'), JSON.stringify(r, null, 2), 'utf8')
      if (!AS_JSON) console.log(`✅ ${img} [${MODEL}]`)
    } catch (e) {
      console.error(`❌ ${img}: ${e.message}`)
    }
  }
  if (AS_JSON) console.log(JSON.stringify(results, null, 2))
  // 关闭 undici 全局连接池，避免 Windows 上退出时的句柄清理竞态
  // (间歇性 "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)")
  try {
    const dispatcher = globalThis[Symbol.for('undici.globalDispatcher.1')]
    if (dispatcher?.close) await dispatcher.close()
  } catch { /* best-effort */ }
  process.exit(results.length === IMAGES.length ? 0 : 1)
}

main().catch((e) => { console.error('describe_visual fatal:', e); process.exit(1) })