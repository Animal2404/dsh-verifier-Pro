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
import { existsSync, readFileSync } from 'node:fs'
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
    const args = [...artifacts, '--out', outDir]
    for (const [name, text] of summaries) args.push('--summary', `${name}=${text}`)
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(process.execPath, [join(pluginRoot, 'scripts', 'evidence_chain.mjs'), ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
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
  } catch {
    return []
  }
}

/** Read per-candidate smoke status from evidence chain output dir. */
function smokeOk(outDir: string, name: string): boolean | undefined {
  const file = join(outDir, 'smoke', `${name}.smoke.json`)
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8')).ok === true
  } catch {
    return undefined
  }
}

/** F16: /bestofn spawns one member per candidate — keep fan-out sane. */
const MAX_BESTOFN_N = 8

function parseArgs(rawInput: string): { positionals: string[]; summaries: Map<string, string>; quick: boolean; local: boolean; n: number } {
  const tokens = rawInput.trim().split(/\s+/).filter(Boolean)
  const positionals: string[] = []
  const summaries = new Map<string, string>()
  let quick = false
  let local = false
  let n = 3
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok === '--quick') { quick = true; continue }
    if (tok === '--local') { local = true; continue }
    if (tok === '--summary') {
      // F16: summary text may contain spaces — consume tokens until the next
      // option-like token instead of grabbing a single whitespace-split token.
      const parts: string[] = []
      let j = i + 1
      while (j < tokens.length && !tokens[j].startsWith('-')) { parts.push(tokens[j]); j++ }
      const pair = parts.join(' ')
      if (pair.includes('=')) {
        const eq = pair.indexOf('=')
        summaries.set(pair.slice(0, eq).trim(), pair.slice(eq + 1))
        i = j - 1
      }
      continue
    }
    if (tok === '-n' || tok === '--n') {
      const val = Number(tokens[i + 1])
      if (Number.isFinite(val) && val > 0) n = Math.min(Math.floor(val), MAX_BESTOFN_N)
      i++
      continue
    }
    // 尾部 [N]：团队模式允许 "goal... N" 形式——纯数字的最后一个 positional 当 N
    if (i === tokens.length - 1 && /^\d+$/.test(tok) && !local && positionals.length > 0) {
      const val = Number(tok)
      if (val > 0) { n = Math.min(Math.floor(val), MAX_BESTOFN_N); continue }
    }
    positionals.push(tok)
  }
  return { positionals, summaries, quick, local, n }
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
    '3. Evidence chain per artifact: `node "' + join(pluginRoot, 'scripts', 'evidence_chain.mjs') + '" <artifact> --summary <name>=<self-description>`. Crash candidates (smoke ok=false) are eliminated on the spot.',
    '4. Survivor evidence blocks -> verifier select (adaptive K handles close margins).',
    '5. Integrate: hand ALL survivors + scores to an integrator agent to merge the best parts -> merge smoke -> verifier compare(merged, champion) gate.',
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
      const { positionals, summaries, quick, local: explicitLocal, n } = parseArgs(invocation.rawInput)

      // 智能模式判定：全部 positional 是存在的文件（≥2 个）→ 本地对比；否则视为目标文字
      const local = explicitLocal || (positionals.length >= 2 && positionals.every((p) => existsSync(resolve(p))))
      const artifacts = local ? positionals : []
      const goal = local ? '' : positionals.join(' ')

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
          text: `/bestofn activated — the captain will spawn ${n} members implementing: ${goal}`,
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
        const selected = await deps.runner('select', {
          problem: 'Which candidate is best, judged on runtime evidence (not self-claims)?',
          candidates: survivors.map((b) => b.text),
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

        const index = Number(selected.index ?? 0)
        const scores = Array.isArray(selected.scores) ? selected.scores as number[] : []
        const champion = survivors[index]?.name
        const lines: string[] = []
        lines.push(`## /bestofn 优选报告`)
        const crashInfo2 = crashLines()
        if (crashInfo2) lines.push(`\n${crashInfo2}`)
        lines.push(`\n🏆 冠军: ${champion}`)
        lines.push(`排名: ${survivors.map((s, i) => `${i + 1}.${s.name} (${scores[i] !== undefined ? scores[i].toFixed(4) : '?'})`).join('  ')}`)
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
