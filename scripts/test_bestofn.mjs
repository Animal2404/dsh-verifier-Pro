#!/usr/bin/env node
/**
 * M4-B /bestofn handler 最小验证：mock commandCtx + 真实 bridge/runner。
 * 直接调用 registerBestOfNCommand 注册，然后模拟 invocation 执行。
 */
import { registerBestOfNCommand } from '../lib/bestofn.js'
import { PythonBridge } from '../lib/bridge.js'
import { VerifierStore } from '../lib/persist.js'
import { createEscalationRunner } from '../lib/tools.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = process.cwd()
const API_KEY = process.env.OPENCODE_GO_API_KEY || ''

const env = {
  ...process.env,
  DEEPSEEK_EFFORT: 'off',
  OPENAI_BASE_URL: 'https://opencode.ai/zen/go/v1',
  OPENAI_API_KEY: API_KEY,
}

const stateDir = mkdtempSync(join(tmpdir(), 'bestofn-test-'))
const store = new VerifierStore(stateDir)
// U-B6: portable python resolution — the old hardcoded .venv/Scripts path
// only worked on Windows checkouts.
const pythonBin = process.env.VB_PYTHON
  ?? (process.platform === 'win32' ? join(ROOT, '.venv/Scripts/python.exe') : join(ROOT, '.venv/bin/python'))
const bridge = new PythonBridge(join(ROOT, 'bridge/verifier_brain_bridge.py'), pythonBin, 300_000, env)
const getBridge = async () => bridge
const runner = createEscalationRunner({ getBridge, store, esc: { autoEscalate: true, escalateThreshold: 0.15, maxEscalateK: 3 }, budgetMs: () => 1_800_000 })

// mock commandCtx with effect + commands.register
const registrations = []
const mockCtx = {
  effect: (fn) => { fn() }, // 立即执行 effect，让 commands.register 真正被调用
  commands: {
    register: (def) => { mockCtx._def = def; return () => {} },
  },
  _def: null,
}

registerBestOfNCommand(mockCtx, { getBridge, store, runner, defaultModel: 'deepseek-v4-pro' })
console.log('注册的命令:', mockCtx._def?.name, '|', mockCtx._def?.description)

const handler = mockCtx._def.handler
const followed = []
const invocation = {
  rawInput: '',
  agent: {
    followup: (msg) => { followed.push(msg) },
  },
  signal: new AbortController().signal,
  attachments: [],
}

async function run(input) {
  followed.length = 0
  invocation.rawInput = input
  const result = await handler(invocation)
  console.log('\n=== /bestofn ' + input + ' ===')
  console.log('kind:', result.kind)
  console.log(result.text)
  if (followed.length) {
    console.log('--- followup 激活指令 ---')
    console.log(followed[0].content[0].text)
  }
  return result
}

// 测试1: 空输入 → 简短引导
await run('')

// 测试1b: 团队模式（智能检测：纯文字 = 目标）→ followup 激活
await run('实现一个贪吃蛇游戏 4')

// 测试2: 本地模式（智能检测：真实文件路径 → 自动本地，无需 --local）
await run(`scripts/__fixtures__/good.html scripts/__fixtures__/broken.html --summary good=完整游戏实现 --summary broken=有崩溃的游戏 --quick`)

// 测试3: 本地模式 select 优选（两个都存活）
await run(`scripts/__fixtures__/good.html scripts/__fixtures__/other.html --summary good=完整游戏实现绿色背景 --summary other=变体游戏实现蓝色方块 --quick`)

bridge.close()