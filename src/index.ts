/**
 * @dsh-external/dsh-verifier-pro — LLM-as-a-Verifier brain for DSH.
 *
 * Exposes the official llm-verifier framework (fine-grained logprob rewards:
 * select / compare / track / ProgressTracker) as DSH agent tools through a
 * concurrent Python stdio bridge, and injects the usage policy that wires it
 * into AgentTeams workflows (best-of-N selection, reviewer quality gates,
 * live progress sensing).
 *
 * Architecture:
 *   DSH agent -> verifier_* tools (this plugin)
 *     -> JSON Lines over stdio -> bridge/verifier_brain_bridge.py
 *     -> official llm-verifier package -> logprobs backend (DeepSeek / Vertex / OpenAI-compatible)
 *
 * The bridge never uses ctx.llm: DSH's streaming interface does not expose
 * logprobs, which the fine-grained reward estimation requires.
 *
 * 规范：资源注册全部挂 ctx.effect（热重载/卸载自动清理）。
 */
import type { Context } from 'cordis'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import z from 'schemastery'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { PythonBridge, type ProbeResult } from './bridge.js'
import { buildBridgeEnv } from './credentials.js'
import { VerifierStore } from './persist.js'
import { verifierUsageSection, bestOfNProtocolSection } from './prompt.js'
import { VerifierBrainService } from './service.js'
import { createEscalationRunner, createVerifierTaskManager, registerVerifierTools } from './tools.js'
import { Semaphore } from './concurrency.js'
import { registerBestOfNCommand } from './bestofn.js'

export const name = '@dsh-external/dsh-verifier-pro'
export const inject = ['tools', 'systemPrompt']

export interface Config {
  /** Python executable for the bridge. Default: the project .venv, then `python`. */
  pythonBin?: string
  /** Single bridge-call timeout in ms for SYNC tool calls (default 5min). */
  bridgeTimeoutMs?: number
  /** Timeout budget in ms for ASYNC verifier tasks (default 30min). */
  taskTimeoutMs?: number
  /** Default verifier model id (e.g. deepseek-v4-flash-vision-exp); per-call args override. */
  verifierModel?: string
  /** Explicit OpenAI-compatible backend base URL (overrides credential auto-detect). */
  backendBaseUrl?: string
  /** Explicit backend API key (overrides credential auto-detect). */
  backendApiKey?: string
  /** Concurrent request workers inside the Python bridge. */
  maxWorkers?: number
  /** Durable state directory for score history and async-task records. */
  stateDir?: string
  /** Register the verifier usage policy into the global system prompt. */
  promptSection?: boolean
  /** System-prompt section order (after agent-teams' 117). */
  promptSectionOrder?: number
  /** Auto re-evaluate (K=3) when a score margin falls in the noise band. */
  autoEscalate?: boolean
  /** Margins at or below this (but above flat ~0.03) trigger escalation. */
  escalateThreshold?: number
  /** Total evaluation count after escalation. */
  maxEscalateK?: number
  /**
   * Tiered scoring (降本4): optional stronger model used ONLY for escalation
   * reps. Keep verifierModel on a cheap tier and spend this one only on the
   * close-margin cases that need it. Unset = same as verifierModel.
   */
  escalationModel?: string
  /** Max cost in USD per verification task (default: no limit). */
  maxCostPerVerification?: number
  /** Cost per 1K input tokens in USD (for cost estimation). */
  costPer1kInputTokens?: number
  /** Cost per 1K output tokens in USD (for cost estimation). */
  costPer1kOutputTokens?: number
}

export const Config: z<Config> = z.object({
  pythonBin: z.string(),
  bridgeTimeoutMs: z.natural().default(300_000),
  taskTimeoutMs: z.natural().default(1_800_000),
  verifierModel: z.string(),
  backendBaseUrl: z.string(),
  backendApiKey: z.string(),
  maxWorkers: z.natural().min(1).default(4),
  stateDir: z.string(),
  promptSection: z.boolean().default(true),
  promptSectionOrder: z.natural().default(118),
  autoEscalate: z.boolean().default(true),
  escalateThreshold: z.number().default(0.15),
  maxEscalateK: z.natural().default(3),
  escalationModel: z.string(),
  maxCostPerVerification: z.number().min(0),
  costPer1kInputTokens: z.number().min(0),
  costPer1kOutputTokens: z.number().min(0),
})

/** Plugin root (the directory containing package.json / bridge/). */
const pluginRoot = fileURLToPath(new URL('..', import.meta.url))

/** Resolve the Python executable: config override > project .venv > `python`. */
function resolvePythonBin(configPythonBin?: string): string {
  if (configPythonBin) return configPythonBin
  const venvPython = process.platform === 'win32'
    ? join(pluginRoot, '.venv', 'Scripts', 'python.exe')
    : join(pluginRoot, '.venv', 'bin', 'python')
  if (existsSync(venvPython)) return venvPython
  return process.platform === 'win32' ? 'python' : 'python3'
}

export function apply(ctx: Context, config: Config): void {
  const pythonBin = resolvePythonBin(config.pythonBin)
  const scriptPath = join(pluginRoot, 'bridge', 'verifier_brain_bridge.py')
  const store = new VerifierStore(config.stateDir)

  if (!existsSync(scriptPath)) {
    ctx.logger.warn('verifier-brain: bridge script missing at %s', scriptPath)
    return
  }

  let bridge: PythonBridge | undefined
  const env = buildBridgeEnv({
    VERIFIER_BRAIN_WORKERS: config.maxWorkers ? String(config.maxWorkers) : undefined,
    ...(config.backendBaseUrl ? { OPENAI_BASE_URL: config.backendBaseUrl } : {}),
    ...(config.backendApiKey ? { OPENAI_API_KEY: config.backendApiKey } : {}),
  })
  let probeResult: ProbeResult | null = null
  let probePromise: Promise<void> | null = null

  const getBridge = async (): Promise<PythonBridge> => {
    if (!bridge) {
      bridge = new PythonBridge(
        scriptPath,
        pythonBin,
        config.bridgeTimeoutMs ?? 300_000,
        env,
        (reason) => ctx.logger.warn('verifier-brain: bridge restarted (%s)', reason),
      )
      // Probe on first bridge creation
      if (!probePromise) {
        probePromise = (async () => {
          try {
            const result = await bridge.probe()
            probeResult = result
            ctx.logger.info('verifier-brain: probe result: model=%s, base_url=%s, logprobs=%s%s',
              result.model, result.base_url, result.logprobs_supported ? 'supported' : 'NOT SUPPORTED',
              result.logprobs_error ? ` (error: ${result.logprobs_error})` : '')
            if (!result.logprobs_supported) {
              ctx.logger.warn('verifier-brain: logprobs NOT supported by current backend — scoring will fail or degrade. Check model/backend config.')
            }
          } catch (e) {
            ctx.logger.warn('verifier-brain: probe failed: %s', e instanceof Error ? e.message : String(e))
            probeResult = { model: 'unknown', base_url: 'unknown', logprobs_supported: false, logprobs_error: String(e), llm_verifier_version: 'unknown' }
          }
        })()
      }
    }
    return bridge
  }

  const escalation = {
    autoEscalate: config.autoEscalate ?? true,
    escalateThreshold: config.escalateThreshold ?? 0.15,
    maxEscalateK: config.maxEscalateK ?? 3,
    escalationModel: config.escalationModel,
  }
  // F6: one shared concurrency gate for EVERY scoring path — sync tools,
  // async tasks / /bestofn (runner), and the service seam. Previously only
  // the tool path was gated; N parallel tasks could storm the bridge and
  // the provider (rate-limit + cost spike).
  const scoringGate = new Semaphore(config.maxWorkers ?? 4)
  const runner = createEscalationRunner({
    getBridge,
    store,
    esc: escalation,
    budgetMs: () => config.taskTimeoutMs ?? 1_800_000,
    scoringGate,
  })

  const tasks = createVerifierTaskManager(getBridge, store, config.taskTimeoutMs ?? 1_800_000, runner)

  // Service seam for other plugins: ctx.verifierBrain.select({...}) etc.
  // U-N2/U-N9: routed through the same runner as the tools — cache, clamp,
  // escalation, concurrency gate, history, and defaultModel injection now
  // apply to service callers too (no more silent gemini fallback → 401).
  ctx.plugin(VerifierBrainService, {
    getBridge,
    run: runner,
    defaultModel: config.verifierModel,
  } as never)

  registerVerifierTools(ctx, {
    getBridge,
    store,
    tasks,
    defaultModel: config.verifierModel,
    taskTimeoutMs: config.taskTimeoutMs ?? 1_800_000,
    syncBudgetMs: config.bridgeTimeoutMs ?? 300_000,
    escalation,
    maxConcurrentScoring: config.maxWorkers ?? 4,
    scoringGate,
    // #11: 真实成本预算（此前是无效预留配置）
    maxCostPerVerification: config.maxCostPerVerification,
    costPer1kInputTokens: config.costPer1kInputTokens,
    costPer1kOutputTokens: config.costPer1kOutputTokens,
  })

  // M4-B: /bestofn command (lazily when the commands registry is mounted)
  ctx.inject(['commands'], (commandCtx) => {
    registerBestOfNCommand(commandCtx, {
      getBridge,
      store,
      runner,
      defaultModel: config.verifierModel,
    })
  })

  if (config.promptSection ?? true) {
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'verifier-brain:usage',
      order: config.promptSectionOrder ?? 118,
      text: verifierUsageSection(config.verifierModel),
    }), 'verifier-brain: prompt section')
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'verifier-brain:bestofn',
      order: (config.promptSectionOrder ?? 118) + 1,
      text: bestOfNProtocolSection(),
    }), 'verifier-brain: bestofn protocol section')
  }

  ctx.logger.info('verifier-brain: ready (python=%s, state=%s)', pythonBin, store.stateDir)

  // Bridge process lifecycle: the disposer kills the child on fiber dispose.
  ctx.effect(() => () => {
    bridge?.close()
    bridge = undefined
  }, 'verifier-brain: bridge lifecycle')
}
