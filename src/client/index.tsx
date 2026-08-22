/**
 * dsh-verifier-Pro, browser half.
 *
 * Client bundles are cordis-style plugins: they export { name, inject, apply }
 * and are materialized by the DSH ClientModuleLoader through the
 * `window.__ModuleLoader__.load({ id, factory })` wrapper (see tsdown.config.ts
 * banner/footer). Slot registration MUST go through `ctx.slots.inject(...)`,
 * which defers until the hosting slot is declared — a direct register racing
 * boot fails, and a speculative name simply never fires (safe).
 *
 * Current registration: the VerifierPanel renders under the keyed toolview
 * slot whenever a verifier tool result carries meta key `verifier`. The host
 * does not stamp that key yet (tracked in PLAN.md v0.5.x); wiring this now
 * keeps the client half shippable and testable end-to-end.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { VerifierPanel } from './VerifierPanel.jsx'

export const name = '@dsh-external/dsh-verifier-pro'

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: 'verifier' },
    VerifierPanel,
  ))
}
