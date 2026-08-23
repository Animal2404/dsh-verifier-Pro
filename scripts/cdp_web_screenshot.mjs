/**
 * CDP-driven visual test of the dsh web UI:
 *   1. assumes a Chrome/Edge already listening on --remote-debugging-port=9223
 *   2. opens http://127.0.0.1:3080 in a new tab
 *   3. waits for the SPA to settle (fixed delay), captures a full-page PNG
 * Usage: node scripts/cdp_web_screenshot.mjs <outPng> [waitMs]
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'tmp_articles', 'web-verify.png')
const WAIT_MS = Number(process.argv[3] ?? 8000)
const CDP = 'http://127.0.0.1:9223'
const APP = 'http://127.0.0.1:3080'

async function cdpList() {
  const r = await fetch(`${CDP}/json/list`)
  if (!r.ok) throw new Error(`cdp list ${r.status}`)
  return r.json()
}

const version = await (await fetch(`${CDP}/json/version`)).json()
console.log('browser:', version.Browser)

// Fresh tab pointed at the app.
const created = await fetch(`${CDP}/json/new?${encodeURIComponent(APP)}`, { method: 'PUT' }).then((r) => r.json())
const wsUrl = created.webSocketDebuggerUrl
console.log('tab:', created.id)

const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

let seq = 0
const pending = new Map()
function send(method, params = {}) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((res, rej) => pending.set(id, { res, rej }))
}
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) {
    const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ')
    console.log(`[console.${msg.params.type}]`, text.slice(0, 300))
  }
  if (msg.method === 'Log.entryAdded') {
    console.log(`[log.${msg.params.entry.level}]`, String(msg.params.entry.text).slice(0, 300))
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails
    console.log('[exception]', (d.exception?.description || d.text || '').slice(0, 400))
  }
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) rej(new Error(msg.error.message)) ; else res(msg.result)
  }
}

await send('Page.enable')
await send('Runtime.enable')
await send('Log.enable')
// Chrome 120+: PUT /json/new?url often ignores the url — navigate explicitly.
await send('Page.navigate', { url: APP })
await new Promise((r) => setTimeout(r, 4000))

// Navigate into the session whose sidebar title matches SESSION_MATCH.
// Harden (#12): try exact → prefix → scroll-and-retry (virtualized sidebar
// rows only mount when scrolled into view); clicking a broad container does
// nothing, so we target the LEAF text node's nearest clickable ancestor.
const SESSION_MATCH = process.argv[4] ?? 'AI 编程助手'
async function clickSession() {
  const expr = (mode) => `(() => {
    const m = ${JSON.stringify(SESSION_MATCH)};
    const leaves = [...document.querySelectorAll('*')].filter(el =>
      el.childElementCount === 0 && (el.textContent || '').trim().length > 0 &&
      (${mode}));
    if (!leaves.length) return null;
    const leaf = leaves[leaves.length - 1];
    const hit = leaf.closest('button, a, [role="button"], li, [class*="item"]') || leaf.parentElement || leaf;
    hit.click(); leaf.click();
    return (hit.textContent || '').trim().slice(0, 50);
  })()`
  const exact = `(el.textContent).trim() === m`
  const prefix = `(el.textContent).trim().startsWith(m)`
  for (const mode of [exact, prefix]) {
    const r = await send('Runtime.evaluate', { expression: expr(mode), returnByValue: true })
    if (r.result && r.result.value) return r.result.value
  }
  // virtualized list: scroll the sidebar through its range and retry prefix
  for (let i = 0; i < 5; i++) {
    await send('Runtime.evaluate', { expression: 'window.scrollBy(0, 600); [...document.querySelectorAll("[class*=scroll],[class*=list]")].forEach(e => e.scrollTop = e.scrollTop + 400)' })
    await new Promise((r) => setTimeout(r, 700))
    const r = await send('Runtime.evaluate', { expression: expr(prefix), returnByValue: true })
    if (r.result && r.result.value) return r.result.value
  }
  return null
}
const clicked = await clickSession()
console.log('clicked session:', clicked)
await new Promise((r) => setTimeout(r, 8000))

// Step-scroll the transcript so virtualized rows mount.
for (let i = 0; i < 6; i++) {
  await send('Runtime.evaluate', { expression: 'window.scrollBy(0, document.body.scrollHeight / 4); window.scrollTo(0, document.body.scrollHeight)' })
  await new Promise((r) => setTimeout(r, 900))
}

const { result } = await send('Runtime.evaluate', {
  expression: `JSON.stringify({title: document.title, url: location.href, callRows: document.querySelectorAll("[data-chat-call-id]").length, verifierCards: [...document.querySelectorAll("div")].filter(d => /^🔍 (对比评审|择优评选|轨迹打分|进度追踪|异步任务|用量统计|verifier)/.test((d.textContent||"").trim())).length})`,
  returnByValue: true,
})
console.log('page probe:', result.value)

// Introspect one verifier card's React fiber to learn the real block shape.
const inspect = await send('Runtime.evaluate', {
  expression: `(() => {
    const cards = [...document.querySelectorAll('div')].filter(d => (d.textContent||'').trim().startsWith('🔍 verifier'));
    if (!cards.length) return 'no cards';
    const el = cards[cards.length - 1];
    const fk = Object.keys(el).find(k => k.startsWith('__reactFiber'));
    if (!fk) return 'no fiber key';
    let f = el[fk];
    for (let hop = 0; f && hop < 40; hop++) {
      const p = f.memoizedProps;
      if (p && typeof p === 'object' && ('block' in p)) {
        const b = p.block || {};
        const out = {
          topKeys: Object.keys(p),
          blockTopKeys: Object.keys(b),
          kind: b.kind,
          isError: b.isError,
          metaType: typeof b.meta,
          metaPreview: b.meta ? JSON.stringify(b.meta).slice(0, 200) : null,
          contentType: Array.isArray(b.content) ? (b.content[0] && Object.keys(b.content[0])) : typeof b.content,
          contentPreview: Array.isArray(b.content) ? JSON.stringify(b.content).slice(0, 300) : String(b.content).slice(0, 120),
          callName: b.call ? b.call.name : null,
          argsRawPreview: b.call && b.call.argsRaw ? b.call.argsRaw.slice(0, 80) : (b.argsRaw ? String(b.argsRaw).slice(0, 80) : null),
        };
        return JSON.stringify(out, null, 1);
      }
      f = f.return;
    }
    return 'no owner prop found walking up';
  })()`,
  returnByValue: true,
})
console.log('block inspect:', inspect.result.value)

const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(OUT, Buffer.from(shot.data, 'base64'))
console.log('saved:', OUT)

ws.close()
await fetch(`${CDP}/json/close/${created.id}`).catch(() => {})
process.exit(0)
