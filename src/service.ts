/**
 * VerifierBrain service seam: exposes the llm-verifier bridge as a cordis
 * service (ctx.verifierBrain) so other plugins / workflows / commands can
 * reuse the verification backend without going through the model-facing
 * tools.
 */
import { Service, type Context } from 'cordis'
import type { PythonBridge } from './bridge.js'

declare module 'cordis' {
  interface Context {
    verifierBrain: VerifierBrainService
  }
}

export class VerifierBrainService extends Service {
  constructor(
    ctx: Context,
    private readonly getBridge: () => Promise<PythonBridge>,
  ) {
    super(ctx, 'verifierBrain')
  }

  async ping(): Promise<Record<string, unknown>> {
    return (await this.getBridge()).request('ping')
  }

  async select(params: Record<string, unknown>): Promise<unknown> {
    return (await this.getBridge()).request('select', params)
  }

  async compare(params: Record<string, unknown>): Promise<unknown> {
    return (await this.getBridge()).request('compare', params)
  }

  async track(params: Record<string, unknown>): Promise<unknown> {
    return (await this.getBridge()).request('track', params)
  }

  async progressStart(params: Record<string, unknown>): Promise<unknown> {
    return (await this.getBridge()).request('progress_start', params)
  }

  async progressUpdate(params: Record<string, unknown>): Promise<unknown> {
    return (await this.getBridge()).request('progress_update', params)
  }

  async progressClose(params: Record<string, unknown>): Promise<unknown> {
    return (await this.getBridge()).request('progress_close', params)
  }

  async usage(): Promise<Record<string, unknown>> {
    return (await this.getBridge()).request('usage')
  }
}
