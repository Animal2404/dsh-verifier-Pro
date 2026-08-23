/**
 * VerifierBrain service seam: exposes the llm-verifier bridge as a cordis
 * service (ctx.verifierBrain) so other plugins / workflows / commands can
 * reuse the verification backend without going through the model-facing
 * tools.
 *
 * U-N2/U-N9: select/compare/track are routed through the SAME escalation
 * runner as the model-facing tools — result caching, clamp01 invariant,
 * auto-escalation, the shared concurrency gate, history persistence and
 * sanitize/bounds now apply to the seam too (select/compare via runSelect/
 * runCompare; track via the runner fall-through which sanitizes text and
 * bounds n_evaluations). `defaultModel` is injected when the caller omits
 * `model`, so callers never fall through to the official package's gemini
 * default (which 401s on DeepSeek credentials). R3-19: select/compare now
 * REQUIRE `criteria`, mirroring the task_start validation (the bridge would
 * otherwise silently substitute DEFAULT_CRITERIA).
 */
import { Service, type Context } from 'cordis'
import type { PythonBridge } from './bridge.js'

declare module 'cordis' {
  interface Context {
    verifierBrain: VerifierBrainService
  }
}

export interface VerifierBrainServiceDeps {
  getBridge: () => Promise<PythonBridge>
  /** Escalation-aware runner shared with the tool path (F6 gate included). */
  run: (method: string, params: Record<string, unknown>) => Promise<unknown>
  /** Plugin-configured verifier model; injected when caller omits `model`. */
  defaultModel: string
}

export class VerifierBrainService extends Service {
  constructor(
    ctx: Context,
    private readonly deps: VerifierBrainServiceDeps,
  ) {
    super(ctx, 'verifierBrain')
  }

  /** Inject defaultModel unless the caller explicitly chose one. */
  private withModel(params: Record<string, unknown>): Record<string, unknown> {
    return params.model ? params : { ...params, model: this.deps.defaultModel }
  }

  /** Direct bridge access for methods with no runner semantics (ping/usage). */
  private async direct(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return (await this.deps.getBridge()).request(method, params)
  }

  async ping(): Promise<Record<string, unknown>> {
    return this.direct('ping') as Promise<Record<string, unknown>>
  }

  async select(params: Record<string, unknown>): Promise<unknown> {
    // R3-19: same rationale as U-N1 — the bridge silently swaps in
    // DEFAULT_CRITERIA when criteria is missing (semantic drift + injection
    // surface); the service seam must not be the quiet exception.
    const c = params.criteria
    if (c === undefined || c === null || (typeof c === 'string' && !c.trim())) {
      throw new Error('verifierBrain.select requires `criteria` (preset name or criteria object)')
    }
    return this.deps.run('select', this.withModel(params))
  }

  async compare(params: Record<string, unknown>): Promise<unknown> {
    const c = params.criteria
    if (c === undefined || c === null || (typeof c === 'string' && !c.trim())) {
      throw new Error('verifierBrain.compare requires `criteria` (preset name or criteria object)')
    }
    return this.deps.run('compare', this.withModel(params))
  }

  async track(params: Record<string, unknown>): Promise<unknown> {
    return this.deps.run('track', this.withModel(params))
  }

  async progressStart(params: Record<string, unknown>): Promise<unknown> {
    // R3-7: progress_start accepts a model — inject defaultModel so callers
    // cannot fall through to the official gemini default (401 on DeepSeek).
    return this.deps.run('progress_start', this.withModel(params))
  }

  async progressUpdate(params: Record<string, unknown>): Promise<unknown> {
    return this.deps.run('progress_update', params)
  }

  async progressClose(params: Record<string, unknown>): Promise<unknown> {
    return this.deps.run('progress_close', params)
  }

  async usage(): Promise<Record<string, unknown>> {
    return this.direct('usage') as Promise<Record<string, unknown>>
  }
}
