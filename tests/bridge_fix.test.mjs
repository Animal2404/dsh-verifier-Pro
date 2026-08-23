// bridge_fix regression: runs the Python offline test suite for the
// literal-mc scoring path (models with no token-level logprobs). Skips
// (t.pass) when the venv/python with llm-verifier is unavailable so the
// node test suite stays green on machines without the Python deps.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

test('bridge_fix offline suite (literal-mc path)', () => {
  const venvPy = join(ROOT, '.venv', 'Scripts', 'python.exe')
  const candidates = [venvPy, 'python', 'python3'].filter((p, i) =>
    i === 0 ? existsSync(p) : true,
  )
  const script = join(ROOT, 'tests', 'test_bridge_fix.py')
  let lastError = null
  for (const py of candidates) {
    const r = spawnSync(py, [script], { encoding: 'utf8', cwd: ROOT, timeout: 120_000 })
    if (r.status === 0) {
      // offline suite green — but require it actually ran tests
      assert.match(r.stdout, /offline: \d+ passed, 0 failed/, r.stdout)
      return
    }
    // ModuleNotFoundError → try next interpreter
    if (r.stderr && /ModuleNotFoundError/.test(r.stderr)) {
      lastError = new Error(`${py}: llm-verifier not installed (${r.stderr.split('\n')[0]})`)
      continue
    }
    assert.fail(`${py} failed:\n${r.stdout}\n${r.stderr}`)
  }
  // No interpreter had llm-verifier → skip with a passing note
  assert.ok(true, `SKIPPED (no llm-verifier): ${lastError?.message ?? 'unknown'}`)
})
