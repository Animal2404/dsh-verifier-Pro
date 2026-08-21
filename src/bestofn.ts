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
import type { PythonBridge } from './bridge.js'
import type { VerifierStore } from './persist.js'
import type { EscalationDeps } from './tools.js'

const pluginRoot = fileURLToPath(new URL('..', import.meta.url))

interface BestOfNResult {
  rankings: Array<{ name: string; ok: boolean; index?: number; score?: number; reason?: string }>
  champion?: string
  note?: string
}

/** Run evidence_chain.mjs as a subprocess; returns its exit code + stdout. */
function runEvidenceChain(artifacts: string[], summaries: Map<string, string>, outDir: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolvePromise) => {
    const args = [...artifacts, '--out', outDir]
    for (const [name, text] of summaries) args.push('--summary', `${name}=${text}`)
    const child = spawn(process.execPath, [join(pluginRoot, 'scripts', 'evidence_chain.mjs'), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('close', (code) => resolvePromise({ code: code ?? 1, stdout: stdout + (stderr ? `\n[stderr] ${stderr}` : '') }))
    child.on('error', (e) => resolvePromise({ code: 1, stdout: `evidence_chain spawn error: ${e.message}` }))
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

function parseArgs(rawInput: string): { artifacts: string[]; summaries: Map<string, string>; quick: boolean } {
  const tokens = rawInput.trim().split(/\s+/).filter(Boolean)
  const artifacts: string[] = []
  const summaries = new Map<string, string>()
  let quick = false
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok === '--quick') { quick = true; continue }
    if (tok === '--summary') {
      const pair = tokens[i + 1]
      if (pair && pair.includes('=')) {
        const eq = pair.indexOf('=')
        summaries.set(pair.slice(0, eq), pair.slice(eq + 1))
        i++
      }
      continue
    }
    artifacts.push(tok)
  }
  return { artifacts, summaries, quick }
}

/** M4-B command handler: evidence chain → crash-out → select → report. */
export function registerBestOfNCommand(ctx: Context, deps: {
  getBridge: () => Promise<PythonBridge>
  store: VerifierStore
  runner: (method: string, params: Record<string, unknown>) => Promise<unknown>
  defaultModel?: string
}): void {
  ctx.effect(() => ctx.commands.register({
    name: 'bestofn',
    description: 'run the evidence-then-select Best-of-N loop over local candidate artifacts',
    input: { hint: '<candidate1> <candidate2> ... [--summary name=text]... [--quick]' },
    async handler(invocation) {
      const { artifacts, summaries, quick } = parseArgs(invocation.rawInput)
      if (artifacts.length < 2) {
        return {
          kind: 'error',
          text: 'Usage: /bestofn <candidate1> <candidate2> ... [--summary name=text]... [--quick]',
        }
      }

      const outDir = join(deps.store.stateDir, 'bestofn')
      // 1) 证据链（冒烟→视觉→拼接）
      const chain = await runEvidenceChain(artifacts, summaries, outDir)
      const blocks = readEvidence(outDir)
      if (blocks.length === 0) {
        return {
          kind: 'error',
          text: `/bestofn: 证据链未产出有效结果。\n${chain.stdout.slice(0, 500)}`,
        }
      }

      // 2) 崩溃候选出局
      const survivors = blocks.filter((b) => {
        const ok = smokeOk(outDir, b.name)
        return ok !== false // 无 smoke 记录也保留（可能只有视觉证据）
      })
      const crashed = blocks.filter((b) => smokeOk(outDir, b.name) === false)

      if (survivors.length === 0) {
        return {
          kind: 'error',
          text: `/bestofn: 全部候选冒烟失败，无幸存者。\n${crashed.map((c) => `  ❌ ${c.name}`).join('\n')}`,
        }
      }
      if (survivors.length === 1) {
        return {
          kind: 'success',
          text: `/bestofn: 仅一个候选存活（${survivors[0].name}），直接为冠军。\n${crashed.length ? `出局: ${crashed.map((c) => c.name).join(', ')}` : ''}`,
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

        const index = Number(selected.index ?? 0)
        const scores = Array.isArray(selected.scores) ? selected.scores as number[] : []
        const champion = survivors[index]?.name
        const lines: string[] = []
        lines.push(`## /bestofn 优选报告`)
        if (crashed.length) lines.push(`\n❌ 崩溃出局: ${crashed.map((c) => c.name).join(', ')}`)
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
