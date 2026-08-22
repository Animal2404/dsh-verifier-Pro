import { defineConfig } from 'tsdown'

/**
 * Client bundle for the DSH web UI.
 *
 * DSH client bundles are NOT plain ESM: they are classic scripts that register
 * a lazy CJS factory via `window.__ModuleLoader__.load({ id, factory })`
 * (see @deepseek-ai/dsh-client-modules manifest.d.ts). The loader precheck in
 * dev tooling rejects lib/client.js without that marker.
 *
 * Recipe (mirrors the shipped dsh-visualize bundle byte-for-byte in shape):
 *   format 'cjs'  → body uses require("react") / exports.x, resolved by the
 *                   synchronous require the host hands to the factory;
 *   banner/footer → wrap the CJS body in the ModuleLoader registration,
 *                   returning module.exports from inside the factory closure;
 *   clean:false   → outDir is lib/, which also holds host tsc output — never
 *                   wipe it here.
 */
const PKG_ID = '@dsh-external/dsh-verifier-pro'

export default defineConfig({
  entry: { client: 'src/client/index.tsx' },
  format: ['cjs'],
  platform: 'browser',
  outDir: 'lib',
  clean: false,
  sourcemap: false,
  dts: false,
  // The loader serves lib/client.js as a CLASSIC script at /plugins/<id>/client.js;
  // force the .js extension even though this package is type:module.
  outExtensions: () => ({ js: '.js' }),
})