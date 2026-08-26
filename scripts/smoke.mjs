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
import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync, openSync, closeSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

// S22: `--` 分隔符后的 token 一律视为候选输入（允许以 '-' 开头的文件名）
const argv = process.argv.slice(2)
const ddash = argv.indexOf('--')
const optRegion = ddash >= 0 ? argv.slice(0, ddash) : argv
const forcedInputs = ddash >= 0 ? argv.slice(ddash + 1) : []

const OUT_DIR = resolve(process.argv[findArg('--out')] ?? join(process.cwd(), 'tmp_articles', 'smoke'))
// m5: --cdp-port 必须是十进制数字——NaN/负数/非数字不再静默产生 127.0.0.1:NaN 的误导性失败
const rawPort = process.argv[findArg('--cdp-port')]
let CDP_PORT = 9222
if (rawPort !== undefined) {
  if (/^\d+$/.test(rawPort)) CDP_PORT = Number(rawPort)
  else process.stderr.write(`[smoke] --cdp-port 忽略无效值: ${rawPort}（用默认 9222）\n`)
}
// vselftest-m2：值位垃圾（`--ticks x` → NaN）不再产生静默零循环/零等待。
const rawTicks = Number(process.argv[findArg('--ticks')])
// m5: --ticks 封顶 10000——`--ticks 1e9` 会注入浏览器侧长循环 → evalJs 30s 超时 → 假 crashed
const TICKS = Number.isFinite(rawTicks) && rawTicks > 0 ? Math.min(Math.floor(rawTicks), 10000) : 300
const rawWait = Number(process.argv[findArg('--wait')])
const WAIT_MS = Number.isFinite(rawWait) && rawWait > 0 ? Math.floor(rawWait) : 1500
const AS_JSON = optRegion.includes('--json')

const VALUED_ARGS = new Set(['--out', '--cdp-port', '--ticks', '--wait'])
// S21: 重复 valued flag 告警（首个生效，其余连同值被丢弃——不再静默）
for (const flag of VALUED_ARGS) {
  const n = optRegion.filter((a) => a === flag).length
  if (n > 1) process.stderr.write(`[smoke] 重复参数 ${flag} ×${n}——仅第一个生效\n`)
}
const INPUTS = [
  ...optRegion.filter((a, i, arr) => {
    if (a.startsWith('--')) return false
    return !VALUED_ARGS.has(arr[i - 1])
  }),
  ...forcedInputs,
]

function findArg(name) {
  // 只在 `--` 分隔符之前的选项区查找（S22: 分隔符后的 token 是输入不是选项）
  const i = optRegion.indexOf(name)
  // N8: valued flag 后紧跟另一个 flag（如 `--out --json`）时，flag 会被误当值吞掉
  // ——值必须是「不以 -- 开头」的 token，否则视为缺省（缺省由调用方兜底）。
  if (i < 0 || i + 1 >= optRegion.length) return -1
  const val = optRegion[i + 1]
  if (val.startsWith('--')) return -1
  // optRegion = process.argv.slice(2)：flag 在 process.argv 的位置是 i+2，值在 i+3
  return i + 3
}

function collectFiles(inputs) {
  const out = []
  const EXT = new Set(['.html', '.htm', '.js', '.mjs', '.cjs'])
  // S18: 目录递归展开（深度 ≤3、文件数 ≤200、跳过 node_modules/.git）——
  // 此前仅展开一层；显式文件输入原样保留（非 EXT 在下游标 unsupported）。
  const walk = (input, depth) => {
    if (out.length >= 200) return
    if (!existsSync(input)) { console.error(`smoke: not found: ${input}`); return }
    const st = statSync(input)
    if (st.isDirectory()) {
      if (depth > 3) return
      for (const f of readdirSync(input).sort()) {
        if (f === 'node_modules' || f === '.git' || f === '.smoke.lock') continue
        walk(join(input, f), depth + 1)
      }
    } else if (EXT.has(extname(input).toLowerCase())) {
      out.push(input)
    }
  }
  for (const input of inputs) walk(input, 0)
  return out
}

function kindOf(file) {
  return ['.html', '.htm'].includes(extname(file).toLowerCase()) ? 'html' : 'node'
}

// ---------- Node.js 冒烟 ----------
function smokeNode(file, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', timedOut = false, settled = false
    // S4/M1: SIGTERM 陷阱候选（process.on('SIGTERM') 不退出）会让 'close' 永不触发
    // → promise 永挂 → 记录永不落盘 → 整轮挂到 bestofn 外层 10min。三保险：
    // ① SIGTERM（30s 时）② SIGKILL 升级（3s 后）③ 硬回退 resolve（timeout+5s 兜底）。
    let killer = null, hardFallback = null
    const finish = (r) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killer) clearTimeout(killer)
      if (hardFallback) clearTimeout(hardFallback)
      resolve(r)
    }
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill() } catch { /* already dead */ }
      killer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already dead */ } }, 3000)
      hardFallback = setTimeout(() => {
        finish({
          file, kind: 'node', ok: false,
          errors: [`timeout after ${timeoutMs}ms（进程未响应终止，已强制结束）`],
          exitCode: null, timeout: true,
          stdoutTail: stdout.slice(-2000), stderrTail: stderr.slice(-2000),
        })
      }, timeoutMs + 5000)
    }, timeoutMs)
    child.stdout.on('data', d => { stdout = (stdout + d.toString()).slice(-65536) })
    child.stderr.on('data', d => { stderr = (stderr + d.toString()).slice(-65536) })
    child.on('close', (code) => {
      const errors = []
      if (timedOut) errors.push(`timeout after ${timeoutMs}ms`)
      else if (code !== 0) errors.push(code === null ? '进程被信号终止（退出码未知）' : `exit code ${code}`)
      finish({
        file, kind: 'node', ok: errors.length === 0, errors,
        exitCode: code ?? null, timeout: timedOut,
        stdoutTail: stdout.slice(-2000), stderrTail: stderr.slice(-2000),
      })
    })
    child.on('error', (e) => {
      finish({ file, kind: 'node', ok: false, errors: [String(e.message)], exitCode: null, stdoutTail: stdout.slice(-2000), stderrTail: stderr.slice(-2000) })
    })
  })
}

// ---------- CDP 客户端 ----------
async function cdpConnect(port) {
  let targets
  for (let i = 0; i < 20; i++) {
    try {
      // S20: /json 探测带超时——半开端点不再卡死探针（此前仅靠 bestofn 外层 10min 兜底）
      targets = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(3000) })).json()
      if (targets.some(t => t.type === 'page')) break
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 500))
  }
  if (!targets?.some(t => t.type === 'page')) throw new Error(`no CDP page target on :${port}`)
  const page = targets.find(t => t.type === 'page')
  return cdpConnectWs(page.webSocketDebuggerUrl)
}

/** 连接到指定 WebSocket 调试 URL（S5: 复用外部 Chrome 时连接新建的独立 tab）。 */
async function cdpConnectWs(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  let seq = 0
  const pending = new Map()
  // 收集运行时异常（含异步 setTimeout/rAF 回调里的错误——审计 P0-3）。
  // vselftest-M2：异常携带来源 frameId——Page.navigate 换页后旧页面的迟到异常
  // 不得记到新候选头上（此前无归属过滤 → 无辜候选被误判 crashed）。
  const collectedExceptions = [] // [{ text, contextId, frameId }]
  const ctxFrame = new Map()     // executionContextId -> frameId
  // S1: 按 frameId 追踪 context 集合——同 frame 跨导航时 frameId 不变，旧文档与
  // 新文档共享同一 frameId，仅凭 frameId 无法隔离迟到异常。smokeHtml 用「导航后
  // 新建的 context」过滤（旧文档的迟到异常被剔除）。
  const ctxByFrame = new Map()   // frameId -> Set<executionContextId>
  // N5: frameId 归属 fail-closed——未知来源（frameId 缺失）的异常不再默认记到
  // 当前候选头上。onclose/onerror：pending 全部拒绝，避免永久挂起。
  ws.onclose = () => {
    const err = new Error('CDP WebSocket closed while awaiting responses')
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err) }
    pending.clear()
  }
  ws.onerror = () => ws.close()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.method === 'Runtime.executionContextCreated') {
      const c = msg.params?.context
      if (c?.id !== undefined) {
        const fid = c.auxData?.frameId ?? null
        ctxFrame.set(c.id, fid)
        if (fid != null) {
          if (!ctxByFrame.has(fid)) ctxByFrame.set(fid, new Set())
          ctxByFrame.get(fid).add(c.id)
        }
      }
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params?.exceptionDetails
      const text = d?.exception?.description || d?.text || 'unknown exception'
      collectedExceptions.push({ text: String(text).slice(0, 200), contextId: d?.executionContextId ?? null, frameId: ctxFrame.get(d?.executionContextId) ?? null })
    }
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      // m2: CDP 协议级错误（{id, error}）必须 reject——此前 resolve 会让
      // Page.navigate 等错误形响应静默滑过 → 探针跑在旧页面上、旧证据记到新候选。
      if (msg.error) {
        clearTimeout(p.timer)
        p.reject(new Error(`CDP ${p.method}: ${msg.error.message || JSON.stringify(msg.error)}`))
      } else {
        p.resolve(msg)
      }
    }
  }
  // F-D: 每个 CDP 请求带超时（Node 路径同 30s 语义）——Chrome 半路死掉时
  // send() 拒绝而非永久挂起；连接断开时 pending 全部拒绝（onclose）。
  const send = (method, params = {}, timeoutMs = 30000) => new Promise((resolve, reject) => {
    const id = ++seq
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    pending.set(id, { method, timer, resolve: (m) => { clearTimeout(timer); resolve(m) }, reject })
    try {
      ws.send(JSON.stringify({ id, method, params }))
    } catch (e) {
      clearTimeout(timer)
      pending.delete(id)
      reject(e instanceof Error ? e : new Error(String(e)))
    }
  })
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    return r.result?.result?.value ?? r.result?.result?.description ?? JSON.stringify(r.result)
  }
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 960, height: 540, deviceScaleFactor: 1, mobile: false })
  return { send, evalJs, collectedExceptions, ctxByFrame, close: () => { try { ws.close() } catch {} } }
}

// ---------- HTML 冒烟 ----------
/** 每个新文档创建时注入的错误采集器（导航不会丢失——审计 P0-3 修复）。
 *  vselftest-M1：源码自守卫（浏览器侧幂等）——外部 Chrome 被多个运行复用时，
 *  addScriptToEvaluateOnNewDocument 会累积注册 k 份脚本；此前每份都重置
 *  __errs 并各挂一对监听器 → 错误被计 k×。改为首份安装、其余跳过。 */
const ERR_COLLECTOR = `
if (!window.__errCollectorInstalled) {
  // S7: 非可写/不可配置属性——页面脚本无法通过赋值清空 __errs 或伪装"已安装"。
  // （此前页面置 window.__errs=[] 即抹掉监听证据 → 对抗候选可隐身 → 假 ok。）
  var __errs = [];
  try {
    Object.defineProperty(window, '__errs', { value: __errs, writable: false, configurable: false });
    Object.defineProperty(window, '__errCollectorInstalled', { value: true, writable: false, configurable: false });
  } catch (e) { window.__errs = __errs; window.__errCollectorInstalled = true; }
  window.addEventListener('error', e => __errs.push(String(e.message)));
  window.addEventListener('unhandledrejection', e => __errs.push('unhandledrejection: ' + String(e.reason)));
  // S3: 计数页面自身的 rAF 调度——自驱动游戏靠 rAF 推进，探针手动 update() 会
  // 双重驱动 + 时间压缩（dt≈0 → 假 NaN/违例）。包装在文档起始注入（早于页面脚本）。
  var __origRaf = window.requestAnimationFrame.bind(window);
  window.__rafCalls = 0;
  window.requestAnimationFrame = function (cb) { window.__rafCalls++; return __origRaf(cb); };
}
'ok'`

// ---------- F10: collision-proof artifact naming ----------
// Two candidates in different directories may share a basename (two
// `index.html`); the later one used to silently overwrite the earlier one's
// .smoke.json. A short hash of the resolved path disambiguates while staying
// deterministic across build_evidence.mjs (which derives names identically).
// S19: 哈希 12 hex（48bit）——8 hex（32bit）生日碰撞概率在候选规模下非零。
import { createHash } from 'node:crypto'
const shortHash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12)
function artifactName(file) {
  const stem = basename(file).replace(/\.[^.]+$/, '')
  return `${stem}-${shortHash(resolve(file))}`
}

async function smokeHtml(cdp, file, outDir) {
  const name = artifactName(file)
  // S11/m8: file URL 逐段百分号编码——空格/#/? 路径此前会截断 URL → 加载错误文件
  // → 导航无 errorText → 探针跑在错内容上 → 假 ok。
  const fileUrl = 'file:///' + resolve(file).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')
  // 清空上一候选的异常残留 + 捕获本次导航的 frameId：vselftest-M2——旧页面
  // 的迟到异常按 frameId 过滤（清零发生在下一候选导航之前，纯时序屏障挡不住
  // A 页异步错误落进 B 的证据）。
  cdp.collectedExceptions.length = 0
  // S1: 记录导航前全部已存在的 context（旧文档）——同 frame 跨导航时 frameId 不变，
  // 迟到异常只能靠「context 是否导航后新建」隔离：旧文档异步回调在导航收尾期触发的
  // 异常携带旧 contextId（在 preNavCtx 里）→ 剔除，不再误记到新候选。
  const preNavCtx = new Set()
  for (const s of cdp.ctxByFrame.values()) for (const c of s) preNavCtx.add(c)
  const nav = await cdp.send('Page.navigate', { url: fileUrl })
  // F-E: 导航失败（文件不存在/无法加载）必须显式失败——此前只取 frameId，
  // errorText 被无视 → 不可加载页面被误报 ok:true。
  const navError = nav.result?.errorText
  if (navError) {
    return { file, kind: 'html', ok: false, errors: [`导航失败: ${navError}`], screenshot: null, state: null, player: null, ticksDone: null }
  }
  const currentFrameId = nav.result?.frameId ?? null
  await new Promise(r => setTimeout(r, WAIT_MS))
  // S9: 慢加载页在固定 WAIT 内可能尚未定义 update/start——轮询就绪（上限 3×500ms），
  // 就绪后才探针；超时未就绪则照旧 probe-skip（note 如实标注）。
  for (let i = 0; i < 3; i++) {
    const ready = await cdp.evalJs(`(typeof update === 'function') || (typeof startGame === 'function') || (typeof window.start === 'function')`)
    if (ready === true) break
    if (i < 2) await new Promise(r => setTimeout(r, 500))
  }
  const result = await cdp.evalJs(`
    (function(){
      try {
        const hasUpdate = typeof update === 'function';
        if (typeof startGame === 'function') startGame();
        else if (typeof window.start === 'function') window.start();
        else if (typeof window.init === 'function') window.init();
        let errs = [];
        let ticksRun = 0;
        // S3: 页面用 rAF 自驱动时不再手动 tick（双重驱动 + 时间压缩 → 假 NaN/违例）。
        // 由页面自己的 rAF 推进，探针只快照状态。非自驱动页照旧手动驱动。
        const selfDriven = (window.__rafCalls || 0) > 0;
        if (!selfDriven) {
          for (let i = 0; i < ${TICKS}; i++) {
            try { if (hasUpdate) { update(); ticksRun++ } else break; }
            catch (e) { errs.push(String(e.message) + ' @' + i); break; }
          }
        }
        if (typeof draw === 'function') { try { draw(); } catch (e) { errs.push('draw: ' + e.message); } }
        let pageState = null
        try { pageState = (typeof state !== 'undefined' && state != null) ? state : null } catch {}
        const p = (typeof player !== 'undefined' && player) ? { x: Math.round(player.x), y: Math.round(player.y) } : null
        const payload = { hasUpdate, ticksRun, selfDriven, errors: errs.slice(0, 5), globalErrs: (window.__errs || []).slice(0, 5), state: pageState, player: p }
        // S2: 游戏 state 常含循环引用/BigInt——整体序列化失败时降级为"丢弃 state
        // 但保留行为证据"，而不是把整个探针判 fatal → 合法候选被误判 crashed。
        try {
          return JSON.stringify(payload)
        } catch (serErr) {
          const stripped = Object.assign({}, payload, { state: null, player: null, stateOmitted: String(serErr && serErr.message ? serErr.message : serErr).slice(0, 80) })
          return JSON.stringify(stripped)
        }
      } catch (e) { return JSON.stringify({ fatal: String(e.message) }) }
    })()
  `)
  let parsed
  let unparsable = false
  try { parsed = JSON.parse(result) } catch { parsed = { raw: result }; unparsable = true }
  // N10: evaluate 结果不可用（渲染进程崩溃/WS 异常/错误响应）→ 显式失败而非假 PASS。
  // 覆盖形态：① JSON.parse 失败（含 result=undefined——错误响应时 evalJs 返回
  // undefined，parse 抛错）；② 解析结果是非对象（探针永远返回对象，其他类型说明
  // evaluate 已异常）。此前只查 parsed.raw != null，漏掉 undefined 形态 → 仍会落进
  // 静态页 ok:true 假 PASS。
  if (unparsable || parsed?.raw !== undefined || typeof parsed !== 'object') {
    const raw = String(result ?? JSON.stringify(parsed ?? null)).slice(0, 200)
    return {
      file, kind: 'html', ok: false,
      errors: [`Runtime.evaluate 结果不可用（渲染进程可能已崩溃）: ${raw}`],
      screenshot: null, state: null, player: null, ticksDone: null,
    }
  }
  // globalErrs 现在来自新文档的监听器（真实页面错误）+ CDP exceptionThrown 事件；
  // exceptionThrown 按 frameId 归属当前候选（vselftest-M2），上一页的迟到异常被滤除。
  // N5: fail-closed——frameId 未知（null/缺失）的异常不再记到当前候选头上
  // （fail-open 会把无关页面的异常误判为当前候选崩溃）。
  const frameErrors = cdp.collectedExceptions
    .filter((e) => e.frameId === currentFrameId && e.contextId != null && !preNavCtx.has(e.contextId))
    .map((e) => e.text)
  const errors = [...(parsed.errors || []), ...(parsed.globalErrs || []), ...(parsed.fatal ? [parsed.fatal] : []), ...frameErrors]
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
    const shotTaken = existsSync(screenshot)
    return {
      file, kind: 'html', ok: true,
      // S10: 截图失败时 note 不再宣称"已截图"——如实标注证据缺口
      note: shotTaken
        ? 'probe-skip: 页面无可驱动的 update() 探针，仅验证加载无错+截图；行为正确性未测'
        : 'probe-skip: 页面无可驱动探针且截图失败——仅验证加载无错；行为正确性与视觉证据均未测',
      probeSkipped: true,
      errors, screenshot: shotTaken ? screenshot : null,
      state: parsed.state ?? null, player: parsed.player ?? null,
      stateNote: parsed.stateOmitted || null,
      selfDriven: parsed.selfDriven === true,
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
    stateNote: parsed.stateOmitted || null,
    selfDriven: parsed.selfDriven === true,
    ticksDone: parsed.ticksRun > 0 ? true : null,
  }
}

// ---------- 自动拉起/释放 headless Chrome ----------
async function withChrome(fn) {
  let chrome
  let externalTarget = null
  let externalExists = false
  try {
    // vselftest-m6：探测连接用完即关（此前 reachability 探测的 WebSocket 泄漏）。
    const probe = await cdpConnect(CDP_PORT)
    probe.close()
    externalExists = true
  } catch { /* 无外部端点 → 自行拉起 */ }

  if (externalExists) {
    // S5: 复用外部 Chrome 时新建独立 tab（绝不导航用户的第一个 tab），
    // 导航/注入副作用只落在临时 tab 上，结束后关闭。
    try {
      const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(3000) })
      externalTarget = await resp.json()
      if (!externalTarget || !externalTarget.webSocketDebuggerUrl) throw new Error('bad /json/new response')
    } catch (e) {
      throw new Error(`external Chrome on :${CDP_PORT} 无法新建独立 tab（${e instanceof Error ? e.message : String(e)}）——为避免导航用户现有页面，本次放弃复用；请关掉该 Chrome 或换 --cdp-port`)
    }
  } else {
    const candidates = [
      process.env.CHROME_PATH,
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ].filter(Boolean)
    const found = candidates.find(c => existsSync(c))
    if (!found) throw new Error('no Chrome found; set CHROME_PATH or start one with --remote-debugging-port=' + CDP_PORT)
    // S17: 独立 --user-data-dir 临时 profile——避免与用户已开 Chrome 的 profile 锁冲突
    const userDataDir = join(tmpdir(), `dsh-smoke-chrome-${process.pid}`)
    chrome = spawn(found, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDataDir}`, '--disable-gpu', '--no-first-run', 'about:blank'], { stdio: 'ignore' })
    let ok = false
    for (let i = 0; i < 40 && !ok; i++) {
      try { const p = await cdpConnect(CDP_PORT); p.close(); ok = true } catch { await new Promise(r => setTimeout(r, 500)) }
    }
    if (!ok) throw new Error(`failed to start headless Chrome on :${CDP_PORT}`)
  }
  try {
    return await fn(externalTarget)
  } finally {
    if (chrome) chrome.kill()
    if (externalTarget && externalTarget.id) {
      try { await fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${externalTarget.id}`, { signal: AbortSignal.timeout(3000) }) } catch {}
    }
  }
}

// m4: 写盘失败不中止整轮——记录诊断并继续（node 路径此前无 try 全丢、
// html 路径被 catch 误包装成「CDP 冒烟失败」，两路径症状不一致）。
function safeWrite(file, data) {
  try { writeFileSync(file, data, 'utf8'); return true } catch (e) { console.error(`smoke: 写盘失败 ${file}: ${e.message}`); return false }
}

async function main() {
  const files = collectFiles(INPUTS)
  if (files.length === 0) {
    console.error('usage: node scripts/smoke.mjs <fileOrDir...> [--out <dir>] [--cdp-port 9222] [--ticks 300] [--wait 1500]')
    process.exitCode = 2
    return
  }
  mkdirSync(OUT_DIR, { recursive: true })
  // S6: 同 OUT_DIR 并发互斥——两个实例若共享同一 --out（含同端口 CDP），
  // 会在同一 tab 上交错导航、互相污染证据。用排他锁文件拒绝并发。
  const lockPath = join(OUT_DIR, '.smoke.lock')
  try {
    const fd = openSync(lockPath, 'wx')
    writeFileSync(fd, String(process.pid) + '\n')
    closeSync(fd)
  } catch {
    console.error(`smoke: ${OUT_DIR} 正被另一个 smoke 实例使用（存在 .smoke.lock）。本次退出，避免证据互相污染。`)
    process.exitCode = 3
    return
  }
  const RUNNABLE_NODE = new Set(['.js', '.mjs', '.cjs'])
  const htmlFiles = files.filter(f => kindOf(f) === 'html')
  // vselftest-m8：显式传入的非可运行文件（.md/.txt/…）不再被当 Node 脚本执行
  // 后报 "exit code 1"（误导性 crashed）——标记 unsupported，冒烟记录省略 ok
  // 字段 → 下游 smokeOk 判 undefined → unknown 排除出排名（U-N14 语义）。
  const nodeFiles = files.filter(f => kindOf(f) === 'node' && RUNNABLE_NODE.has(extname(f).toLowerCase()))
  const unsupportedFiles = files.filter(f => kindOf(f) === 'node' && !RUNNABLE_NODE.has(extname(f).toLowerCase()))
  const results = []

  for (const f of unsupportedFiles) {
    const r = { file: f, kind: 'unsupported', errors: [], exitCode: null, note: 'non-runnable file type — not executed; rename to .js/.mjs/.cjs or wrap in a runnable harness to behavior-smoke it' }
    results.push(r)
    safeWrite(join(OUT_DIR, artifactName(f) + '.smoke.json'), JSON.stringify(r, null, 2))
  }

  // Node 冒烟串行（S16: 并行会让绑定固定端口的候选互抢 → 假 crashed，且并行改变
  // 可观察行为——证据工具确定性优先于速度）
  for (const f of nodeFiles) {
    const r = await smokeNode(f)
    results.push(r)
    safeWrite(join(OUT_DIR, artifactName(f) + '.smoke.json'), JSON.stringify(r, null, 2))
  }

  // HTML 冒烟（共享一个 CDP 会话；复用外部 Chrome 时用独立新建的 tab）
  if (htmlFiles.length > 0) {
    await withChrome(async (externalTarget) => {
      const cdp = externalTarget ? await cdpConnectWs(externalTarget.webSocketDebuggerUrl) : await cdpConnect(CDP_PORT)
      try {
        // R3-10: inject the error collector ONCE per session. #15: a reused
        // EXTERNAL Chrome connection (--remote-debugging-port) across smoke
        // runs would re-inject per run — track on the connection so a given
        // browser target never accumulates duplicate collectors.
        if (!cdp.__errCollectorInjected) {
          await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: ERR_COLLECTOR })
          cdp.__errCollectorInjected = true
        }
        for (const f of htmlFiles) {
          // F-D/N10: 单个候选的 CDP 失败（超时/断连/崩溃）产出 crashed 记录，
          // 不再让整个 run 抛异常退出——其余候选继续冒烟，失败原因留在记录里。
          try {
            const r = await smokeHtml(cdp, f, OUT_DIR)
            results.push(r)
            safeWrite(join(OUT_DIR, artifactName(f) + '.smoke.json'), JSON.stringify(r, null, 2))
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            const r = { file: f, kind: 'html', ok: false, errors: [`CDP 冒烟失败: ${msg}`], exitCode: null, screenshot: null }
            results.push(r)
            safeWrite(join(OUT_DIR, artifactName(f) + '.smoke.json'), JSON.stringify(r, null, 2))
          }
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
      const mark = r.kind === 'unsupported' ? '⏭️' : (r.ok ? '✅' : '❌')
      console.log(`${mark} ${r.file} [${r.kind}]` +
        (r.errors?.length ? ` errors=${JSON.stringify(r.errors)}` : '') +
        (r.exitCode !== null && r.exitCode !== undefined ? ` exit=${r.exitCode}` : '') +
        (r.note ? ` note=${r.note}` : '') +
        (r.screenshot ? ` shot=${r.screenshot}` : ''))
    }
    const judged = results.filter(r => r.kind !== 'unsupported')
    const ok = judged.filter(r => r.ok).length
    const skipped = results.length - judged.length
    console.log(`\n${ok}/${judged.length} passed${skipped ? `（另 ${skipped} 个 unsupported 跳过）` : ''}`)
  }
  // 自然退出（避免 process.exit 与 WebSocket/child 清理竞态触发 UV 断言）。
  // vselftest-m8：unsupported 候选不计入失败（它们没被执行，不是崩溃）。
  process.exitCode = results.filter(r => r.kind !== 'unsupported').every(r => r.ok) ? 0 : 1
}

main().catch(e => { console.error('smoke fatal:', e); process.exit(1) })