/**
 * Harness credential reuse: read `~/.dsh/.credentials.yaml` and expose the
 * verifier backend keys as environment variables for the Python bridge, so
 * users never configure API keys twice. Only keys not already present in
 * process.env are filled (explicit env wins).
 *
 * U-B4: proxy aliases (OPENCODE_GO_API_KEY → OPENAI_*) now fire even when the
 * credentials FILE does not exist — an env-only OPENCODE_GO_API_KEY used to be
 * ignored because the whole alias block sat inside the existsSync guard.
 * U-N11: nested provider sections ("deepseek:\n  api_key: sk-x") are mapped to
 * canonical credential keys via the SAME table setup.mjs advertises, instead
 * of being silently dropped by the flat parser.
 * U-N7: inline comments are stripped quote-aware; quoted values are
 * unescaped; values containing colons survive intact.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Credential yaml keys we forward to the verifier backend. */
export const FORWARD_KEYS = [
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

/** Keys we recognize verbatim anywhere in the file (flat or nested). */
const KNOWN_KEYS = new Set<string>([...FORWARD_KEYS, ...ALIASES.map((a) => a.from)])

/**
 * U-N11: lowercase provider section name → canonical credential key.
 * MUST stay in sync with scripts/setup.mjs SECTION_TO_CRED_KEY.
 */
const SECTION_TO_CRED_KEY = new Map([
  ['deepseek', 'DEEPSEEK_API_KEY'],
  ['opencode', 'OPENCODE_GO_API_KEY'],
  ['openrouter', 'OPENROUTER_API_KEY'],
  ['openai', 'OPENAI_API_KEY'],
])

/** Strip a trailing `# comment` that sits OUTSIDE quotes. */
function stripInlineComment(line: string): string {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    else if (ch === '#' && !inSingle && !inDouble && i > 0 && /\s/.test(line[i - 1])) {
      return line.slice(0, i)
    }
  }
  return line
}

/** Unquote a scalar value; double-quoted values get minimal unescaping. */
function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    const inner = value.slice(1, -1)
    // Minimal YAML double-quote unescaping (the escapes plausibly in keys/URLs).
    return inner.replace(/\\(["\\ntr])/g, (_, c: string) => (
      c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c
    ))
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  return value
}

/**
 * Parse credential entries from DSH's `.credentials.yaml`. Tolerates THREE
 * layouts (U-N11: runtime now matches what setup.mjs advertises):
 *   1. legacy flat `KEY: value`
 *   2. current `version: 1` + `refs:` nested layout (known keys indented)
 *   3. provider sections (`deepseek:` + `api_key: x`) via SECTION_TO_CRED_KEY
 * Quote-aware comment stripping; values may contain colons (URLs).
 */
export function parseCredentialYaml(text: string): Map<string, string> {
  const map = new Map<string, string>()
  let section: string | null = null
  for (const rawLine of text.split(/\r?\n/)) {
    const indent = rawLine.length - rawLine.trimStart().length
    const line = stripInlineComment(rawLine).trim()
    if (!line || line.startsWith('#')) continue

    // Section header: `name:` with no value on the same line.
    const headerMatch = /^([A-Za-z_][A-Za-z0-9_-]*):\s*$/.exec(line)
    if (headerMatch) {
      section = headerMatch[1].toLowerCase()
      continue
    }

    const match = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.+)$/.exec(line)
    if (!match) continue
    const key = match[1]
    const value = unquote(match[2].trim())
    if (!value || value === '~' || value === 'null') continue

    // R3-1: a top-level key MUST reset the provider section — otherwise a
    // flat `TOP_OTHER: x` line after `deepseek:` would be parsed as a child
    // of deepseek and pollute DEEPSEEK_API_KEY (cross-section contamination,
    // confirmed by runtime reproduction).
    if (indent === 0) section = null

    if (KNOWN_KEYS.has(key)) {
      // Known credential key — store verbatim at any nesting depth.
      map.set(key, value)
    } else if (section !== null && SECTION_TO_CRED_KEY.has(section)) {
      // Provider-section child (e.g. deepseek.api_key) → canonical name.
      // R3-1: only key/token/secret-like children map — arbitrary members
      // such as `base_url:` or `description:` must NOT overwrite the
      // credential (they used to, last-write-wins → silent wrong key → 401).
      if (/(key|token|secret)/i.test(key)) {
        map.set(SECTION_TO_CRED_KEY.get(section) as string, value)
      }
    }
    // Anything else is not a verifier backend credential — ignore.
  }
  return map
}

/**
 * Pure core of buildBridgeEnv — exported for offline tests (no filesystem).
 * `fileCreds` comes from parseCredentialYaml; `extra` is plugin config.
 */
export function resolveBridgeEnv(
  processEnv: NodeJS.ProcessEnv,
  fileCreds: Map<string, string>,
  extra: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...processEnv }
  // File creds fill ONLY keys absent from the environment (explicit env wins).
  for (const key of FORWARD_KEYS) {
    if (env[key] === undefined || env[key] === '') {
      const value = fileCreds.get(key)
      if (value) env[key] = value
    }
  }

  // Proxy aliases: expose a harness-only credential under the standard
  // OpenAI-compatible names the official llm-verifier backend reads.
  //
  // P0 smoke-fix (2026-08-22): the alias previously fired whenever
  // OPENAI_API_KEY was empty — even when a native provider key existed.
  // With both DEEPSEEK_API_KEY and OPENCODE_GO_API_KEY present, the alias
  // filled OPENAI_API_KEY with the OpenCode key while config pointed at
  // api.deepseek.com → 401. Rule: an explicit native-provider credential
  // always outranks the proxy alias fallback.
  const nativeProviderPresent =
    ['DEEPSEEK_API_KEY', 'VERTEX_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY']
      .some((k) => env[k] !== undefined && env[k] !== '')
    || [...fileCreds.keys()].some((k) =>
      ['DEEPSEEK_API_KEY', 'VERTEX_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY'].includes(k),
    )
  // An explicit backendBaseUrl in plugin config IS the user's backend choice:
  // when it names an aliased proxy, that proxy's credential wins over the
  // generic native-provider fallback (e.g. DeepSeek out of balance → user
  // points backendBaseUrl at opencode).
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
      // U-B4: source may live in the credentials FILE **or** plain env — an
      // env-only OPENCODE_GO_API_KEY must work with no credentials file.
      const value = fileCreds.get(alias.from) ?? processEnv[alias.from]
      if (value) {
        env[alias.to] = value
        if (alias.baseUrl && !hasTarget('OPENAI_BASE_URL')) env.OPENAI_BASE_URL = alias.baseUrl
      }
    }
  }

  // Plugin config always wins last (it IS the explicit backend choice).
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== '') env[key] = value
  }
  return env
}

/**
 * Build the child-process env for the bridge: process.env plus any verifier
 * backend credential found in the Harness credentials file.
 */
export function buildBridgeEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  let fileCreds = new Map<string, string>()
  try {
    const credPath = join(homedir(), '.dsh', '.credentials.yaml')
    if (existsSync(credPath)) {
      fileCreds = parseCredentialYaml(readFileSync(credPath, 'utf8'))
    }
  } catch {
    // Credentials are best-effort; the bridge can also rely on a plugin .env.
  }
  return resolveBridgeEnv(process.env, fileCreds, extra)
}
