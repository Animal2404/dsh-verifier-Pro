/**
 * Wrap lib/client.js into the DSH ClientModuleLoader protocol:
 *   window.__ModuleLoader__.load({ id, factory(require) { ...body...; return module.exports } })
 *
 * Why a post-step instead of tsdown banner/footer: deterministic across tsdown
 * versions (banner option proved inert here), and idempotent (skips if the
 * marker is already present). The DSH reload precheck requires this marker.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const target = fileURLToPath(new URL('../lib/client.js', import.meta.url))
let body
try {
  body = readFileSync(target, 'utf8')
} catch {
  console.error('wrap_client: lib/client.js not found — run tsdown first')
  process.exit(1)
}

if (body.includes('__ModuleLoader__')) {
  console.log('wrap_client: already wrapped, skipping')
  process.exit(0)
}

const PKG_ID = '@dsh-external/dsh-verifier-pro'
const banner = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(PKG_ID)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
`
const footer = `
    return module.exports;
  }
});
`

writeFileSync(target, banner + body + footer)
console.log(`wrap_client: wrapped ${PKG_ID} (${body.length} → ${body.length + banner.length + footer.length} chars)`)
