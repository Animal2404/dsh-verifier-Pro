#!/usr/bin/env node
/**
 * ============================================================
 * setup.mjs —— dsh-verifier-Pro 一键安装 / 诊断脚本
 * ============================================================
 * 本文件是 setup-a / setup-b / setup-c 三份功能等价实现的合并版：
 *   · 底座：setup-c（最全的测试覆盖：四态 .venv 判定、占位符凭据过滤、
 *           --root 双语法、退出码纪律、fixture 级缺失项渲染）；
 *   · 嫁接 setup-a 独有优点：
 *       A1) 三种 YAML 凭据格式兼容（扁平键值对 / "- KEY" 列表项 /
 *           "deepseek:" + "api_key:" 嵌套节）；
 *       A2) EPERM/沙箱拦截子进程时优雅降级——标记「无法探测」，
 *           不误报「未安装」；
 *       A3) --fix 失败按类型返回分型错误码
 *           （10=无 Python / 11=venv失败 / 12=pip失败 /
 *             13=Node过旧 / 14=找不到项目根）；
 *       A4) 凭据推荐优先级第四级 OPENAI_API_KEY 兜底。
 *   · 嫁接 setup-b 独有优点：
 *       B1) Node 版本检查附带 package.json engines.node 提示；
 *       B2) 推荐配置片段之后对比 cordis.patch.yml 当前硬编码值
 *           （verifierModel/backendBaseUrl），点名「作者环境不一致
 *           是装完不能用的根源」；
 *       B3) pip install 失败时给出清华镜像源手动命令提示；
 *       B4) Windows 商店别名桩过滤（py -3 启动器优先、
 *           WindowsApps 假 python3 探测过滤）。
 *
 * 用法：
 *   node scripts/setup.mjs              # 等价于 --check（只诊断，不修改）
 *   node scripts/setup.mjs --check      # 只诊断不修改；缺项时恒 exit 0（--strict 则 exit 1）
 *   node scripts/setup.mjs --fix        # 自动修复：建 .venv + 装 llm-verifier + 写配置 +
 *                                       # 构建 lib/ + 挂载到 profile（dsh CLI 可用时）
 *                                       # 成功 exit 0；失败按类型返回 10~15
 *   node scripts/setup.mjs --bench      # 判别力自检：固定微任务集实测评分模型质量（G1）
 *   node scripts/setup.mjs --help       # 帮助
 *   --root <目录> / --root=<目录>      # 显式指定项目根目录（两种语法都支持）
 *   --profile <名称>                   # 挂载目标 profile（默认 web；--no-mount 跳过挂载）
 *   --strict                           # 与 --check 连用：存在待处理项时 exit 1（CI 用）
 *
 * 设计约束：
 *   - 纯 Node 实现、零第三方依赖（仅 node: 内置模块）；要求 Node >= 18；
 *   - Windows / macOS / Linux 兼容；
 *   - 凭据检测只识别键名，任何密钥明文都不会被读取后打印；
 *   - 所有输出与注释均为中文。
 *
 * 退出码纪律：
 *   --check          ：报告正常完成恒为 0（自动化预检请加 --strict，有缺项时 exit 1）；
 *                       仅诊断自身崩溃才非 0（1）。
 *   --fix            ：成功 0；参数错误 2；按失败类型返回 10~15。
 * ============================================================
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ----------------------------- 常量 ----------------------------- */

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const SELF_NAME = path.basename(process.argv[1] || SCRIPT_FILE) || 'setup.mjs';
const IS_WIN = process.platform === 'win32';

const MIN_NODE_MAJOR = 18;      // 项目要求的 Node 最低大版本
const PY_PKG = 'llm-verifier';  // venv 内必需的 Python 包名
const PY_MOD = 'llm_verifier';  // 对应的 import 模块名
// D-9: the bridge needs post-0.2.0 APIs (token_usage hook, tagged path).
// m-4（复盘 R-refcomp）：加上 <0.3.0 上界——上游 minor 破坏性变更会静默进入所有
// 新装环境，与本项目「钉扎版本」的自身哲学一致；升级需有意解除上界并回归。
const PY_PKG_REQ = 'llm-verifier>=0.2.0,<0.3.0';

/** 【嫁接 A3】--fix 分型错误码表 */
const EXIT = {
  OK: 0,
  GENERIC_FAILED: 1,
  BAD_ARGS: 2,
  PYTHON_NOT_FOUND: 10,   // 没找到可用的系统 Python
  VENV_CREATE_FAILED: 11, // 创建 .venv 失败
  PIP_INSTALL_FAILED: 12, // pip 安装 llm-verifier 失败
  NODE_TOO_OLD: 13,       // Node 版本低于 18
  ROOT_NOT_FOUND: 14,     // 无法定位项目根目录
  BUILD_FAILED: 15,       // lib/ 构建失败（--fix 步骤⑤）
};

/**
 * 已知的评分后端映射表（按推荐优先级排序）。
 * 用户凭据里存在哪个 envKey，就推荐对应的 model / baseUrl 组合。
 * 【嫁接 A4】第四级 OPENAI_API_KEY 作为兜底后端。
 */
const KNOWN_BACKENDS = [
  {
    envKey: 'DEEPSEEK_API_KEY',
    label: 'DeepSeek 官方',
    model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com',
    applyUrl: 'https://platform.deepseek.com/api_keys',
    // m-2（复盘 R-refcomp）：诚实标注——API 参数存在 ≠ 本仓实测过分布质量。
    verifyHint: 'logprobs 分布质量未在本仓实测，建议先跑 scripts/probe_logprobs.py 验证',
  },
  {
    envKey: 'OPENCODE_GO_API_KEY',
    label: 'OpenCode Zen',
    // 2026-08-23: flash-vision-exp 实测可评分且更省；flash 本体被上游禁 logprobs。
    model: 'deepseek-v4-flash-vision-exp',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    applyUrl: 'https://opencode.ai',
  },
  {
    envKey: 'OPENROUTER_API_KEY',
    label: 'OpenRouter',
    model: 'deepseek/deepseek-chat',
    baseUrl: 'https://openrouter.ai/api/v1',
    applyUrl: 'https://openrouter.ai/settings/keys',
    verifyHint: '未验证 logprobs，建议先跑 scripts/probe_logprobs.py 验证',
  },
  {
    envKey: 'OPENAI_API_KEY',
    label: 'OpenAI 官方（兜底）',
    model: 'gpt-4o-mini',
    baseUrl: 'https://api.openai.com/v1',
    applyUrl: 'https://platform.openai.com/api-keys',
    verifyHint: 'logprobs 支持未在本仓实测，建议先跑 scripts/probe_logprobs.py 验证',
  },
];

const KNOWN_ENV_KEYS = new Set(KNOWN_BACKENDS.map((b) => b.envKey));

/** 【嫁接 A1】小写配置节名 → 对应凭据键名（兼容 “deepseek:\n  api_key: xxx” 嵌套写法） */
const SECTION_TO_CRED_KEY = new Map([
  ['deepseek', 'DEEPSEEK_API_KEY'],
  ['opencode', 'OPENCODE_GO_API_KEY'],
  ['openrouter', 'OPENROUTER_API_KEY'],
  ['openai', 'OPENAI_API_KEY'],
]);

/* ----------------------------- 输出小工具 ----------------------------- */

const USE_COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code, text) => (USE_COLOR ? `\x1b[${code}m${text}\x1b[0m` : String(text));
const red = (t) => paint('31', t);
const green = (t) => paint('32', t);
const yellow = (t) => paint('33', t);
const cyan = (t) => paint('36', t);
const gray = (t) => paint('90', t);
const bold = (t) => paint('1', t);

const MARK_OK = green('[OK]');
const MARK_BAD = red('[X]');
const MARK_WARN = yellow('[!]');

function hr(char = '=', width = 66) {
  return char.repeat(width);
}

/** 截取多行文本的最后 limit 行（用于错误摘要）。 */
function tailLines(text, limit = 5) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter(Boolean);
  return lines.slice(-limit).join('\n');
}

/** 把多行文本整体缩进后返回（保持排版）。 */
function indentBlock(text, pad = '        ') {
  return String(text || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => pad + l)
    .join('\n');
}

/** 给路径加引号（仅用于"展示将要执行的命令"，含空格时才加）。 */
function q(p) {
  const s = String(p);
  return /\s/.test(s) ? `"${s.replace(/"/g, '')}"` : s;
}

/* ----------------------------- 文件系统小工具 ----------------------------- */

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readTextSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function readJsonSafe(p) {
  const text = readTextSafe(p);
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/* ----------------------------- 项目定位 ----------------------------- */

/**
 * 解析项目根目录：
 *   ① 命令行 --root <目录> 或 --root=<目录>（两种语法，保留自 setup-c）；
 *   ② 从脚本所在目录向上最多 6 层找 package.json；
 *   ③ 兜底：按约定位置向上两级。
 */
function findProjectRoot(argv) {
  for (const a of argv) {
    const m = a.match(/^--root=(.+)$/);
    if (m) return path.resolve(m[1]);
  }
  const i = argv.indexOf('--root');
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) return path.resolve(argv[i + 1]);

  let dir = path.dirname(SCRIPT_FILE);
  for (let depth = 0; depth < 6; depth += 1) {
    if (isFile(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(path.dirname(SCRIPT_FILE), '..', '..');
}

/* ----------------------------- 子进程封装 ----------------------------- */

/**
 * 同步执行一条命令。
 * - 默认捕获 stdout/stderr（用于探测）；
 * - opts.inherit = true 时让子进程直接继承当前终端（pip 安装时能看到实时进度）；
 * - 统一注入 PYTHONIOENCODING=utf-8，避免 Windows 下中文输出乱码。
 */
function run(exe, args, opts = {}) {
  return spawnSync(exe, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: opts.timeoutMs ?? 30_000,
    cwd: opts.cwd,
    env: opts.env ?? { ...process.env, PYTHONIOENCODING: 'utf-8' },
    ...(opts.inherit ? { stdio: 'inherit' } : { stdio: ['ignore', 'pipe', 'pipe'] }),
  });
}

/* ----------------------------- Python 探测 ----------------------------- */

/** 让解释器自报版本的探测代码片段。 */
const VERSION_SNIPPET = 'import sys;sys.stdout.write("%d.%d.%d" % sys.version_info[:3])';

/**
 * 探测某个解释器是否真的可用。
 * 返回 { version } 或 { blocked: true } 或 null：
 *   - blocked 表示子进程被环境拦截（EPERM 等，常见于沙箱/受限终端/杀软），
 *     此时【嫁接 A2】不能武断判定"未安装"，只能标记"无法探测"；
 *   - null 表示命令能跑但不是有效的 Python（含 Windows 商店假别名桩，
 *     它们以非 0 退出且无有效版本输出 ——【嫁接 B4】借此自然过滤掉）。
 */
function probePython(exe, prefixArgs = []) {
  const r = run(exe, [...prefixArgs, '-c', VERSION_SNIPPET], { timeoutMs: 20_000 });
  if (r && r.error) {
    const code = r.error.code || '';
    if (code === 'EPERM' || code === 'EACCES') return { blocked: true };
    return null;
  }
  if (!r || r.status !== 0) return null;
  const out = String(r.stdout || '').trim();
  return /^\d+\.\d+\.\d+$/.test(out) ? { version: out } : null;
}

/** 把 "x.y.z" 变成可比较的数字（忽略补丁位）。 */
function versionWeight(v) {
  const [maj, min] = String(v).split('.').map(Number);
  return maj * 1000 + (Number.isFinite(min) ? min : 0);
}

/**
 * 收集系统里"实测可用"的 Python 解释器候选，按版本从新到旧排序。
 * 【嫁接 B4】Windows 上把官方 py 启动器（py -3）排在最前——它可绕开
 * 应用商店的 python/python3 别名桩；商店桩本身会因非 0 退出且无有效版本
 * 输出而被 probePython 过滤（见上）。类 Unix 上依次尝试 python3 → python。
 */
function discoverSystemPythons() {
  const candidates = [];
  if (process.env.PYTHON) candidates.push({ exe: process.env.PYTHON, prefix: [] });
  if (IS_WIN) {
    candidates.push({ exe: 'py', prefix: ['-3'] });   // py -3 启动器优先
    candidates.push({ exe: 'py', prefix: [] });
    candidates.push({ exe: 'python.exe', prefix: [] }); // 商店桩会被版本探测过滤
    candidates.push({ exe: 'python', prefix: [] });
    candidates.push({ exe: 'python3', prefix: [] });    // 同上（WindowsApps 桩）
  } else {
    candidates.push({ exe: 'python3', prefix: [] });
    candidates.push({ exe: 'python', prefix: [] });
  }

  const seen = new Set();
  const found = [];
  let anyBlocked = false;
  for (const cand of candidates) {
    const id = `${cand.exe}|${cand.prefix.join(' ')}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const probed = probePython(cand.exe, cand.prefix);
    if (probed && probed.blocked) {
      anyBlocked = true;
      continue;
    }
    if (probed && probed.version) found.push({ ...cand, version: probed.version });
  }
  found.sort((a, b) => versionWeight(b.version) - versionWeight(a.version));
  return { found, anyBlocked };
}

/* ----------------------------- .venv 相关 ----------------------------- */

function venvDirOf(root) {
  return path.join(root, '.venv');
}

/** venv 内解释器的平台相关路径：Windows 是 Scripts\python.exe，类 Unix 是 bin/python。 */
function venvPythonOf(root) {
  return IS_WIN
    ? path.join(venvDirOf(root), 'Scripts', 'python.exe')
    : path.join(venvDirOf(root), 'bin', 'python');
}

/**
 * 用 venv 的解释器探测 llm_verifier 是否可导入。
 * 【嫁接 A2】返回的 pkgState 取值：
 *   ok / missing / unknown（EPERM 等环境拦截，无法探测）/ error。
 */
function probePackage(venvPython) {
  const r = run(venvPython, ['-c', `import ${PY_MOD}`], { timeoutMs: 60_000 });
  if (r && r.error) {
    const code = r.error.code || '';
    if (code === 'EPERM' || code === 'EACCES') {
      return { pkgState: 'unknown', error: `子进程被环境拦截（${code}），无法探测` };
    }
    const timedOut = r.error.code === 'ETIMEDOUT';
    return { pkgState: 'error', error: timedOut ? '导入探测超时' : `${code || '未知错误'}` };
  }
  if (r && r.status === 0) return { pkgState: 'ok', error: null };
  return { pkgState: 'missing', error: tailLines(r && r.stderr, 5) || '导入失败' };
}

/**
 * 检查 .venv 整体状态（保留 setup-c 的四态判定）：
 *   missing —— 目录不存在；
 *   broken  —— 目录存在但里面的解释器不可用（残留/损坏）；
 *   noPkg   —— 解释器可用但缺 llm-verifier；
 *   ready   —— 全部就绪。
 * 另附 pkgState 字段细化包探测结果（ready 但 unknown 时渲染为"无法探测"警告）。
 */
function checkVenv(root) {
  const dir = venvDirOf(root);
  const python = venvPythonOf(root);
  if (!isDir(dir)) return { state: 'missing', dir, python, pkgState: null, version: null };
  const probed = probePython(python);
  if (!probed || !probed.version) return { state: 'broken', dir, python, pkgState: null, version: null };
  const pkg = probePackage(python);
  return {
    state: pkg.pkgState === 'ok' ? 'ready' : 'noPkg',
    dir,
    python,
    version: probed.version,
    pkgState: pkg.pkgState,
    pkgError: pkg.error,
  };
}

/* ----------------------------- lib/ 编译产物检查 ----------------------------- */

/** 从 package.json 推断编译命令提示。 */
function buildCommandHint(root) {
  const pkg = readJsonSafe(path.join(root, 'package.json'));
  if (pkg && pkg.scripts) {
    if (pkg.scripts.build) return 'npm run build';
    if (pkg.scripts.compile) return 'npm run compile';
  }
  return 'npm install && npm run build';
}

/** lib/ 目录是否存在且有 .js/.mjs/.cjs 产物（递归统计，忽略 node_modules 与隐藏目录）。 */
function checkLibBuild(root) {
  const libDir = path.join(root, 'lib');
  if (!isDir(libDir)) {
    return { ok: false, libDir, jsCount: 0, reason: 'lib/ 目录不存在（尚未编译？）' };
  }
  let jsCount = 0;
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p, depth + 1);
      else if (ent.isFile() && /\.(m|c)?js$/i.test(ent.name)) jsCount += 1;
    }
  };
  walk(libDir, 0);
  return {
    ok: jsCount > 0,
    libDir,
    jsCount,
    reason: jsCount > 0 ? null : 'lib/ 存在但里面没有任何 .js 产物',
  };
}

/* ----------------------------- Node 版本检查 ----------------------------- */

/** 【嫁接 B1】读取 package.json 的 engines.node 字段（仅展示提示用）。 */
function readEnginesNote(root) {
  const pkg = readJsonSafe(path.join(root, 'package.json'));
  return pkg && pkg.engines && pkg.engines.node ? String(pkg.engines.node) : null;
}

function checkNodeInfo() {
  const major = Number(process.versions.node.split('.')[0]);
  return { ok: major >= MIN_NODE_MAJOR, version: process.version, major };
}

/* ----------------------------- 凭据解析（零依赖极简 YAML 扫描） ----------------------------- */

function credentialsPath() {
  return path.join(os.homedir(), '.dsh', '.credentials.yaml');
}

/** 归一化 YAML 标量：去掉行尾注释、剥掉成对引号（仅用于判断值是否"像真密钥"）。 */
function normalizeYamlScalar(raw) {
  let t = String(raw).trim();
  if (!t || t.startsWith('#')) return '';
  if (!/^["']/.test(t)) {
    const h = t.indexOf(' #');
    if (h !== -1) t = t.slice(0, h).trim();
  }
  if (
    (t.startsWith('"') && t.endsWith('"') && t.length >= 2) ||
    (t.startsWith("'") && t.endsWith("'") && t.length >= 2)
  ) {
    t = t.slice(1, -1).trim();
  }
  return t;
}

/** 取某键最后一次出现的值（归一化后的字符串；找不到返回 null）。 */
function yamlValueOf(text, key) {
  const re = new RegExp(`^[ \\t]*['"]?${escapeRegExp(key)}['"]?[ \\t]*:[ \\t]*(.*)$`);
  let value = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const m = raw.match(re);
    if (m) value = normalizeYamlScalar(m[1]);
  }
  return value == null ? null : value;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 判断一个凭据值是否"像真实可用的密钥"（占位符过滤，保留自 setup-c）。
 * 注意：这个函数的结果只用来决定"是否推荐该后端"，值本身永远不会被打印。
 */
function looksLikeRealSecret(v) {
  if (typeof v !== 'string') return false;
  const t = v.trim();
  if (t.length < 10) return false; // 太短基本是占位符
  if (/^[<'~]/.test(t)) return false;
  if (/^(null|empty|changeme|placeholder|your[_-].*|todo|change_me|\$\{[^}]*\}|<[^>]*>)$/i.test(t)) return false;
  return true;
}

/**
 * 【嫁接 A1】扫描凭据 YAML 文本，识别三种写法下"可用的已知凭据键"。
 * 兼容格式：
 *   写法 1 扁平键值对： DEEPSEEK_API_KEY: sk-xxx
 *   写法 2 列表项：    - DEEPSEEK_API_KEY
 *   写法 3 嵌套节：    deepseek:
 *                        api_key: sk-xxx
 * 安全约束：只收集键名与"该键是否像真密钥"的布尔结论，绝不保存/打印值。
 * 返回 Set<envKey>（KNOWN_BACKENDS 中判定可用的那些）。
 */
function analyzeCredentialText(text) {
  const avail = new Set();
  let section = null;

  for (const raw of String(text).split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue; // 跳过空行与整行注释

    // —— 写法 2：列表项 “- KEY_NAME”（可有引号）
    let m = raw.match(/^[ \t]*-[ \t]*['"]?([A-Za-z][A-Za-z0-9_-]*)['"]?[ \t]*$/);
    if (m) {
      if (KNOWN_ENV_KEYS.has(m[1])) avail.add(m[1]); // 列表形式不带值，视为用户声明可用
      continue;
    }

    const indented = /^[ \t]/.test(raw);

    // —— 写法 3 节头：裸词 + 冒号结尾（如 deepseek:），记录当前节名
    m = raw.match(/^[ \t]*([A-Za-z][A-Za-z0-9_-]*)[ \t]*:[ \t]*$/);
    if (m) {
      section = indented ? section : m[1].toLowerCase();
      continue;
    }

    // —— 写法 1：任意 “KEY: value”（键名可带引号）
    m = raw.match(/^([ \t]*)['"]?([A-Za-z][A-Za-z0-9_-]*?)['"]?[ \t]*:[ \t]*(.+)$/);
    if (!m) continue;
    const indent = m[1];
    const key = m[2];
    const val = normalizeYamlScalar(m[3]);

    if (!indent) {
      // 顶层扁平键：直接匹配已知凭据键名，并要求值像真密钥
      section = null; // 新的顶层键结束之前的嵌套节上下文
      if (KNOWN_ENV_KEYS.has(key) && looksLikeRealSecret(val)) avail.add(key);
    } else if (section === 'refs') {
      // DSH v1 凭据格式（审计二实证）：refs: 节下的缩进键就是用户凭据本体，
      // 与顶层扁平键等价处理。此前该节无映射导致全部真实 key 假阴性。
      if (KNOWN_ENV_KEYS.has(key) && looksLikeRealSecret(val)) avail.add(key);
    } else if (section) {
      // 缩进的 key/token 行落在某个已知 provider 节内 → 映射为大写凭据键
      const mapped = SECTION_TO_CRED_KEY.get(section);
      if (mapped && /(key|token|secret)/i.test(key) && looksLikeRealSecret(val)) {
        avail.add(mapped);
      }
    }
  }
  return avail;
}

/**
 * 汇总用户可用的评分凭据：
 *   数据源 1：~/.dsh/.credentials.yaml（存在才读，读失败不致命）；
 *   数据源 2：进程环境变量（兜底）。
 * 返回结构只含 key 名与来源布尔结论，绝不携带密钥明文。
 */
function gatherCredentials() {
  const credPath = credentialsPath();
  const exists = isFile(credPath);
  let text = null;
  let scanned = null; // 仅键名集合（供展示）
  let fileAvail = new Set();
  if (exists) {
    text = readTextSafe(credPath);
    if (text != null) {
      fileAvail = analyzeCredentialText(text);
      scanned = new Set();
      for (const line of text.split(/\r?\n/)) {
        const m1 = line.match(/^\s*-?\s*['"]?([A-Za-z][A-Za-z0-9_.-]*)['"]?\s*:/);
        if (m1 && !line.trim().startsWith('#')) scanned.add(m1[1]);
        const m2 = line.match(/^\s*-\s*['"]?([A-Za-z][A-Za-z0-9_.-]*)['"]?\s*$/);
        if (m2) scanned.add(m2[1]);
      }
    }
  }
  const found = [];
  for (const backend of KNOWN_BACKENDS) {
    let source = null;
    if (fileAvail.has(backend.envKey)) {
      source = '凭据文件';
    } else if (looksLikeRealSecret(process.env[backend.envKey])) {
      source = '环境变量';
    }
    if (source) found.push({ ...backend, source });
  }
  return {
    credPath,
    exists,
    readable: text != null,
    scanned: scanned ? [...scanned] : null,
    found,
  };
}

/** 由一个已知后端生成推荐配置片段（两行 YAML）。 */
function recommendSnippet(backend) {
  return [`verifierModel: ${backend.model}`, `backendBaseUrl: ${backend.baseUrl}`];
}

/**
 * F-2（复盘 R-refcomp）：把「写哪份 cordis.patch.yml」参数化——同一套替换逻辑
 * 既用于仓库根的随包补丁，也用于 profile 的实际生效层
 * （~/.dsh/profiles/<profile>/cordis.patch.yml）。
 * 返回 { written: boolean, backupPath?: string, error?: string }。
 */
function patchConfigAt(patchPath, backend) {
  const text = readTextSafe(patchPath);
  if (text == null) return { written: false, error: `${patchPath} 不存在` };

  // 备份（F8: 只保留最近 3 份，防 .bak.<ts> 无限堆积）
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${patchPath}.bak.${timestamp}`;
  try {
    fs.copyFileSync(patchPath, backupPath);
    const dir = path.dirname(patchPath);
    const base = path.basename(patchPath);
    const olds = fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.bak.`)).sort();
    for (const old of olds.slice(0, Math.max(0, olds.length - 3))) {
      try { fs.unlinkSync(path.join(dir, old)); } catch { /* best-effort */ }
    }
  } catch (e) {
    return { written: false, error: `备份失败：${e.message}` };
  }

  // 替换 verifierModel 和 backendBaseUrl
  let newText = text;
  const lines = newText.split('\n');
  let vmReplaced = false;
  let bbReplaced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^[ \t]*verifierModel[ \t]*:/.test(line)) {
      lines[i] = line.replace(/^([ \t]*verifierModel[ \t]*:[ \t]*).+$/, `$1${backend.model}`);
      vmReplaced = true;
    } else if (/^[ \t]*backendBaseUrl[ \t]*:/.test(line)) {
      lines[i] = line.replace(/^([ \t]*backendBaseUrl[ \t]*:[ \t]*).+$/, `$1${backend.baseUrl}`);
      bbReplaced = true;
    }
  }
  newText = lines.join('\n');

  // F8: 缺行时插入到 verifier-brain 条目的 config 块，而不是假成功。
  if (!vmReplaced || !bbReplaced) {
    const insLines = [];
    if (!vmReplaced) insLines.push(`verifierModel: ${backend.model}`);
    if (!bbReplaced) insLines.push(`backendBaseUrl: ${backend.baseUrl}`);
    const lines2 = newText.split('\n');
    let insertAt = -1;
    let indent = '      ';
    for (let i = 0; i < lines2.length; i++) {
      if (/^[ \t]*-[ \t]+id:[ \t]*["']?verifier-brain["']?\s*$/.test(lines2[i])) {
        for (let j = i + 1; j <= i + 5 && j < lines2.length; j++) {
          const m = lines2[j].match(/^([ \t]*)config:[ \t]*$/);
          if (m) { insertAt = j + 1; indent = m[1] + '  '; break; }
        }
        break;
      }
    }
    if (insertAt >= 0) {
      insLines.forEach((l, k) => lines2.splice(insertAt + k, 0, indent + l));
      newText = lines2.join('\n');
    } else {
      return { written: false, error: `${path.basename(patchPath)} 缺少 verifier-brain 条目或其 config 块；请手动添加 verifierModel/backendBaseUrl 两行后重试 --fix` };
    }
  }

  // F8: 原子写（tmp + rename），失败时恢复备份。
  const tmpPath = `${patchPath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmpPath, newText, 'utf8');
    fs.renameSync(tmpPath, patchPath);
  } catch (e) {
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* best-effort */ }
    try { fs.copyFileSync(backupPath, patchPath); } catch { /* best-effort */ }
    return { written: false, error: `写入失败：${e.message}` };
  }

  return { written: true, backupPath, vmReplaced, bbReplaced };
}

function writePatchConfig(root, backend) {
  return patchConfigAt(path.join(root, 'cordis.patch.yml'), backend);
}

/** F-2：三层 cordis.patch.yml 关系——
 *   ① 仓库根 cordis.patch.yml   （clone 目录里 --fix 写的那份）
 *   ② 安装副本里的 cordis.patch.yml（dsh plugin add 随包分发进 profile 包目录）
 *   ③ profile 补丁 ~/.dsh/profiles/<profile>/cordis.patch.yml（【实际生效层】，
 *      覆盖前两者）。--fix 双写 ①+③；② 由宿主装配语义决定，改 ③ 即可覆盖它。 */
function profilePatchPath(profile) {
  return path.join(os.homedir(), '.dsh', 'profiles', profile, 'cordis.patch.yml');
}

/** 把推荐配置双写到仓库补丁 + profile 补丁（存在才写），返回渲染行与手动事项。 */
function applyRecommendedConfig(root, backend, profile) {
  const lines = [];
  const manual = [];
  const targets = [
    ['仓库补丁', path.join(root, 'cordis.patch.yml')],
    [`profile 补丁（实际生效层）`, profilePatchPath(profile)],
  ];
  let anyWritten = false;
  for (const [label, p] of targets) {
    if (!isFile(p)) {
      if (label.startsWith('profile')) {
        manual.push(`profile 补丁不存在：把 verifierModel/backendBaseUrl 两行加进 ${p} 的 verifier-brain 条目 config 块（或先 dsh plugin add 生成分发层后重跑 --fix）`);
      }
      continue;
    }
    const r = patchConfigAt(p, backend);
    if (r.written) {
      anyWritten = true;
      lines.push(`${MARK_OK} 已更新${label}：${gray(p)}`);
      lines.push(`      verifierModel:  ${backend.model}`);
      lines.push(`      backendBaseUrl: ${backend.baseUrl}`);
      if (r.backupPath) lines.push(`      ${gray('备份：')} ${path.basename(r.backupPath)}`);
    } else {
      lines.push(`${MARK_WARN} 更新${label}失败：${r.error}`);
      manual.push(`手动把 verifierModel/backendBaseUrl 写入 ${p}`);
    }
  }
  if (!anyWritten && manual.length === 0) {
    manual.push(`未找到任何 cordis.patch.yml（仓库根与 ~/.dsh/profiles/${profile}/ 都没有）；安装后按 README「配置详解」节创建`);
  }
  return { lines, manual, anyWritten };
}

/** 【嫁接 B2】从 cordis.patch.yml 抓取当前硬编码的 verifierModel / backendBaseUrl 值。 */
function readCurrentPatchConfig(root) {
  const p = path.join(root, 'cordis.patch.yml');
  const text = readTextSafe(p);
  if (text == null) return { fileExists: false, path: p };
  const grab = (name) => {
    const m = text.match(new RegExp(`^[ \\t]*${name}[ \\t]*:[ \\t]*(.+?)[ \\t]*$`, 'm'));
    return m ? normalizeYamlScalar(m[1]) : null;
  };
  return { fileExists: true, path: p, verifierModel: grab('verifierModel'), backendBaseUrl: grab('backendBaseUrl') };
}

/**
 * 渲染「凭据 / 推荐评分后端」区块，返回行数组。
 * indent 用于在 --fix 清单里二次缩进。
 * 【嫁接 B2】推荐片段之后对比 cordis.patch.yml 当前硬编码值。
 */
function renderCredentialSection(creds, root, indent = '    ') {
  const lines = [];

  // —— 凭据文件本身的状态
  if (!creds.exists) {
    lines.push(`${MARK_WARN} 未找到凭据文件 ${gray(creds.credPath)}（没有也不影响其它检查项）`);
  } else if (!creds.readable) {
    lines.push(`${MARK_BAD} 凭据文件存在但无法读取（请检查文件权限）：${creds.credPath}`);
  } else {
    const names = creds.scanned.filter((k) => /^[A-Za-z0-9_.-]+$/.test(k));
    lines.push(`${MARK_OK} 已读取凭据文件：${gray(creds.credPath)}（只显示键名，绝不显示值）`);
    if (names.length > 0) {
      const head = names.slice(0, 12);
      lines.push(
        `${indent}${cyan('·')} 其中包含的键名：${head.join(', ')}${names.length > head.length ? ' …' : ''}`,
      );
    }
  }

  // —— 是否能据此推荐评分后端
  if (creds.found.length > 0) {
    const primary = creds.found[0]; // KNOWN_BACKENDS 数组顺序即优先级
    lines.push(
      `${MARK_OK} 检测到可用评分凭据：${creds.found.map((f) => `${f.envKey}（来自${f.source}）`).join('、')}`,
    );
    lines.push(`${indent}${bold('推荐配置片段')}（依据 ${primary.envKey} → ${primary.label}）：`);
    for (const l of recommendSnippet(primary)) {
      lines.push(`${indent}${gray('| ')}${cyan(l)}`);
    }
    if (primary.verifyHint) {
      lines.push(`${indent}${MARK_WARN} 验证标注：${primary.verifyHint}`);
    }
    const others = creds.found.slice(1);
    if (others.length > 0) {
      lines.push(
        `${indent}${cyan('·')} 备选：${others.map((o) => `${o.envKey} → ${o.model} @ ${o.baseUrl}`).join('；')}`,
      );
    }
    lines.push(
      `${indent}${cyan('·')} 用法：把上面两行写入项目根目录的 ${bold('cordis.patch.yml')}，替换作者硬编码的 verifierModel / backendBaseUrl`,
    );

    // ——【嫁接 B2】对比 cordis.patch.yml 当前硬编码值
    const cur = readCurrentPatchConfig(root);
    if (cur.fileExists && (cur.verifierModel || cur.backendBaseUrl)) {
      lines.push(`${indent}${cyan('·')} 当前 ${cur.path} 中的硬编码值（作者环境）：`);
      lines.push(`${indent}      verifierModel:  ${cur.verifierModel ?? '(未找到)'}`);
      lines.push(`${indent}      backendBaseUrl: ${cur.backendBaseUrl ?? '(未找到)'}`);
      if (cur.backendBaseUrl && primary && cur.backendBaseUrl !== primary.baseUrl) {
        lines.push(`${indent}${MARK_WARN} 当前后端与你实际持有的凭据不一致——${bold('这正是「装完不能用」的根源')}，请用上面的首选片段替换这两行。`);
      } else if (cur.backendBaseUrl && primary && cur.backendBaseUrl === primary.baseUrl) {
        lines.push(`${indent}${MARK_OK} 当前配置已与你持有的凭据匹配，无需改动。`);
      }
    }
  } else {
    lines.push(`${MARK_BAD} 未发现可直接使用的评分后端凭据，任选以下渠道之一申请即可：`);
    for (const b of KNOWN_BACKENDS) {
      lines.push(`${indent}${cyan('·')} ${b.label}：申请入口 ${b.applyUrl}（对应键名 ${b.envKey}）`);
    }
    lines.push(
      `${indent}${cyan('·')} 拿到后写入 ${gray('~/.dsh/.credentials.yaml')}（支持三种写法：` +
      `扁平 ${KNOWN_BACKENDS[0].envKey}: sk-xxx ／ 列表项 "- ${KNOWN_BACKENDS[0].envKey}" ／ ` +
      `嵌套节 deepseek: + api_key:）或导出为同名环境变量`,
    );
  }
  return lines;
}

/* ----------------------------- --check 主流程 ----------------------------- */

function runCheck(root, opts = {}) {
  const strict = Boolean(opts.strict);
  console.log('');
  console.log(bold(hr('=')));
  console.log(bold(' dsh-verifier-Pro 就绪报告（--check 只读诊断模式）'));
  console.log(gray(` ${new Date().toLocaleString()}    脚本：${SELF_NAME}`));
  console.log(bold(hr('=')));

  const node = checkNodeInfo();
  const enginesNote = readEnginesNote(root); // 【嫁接 B1】
  const venv = checkVenv(root);
  const lib = checkLibBuild(root);
  const creds = gatherCredentials();

  const missing = []; // 待处理事项清单

  console.log('');
  console.log(`${bold('项目根目录')}：${root}`);

  // —— 【1/4】Node 版本
  console.log('');
  console.log(`${bold('【1/4】Node 运行时')}  ${node.ok ? MARK_OK : MARK_BAD}`);
  console.log(`    ${cyan('·')} 当前 ${node.version}，要求 >= ${MIN_NODE_MAJOR}.0.0`);
  if (enginesNote) {
    console.log(`    ${cyan('·')} package.json engines 另声明了：${enginesNote}（更严格时以其为准）`);
  }
  if (node.ok) {
    console.log(`    ${cyan('·')} 满足要求`);
  } else {
    missing.push('升级 Node.js 到 18 及以上（下载地址 https://nodejs.org ）');
    console.log(`    ${MARK_BAD} 不满足要求，部分功能可能无法工作`);
  }

  // —— 【2/4】Python 虚拟环境（保留四态判定；unknown 为【嫁接 A2】的优雅降级态）
  console.log('');
  console.log(`${bold('【2/4】Python 虚拟环境（.venv + llm-verifier）')}  ${
    venv.state === 'ready'
      ? (venv.pkgState === 'ok' ? MARK_OK : MARK_WARN)
      : venv.state === 'noPkg' ? MARK_WARN : MARK_BAD
  }`);
  switch (venv.state) {
    case 'ready':
      console.log(`    ${cyan('·')} 解释器：${venv.python}`);
      console.log(`    ${cyan('·')} Python ${venv.version}，import ${PY_MOD} 成功`);
      break;
    case 'noPkg':
      if (venv.pkgState === 'unknown') {
        // 【嫁接 A2】EPERM/沙箱拦截：标记"无法探测"，绝不误报"未安装"
        console.log(`    ${MARK_WARN} 解释器可用（Python ${venv.version}），但当前环境限制了子进程探测，无法确认 ${PY_PKG} 是否已安装`);
        if (venv.pkgError) console.log(indentBlock(venv.pkgError));
        console.log(`    ${cyan('·')} 建议：换一个普通终端运行本命令复核，或直接运行 ${q(venv.python)} -c "import ${PY_MOD}" 确认`);
      } else {
        console.log(`    ${MARK_WARN} 解释器可用（Python ${venv.version}），但缺少 ${PY_PKG}`);
        if (venv.pkgError) console.log(indentBlock(venv.pkgError));
        console.log(`    ${cyan('·')} 修复：运行 node ${SELF_NAME} --fix 自动补装`);
        missing.push(`安装 Python 包 ${PY_PKG}（可用 --fix 自动完成）`);
      }
      break;
    case 'broken':
      console.log(`    ${MARK_BAD} .venv 目录存在但解释器不可用：${venv.python}`);
      console.log(`    ${cyan('·')} 可能是损坏/残留的虚拟环境，请手动删除 ${venv.dir} 后运行 --fix`);
      missing.push('.venv 已损坏，需手动删除后重建');
      break;
    default:
      console.log(`    ${MARK_BAD} 未找到 .venv 目录（期望位置：${venv.dir}）`);
      console.log(`    ${cyan('·')} 修复：运行 node ${SELF_NAME} --fix 自动创建并安装`);
      missing.push(`创建 .venv 并安装 ${PY_PKG}（可用 --fix 自动完成）`);
      break;
  }

  // —— 【3/4】lib/ 编译产物
  console.log('');
  console.log(`${bold('【3/4】lib/ 编译产物')}  ${lib.ok ? MARK_OK : MARK_BAD}`);
  if (lib.ok) {
    console.log(`    ${cyan('·')} ${lib.libDir}（共 ${lib.jsCount} 个 .js 文件）`);
  } else {
    const bc = buildCommandHint(root);
    console.log(`    ${MARK_BAD} ${lib.reason}`);
    console.log(`    ${cyan('·')} 修复：在项目根目录执行 ${cyan(bc)}`);
    missing.push(`编译产物缺失：${bc}`);
  }

  // —— 【4/4】凭据与评分后端配置
  console.log('');
  console.log(`${bold('【4/4】凭据与评分后端配置')}  ${creds.found.length > 0 ? MARK_OK : MARK_BAD}`);
  for (const line of renderCredentialSection(creds, root)) {
    console.log(`    ${line}`);
  }
  if (creds.found.length === 0) {
    missing.push('申请并配置至少一个评分后端凭据（见上方渠道）');
  }

  // —— 汇总（fixture 级缺失项渲染，保留自 setup-c）
  const readyCount =
    (node.ok ? 1 : 0) +
    (venv.state === 'ready' && venv.pkgState === 'ok' ? 1 : 0) +
    (lib.ok ? 1 : 0) +
    (creds.found.length > 0 ? 1 : 0);

  console.log('');
  console.log(bold(hr('-')));
  if (missing.length === 0) {
    console.log(`${bold('汇总')}：4/4 全部就绪！装完即用，无需其它操作。`);
  } else {
    console.log(`${bold('汇总')}：${readyCount}/4 项就绪，${missing.length} 项待处理：`);
    missing.forEach((m, i) => console.log(`  ${i + 1}. ${m}`));
    console.log('');
    console.log(
      `${cyan('·')} 提示：${cyan(`node ${SELF_NAME} --fix`)} 可自动完成「创建 .venv / 安装 ${PY_PKG}」；其余事项请按上面提示手动处理`,
    );
  }
  console.log('');
  // G1（复盘 R-refcomp）：判别力自检入口提示——probe 只验「能不能评」，
  // 不验「评得好不好」；换评分模型后应跑一次质量回归门。
  if (venv.state === 'ready' && venv.pkgState === 'ok' && creds.found.length > 0) {
    console.log(`${cyan('·')} 可选：跑一次判别力自检验证评分模型质量（固定微任务 A/B 对照）：`);
    console.log(`      ${cyan(`node ${SELF_NAME} --bench`)}`);
  }
  console.log('');
  if (strict && missing.length > 0) {
    console.log(gray('--check --strict 模式：存在待处理项，exit 1（供 CI/脚本化预检）。'));
    process.exitCode = EXIT.GENERIC_FAILED;
    return;
  }
  console.log(gray('--check 模式恒定 exit 0（仅报告，不修改任何文件）；自动化预检加 --strict。'));

  process.exitCode = EXIT.OK; // 明确满足"--check 恒 0"的退出码约定
}

/* ----------------------------- --bench 判别力自检（G1） ----------------------------- */

/**
 * 跑 scripts/discriminative_check.py：固定微任务集 A/B 对照，实测「评分模型
 * 判别力」而非「连通性」。换评分模型后应跑一次，作为质量回归门。
 */
function runBench(root) {
  const venv = checkVenv(root);
  if (venv.state !== 'ready' || venv.pkgState !== 'ok') {
    console.log(`${MARK_BAD} .venv 未就绪（先运行 node ${SELF_NAME} --fix），无法执行判别力自检。`);
    process.exitCode = EXIT.GENERIC_FAILED;
    return;
  }
  const script = path.join(root, 'scripts', 'discriminative_check.py');
  if (!isFile(script)) {
    console.log(`${MARK_BAD} 未找到 ${script}（安装不完整？）。`);
    process.exitCode = EXIT.GENERIC_FAILED;
    return;
  }
  console.log('');
  console.log(bold(hr('=')));
  console.log(bold(' dsh-verifier-Pro 判别力自检（--bench · G1）'));
  console.log(gray(` 解释器：${venv.python}`));
  console.log(bold(hr('=')));
  console.log(`${cyan('·')} 将对固定微任务集发起真实评分调用（会产生少量 API 费用）；`);
  console.log(`${cyan('·')} 通过标准：好/坏候选方向判定全部正确（详见脚本内说明）。`);
  const r = run(venv.python, [script], { inherit: true, cwd: root, timeoutMs: 900_000 });
  process.exitCode = r && !r.error && r.status === 0 ? EXIT.OK : EXIT.GENERIC_FAILED;
}

/* ----------------------------- --fix 主流程 ----------------------------- */

/** 收尾：打印结果并设置退出码（--fix 成功 0 / 失败按类型 10~14）。 */
function finishFix(exitCode, manualItems) {
  console.log('');
  console.log(bold(hr('-')));
  if (exitCode === EXIT.OK) {
    console.log(
      `${green('结果：--fix 完成')}（核心安装成功）。剩余 ${manualItems.length} 项手动事项见上方清单。`,
    );
  } else {
    console.log(`${red('结果：--fix 未完成')}（退出码 ${exitCode}），请按上方提示处理后重新运行。`);
  }
  process.exitCode = exitCode;
}

/**
 * --fix 主流程。【嫁接 A3】失败按类型返回分型错误码：
 *   13=Node过旧 → 14=找不到项目根 → 10=无Python → 11=venv失败 → 12=pip失败。
 */
function runFix(root, opts = {}) {
  const profile = opts.profile || 'web';
  console.log('');
  console.log(bold(hr('=')));
  console.log(bold(' dsh-verifier-Pro 自动修复（--fix）'));
  console.log(gray(` 项目根目录：${root}`));
  console.log(bold(hr('=')));
  console.log('');
  console.log(`${cyan('·')} 将依次执行：① 创建 .venv（若缺失）→ ② 安装 ${PY_PKG} → ③ 复核 →`);
  console.log(`${cyan('·')}   ④ 双写推荐评分配置（仓库补丁 + profile 补丁）→ ⑤ 构建 lib/ → ⑥ 挂载到 profile「${profile}」`);
  console.log(gray('  凡涉及写入文件或网络下载的操作，都会先打印实际执行的命令再运行。'));

  // ---------- 前置校验 ①：Node 版本硬门槛（【嫁接 A3】退出码 13） ----------
  const node = checkNodeInfo();
  if (!node.ok) {
    console.log('');
    console.log(`${red(`✘ 当前 Node ${node.version} 低于要求的 ${MIN_NODE_MAJOR}.x，终止修复。`)}`);
    console.log(`  请先安装 Node ${MIN_NODE_MAJOR}+ LTS：https://nodejs.org`);
    process.exitCode = EXIT.NODE_TOO_OLD;
    return;
  }

  // ---------- 前置校验 ②：项目根必须存在 package.json（【嫁接 A3】退出码 14） ----------
  if (!isFile(path.join(root, 'package.json'))) {
    console.log('');
    console.log(red(`✘ 无法定位项目根目录（当前猜测：${root}，其下没有 package.json）。`));
    console.log('  请在项目根目录下运行本脚本，或用 --root <目录> 手动指定。');
    process.exitCode = EXIT.ROOT_NOT_FOUND;
    return;
  }

  // ---------- 步骤 ①：确保 .venv ----------
  console.log('');
  console.log(bold('【步骤 1/6】确保 Python 虚拟环境 .venv'));
  let venv = checkVenv(root);
  if (venv.state === 'ready' || venv.state === 'noPkg') {
    console.log(`  ${MARK_OK} 已有可用虚拟环境：${venv.dir}${venv.version ? gray(`（Python ${venv.version}）`) : ''}`);
  } else if (venv.state === 'broken') {
    console.log(`  ${MARK_WARN} .venv 存在但解释器不可用（可能是损坏的残留目录）：${venv.python}`);
    console.log(`  ${cyan('·')} 本脚本不会擅自删除目录；请手动删除 ${venv.dir} 后重试 --fix。`);
    finishFix(EXIT.VENV_CREATE_FAILED, ['.venv 已损坏，需手动删除后重试']);
    return;
  } else {
    // 【嫁接 B4】discoverSystemPythons 内部已做商店桩过滤 + py -3 优先
    const { found: pythons, anyBlocked } = discoverSystemPythons();
    if (pythons.length === 0) {
      console.log(`  ${MARK_BAD} 未找到可用的系统 Python，无法创建 .venv。`);
      if (anyBlocked) {
        // 【嫁接 A2】候选被 EPERM 拦截时如实说明，而不是说"没装"
        console.log(`  ${MARK_WARN} 注意：部分候选解释器被子进程限制拦截（EPERM），可能实际已安装但无法探测；请换普通终端重试。`);
      }
      console.log(`  ${cyan('·')} Windows：到 https://www.python.org/downloads/ 安装，安装时勾选 "Add python.exe to PATH"；`);
      console.log(`  ${cyan('·')} macOS：brew install python3（或 xcode-select --install）；`);
      console.log(`  ${cyan('·')} Ubuntu/Debian：sudo apt install python3 python3-venv；`);
      console.log(`  ${cyan('·')} 也可把解释器完整路径写入环境变量 PYTHON 后重试。`);
      finishFix(EXIT.PYTHON_NOT_FOUND, ['先安装系统 Python']);
      return;
    }
    const chosen = pythons[0];
    // m-1（复盘 R-refcomp）：与 README 口径对齐（Python 3.10+）；仅软警告不阻止。
    if (versionWeight(chosen.version) < versionWeight('3.10')) {
      console.log(`  ${MARK_WARN} 选中的 Python ${chosen.version} 低于文档声明的 3.10+，llm-verifier 可能不兼容（CI 仅实测 3.12）`);
    }
    const prefixStr = chosen.prefix.length > 0 ? chosen.prefix.join(' ') + ' ' : '';
    const prefixNote = chosen.prefix.length > 0 ? `（${chosen.prefix.join(' ')}）` : '';
    console.log(`  ${cyan('·')} 使用系统 Python：${q(chosen.exe)}${prefixNote}（${chosen.version}）`);
    console.log(`  ${cyan('·')} 即将执行（会在项目根目录写入 .venv/）：`);
    console.log(gray(`      > ${q(chosen.exe)} ${prefixStr}-m venv ${q(venvDirOf(root))}`));
    const r = run(chosen.exe, [...chosen.prefix, '-m', 'venv', venvDirOf(root)], {
      inherit: true,
      timeoutMs: 180_000,
    });
    if (!r || r.error || r.status !== 0) {
      const why = r && r.error ? `（${r.error.code || r.error}）` : `（exit ${r ? r.status : '?'}）`;
      console.log(`  ${MARK_BAD} 创建 .venv 失败 ${why}`);
      console.log(`  ${cyan('·')} Ubuntu/Debian 若报 ensurepip 缺失：sudo apt install python3-venv 后重试。`);
      finishFix(EXIT.VENV_CREATE_FAILED, ['创建 .venv 失败']); // 【嫁接 A3】退出码 11
      return;
    }
    venv = checkVenv(root);
    if (venv.state === 'missing' || venv.state === 'broken') {
      console.log(`  ${MARK_BAD} .venv 创建命令已执行，但解释器仍不可用：${venv.python}`);
      finishFix(EXIT.VENV_CREATE_FAILED, ['.venv 创建后不可用']); // 【嫁接 A3】退出码 11
      return;
    }
    console.log(`  ${MARK_OK} .venv 已创建（Python ${venv.version}）`);
  }

  // ---------- 步骤 ②：安装 llm-verifier ----------
  console.log('');
  console.log(bold(`【步骤 2/6】在 .venv 中安装 ${PY_PKG}`));
  venv = checkVenv(root);
  if (venv.state === 'ready') {
    console.log(`  ${MARK_OK} ${PY_PKG} 已可导入，跳过安装（如需重装请先 pip uninstall ${PY_PKG}）。`);
  } else {
    // 个别环境下 venv 可能缺 pip，先确保 pip 可用（借鉴 setup-b 的 ensurepip 预检）
    const pipProbe = run(venv.python, ['-m', 'pip', '--version'], { timeoutMs: 30_000 });
    if (pipProbe.error || pipProbe.status !== 0) {
      console.log(`  ${cyan('·')} .venv 内未见可用 pip，先执行 ensurepip：`);
      console.log(gray(`      > ${q(venv.python)} -m ensurepip --upgrade`));
      run(venv.python, ['-m', 'ensurepip', '--upgrade'], { inherit: true, timeoutMs: 180_000 });
    }
    console.log(`  ${cyan('·')} 即将执行（联网下载，可能需要几分钟）：`);
    console.log(gray(`      > ${q(venv.python)} -m pip install "${PY_PKG_REQ}"`));
    const r = run(venv.python, ['-m', 'pip', '--disable-pip-version-check', 'install', PY_PKG_REQ], {
      inherit: true,
      timeoutMs: 900_000,
    });
    if (!r || r.error || r.status !== 0) {
      const timedOut = Boolean(r && r.error && r.error.code === 'ETIMEDOUT');
      console.log(`  ${MARK_BAD} pip 安装失败${timedOut ? '（超时）' : ''}。`);
      // 【嫁接 B3】给出清华镜像源的手动完整命令
      console.log(`  ${cyan('·')} 国内网络可直接用清华镜像源手动安装：`);
      console.log(gray(`      ${q(venv.python)} -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple "${PY_PKG_REQ}"`));
      console.log(`  ${cyan('·')} 或设置镜像环境变量后重试：`);
      console.log(`      CMD：        set PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple`);
      console.log(`      PowerShell： $env:PIP_INDEX_URL="https://pypi.tuna.tsinghua.edu.cn/simple"`);
      finishFix(EXIT.PIP_INSTALL_FAILED, [`pip install ${PY_PKG} 失败`]); // 【嫁接 A3】退出码 12
      return;
    }
  }

  // ---------- 步骤 ③：复核 ----------
  console.log('');
  console.log(bold('【步骤 3/6】复核安装结果'));
  venv = checkVenv(root);
  const coreOk =
    (venv.state === 'ready' && venv.pkgState === 'ok') ||
    (venv.state === 'ready' && venv.pkgState === 'unknown'); // 拦截环境下不误判失败
  if (venv.state === 'ready' && venv.pkgState === 'ok') {
    console.log(`  ${MARK_OK} import ${PY_MOD} 成功（Python ${venv.version}），verifier 依赖链已通。`);
  } else if (venv.state === 'ready' && venv.pkgState === 'unknown') {
    console.log(`  ${MARK_WARN} 当前环境限制了子进程探测，无法确认 ${PY_MOD}；请在普通终端复核。`);
  } else {
    console.log(`  ${MARK_BAD} import ${PY_MOD} 仍未通过（状态：${venv.state}）`);
    if (venv.pkgError) console.log(indentBlock(venv.pkgError));
  }

  // ---------- 步骤 ④：双写推荐配置（F-2：仓库补丁 + profile 实际生效层） ----------
  console.log('');
  console.log(bold('【步骤 4/6】双写推荐评分后端配置'));
  console.log(`  ${gray('三层关系：① clone 目录的 cordis.patch.yml（本步写）→ ② 安装副本随包分发的同名文件 →')}`);
  console.log(`  ${gray('③ ~/.dsh/profiles/' + profile + '/cordis.patch.yml 是【实际生效层】，覆盖前两者——本步两层都写，改配置只需认 ③。')}`);
  const credsForPatch = gatherCredentials();
  let patchWritten = false;
  const fixManual = [];
  if (credsForPatch.found.length > 0) {
    const primary = credsForPatch.found[0];
    const applied = applyRecommendedConfig(root, primary, profile);
    for (const l of applied.lines) console.log(`  ${l}`);
    for (const m of applied.manual) fixManual.push(m);
    patchWritten = applied.anyWritten;
  } else {
    console.log(`  ${MARK_WARN} 无可用凭据，跳过自动更新（需手动配置后再运行 --fix）`);
  }

  // ---------- 步骤 ⑤：构建 lib/（F-1：一键安装必须真的产出可加载的插件） ----------
  console.log('');
  console.log(bold('【步骤 5/6】构建 lib/（npm run build）'));
  let buildOk = false;
  let lib = checkLibBuild(root);
  if (lib.ok && !process.env.FORCE_BUILD) {
    console.log(`  ${MARK_OK} lib/ 编译产物已存在（${lib.jsCount} 个 .js 文件），跳过构建（FORCE_BUILD=1 可强制重建）。`);
    buildOk = true;
  } else {
    const npmExe = IS_WIN ? 'npm.cmd' : 'npm';
    console.log(`  ${cyan('·')} 即将执行（首次可能引导安装 typescript/tsdown，需联网）：`);
    console.log(gray(`      > ${npmExe} run build`));
    const r = run(npmExe, ['run', 'build'], { inherit: true, cwd: root, timeoutMs: 900_000 });
    lib = checkLibBuild(root);
    buildOk = Boolean(r && !r.error && r.status === 0 && lib.ok);
    if (buildOk) {
      console.log(`  ${MARK_OK} 构建完成（lib/ 共 ${lib.jsCount} 个 .js 文件）。`);
    } else {
      console.log(`  ${MARK_BAD} 构建失败或产物缺失。请手动在项目根目录执行：${cyan(buildCommandHint(root))}`);
      fixManual.push(`构建失败：请在项目根目录执行 ${buildCommandHint(root)} 后重试`);
    }
  }

  // ---------- 步骤 ⑥：挂载到 profile（F-1 收尾） ----------
  console.log('');
  console.log(bold(`【步骤 6/6】挂载到 dsh profile「${profile}」`));
  const mountCmd = `dsh plugin --profile ${profile} add ${q(root)}`;
  if (opts.noMount) {
    console.log(`  ${MARK_WARN} 已指定 --no-mount，跳过自动挂载。就绪后请执行：`);
    console.log(gray(`      > ${mountCmd}`));
  } else {
    const dshExe = detectDshCli();
    if (!dshExe) {
      console.log(`  ${MARK_WARN} 未检测到 dsh CLI（不在 PATH）。环境就绪后请手动挂载并重启 dsh：`);
      console.log(gray(`      > ${mountCmd}`));
      fixManual.push(`挂载：${mountCmd} ，然后重启 dsh`);
    } else {
      console.log(`  ${cyan('·')} 检测到 dsh CLI，即将执行：`);
      console.log(gray(`      > ${mountCmd}`));
      const r = run(dshExe, ['plugin', '--profile', profile, 'add', root], { inherit: true, cwd: root, timeoutMs: 300_000 });
      if (!r || r.error || r.status !== 0) {
        console.log(`  ${MARK_WARN} 自动挂载未成功，请手动执行：${mountCmd}`);
        fixManual.push(`自动挂载未成功，请手动执行：${mountCmd} ，然后重启 dsh`);
      } else {
        console.log(`  ${MARK_OK} 已挂载到 profile「${profile}」。重启 dsh 生效；Web 页面如已打开请刷新一次。`);
      }
    }
  }

  // ---------- 剩余手动事项 ----------
  console.log('');
  console.log(bold('剩余需要你确认的事项'));
  const manual = fixManual;

  const creds = gatherCredentials();
  for (const line of renderCredentialSection(creds, root, '      ')) {
    console.log(`  ${line}`);
  }
  if (creds.found.length > 0 && !patchWritten) {
    manual.push('把推荐的 verifierModel/backendBaseUrl 写入 cordis.patch.yml 的 verifier-brain 条目（profile 层优先）');
  } else if (creds.found.length === 0) {
    manual.push('申请并配置至少一个评分后端凭据（见上方渠道）');
  }

  const exitCode = !coreOk ? EXIT.GENERIC_FAILED : (!buildOk ? EXIT.BUILD_FAILED : EXIT.OK);
  finishFix(exitCode, manual);
}

/** F-1：探测 dsh CLI 是否可用（返回可执行名或 null）。 */
function detectDshCli() {
  const exe = IS_WIN ? 'dsh.cmd' : 'dsh';
  const r = run(exe, ['--version'], { timeoutMs: 15_000 });
  return r && !r.error && r.status === 0 ? exe : null;
}

/* ----------------------------- 帮助与入口 ----------------------------- */

function printHelp() {
  console.log('');
  console.log(bold(`${SELF_NAME} —— dsh-verifier-Pro 一键安装 / 诊断脚本`));
  console.log('');
  console.log('用法：');
  console.log(`  node ${SELF_NAME} [--check | --fix] [--root <项目根目录>]`);
  console.log('');
  console.log('模式：');
  console.log('  （默认，等价 --check）只诊断不修改，输出就绪报告；缺项时恒 exit 0。');
  console.log('  --fix                  自动修复：创建 .venv → pip 安装 llm-verifier → 复核 →');
  console.log('                         双写推荐配置（仓库补丁 + profile 补丁）→ 构建 lib/ →');
  console.log('                         挂载到 dsh profile。成功退出码 0；失败按类型返回：');
  console.log('                           10 = 未找到可用系统 Python');
  console.log('                           11 = 创建 .venv 失败');
  console.log('                           12 = pip 安装 llm-verifier 失败');
  console.log('                           13 = Node 版本过低');
  console.log('                           14 = 找不到项目根目录');
  console.log('                           15 = lib/ 构建失败');
  console.log('  --bench                判别力自检（G1）：固定微任务集实测评分模型判别力，');
  console.log('                         换评分模型后的质量回归门（产生少量真实 API 费用）;');
  console.log('                         全部方向判定正确 exit 0，否则 exit 1。');
  console.log('  --help, -h             显示本帮助。');
  console.log('');
  console.log('选项：');
  console.log('  --root <目录>          显式指定项目根目录（支持 "--root 目录" 与 "--root=目录" 两种写法）。');
  console.log('  --profile <名称>       --fix 挂载目标 profile（默认 web）。');
  console.log('  --no-mount             --fix 只做到构建为止，不自动挂载。');
  console.log('  --strict               与 --check 连用：存在待处理项时 exit 1（CI/脚本化预检）。');
  console.log('');
  console.log('示例：');
  console.log(`  node ${SELF_NAME}                # clone 之后先做个体检`);
  console.log(`  node ${SELF_NAME} --fix          # 一键补齐 Python 环境`);
  console.log(`  node ${SELF_NAME} --check --root D:\\code\\dsh-verifier-Pro`);
  console.log('');
  console.log('说明：');
  console.log('  · 纯 Node 实现、零第三方依赖；要求 Node >= 18；Windows / macOS / Linux 均可。');
  console.log('  · 凭据检测只读取 ~/.dsh/.credentials.yaml 的键名，任何密钥值都不会被打印。');
  console.log('  · 凭据文件兼容三种写法：扁平键值对、"- KEY" 列表项、"provider:" + "api_key:" 嵌套节。');
  console.log('  · 如需关闭彩色输出，可设置环境变量 NO_COLOR=1。');
  console.log('');
}

function main() {
  const argv = process.argv.slice(2);

  if (argv.some((a) => a === '--help' || a === '-h')) {
    printHelp();
    process.exitCode = EXIT.OK;
    return;
  }

  const wantFix = argv.includes('--fix');
  const wantCheck = argv.includes('--check');
  const wantBench = argv.includes('--bench');
  const strict = argv.includes('--strict');
  const noMount = argv.includes('--no-mount');

  // --root / --profile 均支持 "空格分隔" 与 "=" 连写两种语法。
  const valueFlagIdx = (name) => {
    const i = argv.indexOf(name);
    return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? i + 1 : -1;
  };
  const rootValueIdx = valueFlagIdx('--root');
  const profileValueIdx = valueFlagIdx('--profile');
  const profileEq = argv.find((a) => a.startsWith('--profile='));

  const knownFlags = new Set(['--fix', '--check', '--bench', '--strict', '--no-mount', '--root', '--profile']);
  const unknown = argv.filter((a, i) => {
    if (knownFlags.has(a) || a.startsWith('--root=') || a.startsWith('--profile=')) return false;
    if (i === rootValueIdx || i === profileValueIdx) return false; // 标志的值，不是未知参数
    return true;
  });

  // 退出码纪律：参数错误一律 2（保留自 setup-c）
  if ((wantFix && wantCheck) || (wantBench && (wantFix || wantCheck))) {
    console.error(red('错误：--check / --fix / --bench 只能三选一。'));
    printHelp();
    process.exitCode = EXIT.BAD_ARGS;
    return;
  }
  if (strict && !wantCheck) {
    console.error(red('错误：--strict 只能与 --check 连用。'));
    process.exitCode = EXIT.BAD_ARGS;
    return;
  }
  if (unknown.length > 0) {
    console.error(red(`错误：无法识别的参数：${unknown.join(' ')}`));
    printHelp();
    process.exitCode = EXIT.BAD_ARGS;
    return;
  }

  const opts = {
    strict,
    noMount,
    profile: profileEq ? normalizeYamlScalar(profileEq.slice('--profile='.length)) : undefined,
  };

  const root = findProjectRoot(argv);
  if (wantFix) {
    runFix(root, opts);
  } else if (wantBench) {
    runBench(root);
  } else {
    runCheck(root, opts); // 默认行为等价于 --check
  }
}

try {
  main();
} catch (err) {
  // 兜底异常保护：诊断脚本自身绝不该无声崩溃
  console.error(red(`脚本异常：${err && err.message ? err.message : err}`));
  if (err && err.stack) console.error(gray(indentBlock(err.stack.split('\n').slice(1, 5).join('\n'))));
  process.exitCode = EXIT.GENERIC_FAILED;
}
