/**
 * Harness credential reuse: read `~/.dsh/.credentials.yaml` and expose the
 * verifier backend keys as environment variables for the Python bridge, so
 * users never configure API keys twice. Only keys not already present in
 * process.env are filled (explicit env wins).
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Credential yaml keys we forward to the verifier backend. */
const FORWARD_KEYS = [
  'DEEPSEEK_API_KEY',
  'VERTEX_API_KEY',
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENROUTER_API_KEY',
] as const

/** Harness proxy credentials that map onto the OpenAI-compatible backend. */
const ALIASES: Array<{ from: string; to: string; baseUrl?: string }> = [
  {
    from: 'OPENCODE_GO_API_KEY',
    to: 'OPENAI_API_KEY',
    baseUrl: 'https://opencode.ai/zen/go/v1',
  },
]

/**
 * Parse credential keys from DSH's `.credentials.yaml`. Tolerates BOTH known
 * formats (审计二修正): the legacy flat `KEY: value` layout AND the current
 * `version: 1` + `refs:` nested layout where keys sit indented under the refs
 * node. Skips comments and continuation lines; values may be quoted.
 */
function parseFlatYaml(text: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line)
    if (!match) continue
    let value = match[2].trim()
    if (!value || value === '~' || value === 'null') continue
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    map.set(match[1], value)
  }
  return map
}

/**
 * Build the child-process env for the bridge: process.env plus any verifier
 * backend credential found in the Harness credentials file.
 */
export function buildBridgeEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  try {
    const credPath = join(homedir(), '.dsh', '.credentials.yaml')
    if (existsSync(credPath)) {
      const parsed = parseFlatYaml(readFileSync(credPath, 'utf8'))
      for (const key of FORWARD_KEYS) {
        if (env[key] === undefined || env[key] === '') {
          const value = parsed.get(key)
          if (value) env[key] = value
        }
      }
      // Proxy aliases: expose a harness-only credential under the standard
      // OpenAI-compatible names the official llm-verifier backend reads.
      //
      // P0 smoke-fix (2026-08-22): the alias previously fired whenever
      // OPENAI_API_KEY was empty — even when a native provider key existed.
      // With both DEEPSEEK_API_KEY and OPENCODE_GO_API_KEY in the file, the
      // alias filled OPENAI_API_KEY with the OpenCode key while config pointed
      // at api.deepseek.com → 401 (opencode key sent to DeepSeek). Rule now:
      // an explicit native-provider credential always outranks the proxy
      // alias fallback.
      const nativeProviderPresent =
        ['DEEPSEEK_API_KEY', 'VERTEX_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY']
          .some((k) => env[k] !== undefined && env[k] !== '')
        || [...parsed.keys()].some((k) =>
          ['DEEPSEEK_API_KEY', 'VERTEX_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY'].includes(k),
        )
      // An explicit backendBaseUrl in plugin config IS the user's backend
      // choice: when it names an aliased proxy, that proxy's credential wins
      // over the generic native-provider fallback (e.g. DeepSeek out of
      // balance → user points backendBaseUrl at opencode).
      const explicitBaseUrl = typeof extra.OPENAI_BASE_URL === 'string' && extra.OPENAI_BASE_URL !== ''
        ? extra.OPENAI_BASE_URL.replace(/\/+$/, '')
        : undefined
      for (const alias of ALIASES) {
        const hasTarget = (key: string): boolean => env[key] !== undefined && env[key] !== ''
        const aliasChosenByConfig = explicitBaseUrl !== undefined
          && alias.baseUrl !== undefined
          && explicitBaseUrl === alias.baseUrl.replace(/\/+$/, '')
        if (nativeProviderPresent && !aliasChosenByConfig) continue
        if (!hasTarget(alias.to)) {
          const value = parsed.get(alias.from) ?? process.env[alias.from]
          if (value) {
            env[alias.to] = value
            if (alias.baseUrl && !hasTarget('OPENAI_BASE_URL')) env.OPENAI_BASE_URL = alias.baseUrl
          }
        }
      }
    }
  } catch {
    // Credentials are best-effort; the bridge can also rely on a plugin .env.
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== '') env[key] = value
  }
  return env
}
