// P2-1（2026-08-28 审计）：prompt 模板字面量卫生回归——
// 悬空反引号（如 "strategy change.`" 的裸 ` 字符）会污染每个会话的 system prompt。
// 判据：每个 section 的输出中反引号计数必须为偶数（\` 转义对出现），
// 且 section 1 的收尾必须干净地结束于预期短语。
// 需要 lib/prompt.js（先 npm run build —— CI harness job 转译后自动覆盖）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const libPrompt = join(here, '..', 'lib', 'prompt.js')
// Windows：动态 import 需要 file:// URL（裸盘符路径会 ERR_UNSUPPORTED_ESM_URL_SCHEME）。
const libPromptUrl = pathToFileURL(libPrompt).href
const libMissing = !existsSync(libPrompt)

const backtickCount = (s) => (s.match(/`/g) ?? []).length

test('P2-1: verifierUsageSection 无悬空反引号（计数为偶数）且收尾干净', { skip: libMissing && 'lib/ not built — run npm run build first' }, async () => {
  const { verifierUsageSection } = await import(libPromptUrl)
  const sec = verifierUsageSection()
  assert.ok(sec.length > 100, 'section 不应为空')
  assert.equal(backtickCount(sec) % 2, 0, `反引号计数应为偶数（悬空反引号会让其为奇数）: ${backtickCount(sec)}`)
  assert.ok(sec.trimEnd().endsWith('strategy change.'), 'section 收尾应为 "strategy change."（P2-1 悬空反引号已删）')
})

test('P2-1: bestOfNProtocolSection 无悬空反引号', { skip: libMissing && 'lib/ not built — run npm run build first' }, async () => {
  const { bestOfNProtocolSection } = await import(libPromptUrl)
  const sec = bestOfNProtocolSection()
  assert.ok(sec.length > 100, 'section 不应为空')
  assert.equal(backtickCount(sec) % 2, 0, `反引号计数应为偶数: ${backtickCount(sec)}`)
})

test('P2-1: usage section 首句列出全部 12 个 action（D2 回归）', { skip: libMissing && 'lib/ not built — run npm run build first' }, async () => {
  const { verifierUsageSection } = await import(libPromptUrl)
  const firstLine = verifierUsageSection().split('\n')[0]
  for (const action of ['select', 'compare', 'track', 'decompose', 'evaluate_session',
    'progress_start', 'progress_update', 'progress_close', 'task_start', 'task_status',
    'usage', 'config']) {
    assert.ok(firstLine.includes(action), `首句应列出 action: ${action}`)
  }
})
