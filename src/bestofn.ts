/**
 * M4-B `/bestofn` 命令：证据链 + 优选闭环（最小可用，无团队依赖）。
 *
 * 用法（Web GUI 斜杠命令）:
 *   /bestofn <candidate1> <candidate2> ... [--summary name=text]... [--quick]
 *
 * 流程:
 *   1. 对每个候选产物跑 M3 证据链（evidence_chain.mjs: 冒烟→视觉→拼接）
 *   2. 崩溃候选（smoke.ok=false）直接出局，不参与优选
 *   3. 幸存者证据块 → verifier select（含自适应 K 升级）
 *   4. 报告排名 + 分数 + 升级元数据；--quick 直接给冠军，否则提示整合
 *
 * 设计边界（B 形态）: 候选来自本地已有产物（HTML/JS），不实时派成员生成。
 * 团队 fan-out 是 A 形态，作为下一步接入。
 */
import type { Context } from 'cordis'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isAbsolute, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type {} from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { PythonBridge } from './bridge.js'
import type { VerifierStore } from './persist.js'
import type { EscalationDeps } from './tools.js'

const pluginRoot = fileURLToPath(new URL('..', import.meta.url))

interface BestOfNResult {
  rankings: Array<{ name: string; ok: boolean; index?: number; score?: number; reason?: string }>
  champion?: string
  note?: string
}

/**
 * Run evidence_chain.mjs as a subprocess; returns its exit code + stdout.
 * P0-4 hardening: hard timeout (default 10min) with SIGTERM→SIGKILL escalation
 * so a hung CDP/browser smoke can no longer wedge the /bestofn command forever.
 */
function runEvidenceChain(
  artifacts: string[],
  summaries: Map<string, string>,
  outDir: string,
  timeoutMs = 10 * 60_000,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolvePromise) => {
    // B16: 候选已在 handler 按会话工作区绝对化（N7 resolveFrom），此处的 resolve()
    // 对绝对路径是防御性 no-op——保留它以防未来其他调用方传入相对路径。
    const absArtifacts = artifacts.map((a) => resolve(a))
    const args = [...absArtifacts, '--out', outDir]
    const tmpFiles: string[] = []
    for (const [name, text] of summaries) {
      // B17: 超长 summary 会撞 Windows argv 上限（~32K 字符）→ 落临时文件，
      // 以 `@file:<path>` 前缀引用（build_evidence 侧解引用）。
      if (text.length > 6000) {
        try {
          const tmp = join(tmpdir(), `bestofn-summary-${process.pid}-${Math.random().toString(36).slice(2, 8)}.txt`)
          writeFileSync(tmp, text, 'utf8')
          tmpFiles.push(tmp)
          args.push('--summary', `${name}=@file:${tmp}`)
          continue
        } catch { /* 落盘失败则回退内联 */ }
      }
      args.push('--summary', `${name}=${text}`)
    }
    let child: ReturnType<typeof spawn>
    try {
      // vselftest-m4（加固）：显式钉 cwd——四个进程的 resolve() 身份哈希依赖
      // 共享 CWD，此前靠继承巧合维持。
      child = spawn(process.execPath, [join(pluginRoot, 'scripts', 'evidence_chain.mjs'), ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: pluginRoot,
      })
    } catch (e) {
      resolvePromise({ code: 1, stdout: `evidence_chain spawn error: ${e instanceof Error ? e.message : String(e)}` })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    const finish = (result: { code: number; stdout: string }) => {
      if (settled) return
      settled = true
      clearTimeout(killer)
      resolvePromise(result)
    }
    // Hard timeout: SIGTERM first (graceful), SIGKILL 5s later (stubborn).
    const killer = setTimeout(() => {
      if (!settled && child.pid) {
        timedOut = true
        try { child.kill('SIGTERM') } catch { /* already dead */ }
        setTimeout(() => {
          if (!settled && child.pid) {
            try { child.kill('SIGKILL') } catch { /* already dead */ }
          }
        }, 5_000).unref()
      }
    }, timeoutMs)
    killer.unref()
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('close', (code) => {
      // F9: on Windows child.kill() yields signal=null — a boolean flag is the
      // only portable way to know we timed out (smoke.mjs does the same).
      const timedOutNote = timedOut ? `\n[evidence_chain killed after ${timeoutMs}ms timeout]` : ''
      for (const t of tmpFiles) { try { rmSync(t, { force: true }) } catch { /* best-effort */ } }
      finish({ code: timedOut ? 124 : (code ?? 1), stdout: stdout + (stderr ? `\n[stderr] ${stderr}` : '') + timedOutNote })
    })
    child.on('error', (e) => {
      for (const t of tmpFiles) { try { rmSync(t, { force: true }) } catch { /* best-effort */ } }
      finish({ code: 1, stdout: `evidence_chain spawn error: ${e.message}` })
    })
  })
}

/** Read evidence.json produced by evidence_chain into blocks. */
function readEvidence(outDir: string): Array<{ name: string; text: string }> {
  const file = join(outDir, 'evidence', 'evidence.json')
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(parsed.blocks) ? parsed.blocks : []
  } catch (e) {
    // vselftest-m5：损坏但存在的 evidence.json 不再伪装成"缺失"——诊断可见。
    process.stderr.write(`[bestofn] evidence.json 解析失败（按空证据处理）: ${e instanceof Error ? e.message : String(e)}\n`)
    return []
  }
}

/** F-G/N2: 读取完整冒烟记录（区分 ok=false / kind=unsupported / 缺失）。 */
function smokeRecord(outDir: string, name: string): { ok?: boolean; kind?: string } | undefined {
  const file = join(outDir, 'smoke', `${name}.smoke.json`)
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as { ok?: boolean; kind?: string }
  } catch (e) {
    // B7/m11: 损坏的 smoke.json 不再静默当 missing——记录在盘但不可读，给出诊断
    process.stderr.write(`[bestofn] ${name}.smoke.json 解析失败（记录在盘但损坏，按 unknown 处理）: ${e instanceof Error ? e.message : String(e)}\n`)
    return undefined
  }
}

/**
 * P1-① 声明-证据对照（借鉴 attest / ai-validator，机械可核对的 v1 范围）：
 * 把候选自述（--summary）与冒烟证据（运行时观察）逐条核对，抓「自述与证据
 * 矛盾」的候选——AI judge 容易被流畅的自述带偏（Gaming the Judge: 只重写
 * 推理不改事实，误报率可升 90%），这里是机器级兜底。
 *
 * 可机械检测的矛盾（诚实范围，不做语义理解）：
 *   1. 负面自述矛盾：自述含负面断言（失败/不工作/未实现/报错/无法），
 *      但冒烟 ok=true 且无错误 → 自述自我贬低与实际证据冲突。
 *   2. 错误遗漏：冒烟显示错误（错误:/退出码≠0），但自述声称全部成功
 *      （全部通过/无错误/完美/成功）→ 自述掩盖证据中的失败。
 *   3. 证据缺失：自述有强断言，但冒烟段是"(无冒烟证据)" → 无据背书。
 * 返回 null=一致；否则返回冲突描述。
 */
/** 导出供测试（P1-① 声明-证据对照的机械核对逻辑）。 */
export function crossCheckClaimEvidence(blockText: string): string | null {
  // m9 结论：段头锚点保持字面全称——格式漂移的检测由 tests/audit-contract.test.mjs
  // 契约③ 守护（CI 中断言 build_evidence 标题与此处正则同字面），此处不留模糊容忍
  // （容忍会把冒烟捕获组移位，静默破坏核对）。
  const summaryMatch = /## 功能摘要（候选自述）\r?\n([\s\S]*?)\r?\n## 运行时观察/.exec(blockText)
  const smokeMatch = /## 运行时观察（冒烟测试，非候选自述）\r?\n([\s\S]*?)(?:\r?\n## |$)/.exec(blockText)
  const summary = summaryMatch ? summaryMatch[1].trim() : ''
  const smoke = smokeMatch ? smokeMatch[1].trim() : ''
  if (!summary || !smoke) return null // 缺段无法核对（unknown 已排除）

  // F-H: 原始 stdout/stderr 尾片段是任意日志文本，其中出现"错误:"/"退出码: 1"/
  // "❌" 会伪造声明-证据矛盾——扫描只针对结构化行，剔除这两类原始尾巴。
  // （build_evidence 已把尾内容换行转义为 ⏎，整条尾巴只有一行，此处剥离即可完整剔除。）
  const smokeScan = smoke.split(/\r?\n/).filter((l) => !/^(stdout|stderr)\(尾\):/.test(l)).join('\n')

  const hasSmokeEvidence = !smokeScan.includes('(无冒烟证据)')
  const smokeFailed = smokeScan.includes('冒烟: ❌') || /退出码: [1-9]/.test(smokeScan) || smokeScan.includes('错误:')
  const smokeHasErrors = /错误:|❌/.test(smokeScan)

  // 1) 负面自述 vs 通过证据
  if (hasSmokeEvidence && !smokeFailed) {
    // B8: 收窄负面词——"未实现 X"/"无法"/"报错"等常出现在诚实自述的逐特性说明里，
    // 裸匹配会惩罚真话；只命中「整体否定」形态（全部/整体失败、启动即崩、有 bug 等）。
    const negativeClaims = /(全部|整体|整个|核心)(失败|不可用|不能运行|无法工作)|完全失败|直接报错|启动即(崩溃|报错)|根本(不能|无法)(运行|工作)|有 bug|功能不完整|没有(做出来|实现成功)/.test(summary)
    if (negativeClaims) {
      return '自述含负面断言（失败/未实现等），但冒烟通过且无错误——自述自我贬低与实际证据矛盾'
    }
  }
  // 2) 自述声称全对 vs 证据有错误
  const claimsAllGood = /(全部通过|无错误|完美|全部成功|零错误|完全正确|都通过)/.test(summary)
  if (claimsAllGood && smokeHasErrors) {
    return '自述声称全部成功/无错误，但冒烟证据包含错误——自述掩盖证据中的失败'
  }
  // 3) 自述强断言但证据缺失
  if (!hasSmokeEvidence && summary.length > 0) {
    return '自述有功能断言，但冒烟段无证据（(无冒烟证据)）——无据背书，分数仅供参考'
  }
  return null
}

/** F16: /bestofn spawns one member per candidate — keep fan-out sane. */
const MAX_BESTOFN_N = 8

/** 导出供测试（N3/F-B/N4/N6/F-I 的参数解析回归）。 */
export function parseArgs(rawInput: string): { positionals: string[]; summaries: Map<string, string>; quick: boolean; local: boolean; n: number; nClamped: boolean; nSource: 'explicit' | 'trailing' | 'default' } {
  const tokens = rawInput.trim().split(/\s+/).filter(Boolean)
  const positionals: string[] = []
  const summaries = new Map<string, string>()
  let quick = false
  let local = false
  let n = 3
  let nSource: 'explicit' | 'trailing' | 'default' = 'default'
  let nClamped = false
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok === '--quick') { quick = true; continue }
    if (tok === '--local') { local = true; continue }
    if (tok === '--summary') {
      // F16 + vselftest-M3/M-C：无论是否合法都消费到下一个 option-like token——
      // 此前仅在含 '=' 时回退 i，裸 summary 的值会漏回参数流污染
      // local/goal 判定（极端情况翻转成 team 模式拉起 N 个实现代理）。
      const parts: string[] = []
      let j = i + 1
      while (j < tokens.length && !tokens[j].startsWith('-')) {
        // N6/F-F: 值在「看起来像文件路径」的 token 处停止——`--summary a=x y b.html`
        // 不再把 b.html 吃进摘要（此前贪婪吞到 dash 才停，会把后续候选文件吞掉）。
        // 扩展名必须以字母开头：'0.85'/'v1.2' 这类小数结尾不误断（'.85' 不是文件后缀）。
        // B12: 首个 token 永不按文件形中断——`--summary a=README.md` 整体是摘要值。
        if (j > i + 1 && (/[\\/]/.test(tokens[j]) || /\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(tokens[j]))) break
        parts.push(tokens[j])
        j++
      }
      const pair = parts.join(' ')
      const eq = pair.indexOf('=')
      if (eq > 0) {
        // F-I: name 与 value 都 trim——`--summary name = text` 不再把前导空格转发给 build_evidence
        const sname = pair.slice(0, eq).trim()
        const sval = pair.slice(eq + 1).trim()
        // N9: 重复 key 静默后者覆盖——给出警告，避免用户以为两个候选各自有自述
        if (summaries.has(sname)) process.stderr.write(`[bestofn] --summary 重复 key 覆盖: ${sname}（后者覆盖前者）\n`)
        summaries.set(sname, sval)
      } else {
        // M-C：'='@0（空名）或无 '=' —— 拒收并告警。空名值曾以 '=text'
        // 形态落到 build_evidence 的 global 兜底，把单个候选的自述盖到全部候选。
        process.stderr.write(`[bestofn] --summary 忽略（需要 name=text 形式且 name 非空）: ${pair || '(空)'}\n`)
      }
      if (j > i + 1) i = j - 1
      continue
    }
    if (tok === '-n' || tok === '--n') {
      // vselftest-M4：仅在接受合法值时前进——此前无条件 i++ 会静默吞掉
      // 紧随其后的候选文件（'/bestofn a.html -n b.html c.html' 丢 b.html）。
      const val = Number(tokens[i + 1])
      // N4: 必须是正整数——`-n 0.5` 此前 Math.floor(0.5)=0 → "spawn exactly 0 members"
      // B11: 仅接受十进制数字——`-n 0x10`(=16)/`-n 1e2`(=100) 不再被静默接受
      if (/^\d+$/.test(tokens[i + 1] ?? '') && Number.isInteger(val) && val > 0) {
        n = Math.min(Math.floor(val), MAX_BESTOFN_N)
        if (Math.floor(val) > MAX_BESTOFN_N) nClamped = true
        nSource = 'explicit'
        i++
      } else {
        process.stderr.write(`[bestofn] -n 忽略无效值（需要正整数）: ${tokens[i + 1] ?? '(缺省)'}\n`)
      }
      continue
    }
    // 尾部 [N]：团队模式允许 "goal... N" 形式——纯数字的最后一个 positional 当 N。
    // P3-1: 只在 N ≤ MAX_BESTOFN_N（8）时吞掉——goal 文本以数字结尾时
    // （如 "/bestofn 修复 bug 42"），42 > 8 会保留在 goal 里，不再被误吞为 N。
    // m10/B10: 其余 positional 全像文件（扩展名/路径分隔符）时不吞——尾数更可能
    // 是用户误给的候选数而非目标文本，留给 handler 的救援逻辑处理。
    if (i === tokens.length - 1 && /^\d+$/.test(tok) && !local && positionals.length > 0) {
      const val = Number(tok)
      const restAreFiles = positionals.every((p) => /[\\/]/.test(p) || /\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(p))
      if (val > 0 && val <= MAX_BESTOFN_N && !restAreFiles) {
        n = Math.min(Math.floor(val), MAX_BESTOFN_N)
        nSource = 'trailing'
        continue
      }
    }
    positionals.push(tok)
  }
  return { positionals, summaries, quick, local, n, nClamped, nSource }
}

/** Build the follow-up activation directive that starts the team fan-out protocol. */
export function buildBestOfNActivation(goal: string, n: number, summaries?: Map<string, string>, quick?: boolean): string {
  const extras: string[] = []
  if (quick) extras.push('（用户指定 --quick：优选后直接给冠军，跳过整合建议）')
  if (summaries && summaries.size) {
    extras.push(`（用户提供的候选自述 --summary：${[...summaries.entries()].map(([k, v]) => `${k}=${v.slice(0, 60)}`).join(' ; ')}）`)
  }
  const extrasLine = extras.length ? `\n${extras.join('\n')}` : ''
  return [
    'The user invoked the `/bestofn` command. Activate the Best-of-N optimal-selection protocol from your instructions now: you are the captain of a multi-agent team.',
    `Goal: ${goal}`,
    `Candidate count: ${n} (spawn exactly ${n} members, each delivering a COMPLETE independent implementation of the goal — never split the task into aspects per member).`,
    extrasLine,
    'Run the full loop:',
    '1. agent_teams: create team, add N members, assign each the SAME task (complete implementation).',
    '2. Collect N artifacts (each member saves its deliverable to a path).',
    '3. Evidence chain per artifact: `node "' + join(pluginRoot, 'scripts', 'evidence_chain.mjs') + '" <artifact> --summary <name>=<self-description>`. Crash candidates (smoke ok=false) are eliminated on the spot; a candidate with NO smoke record (unknown) is also excluded from ranking — never assume it survived.',
    '4. Survivor evidence blocks -> verifier select (adaptive K handles close margins; flat results carry no ranking signal — confirm the top two with compare). If the confirming compare is also within the noise band, there is NO reliable champion: do not invent one, merge ALL survivors instead.',
    '5. Integrate: hand ALL survivors + scores to an integrator agent to merge the best parts -> merge smoke -> verifier compare(merged, champion-or-nominal-best) gate.',
    '6. Deliver the final result + the full score report (never fabricate or round away scores).',
  ].join('\n')
}

/** M4 command handler: mode is auto-detected (files → local, text → team). */
export function registerBestOfNCommand(ctx: Context, deps: {
  getBridge: () => Promise<PythonBridge>
  store: VerifierStore
  runner: (method: string, params: Record<string, unknown>) => Promise<unknown>
  defaultModel?: string
}): void {
  ctx.effect(() => ctx.commands.register({
    name: 'bestofn',
    description: 'Best-of-N optimal selection: give a goal (spawns N members, evidence chain, select, merge and gate) or file paths (scores existing artifacts)',
    input: { hint: '<goal> [N]   |   <file1> <file2> ...   |   --quick' },
    async handler(invocation) {
      const { positionals, summaries, quick, local: explicitLocal, n, nClamped, nSource } = parseArgs(invocation.rawInput)

      // N7: 相对路径锚定到会话工作区（用户真实 cwd），而非 host 进程 cwd——
      // host cwd 是 DSH 安装目录，相对路径在那里解析会落到错误位置。
      const baseDir = invocation.agent.session?.header?.cwd || process.cwd()
      const resolveFrom = (p: string): string => (isAbsolute(p) ? p : resolve(baseDir, p))

      // N3/F-C + B10/m10: 尾部数字救援——`/bestofn a.html b.html 9` 或 `/bestofn a.html 5`，
      // 尾数是纯数字且前序全部是已存在文件时，意图显然是本地对比：弹出数字按本地处理，
      // 而非翻转成 team 模式跑一个"文件名+数字"的垃圾 goal。parseArgs 已在「其余全像
      // 文件」时拒绝吞掉尾数，这里兜底处理全部漏网形态。
      let trailingN = ''
      const lastTok = positionals.length ? positionals[positionals.length - 1] : ''
      if (!explicitLocal && positionals.length >= 2 && /^\d+$/.test(lastTok)) {
        const rest = positionals.slice(0, -1)
        if (rest.every((p) => existsSync(resolveFrom(p)))) {
          trailingN = lastTok
          positionals.pop()
        }
      }

      // 智能模式判定：全部 positional 是存在的文件（≥2 个）→ 本地对比；否则视为目标文字
      let local = explicitLocal || (positionals.length >= 2 && positionals.every((p) => existsSync(resolveFrom(p))))

      // F-C/N3 + B2: 打错文件名守卫——≥1 个已存在文件 + 缺失项全部形似路径 → 报错，
      // 而不是翻转成 team 模式拉起 N 个代理跑一个"文件名"goal。「2 文件错 1」是最常见
      // 场景：只有 1 个存在文件，此前 existing.length>=2 使守卫失效。
      if (!local && !explicitLocal && positionals.length >= 2) {
        const existing = positionals.filter((p) => existsSync(resolveFrom(p)))
        const missing = positionals.filter((p) => !existsSync(resolveFrom(p)))
        const looksPath = (p: string) => /[\\/]/.test(p) || /\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(p)
        if (existing.length >= 1 && missing.length >= 1 && missing.every(looksPath)) {
          return {
            kind: 'error',
            text: `/bestofn: 以下候选路径不存在（疑似文件名打错）: ${missing.join(', ')}\n本地对比需要全部候选文件都存在；若确实要以文本为目标跑团队模式，请避免使用形如文件路径的词。`,
          }
        }
      }

      // B20: 单个已存在文件路径不是合法团队目标（会 spawn N 个代理实现一个文件名）
      if (!local && !explicitLocal && positionals.length === 1) {
        const only = positionals[0]
        if (existsSync(resolveFrom(only)) && (/[\\/]/.test(only) || /\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(only))) {
          return {
            kind: 'error',
            text: `/bestofn: 单个候选文件（${only}）无法对比——本地对比需要至少两个文件；若想跑团队模式请给文字目标。`,
          }
        }
      }

      // m7: 本地模式去重候选路径——`/bestofn a.html a.html` 不再产生同名冒烟互相覆盖
      const artifacts = local ? [...new Set(positionals)] : []
      const goal = local ? '' : positionals.join(' ')

      if (local && trailingN) {
        process.stderr.write(`[bestofn] 尾部数字 ${trailingN} 在本地对比模式下忽略（候选数参数仅团队模式有效）\n`)
      }

      // vselftest-M-D（入口守卫）：目录候选会以"目录名+哈希"铸造幽灵证据块，
      // 目录内文件被冒烟却永不参与排名（DH-F1，交叉审阅定级 major）。本地模式
      // 明确拒绝并给出展开指引，而不是让用户收到误导性的零幸存者错误。
      if (local) {
        // F-B: 显式 --local 下纯数字不是候选文件——拒绝而非生成幻影候选
        const numeric = artifacts.filter((p) => /^\d+$/.test(p))
        if (numeric.length) {
          return {
            kind: 'error',
            text: `/bestofn: 本地对比不接受纯数字候选: ${numeric.join(', ')}\n（尾部数字 N 仅团队模式有效；本地对比直接给文件路径即可）`,
          }
        }
        const missingArtifacts = artifacts.filter((p) => !existsSync(resolveFrom(p)))
        if (missingArtifacts.length) {
          return {
            kind: 'error',
            text: `/bestofn: 候选文件不存在: ${missingArtifacts.join(', ')}`,
          }
        }
        const dirPos = artifacts.filter((p) => { try { return statSync(resolveFrom(p)).isDirectory() } catch { return false } })
        if (dirPos.length) {
          return {
            kind: 'error',
            text: `/bestofn: 本地对比不支持目录候选（目录会破坏冒烟身份链）：${dirPos.join(', ')}\n请把目录展开为具体文件路径后重试。`,
          }
        }
      }

      // 空输入：简短引导（一键命令不该甩一大段 usage）
      if (!local && goal === '') {
        return {
          kind: 'error',
          text: '/bestofn 需要一个目标，例如：/bestofn 写一个贪吃蛇游戏 3\n（或给出至少两个已存在的文件路径来对比它们）',
        }
      }

      // 团队模式：followup 激活指令，让模型作为队长跑完整优选协议
      if (!local) {
        invocation.agent.followup(createUserMessage({
          // B15: --summary/--quick 透传给队长（此前静默丢弃）
          content: [{ type: 'text', text: buildBestOfNActivation(goal, n, summaries, quick) }],
          source: { kind: 'user' },
        }))
        // B1: 尾部数字被吞为 N 时显式告警——目标截断不再静默发生
        const nWarn = nSource === 'trailing'
          ? `\n⚠️ 尾部数字已作为候选数 N=${n}——若它是目标文本的一部分（如"做 3 个页面"），请改用 -n ${n} 显式指定候选数。`
          : ''
        return {
          kind: 'success',
          text: `/bestofn activated — the captain will spawn ${n} members implementing: ${goal}${nClamped ? `\n⚠️ 请求的候选数超过上限，已截到 ${n}（MAX_BESTOFN_N=8）` : ''}${nWarn}`,
        }
      }

      // 本地模式：证据链 → 崩溃出局 → select → 报告
      if (artifacts.length < 2) {
        return {
          kind: 'error',
          text: '本地对比需要至少两个候选文件，例如：/bestofn a.html b.html',
        }
      }

      // 每次运行独立子目录：防同名候选覆盖与陈旧证据背书（审计 P1-2/P1-4）
      const outDir = join(deps.store.stateDir, 'bestofn', new Date().toISOString().replace(/[:.]/g, '-'))
      // B13: bestofn/ 输出目录只增不减——保留最近 20 个运行，其余清理
      try {
        const bestofnRoot = join(deps.store.stateDir, 'bestofn')
        const olds = readdirSync(bestofnRoot).filter((d) => /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d{3}Z)?$/.test(d)).sort()
        for (const d of olds.slice(0, Math.max(0, olds.length - 20))) rmSync(join(bestofnRoot, d), { recursive: true, force: true })
      } catch { /* best-effort */ }
      // 1) 证据链（冒烟→视觉→拼接）——N7: 候选已按会话工作区绝对化
      const chain = await runEvidenceChain(artifacts.map(resolveFrom), summaries, outDir)
      const blocks = readEvidence(outDir)
      if (blocks.length === 0) {
        return {
          kind: 'error',
          text: `/bestofn: 证据链未产出有效结果。\n${chain.stdout.slice(0, 500)}`,
        }
      }
      // B4: 链未完整完成（超时 124 / 非零退出）但已有部分证据 → 报告必须显式标注，
      // 不能把部分候选集静默当完整集排名。
      const chainNote = chain.code !== 0
        ? `\n⚠️ 证据链未完整完成（exit code ${chain.code}${chain.code === 124 ? '：被超时终止' : ''}）——以下结果基于部分证据，仅供参考。`
        : ''

      // 2) 崩溃候选出局；U-N14 三态化：smoke 记录缺失 = unknown，排除出
      // 排名而不是默认幸存——基础设施失败（如 Chrome 缺失）时淘汰保证不再静默失效。
      // F-G/N2: unsupported（on-disk 但未执行）与 missing 分开标注——此前两者
      // 混用同一句"无冒烟记录"，unsupported 记录明明存在于盘上。
      const smokeState = (name: string): 'ok' | 'crashed' | 'unknown' | 'unsupported' => {
        const rec = smokeRecord(outDir, name)
        if (rec?.ok === true) return 'ok'
        if (rec?.ok === false) return 'crashed'
        if (rec?.kind === 'unsupported') return 'unsupported'
        return 'unknown'
      }
      const crashed = blocks.filter((b) => smokeState(b.name) === 'crashed')
      const unknownSmoke = blocks.filter((b) => smokeState(b.name) === 'unknown')
      const unsupportedSmoke = blocks.filter((b) => smokeState(b.name) === 'unsupported')
      const survivors = blocks.filter((b) => smokeState(b.name) === 'ok')

      const crashLines = (): string => {
        const parts: string[] = []
        if (crashed.length) parts.push(`❌ 崩溃出局: ${crashed.map((c) => c.name).join(', ')}`)
        if (unsupportedSmoke.length) parts.push(`⏭️ 类型不支持（未执行，不计入排名）: ${unsupportedSmoke.map((c) => c.name).join(', ')}`)
        if (unknownSmoke.length) parts.push(`❓ 无冒烟记录（不计入排名）: ${unknownSmoke.map((c) => c.name).join(', ')}`)
        return parts.join('\n')
      }

      if (survivors.length === 0) {
        return {
          kind: 'error',
          text: `/bestofn: 没有通过冒烟验证的候选，无法排名。\n${crashLines()}${chainNote}`,
        }
      }
      if (survivors.length === 1) {
        return {
          kind: 'success',
          text: `/bestofn: 仅一个候选存活（${survivors[0].name}），直接为冠军。\n${crashLines()}${chainNote}`.trim(),
        }
      }

      // 3) select 优选（含自适应 K）
      try {
        // P1-① 声明-证据对照：评分前把每个候选的自述与冒烟证据机械核对，
        // 矛盾候选的文本附上核对结论（评分模型会看到），并在报告中显式标注。
        const crossChecks = new Map<string, string | null>(
          survivors.map((b) => [b.name, crossCheckClaimEvidence(b.text)]),
        )
        const conflicting = survivors.filter((b) => crossChecks.get(b.name) != null)
        const annotate = (text: string, name: string): string => {
          const conflict = crossChecks.get(name)
          if (!conflict) return text
          return `${text}\n\n⚠️ [声明-证据核对] ${conflict}——该候选自述与机器证据矛盾，评分时请降低对其自述的信任、以证据为准。`
        }
        const selected = await deps.runner('select', {
          problem: 'Which candidate is best, judged on runtime evidence (not self-claims)?',
          candidates: survivors.map((b) => annotate(b.text, b.name)),
          criteria: {
            Correctness: 'Does it run without crashing and behave correctly (per smoke evidence)?',
            Evidence: 'Strength of verifiable runtime/visual evidence',
            Completeness: 'Does it fully implement the intended behavior?',
          },
          ...(deps.defaultModel ? { model: deps.defaultModel } : {}),
        }) as Record<string, unknown>

        // degraded（exact-flat 护栏）：全 0.5 = 批量失败被 tie 掩蔽，结果不可用于排名
        if (selected.signal === 'degraded') {
          return {
            kind: 'error',
            text: `/bestofn: 打分结果不可信 —— ${String(selected.warning ?? '全部分量精确等于 0.5，评估疑似被 on_error="tie" 掩蔽的批量失败')}。\n本次不产生排名。建议：更换评分模型重试（见 README 后端配置表），或人工复核候选。`,
          }
        }

        // unstable：不给冠军，呈现全部原始分数建议人工复核（自家 prompt 铁律）
        if (selected.signal === 'unstable') {
          const lines: string[] = []
          lines.push(`## /bestofn 优选报告 — ⚠️ 信号不稳定`)
          const crashInfo = crashLines()
          if (crashInfo) lines.push(`\n${crashInfo}`)
          lines.push(`\n多次评估胜者不一致，本次不产生冠军。全部原始评估如下，请人工复核：`)
          const reps = Array.isArray(selected.reps) ? selected.reps as Array<Record<string, unknown>> : []
          reps.forEach((r, i) => {
            lines.push(`  第${i + 1}次: reward_a=${r.reward_a} reward_b=${r.reward_b}`)
          })
          if (selected.initial || selected.escalated_result) {
            lines.push(`  首评: ${JSON.stringify(selected.initial)}`)
            lines.push(`  升级评: ${JSON.stringify(selected.escalated_result)}`)
          }
          return { kind: 'success', text: lines.join('\n') }
        }

        const index = Number(selected.index ?? -1)
        // R3-11: the winner index comes from an external scoring model — an
        // out-of-range/NaN index used to silently announce `冠军: undefined`
        // while printing a plausible ranking. Explicitly fail instead.
        if (!Number.isInteger(index) || index < 0 || index >= survivors.length) {
          return {
            kind: 'error',
            text: `/bestofn: 评分返回的冠军索引非法（index=${String(selected.index)}，幸存候选 ${survivors.length} 个）。请人工复核候选，不要采信本结果。`,
          }
        }
        const scores = Array.isArray(selected.scores) ? selected.scores as number[] : []
        const champion = survivors[index]?.name
        const lines: string[] = []
        lines.push(`## /bestofn 优选报告`)
        const crashInfo2 = crashLines()
        if (crashInfo2) lines.push(`\n${crashInfo2}`)
        // B6: unknown 候选多为命名契约漂移信号（artifactName↔smokeRecord 零校验的补偿提示）
        if (unknownSmoke.length > 0) {
          lines.push(`\n⚠️ ${unknownSmoke.length} 个候选无冒烟记录——若候选文件确实存在，可能是 smoke.mjs ↔ build_evidence.mjs 的 artifactName 命名契约漂移，请核对两处哈希/命名逻辑一致性。`)
        }
        if (chainNote) lines.push(chainNote)
        lines.push(`\n🏆 冠军: ${champion}`)
        // B14: 排名按分数降序展示（此前按输入序编号，标签暗示排序却未排序）
        const ranked = survivors
          .map((s, i) => ({ name: s.name, score: scores[i] }))
          .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
        lines.push(`排名: ${ranked.map((r, i) => `${i + 1}.${r.name} (${r.score !== undefined ? r.score.toFixed(4) : '?'})`).join('  ')}`)
        // VAL 验证自主等级（P1-②）：幸存者都过了机器冒烟（ok=true）= 客观真值锚定 L2；
        // 但排名分本身仍是 LLM 判断（L0）。如实分层，用户可分辨「证据是机器证的，
        // 分数是模型评的」。
        // B18: ok=true 只证明「加载/运行未崩溃」，行为正确性未证明——L2 表述加限定
        lines.push(`\n🔒 验证锚定: 证据 L2（机器冒烟：确认加载/运行未崩溃；行为正确性未证明）· 评分 L0（LLM 判断）`)
        // P1-① 声明-证据对照结果（矛盾候选显式标注，警示用户勿轻信其自述）
        if (conflicting.length > 0) {
          lines.push(`\n🔍 声明×证据核对: ⚠️ ${conflicting.length} 个候选自述与冒烟证据矛盾——`)
          for (const b of conflicting) {
            lines.push(`  · ${b.name}: ${crossChecks.get(b.name)}`)
          }
        } else {
          lines.push(`\n🔍 声明×证据核对: 全部一致（无自述与证据矛盾）`)
        }
        if (selected.signal === 'flat') lines.push(`\n⚠️ 排名无信号（flat），建议用 compare 复核前二名`)
        if (selected.escalated) {
          lines.push(`📈 自适应升级: ${selected.k_used} 次评估取平均（margin ${selected.margin_before !== undefined ? Number(selected.margin_before).toFixed(3) : '?'} → ${selected.margin_after !== undefined ? Number(selected.margin_after).toFixed(3) : '?'}）`)
        }
        if (!quick && champion) {
          lines.push(`\n→ 整合建议: 把全部幸存候选 + 分数交给整合代理合并，再用 compare(合并版, 冠军) 门禁。`)
        }
        return { kind: 'success', text: lines.join('\n') }
      } catch (error) {
        return {
          kind: 'error',
          text: `/bestofn select 失败: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    },
  }), 'verifier-brain: /bestofn command')
}

/**
 * `/vselftest` 一键自检（用户要求的一键命令）：对插件自身的一个已知协作边界
 * （bestofn ↔ smoke 产物命名/参数解析）发起 AUDIT 轨团队审计。零参数开跑——
 * 范围冻结、反污染、引用核验、交叉审阅全部由系统提示词里的 AUDIT TRACK 承载，
 * 这里只负责激活与注入目标范围。
 */
export function buildSelfTestActivation(focusNote: string): string {
  // B5: 冻结范围路径从 pluginRoot 派生——插件装到任何位置/平台都不再硬编码 E:\DeepSeek
  const scope = `${join(pluginRoot, 'src', 'bestofn.ts')} and ${join(pluginRoot, 'scripts', 'smoke.mjs')}`
  return [
    'The user invoked `/vselftest`. Run the AUDIT TRACK of your Best-of-N protocol now (you are the captain of a multi-agent team).',
    `Frozen scope (findings outside are rejected): ${scope} — focus: ${focusNote}`,
    'Anti-contamination: do NOT read AUDIT-*.md / CHANGELOG.md — only fresh findings from reading the actual source count; parroting known issues scores zero.',
    'N=2 lens-diverse members: member 1 = boldest defect-hunter (attack the design), member 2 = safest correctness-first (trace every code path). Every claim cites exact file:line PLUS a quoted snippet.',
    'You mechanically verify ≥30% of citations per report + ALL fatal findings via grep/read; a fabricated citation invalidates that finding and halves the member\'s weight. MANDATORY cross-review: each member names the other report\'s most fatal unsupported claim. Then verifier select("root_cause") over corrected reports, and deliver the final report labeling EVERY finding VERIFIED / REPORTED — no unlabeled findings ship.',
  ].join('\n')
}

export function registerSelfTestCommand(ctx: Context): void {
  ctx.effect(() => ctx.commands.register({
    name: 'vselftest',
    description: 'One-click verifier self-test: AUDIT-track team review of the plugin\'s own bestofn↔smoke collaboration boundary',
    input: { hint: '[focus note]  (optional — default: artifact-name hash ↔ smokeRecord lookup, arg-parsing edges)' },
    async handler(invocation) {
      const focus = invocation.rawInput.trim()
        || 'the collaboration boundary between smoke.mjs artifactName hashing and bestofn smokeRecord lookup, plus bestofn parseArgs edge cases'
      invocation.agent.followup(createUserMessage({
        content: [{ type: 'text', text: buildSelfTestActivation(focus) }],
        source: { kind: 'user' },
      }))
      return {
        kind: 'success',
        text: '/vselftest activated — captain will run the AUDIT track (N=2, citation-verified) on the bestofn↔smoke boundary.',
      }
    },
  }), 'verifier-brain: /vselftest command')
}
