#!/usr/bin/env node
/**
 * M3 证据链自动化 — 五维视觉描述（多模态"眼睛"）。
 *
 * 用法:
 *   node scripts/describe_visual.mjs <image.png...> [--model mimo-v2.5]
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
 * 后端: OpenAI 兼容 chat/completions 多模态端点（默认 opencode-go 的 mimo-v2.5，
 * 凭据键 OPENCODE_GO_API_KEY 自动读取 ~/.dsh/.credentials.yaml）。
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, basename } from 'node:path'

const OUT_DIR = resolve(process.argv[findArg('--out')] ?? join(process.cwd(), 'tmp_articles', 'describe'))
const MODEL = process.argv[findArg('--model')] ?? 'mimo-v2.5'
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
    // trim 后匹配：兼容 DSH v1 refs: 节下缩进键（审计二修正——此前锚定行首假阴性）
    const m = text.split(/\r?\n/).find((l) => l.trim() === API_KEY_ENV + ':' + '' || l.trim().startsWith(API_KEY_ENV + ':'))
    if (m) return m.trim().slice(API_KEY_ENV.length + 1).trim().replace(/^["']|["']$/g, '')
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
    console.error('usage: node scripts/describe_visual.mjs <image.png...> [--model mimo-v2.5] [--json]')
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