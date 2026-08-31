/**
 * Sanity-check lib/client.js: must parse as a classic script (it will be
 * served as <script src>), and must contain the ModuleLoader wrapper.
 * Usage: node scripts/check_client.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const target = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const body = readFileSync(target, 'utf8')

if (!body.startsWith('window.__ModuleLoader__.load(')) {
  console.error('FAIL: missing ModuleLoader wrapper at head')
  process.exit(1)
}
if (!body.trimEnd().endsWith('});')) {
  console.error('FAIL: wrapper footer truncated')
  process.exit(1)
}
try {
  // Classic-script syntax check: Function constructor parses without executing.
  new Function(body)
} catch (e) {
  console.error('FAIL: syntax error —', e.message)
  process.exit(1)
}
console.log(`client.js OK (${body.length} chars, wrapper + syntax verified)`)
