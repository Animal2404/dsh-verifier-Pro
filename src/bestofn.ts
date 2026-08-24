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
import { existsSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
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
    // vselftest-m4：候选路径先绝对化——spawn 已钉 cwd=pluginRoot，相对路径
    // 若原样转发会在子进程里解析到错误位置。
    const absArtifacts = artifacts.map((a) => resolve(a))
    const args = [...absArtifacts, '--out', outDir]
    for (const [name, text] of summaries) args.push('--summary', `${name}=${text}`)
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
      finish({ code: timedOut ? 124 : (code ?? 1), stdout: stdout + (stderr ? `\n[stderr] ${stderr}` : '') + timedOutNote })
    })
    child.on('error', (e) => finish({ code: 1, stdout: `evidence_chain spawn error: ${e.message}` }))
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

/** Read per-candidate smoke status from evidence chain output dir. */
function smokeOk(outDir: string, name: string): boolean | undefined {
  const file = join(outDir, 'smoke', `${name}.smoke.json`)
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8')).ok === true
  } catch (e) {
    process.stderr.write(`[bestofn] ${name}.smoke.json 解析失败（按 unknown 处理）: ${e instanceof Error ? e.message : String(e)}\n`)
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
  const summaryMatch = /## 功能摘要（候选自述）\r?\n([\s\S]*?)\r?\n## 运行时观察/.exec(blockText)
  const smokeMatch = /## 运行时观察（冒烟测试，非候选自述）\r?\n([\s\S]*?)(?:\r?\n## |$)/.exec(blockText)
  const summary = summaryMatch ? summaryMatch[1].trim() : ''
  const smoke = smokeMatch ? smokeMatch[1].trim() : ''
  if (!summary || !smoke) return null // 缺段无法核对（unknown 已排除）

  const hasSmokeEvidence = !smoke.includes('(无冒烟证据)')
  const smokeFailed = smoke.includes('冒烟: ❌') || /退出码: [1-9]/.test(smoke) || smoke.includes('错误:')
  const smokeHasErrors = /错误:|❌/.test(smoke)

  // 1) 负面自述 vs 通过证据
  if (hasSmokeEvidence && !smokeFailed) {
    const negativeClaims = /(失败|不工作|未实现|无法|报错|不能|没有实现|有 bug|不完整)/.test(summary)
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

function parseArgs(rawInput: string): { positionals: string[]; summaries: Map<string, string>; quick: boolean; local: boolean; n: number; nClamped: boolean } {
  const tokens = rawInput.trim().split(/\s+/).filter(Boolean)
  const positionals: string[] = []
  const summaries = new Map<string, string>()
  let quick = false
  let local = false
  let n = 3
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
      while (j < tokens.length && !tokens[j].startsWith('-')) { parts.push(tokens[j]); j++ }
      const pair = parts.join(' ')
      const eq = pair.indexOf('=')
      if (eq > 0) {
        summaries.set(pair.slice(0, eq).trim(), pair.slice(eq + 1))
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
      if (Number.isFinite(val) && val > 0) {
        n = Math.min(Math.floor(val), MAX_BESTOFN_N)
        if (Math.floor(val) > MAX_BESTOFN_N) nClamped = true
        i++
      } else {
        process.stderr.write(`[bestofn] -n 忽略无效值: ${tokens[i + 1] ?? '(缺省)'}\n`)
      }
      continue
    }
    // 尾部 [N]：团队模式允许 "goal... N" 形式——纯数字的最后一个 positional 当 N。
    // P3-1: 只在 N ≤ MAX_BESTOFN_N（8）时吞掉——goal 文本以数字结尾时
    // （如 "/bestofn 修复 bug 42"），42 > 8 会保留在 goal 里，不再被误吞为 N。
    if (i === tokens.length - 1 && /^\d+$/.test(tok) && !local && positionals.length > 0) {
      const val = Number(tok)
      if (val > 0 && val <= MAX_BESTOFN_N) { n = Math.min(Math.floor(val), MAX_BESTOFN_N); continue }
    }
    positionals.push(tok)
  }
  return { positionals, summaries, quick, local, n, nClamped }
}

/** Build the follow-up activation directive that starts the team fan-out protocol. */
export function buildBestOfNActivation(goal: string, n: number): string {
  return [
    'The user invoked the `/bestofn` command. Activate the Best-of-N optimal-selection protocol from your instructions now: you are the captain of a multi-agent team.',
    `Goal: ${goal}`,
    `Candidate count: ${n} (spawn exactly ${n} members, each delivering a COMPLETE independent implementation of the goal — never split the task into aspects per member).`,
    '',
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
      const { positionals, summaries, quick, local: explicitLocal, n, nClamped } = parseArgs(invocation.rawInput)

      // 智能模式判定：全部 positional 是存在的文件（≥2 个）→ 本地对比；否则视为目标文字
      const local = explicitLocal || (positionals.length >= 2 && positionals.every((p) => existsSync(resolve(p))))
      const artifacts = local ? positionals : []
      const goal = local ? '' : positionals.join(' ')

      // vselftest-M-D（入口守卫）：目录候选会以"目录名+哈希"铸造幽灵证据块，
      // 目录内文件被冒烟却永不参与排名（DH-F1，交叉审阅定级 major）。本地模式
      // 明确拒绝并给出展开指引，而不是让用户收到误导性的零幸存者错误。
      if (local) {
        const dirPos = artifacts.filter((p) => { try { return statSync(resolve(p)).isDirectory() } catch { return false } })
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
          content: [{ type: 'text', text: buildBestOfNActivation(goal, n) }],
          source: { kind: 'user' },
        }))
        return {
          kind: 'success',
          text: `/bestofn activated — the captain will spawn ${n} members implementing: ${goal}${nClamped ? `\n⚠️ 请求的候选数超过上限，已截到 ${n}（MAX_BESTOFN_N=8）` : ''}`,
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
      // 1) 证据链（冒烟→视觉→拼接）
      const chain = await runEvidenceChain(artifacts, summaries, outDir)
      const blocks = readEvidence(outDir)
      if (blocks.length === 0) {
        return {
          kind: 'error',
          text: `/bestofn: 证据链未产出有效结果。\n${chain.stdout.slice(0, 500)}`,
        }
      }

      // 2) 崩溃候选出局；U-N14 三态化：smoke 记录缺失 = unknown，排除出
      // 排名而不是默认幸存——基础设施失败（如 Chrome 缺失）时淘汰保证不再静默失效。
      const smokeState = (name: string): 'ok' | 'crashed' | 'unknown' => {
        const ok = smokeOk(outDir, name)
        return ok === true ? 'ok' : ok === false ? 'crashed' : 'unknown'
      }
      const crashed = blocks.filter((b) => smokeState(b.name) === 'crashed')
      const unknownSmoke = blocks.filter((b) => smokeState(b.name) === 'unknown')
      const survivors = blocks.filter((b) => smokeState(b.name) === 'ok')

      const crashLines = (): string => {
        const parts: string[] = []
        if (crashed.length) parts.push(`❌ 崩溃出局: ${crashed.map((c) => c.name).join(', ')}`)
        if (unknownSmoke.length) parts.push(`❓ 无冒烟记录（不计入排名）: ${unknownSmoke.map((c) => c.name).join(', ')}`)
        return parts.join('\n')
      }

      if (survivors.length === 0) {
        return {
          kind: 'error',
          text: `/bestofn: 没有通过冒烟验证的候选，无法排名。\n${crashLines()}`,
        }
      }
      if (survivors.length === 1) {
        return {
          kind: 'success',
          text: `/bestofn: 仅一个候选存活（${survivors[0].name}），直接为冠军。\n${crashLines()}`.trim(),
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
        lines.push(`\n🏆 冠军: ${champion}`)
        lines.push(`排名: ${survivors.map((s, i) => `${i + 1}.${s.name} (${scores[i] !== undefined ? scores[i].toFixed(4) : '?'})`).join('  ')}`)
        // VAL 验证自主等级（P1-②）：幸存者都过了机器冒烟（ok=true）= 客观真值锚定 L2；
        // 但排名分本身仍是 LLM 判断（L0）。如实分层，用户可分辨「证据是机器证的，
        // 分数是模型评的」。
        lines.push(`\n🔒 验证锚定: 证据 L2（冒烟=机器验证的客观真值）· 评分 L0（LLM 判断）`)
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
  return [
    'The user invoked `/vselftest`. Run the AUDIT TRACK of your Best-of-N protocol now (you are the captain of a multi-agent team).',
    `Frozen scope (findings outside are rejected): E:\\DeepSeek\\dsh-verifier-brain\\src\\bestofn.ts and E:\\DeepSeek\\dsh-verifier-brain\\scripts\\smoke.mjs — focus: ${focusNote}`,
    'Anti-contamination: do NOT read AUDIT-*.md / CHANGELOG.md — only fresh findings from reading the actual source count; parroting known issues scores zero.',
    'N=2 lens-diverse members: member 1 = boldest defect-hunter (attack the design), member 2 = safest correctness-first (trace every code path). Every claim cites exact file:line PLUS a quoted snippet.',
    'You mechanically verify ≥30% of citations per report + ALL fatal findings via grep/read; a fabricated citation invalidates that finding and halves the member\'s weight. MANDATORY cross-review: each member names the other report\'s most fatal unsupported claim. Then verifier select("root_cause") over corrected reports, and deliver the final report labeling EVERY finding VERIFIED / REPORTED — no unlabeled findings ship.',
  ].join('\n')
}

export function registerSelfTestCommand(ctx: Context): void {
  ctx.effect(() => ctx.commands.register({
    name: 'vselftest',
    description: 'One-click verifier self-test: AUDIT-track team review of the plugin\'s own bestofn↔smoke collaboration boundary',
    input: { hint: '[focus note]  (optional — default: artifact-name hash ↔ smokeOk lookup, arg-parsing edges)' },
    async handler(invocation) {
      const focus = invocation.rawInput.trim()
        || 'the collaboration boundary between smoke.mjs artifactName hashing and bestofn smokeOk lookup, plus bestofn parseArgs edge cases'
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
