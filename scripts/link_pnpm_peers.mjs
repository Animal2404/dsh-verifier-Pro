#!/usr/bin/env node
/**
 * link_pnpm_peers.mjs — 审查 #2：让「无 harness 的 CI 工作区」也能跑全量测试。
 *
 * DSH 的宿主 peer 包（cordis / dsh-tools / dsh-scope / ...）无法从公共 npm
 * registry 完整安装（多个 @deepseek-ai/* 内部包 404）。但 `pnpm add
 * @deepseek-ai/dsh` 会把全部 peer/传递依赖铺进 node_modules/.pnpm 虚拟存储。
 * 本脚本把这些 peer 从 .pnpm 提升为顶层 node_modules 链接，使源码的
 * `import 'cordis'` / `import '@deepseek-ai/dsh-tools'` 可解析。
 *
 * 幂等：已存在且指向正确目标的链接跳过。Windows 用 junction，POSIX 用 symlink。
 * 安全：若顶层已存在「非 .pnpm 来源」的链接/目录（本地开发环境），保留不动。
 *
 * 用法：node scripts/link_pnpm_peers.mjs [--dry-run]
 */

import { existsSync, mkdirSync, readdirSync, symlinkSync, realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

// 源码/测试实际 import 的宿主 peer 包（含无 scope 的 cordis）。
const NEEDED = [
  'cordis',
  'cosmokit',
  'schemastery',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-commands',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-ui-tool',
  '@deepseek-ai/dsh-scope',
  '@deepseek-ai/dsh-invariants',
]

const root = resolve(import.meta.dirname, '..')
const pnpmDir = join(root, 'node_modules', '.pnpm')
const dryRun = process.argv.includes('--dry-run')

/** .pnpm 目录名形如 `<escaped-name>@<version>_<hash>`；返回 (name, version) 解析。 */
function parseStoreName(dirName) {
  // 还原 pnpm 的转义：斜杠 -> '+'
  const at = dirName.lastIndexOf('@')
  if (at <= 0) return null
  const name = dirName.slice(0, at).replace(/\+/g, '/')
  const version = dirName.slice(at + 1).split('_')[0]
  return { name, version }
}

/** 版本号比较（粗略，足够挑最高版）。 */
function cmpVersions(a, b) {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

function findBest(name) {
  if (!existsSync(pnpmDir)) return null
  let best = null // { dir, version }
  for (const entry of readdirSync(pnpmDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const parsed = parseStoreName(entry.name)
    if (!parsed || parsed.name !== name) continue
    if (!best || cmpVersions(parsed.version, best.version) > 0) {
      best = { dir: join(pnpmDir, entry.name), version: parsed.version }
    }
  }
  return best
}

let linked = 0
let skipped = 0
const missing = []

for (const name of NEEDED) {
  const store = findBest(name)
  const linkPath = join(root, 'node_modules', ...name.split('/'))
  if (!store) {
    missing.push(name)
    continue
  }
  const target = join(store.dir, 'node_modules', ...name.split('/'))
  if (!existsSync(target)) {
    missing.push(`${name} (store entry lacks node_modules/${name})`)
    continue
  }
  if (existsSync(linkPath)) {
    // 已存在：指向 .pnpm 目标则跳过（正确状态）；指向别处则保留（本地环境）。
    try {
      const existingReal = resolve(realpathSync(linkPath))
      const targetReal = resolve(realpathSync(target))
      if (existingReal === targetReal) {
        skipped++
        continue
      }
      const pnpmMarker = resolve(join(root, 'node_modules', '.pnpm'))
      if (!existingReal.startsWith(pnpmMarker)) {
        console.warn(`[skip] ${name}: existing non-pnpm link/dir kept (${existingReal})`)
        skipped++
        continue
      }
    } catch {
      /* broken link — recreate below */
    }
  }
  if (dryRun) {
    console.log(`[dry-run] would link ${name} -> ${target}`)
    continue
  }
  mkdirSync(join(root, 'node_modules', ...name.split('/').slice(0, -1)), { recursive: true })
  try {
    symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    linked++
    console.log(`linked ${name} -> ${target}`)
  } catch (err) {
    console.error(`[error] link ${name}: ${err.message}`)
  }
}

console.log(`\nsummary: linked=${linked} skipped=${skipped} missing=${missing.length}`)
if (missing.length) console.log('missing:', missing.join(', '))
process.exit(missing.length ? 1 : 0)
