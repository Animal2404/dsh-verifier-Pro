#!/usr/bin/env node
/**
 * M3 证据链自动化 — 泛化冒烟测试（两类产物，评审意见 2.5 收窄范围）。
 *
 * 用法:
 *   node scripts/smoke.mjs <fileOrDir...> [--out <dir>] [--cdp-port 9222]
 *                          [--ticks 300] [--wait 1500] [--json]
 *
 * 支持两类产物:
 *   1) HTML 文件        -> CDP 驱动 Chrome: 开屏、采集 console/exception 错误、
 *                          手动驱动 update() N 帧、截图
 *   2) Node.js 脚本     -> child_process 执行: 采集 stdout/stderr/退出码/超时
 *
 * 输出: 每个产物一个结构化 JSON（stdout 打印 + 落盘 <out>/<name>.smoke.json）:
 *   {
 *     "file": "...", "kind": "html" | "node",
 *     "ok": bool,                     // 无崩溃错误即视为通过
 *     "errors": [...],                // 崩溃/异常证据
 *     "exitCode"?: number, "timeout"?: bool,
 *     "stdoutTail"?: string, "stderrTail"?: string,
 *     "screenshot"?: "<out>/<name>.png",
 *     "state"?: {...}                 // HTML 运行时状态（尽力而为）
 *   }
 *
 * CDP 连接: 默认连 127.0.0.1:<port>；若无可用端点则自动拉起
 *   headless Chrome（--remote-debugging-port）并随后关闭。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'

const OUT_DIR = resolve(process.argv[findArg('--out')] ?? join(process.cwd(), 'tmp_articles', 'smoke'))
const CDP_PORT = Number(process.argv[findArg('--cdp-port')] ?? 9222)
const TICKS = Number(process.argv[findArg('--ticks')] ?? 300)
const WAIT_MS = Number(process.argv[findArg('--wait')] ?? 1500)
const AS_JSON = process.argv.includes('--json')

const VALUED_ARGS = new Set(['--out', '--cdp-port', '--ticks', '--wait'])
const INPUTS = process.argv.slice(2).filter((a, i, arr) => {
  if (a.startsWith('--')) return false
  return !VALUED_ARGS.has(arr[i - 1])
})

function findArg(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? i + 1 : -1
}

function collectFiles(inputs) {
  const out = []
  for (const input of inputs) {
    if (!existsSync(input)) { console.error(`smoke: not found: ${input}`); continue }
    const st = statSync(input)
    if (st.isDirectory()) {
      for (const f of readdirSync(input)) {
        const full = join(input, f)
        if (extname(f).toLowerCase() === '.html' || extname(f).toLowerCase() === '.js' || extname(f).toLowerCase() === '.mjs' || extname(f).toLowerCase() === '.cjs') out.push(full)
      }
    } else {
      out.push(input)
    }
  }
  return out
}

function kindOf(file) {
  return ['.html', '.htm'].includes(extname(file).toLowerCase()) ? 'html' : 'node'
}

// ---------- Node.js 冒烟 ----------
function smokeNode(file, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill() }, timeoutMs)
    child.stdout.on('data', d => { stdout += d.toString() })
    child.stderr.on('data', d => { stderr += d.toString() })
    child.on('close', (code) => {
      clearTimeout(timer)
      const errors = []
      if (timedOut) errors.push(`timeout after ${timeoutMs}ms`)
      else if (code !== 0) errors.push(`exit code ${code}`)
      resolve({
        file, kind: 'node', ok: errors.length === 0, errors,
        exitCode: code ?? null, timeout: timedOut,
        stdoutTail: stdout.slice(-2000), stderrTail: stderr.slice(-2000),
      })
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ file, kind: 'node', ok: false, errors: [String(e.message)], exitCode: null, stdoutTail: stdout.slice(-2000), stderrTail: stderr.slice(-2000) })
    })
  })
}

// ---------- CDP 客户端 ----------
async function cdpConnect(port) {
  let targets
  for (let i = 0; i < 20; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      if (targets.some(t => t.type === 'page')) break
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 500))
  }
  if (!targets?.some(t => t.type === 'page')) throw new Error(`no CDP page target on :${port}`)
  const page = targets.find(t => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  let seq = 0
  const pending = new Map()
  // 收集运行时异常（含异步 setTimeout/rAF 回调里的错误——审计 P0-3）
  const collectedExceptions = []
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params?.exceptionDetails
      const text = d?.exception?.description || d?.text || 'unknown exception'
      collectedExceptions.push(text.slice(0, 200))
    }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  }
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++seq
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    return r.result?.result?.value ?? r.result?.result?.description ?? JSON.stringify(r.result)
  }
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 960, height: 540, deviceScaleFactor: 1, mobile: false })
  return { send, evalJs, collectedExceptions, close: () => { try { ws.close() } catch {} } }
}

// ---------- HTML 冒烟 ----------
/** 每个新文档创建时注入的错误采集器（导航不会丢失——审计 P0-3 修复）。 */
const ERR_COLLECTOR = `
window.__errs = [];
window.addEventListener('error', e => window.__errs.push(String(e.message)));
window.addEventListener('unhandledrejection', e => window.__errs.push('unhandledrejection: ' + String(e.reason)));
'ok'`

// ---------- F10: collision-proof artifact naming ----------
// Two candidates in different directories may share a basename (two
// `index.html`); the later one used to silently overwrite the earlier one's
// .smoke.json. A short hash of the resolved path disambiguates while staying
// deterministic across build_evidence.mjs (which derives names identically).
import { createHash } from 'node:crypto'
const shortHash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 8)
function artifactName(file) {
  const stem = basename(file).replace(/\.[^.]+$/, '')
  return `${stem}-${shortHash(resolve(file))}`
}

async function smokeHtml(cdp, file, outDir) {
  const name = artifactName(file)
  const fileUrl = 'file:///' + resolve(file).replace(/\\/g, '/')
  // 清空上一候选的异常残留，避免会话级收集器跨候选串扰
  cdp.collectedExceptions.length = 0
  // R3-10: ERR_COLLECTOR is injected ONCE per CDP session (in main) — the old
  // per-candidate addScriptToEvaluateOnNewDocument accumulated k collectors
  // after k candidates, each pushing into the same window.__errs and inflating
  // the error count by up to k× per page.
  await cdp.send('Page.navigate', { url: fileUrl })
  await new Promise(r => setTimeout(r, WAIT_MS))
  const result = await cdp.evalJs(`
    (function(){
      try {
        const hasUpdate = typeof update === 'function';
        if (typeof startGame === 'function') startGame();
        else if (typeof window.start === 'function') window.start();
        else if (typeof window.init === 'function') window.init();
        let errs = [];
        let ticksRun = 0;
        for (let i = 0; i < ${TICKS}; i++) {
          try { if (hasUpdate) { update(); ticksRun++ } else break; }
          catch (e) { errs.push(String(e.message) + ' @' + i); break; }
        }
        if (typeof draw === 'function') { try { draw(); } catch (e) { errs.push('draw: ' + e.message); } }
        let state = null
        try { state = (typeof state !== 'undefined') ? state : null } catch {}
        const p = (typeof player !== 'undefined' && player) ? { x: Math.round(player.x), y: Math.round(player.y) } : null
        return JSON.stringify({ hasUpdate, ticksRun, errors: errs.slice(0, 5), globalErrs: (window.__errs || []).slice(0, 5), state, player: p })
      } catch (e) { return JSON.stringify({ fatal: String(e.message) }) }
    })()
  `)
  let parsed
  try { parsed = JSON.parse(result) } catch { parsed = { raw: result } }
  // globalErrs 现在来自新文档的监听器（真实页面错误）+ CDP exceptionThrown 事件
  const errors = [...(parsed.errors || []), ...(parsed.globalErrs || []), ...(parsed.fatal ? [parsed.fatal] : []), ...cdp.collectedExceptions]
  // 无 update 函数的静态页：探针无法驱动行为，显式标记 unknown 而非静默 ok:true（审计 P0-3）
  const probeable = parsed.hasUpdate === true
  if (!probeable && errors.length === 0) {
    // R3-9: the note promised "验证加载无错+截图" but the screenshot was
    // never taken — static pages silently lost their visual-evidence block.
    const screenshot = join(outDir, `${name}.png`)
    try {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(screenshot, Buffer.from(shot.result.data, 'base64'))
    } catch { /* screenshot best-effort */ }
    return {
      file, kind: 'html', ok: true,
      note: 'probe-skip: 页面无可驱动的 update() 探针，仅验证加载无错+截图；行为正确性未测',
      probeSkipped: true,
      errors, screenshot: existsSync(screenshot) ? screenshot : null,
      state: parsed.state ?? null, player: parsed.player ?? null,
      ticksDone: false,
    }
  }
  const screenshot = join(outDir, `${name}.png`)
  try {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(screenshot, Buffer.from(shot.result.data, 'base64'))
  } catch { /* screenshot best-effort */ }
  return {
    file, kind: 'html', ok: errors.length === 0, errors,
    screenshot: existsSync(screenshot) ? screenshot : null,
    state: parsed.state ?? null, player: parsed.player ?? null,
    ticksDone: parsed.ticksRun > 0 ? true : null,
  }
}

// ---------- 自动拉起/释放 headless Chrome ----------
async function withChrome(fn) {
  let chrome
  try {
    await cdpConnect(CDP_PORT) // 已有端点直接复用
  } catch {
    const candidates = [
      process.env.CHROME_PATH,
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ].filter(Boolean)
    const found = candidates.find(c => existsSync(c))
    if (!found) throw new Error('no Chrome found; set CHROME_PATH or start one with --remote-debugging-port=' + CDP_PORT)
    chrome = spawn(found, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--disable-gpu', '--no-first-run', 'about:blank'], { stdio: 'ignore' })
    for (let i = 0; i < 40; i++) {
      try { await cdpConnect(CDP_PORT); break } catch { await new Promise(r => setTimeout(r, 500)) }
    }
  }
  try {
    return await fn()
  } finally {
    if (chrome) chrome.kill()
  }
}

async function main() {
  const files = collectFiles(INPUTS)
  if (files.length === 0) {
    console.error('usage: node scripts/smoke.mjs <fileOrDir...> [--out <dir>] [--cdp-port 9222] [--ticks 300] [--wait 1500]')
    process.exitCode = 2
    return
  }
  mkdirSync(OUT_DIR, { recursive: true })
  const htmlFiles = files.filter(f => kindOf(f) === 'html')
  const nodeFiles = files.filter(f => kindOf(f) === 'node')
  const results = []

  // Node 冒烟并行
  await Promise.all(nodeFiles.map(async (f) => {
    const r = await smokeNode(f)
    results.push(r)
    writeFileSync(join(OUT_DIR, artifactName(f) + '.smoke.json'), JSON.stringify(r, null, 2), 'utf8')
  }))

  // HTML 冒烟（共享一个 CDP 会话）
  if (htmlFiles.length > 0) {
    await withChrome(async () => {
      const cdp = await cdpConnect(CDP_PORT)
      try {
        // R3-10: inject the error collector ONCE for the whole session (see
        // smokeHtml for why per-candidate injection was wrong).
        await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: ERR_COLLECTOR })
        for (const f of htmlFiles) {
          const r = await smokeHtml(cdp, f, OUT_DIR)
          results.push(r)
          writeFileSync(join(OUT_DIR, artifactName(f) + '.smoke.json'), JSON.stringify(r, null, 2), 'utf8')
        }
      } finally {
        cdp.close()
      }
    })
  }

  results.sort((a, b) => a.file.localeCompare(b.file))
  if (AS_JSON) {
    console.log(JSON.stringify(results, null, 2))
  } else {
    for (const r of results) {
      console.log(`${r.ok ? '✅' : '❌'} ${r.file} [${r.kind}]` +
        (r.errors.length ? ` errors=${JSON.stringify(r.errors)}` : '') +
        (r.exitCode !== null && r.exitCode !== undefined ? ` exit=${r.exitCode}` : '') +
        (r.screenshot ? ` shot=${r.screenshot}` : ''))
    }
    const ok = results.filter(r => r.ok).length
    console.log(`\n${ok}/${results.length} passed`)
  }
  // 自然退出（避免 process.exit 与 WebSocket/child 清理竞态触发 UV 断言）
  process.exitCode = results.every(r => r.ok) ? 0 : 1
}

main().catch(e => { console.error('smoke fatal:', e); process.exit(1) })