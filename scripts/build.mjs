#!/usr/bin/env node
/**
 * build.mjs — 纯 Node 构建入口（M-5，复盘 R-refcomp）。
 *
 * README 宣称「Windows 一等公民」，但旧入口 `bash scripts/build.sh` 在没有
 * Git Bash/WSL 的 Windows 上直接失败。本脚本是 build.sh 的忠实移植：同样的
 * 布局探测（DSH_CHECKOUT 源码检出 / npm 安装的 dsh 自动探测）、同样的 junction
 * 链接、同样的 tsc → tsdown → panelLogic → wrap_client → check_client 流程，
 * 全部用 node: 内置模块 + process.execPath 子进程，无任何 POSIX 依赖。
 *
 * build.sh 保留给 bash 用户；`npm run build` 现在两个平台都走本脚本。
 * 环境变量与 build.sh 一致：DSH_INSTALL / DSH_CHECKOUT / DSH_TSC / DSH_TSDOWN /
 * FORCE_BUILD 无关（那是 setup.mjs 的开关）。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';

const readJsonSafe = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
};

function linkPkg(linkRel, target) {
  const link = path.resolve(ROOT, linkRel);
  const dst = path.resolve(target);
  if (!fs.existsSync(dst)) {
    throw new Error(`link_pkg: target missing: ${dst}`);
  }
  fs.rmSync(link, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(dst, link, IS_WIN ? 'junction' : 'dir');
}

/** Case-insensitive single-level probe used for pnpm's @standard-schema+spec@* dir. */
function findDirIgnoreCase(parent, re) {
  try {
    return fs.readdirSync(parent, { withFileTypes: true })
      .filter((e) => e.isDirectory() && re.test(e.name))
      .map((e) => path.join(parent, e.name))[0] ?? null;
  } catch { return null; }
}

function detectLayout() {
  const checkout = process.env.DSH_CHECKOUT || '';
  if (checkout && fs.existsSync(path.join(checkout, 'packages'))) {
    console.log(`=== Layout: source checkout (${checkout}) ===`);
    return { kind: 'checkout', checkout };
  }
  const candidates = [
    process.env.DSH_INSTALL,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh') : null,
    path.join(process.env.HOME || '', 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh'),
    path.join(process.env.HOME || '', '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
    '/usr/lib/node_modules/@deepseek-ai/dsh',
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'node_modules', '@deepseek-ai', 'dsh-tools'))) {
      console.log(`=== Layout: npm-installed dsh (${c}) ===`);
      return { kind: 'install', install: c };
    }
  }
  return { kind: 'none' };
}

function linkPeers(layout) {
  fs.mkdirSync(path.join(ROOT, 'node_modules', '@deepseek-ai'), { recursive: true });
  fs.rmSync(path.join(ROOT, 'node_modules', '@standard-schema'), { recursive: true, force: true });
  let stdSchema = null;
  if (layout.kind === 'install') {
    const NM = path.join(layout.install, 'node_modules');
    linkPkg('node_modules/cordis', path.join(NM, '@deepseek-ai/cordis'));
    linkPkg('node_modules/cosmokit', path.join(NM, '@deepseek-ai/cosmokit'));
    linkPkg('node_modules/schemastery', path.join(NM, '@deepseek-ai/schemastery'));
    linkPkg('node_modules/@deepseek-ai/dsh-tools', path.join(NM, '@deepseek-ai/dsh-tools'));
    linkPkg('node_modules/@deepseek-ai/dsh-llm', path.join(NM, '@deepseek-ai/dsh-llm'));
    linkPkg('node_modules/@deepseek-ai/dsh-system-prompt', path.join(NM, '@deepseek-ai/dsh-system-prompt'));
    if (fs.existsSync(path.join(NM, '@deepseek-ai/dsh-commands'))) {
      linkPkg('node_modules/@deepseek-ai/dsh-commands', path.join(NM, '@deepseek-ai/dsh-commands'));
    }
    // Client half: type-only imports.
    if (fs.existsSync(path.join(NM, '@deepseek-ai/dsh-client-runtime'))) {
      linkPkg('node_modules/@deepseek-ai/dsh-client-runtime', path.join(NM, '@deepseek-ai/dsh-client-runtime'));
    }
    if (fs.existsSync(path.join(NM, '@deepseek-ai/dsh-client-ui-tool'))) {
      linkPkg('node_modules/@deepseek-ai/dsh-client-ui-tool', path.join(NM, '@deepseek-ai/dsh-client-ui-tool'));
    }
    if (fs.existsSync(path.join(NM, '@types/node'))) linkPkg('node_modules/@types/node', path.join(NM, '@types/node'));
    stdSchema = findDirIgnoreCase(path.join(NM, '.pnpm'), /^@standard-schema\+spec@/);
    if (!stdSchema && fs.existsSync(path.join(NM, '@standard-schema'))) stdSchema = path.join(NM, '@standard-schema');
  } else {
    const C = layout.checkout;
    linkPkg('node_modules/cordis', path.join(C, 'vendor/cordis'));
    linkPkg('node_modules/cosmokit', path.join(C, 'vendor/cosmokit'));
    linkPkg('node_modules/schemastery', path.join(C, 'vendor/schemastery'));
    linkPkg('node_modules/@deepseek-ai/dsh-tools', path.join(C, 'packages/core/tools'));
    linkPkg('node_modules/@deepseek-ai/dsh-llm', path.join(C, 'packages/llm/llm'));
    linkPkg('node_modules/@deepseek-ai/dsh-system-prompt', path.join(C, 'packages/core/system-prompt'));
    if (fs.existsSync(path.join(C, 'packages/core/commands'))) {
      linkPkg('node_modules/@deepseek-ai/dsh-commands', path.join(C, 'packages/core/commands'));
    }
    linkPkg('node_modules/@types/node', path.join(C, 'node_modules/@types/node'));
    stdSchema = findDirIgnoreCase(path.join(C, 'node_modules/.pnpm'), /^@standard-schema\+spec@/);
  }
  if (stdSchema) {
    fs.rmSync(path.join(ROOT, 'node_modules', '@standard-schema'), { recursive: true, force: true });
    fs.mkdirSync(path.join(ROOT, 'node_modules', '@standard-schema'), { recursive: true });
    const specSrc = path.join(fs.realpathSync(stdSchema), 'node_modules', '@standard-schema', 'spec');
    fs.symlinkSync(path.resolve(specSrc), path.resolve(ROOT, 'node_modules/@standard-schema/spec'), IS_WIN ? 'junction' : 'dir');
  }
}

/**
 * Resolve a tool entry to run with process.execPath. Prefers the package's
 * real JS bin (works on every platform without .cmd shims); falls back to a
 * user-provided executable via shell.
 */
function resolveTool(pkgName, envVar, bootstrapArgs) {
  const rel = path.join(ROOT, 'node_modules', pkgName);
  if (!fs.existsSync(rel)) {
    console.log(`=== Bootstrapping ${pkgName} (${bootstrapArgs.join(' ')}) ===`);
    const npm = IS_WIN ? 'npm.cmd' : 'npm';
    const r = spawnSync(npm, ['install', '--no-save', '--no-audit', '--no-fund', ...bootstrapArgs], {
      stdio: 'inherit', cwd: ROOT, shell: IS_WIN,
    });
    if (r.status !== 0) return null;
  }
  if (process.env[envVar]) return { kind: 'shell', cmd: process.env[envVar] };
  const pj = readJsonSafe(path.join(rel, 'package.json'));
  if (pj?.bin) {
    const binRel = typeof pj.bin === 'string' ? pj.bin : pj.bin[pj.name.split('/').pop()] ?? Object.values(pj.bin)[0];
    const abs = path.join(fs.realpathSync(rel), binRel);
    if (fs.existsSync(abs)) return { kind: 'node', js: abs };
  }
  const shim = path.join(ROOT, 'node_modules', '.bin', IS_WIN ? `${pkgName.split('/').pop()}.cmd` : pkgName.split('/').pop());
  if (fs.existsSync(shim)) return { kind: 'shell', cmd: shim };
  return null;
}

function runTool(tool, args) {
  const r = tool.kind === 'node'
    ? spawnSync(process.execPath, [tool.js, ...args], { stdio: 'inherit', cwd: ROOT })
    : spawnSync(tool.cmd, args, { stdio: 'inherit', cwd: ROOT, shell: IS_WIN });
  if (r.status !== 0) {
    console.error(`build: ${tool.cmd || tool.js} ${args.join(' ')} failed (exit ${r.status})`) ;
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
console.log(`=== Build root: ${ROOT} ===`);
const layout = detectLayout();
if (layout.kind === 'none') {
  console.error('build: cannot locate a dsh installation (set DSH_CHECKOUT or DSH_INSTALL)');
  process.exit(1);
}
console.log('=== Linking build dependencies ===');
linkPeers(layout);

const tsc = resolveTool('typescript', 'DSH_TSC', ['typescript@^5.9.0']);
if (!tsc) { console.error('build: tsc not found (set DSH_TSC or run: npm i -D typescript)'); process.exit(1); }
console.log('=== Compiling src -> lib ===');
runTool(tsc, ['-p', 'tsconfig.json']);

const tsdown = resolveTool('tsdown', 'DSH_TSDOWN', ['tsdown@latest']);
if (!tsdown) { console.error('build: tsdown not found (set DSH_TSDOWN or run: npm i -D tsdown)'); process.exit(1); }
console.log('=== Compiling client bundle (tsdown) ===');
runTool(tsdown, ['-c', 'tsdown.config.ts']);

console.log('=== Compiling panelLogic for offline tests (CI parity) ===');
runTool(tsc, ['src/client/panelLogic.ts', '--outDir', 'lib', '--rootDir', 'src',
  '--module', 'nodenext', '--moduleResolution', 'nodenext', '--target', 'es2022',
  '--skipLibCheck', '--esModuleInterop']);

console.log('=== Wrapping client bundle into ModuleLoader protocol ===');
for (const step of [['scripts/wrap_client.mjs'], ['scripts/check_client.mjs']]) {
  const r = spawnSync(process.execPath, [path.join(ROOT, ...step)], { stdio: 'inherit', cwd: ROOT });
  if (r.status !== 0) { console.error(`build: ${step[0]} failed`); process.exit(1); }
}
console.log('=== Build complete ===');
