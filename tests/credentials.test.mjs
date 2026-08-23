// Credentials parsing + alias resolution regression (U-B4 / U-N11 / U-N7).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCredentialYaml, resolveBridgeEnv } from '../lib/credentials.js'

test('U-N7: inline comments are stripped quote-aware, colons survive', () => {
  const map = parseCredentialYaml([
    'DEEPSEEK_API_KEY: sk-abc123 # main key',
    'OPENAI_BASE_URL: "https://api.deepseek.com/v1" # with comment',
    "OPENROUTER_API_KEY: 'or-xyz'  #single-quoted",
  ].join('\n'))
  assert.equal(map.get('DEEPSEEK_API_KEY'), 'sk-abc123')
  assert.equal(map.get('OPENAI_BASE_URL'), 'https://api.deepseek.com/v1')
  assert.equal(map.get('OPENROUTER_API_KEY'), 'or-xyz')
})

test('U-N7: quoted values are unescaped; hash inside quotes is kept', () => {
  const map = parseCredentialYaml([
    'OPENAI_API_KEY: "sk-\\"q\\"123"',
    "OPENROUTER_API_KEY: 'it''s-fine'",
  ].join('\n'))
  assert.equal(map.get('OPENAI_API_KEY'), 'sk-"q"123')
  assert.equal(map.get('OPENROUTER_API_KEY'), "it's-fine")
})

test('U-N11: nested provider sections map to canonical credential keys', () => {
  const map = parseCredentialYaml([
    'version: 1',
    'deepseek:',
    '  api_key: sk-nested-deepseek',
    'opencode:',
    '  api_key: oc-nested-key',
  ].join('\n'))
  assert.equal(map.get('DEEPSEEK_API_KEY'), 'sk-nested-deepseek')
  assert.equal(map.get('OPENCODE_GO_API_KEY'), 'oc-nested-key')
})

test('known keys under a refs: nest are stored verbatim at any depth', () => {
  const map = parseCredentialYaml([
    'version: 1',
    'refs:',
    '  DEEPSEEK_API_KEY: sk-under-refs',
    '  OPENCODE_GO_API_KEY: oc-under-refs',
  ].join('\n'))
  assert.equal(map.get('DEEPSEEK_API_KEY'), 'sk-under-refs')
  assert.equal(map.get('OPENCODE_GO_API_KEY'), 'oc-under-refs')
})

test('U-B4: env-only proxy alias fires with NO credentials file', () => {
  const env = resolveBridgeEnv(
    { OPENCODE_GO_API_KEY: 'oc-env-only' },
    new Map(), // empty = no credentials file
  )
  assert.equal(env.OPENAI_API_KEY, 'oc-env-only')
  assert.equal(env.OPENAI_BASE_URL, 'https://opencode.ai/zen/go/v1')
})

test('P0 rule intact: native provider credential outranks the alias fallback', () => {
  const env = resolveBridgeEnv(
    { OPENCODE_GO_API_KEY: 'oc-env' },
    new Map([['DEEPSEEK_API_KEY', 'sk-native']]),
    { OPENAI_BASE_URL: 'https://api.deepseek.com' },
  )
  // DeepSeek native key exists AND config points at DeepSeek → no alias fill.
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.OPENAI_BASE_URL, 'https://api.deepseek.com')
})

test('explicit backendBaseUrl naming the proxy selects its credential', () => {
  const env = resolveBridgeEnv(
    {},
    new Map([['DEEPSEEK_API_KEY', 'sk-native'], ['OPENCODE_GO_API_KEY', 'oc-file']]),
    { OPENAI_BASE_URL: 'https://opencode.ai/zen/go/v1/' },
  )
  assert.equal(env.OPENAI_API_KEY, 'oc-file')
  // Config wins verbatim (trailing slash included) — that IS the user's choice.
  assert.equal(env.OPENAI_BASE_URL, 'https://opencode.ai/zen/go/v1/')
})

test('plugin config extra always wins last', () => {
  const env = resolveBridgeEnv(
    {},
    new Map([['OPENAI_API_KEY', 'from-file']]),
    { OPENAI_API_KEY: 'from-config' },
  )
  assert.equal(env.OPENAI_API_KEY, 'from-config')
})
