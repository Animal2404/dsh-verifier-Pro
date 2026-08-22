#!/usr/bin/env node
/**
 * ============================================================
 * merged-setup.mjs —— dsh-verifier-Pro 一键安装 / 诊断脚本
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
 *   node merged-setup.mjs              # 等价于 --check（只诊断，不修改）
 *   node merged-setup.mjs --check      # 只诊断不修改；无论缺什么 exit code 恒为 0
 *   node merged-setup.mjs --fix        # 自动修复：创建 .venv、安装 llm-verifier
 *                                      # 成功 exit 0；失败按类型返回 10~14
 *   node merged-setup.mjs --help       # 帮助
 *   --root <目录> / --root=<目录>      # 显式指定项目根目录（两种语法都支持）
 *
 * 设计约束：
 *   - 纯 Node 实现、零第三方依赖（仅 node: 内置模块）；要求 Node >= 18；
 *   - Windows / macOS / Linux 兼容；
 *   - 凭据检测只识别键名，任何密钥明文都不会被读取后打印；
 *   - 所有输出与注释均为中文。
 *
 * 退出码纪律：
 *   --check：报告正常完成恒为 0；仅诊断自身崩溃才非 0（1）。
 *   --fix  ：成功 0；参数错误 2；按失败类型返回 10~14。
 * ============================================================
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ----------------------------- 常量 ----------------------------- */

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const SELF_NAME = path.basename(process.argv[1] || SCRIPT_FILE) || 'merged-setup.mjs';
const IS_WIN = process.platform === 'win32';

const MIN_NODE_MAJOR = 18;      // 项目要求的 Node 最低大版本
const PY_PKG = 'llm-verifier';  // venv 内必需的 Python 包名
const PY_MOD = 'llm_verifier';  // 对应的 import 模块名

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
  },
  {
    envKey: 'OPENCODE_GO_API_KEY',
    label: 'OpenCode Zen',
    model: 'deepseek-v4-flash',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    applyUrl: 'https://opencode.ai',
  },
  {
    envKey: 'OPENROUTER_API_KEY',
    label: 'OpenRouter',
    model: 'deepseek/deepseek-chat',
    baseUrl: 'https://openrouter.ai/api/v1',
    applyUrl: 'https://openrouter.ai/settings/keys',
  },
  {
    envKey: 'OPENAI_API_KEY',
    label: 'OpenAI 官方（兜底）',
    model: 'gpt-4o-mini',
    baseUrl: 'https://api.openai.com/v1',
    applyUrl: 'https://platform.openai.com/api-keys',
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
 * 自动写入 cordis.patch.yml 的 verifierModel / backendBaseUrl（带备份）。
 * 返回 { written: boolean, backupPath?: string, error?: string }。
 */
function writePatchConfig(root, backend) {
  const patchPath = path.join(root, 'cordis.patch.yml');
  const text = readTextSafe(patchPath);
  if (text == null) return { written: false, error: 'cordis.patch.yml 不存在' };

  // 备份
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${patchPath}.bak.${timestamp}`;
  try {
    fs.copyFileSync(patchPath, backupPath);
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

  try {
    fs.writeFileSync(patchPath, newText, 'utf8');
  } catch (e) {
    // 恢复备份
    try { fs.copyFileSync(backupPath, patchPath); } catch {}
    return { written: false, error: `写入失败：${e.message}` };
  }

  return { written: true, backupPath, vmReplaced, bbReplaced };
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

function runCheck(root) {
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
  console.log(gray('--check 模式恒定 exit 0（仅报告，不修改任何文件）。'));

  process.exitCode = EXIT.OK; // 明确满足"--check 恒 0"的退出码约定
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
function runFix(root) {
  console.log('');
  console.log(bold(hr('=')));
  console.log(bold(' dsh-verifier-Pro 自动修复（--fix）'));
  console.log(gray(` 项目根目录：${root}`));
  console.log(bold(hr('=')));
  console.log('');
  console.log(`${cyan('·')} 将依次执行：① 创建 .venv（若缺失）→ ② 安装 ${PY_PKG} → ③ 复核 → ④ 输出剩余手动事项`);
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
  console.log(bold('【步骤 1/4】确保 Python 虚拟环境 .venv'));
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
    if (versionWeight(chosen.version) < versionWeight('3.9')) {
      // 仅提示性软警告：低于 3.9 时提醒，但不阻止继续
      console.log(`  ${MARK_WARN} 选中的 Python ${chosen.version} 版本较老，llm-verifier 可能要求 >= 3.9`);
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
  console.log(bold(`【步骤 2/4】在 .venv 中安装 ${PY_PKG}`));
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
    console.log(gray(`      > ${q(venv.python)} -m pip install ${PY_PKG}`));
    const r = run(venv.python, ['-m', 'pip', '--disable-pip-version-check', 'install', PY_PKG], {
      inherit: true,
      timeoutMs: 900_000,
    });
    if (!r || r.error || r.status !== 0) {
      const timedOut = Boolean(r && r.error && r.error.code === 'ETIMEDOUT');
      console.log(`  ${MARK_BAD} pip 安装失败${timedOut ? '（超时）' : ''}。`);
      // 【嫁接 B3】给出清华镜像源的手动完整命令
      console.log(`  ${cyan('·')} 国内网络可直接用清华镜像源手动安装：`);
      console.log(gray(`      ${q(venv.python)} -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple ${PY_PKG}`));
      console.log(`  ${cyan('·')} 或设置镜像环境变量后重试：`);
      console.log(`      CMD：        set PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple`);
      console.log(`      PowerShell： $env:PIP_INDEX_URL="https://pypi.tuna.tsinghua.edu.cn/simple"`);
      finishFix(EXIT.PIP_INSTALL_FAILED, [`pip install ${PY_PKG} 失败`]); // 【嫁接 A3】退出码 12
      return;
    }
  }

  // ---------- 步骤 ③：复核 ----------
  console.log('');
  console.log(bold('【步骤 3/4】复核安装结果'));
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

  // ---------- 步骤 ③.5：自动写入 cordis.patch.yml 推荐配置 ----------
  console.log('');
  console.log(bold('【步骤 3.5/4】自动写入推荐评分后端配置'));
  const credsForPatch = gatherCredentials();
  let patchWritten = false;
  let patchBackup = '';
  if (credsForPatch.found.length > 0) {
    const primary = credsForPatch.found[0];
    const result = writePatchConfig(root, primary);
    if (result.written) {
      patchWritten = true;
      patchBackup = result.backupPath;
      console.log(`  ${MARK_OK} 已自动更新 cordis.patch.yml：`);
      console.log(`      verifierModel:  ${primary.model}`);
      console.log(`      backendBaseUrl: ${primary.baseUrl}`);
      console.log(`      ${gray('备份：')} ${path.basename(result.backupPath)}`);
    } else {
      console.log(`  ${MARK_WARN} 自动更新失败：${result.error}，需手动修改`);
    }
  } else {
    console.log(`  ${MARK_WARN} 无可用凭据，跳过自动更新（需手动配置后再运行 --fix）`);
  }

  // ---------- 步骤 ④：剩余手动事项 ----------
  console.log('');
  console.log(bold('【步骤 4/4】需要你手动确认的事项'));
  const manual = [];

  const lib = checkLibBuild(root);
  if (lib.ok) {
    console.log(`  ${MARK_OK} lib/ 编译产物齐全（${lib.jsCount} 个 .js 文件），无需处理。`);
  } else {
    const bc = buildCommandHint(root);
    console.log(`  ${MARK_WARN} lib/ 编译产物缺失，请在项目根目录执行：${cyan(bc)}`);
    manual.push(`编译产物缺失：${bc}`);
  }

  const creds = gatherCredentials();
  for (const line of renderCredentialSection(creds, root, '      ')) {
    console.log(`  ${line}`);
  }
  if (creds.found.length > 0 && !patchWritten) {
    manual.push('把推荐的 verifierModel/backendBaseUrl 写入 cordis.patch.yml（替换作者环境的硬编码值）');
  } else if (creds.found.length === 0) {
    manual.push('申请并配置至少一个评分后端凭据（见上方渠道）');
  }

  finishFix(coreOk ? EXIT.OK : EXIT.GENERIC_FAILED, manual);
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
  console.log('  （默认，等价 --check）只诊断不修改，输出就绪报告；无论缺什么，退出码恒为 0。');
  console.log('  --fix                  自动修复：创建 .venv、在其中 pip 安装 llm-verifier，');
  console.log('                         成功退出码 0；失败按类型返回：');
  console.log('                           10 = 未找到可用系统 Python');
  console.log('                           11 = 创建 .venv 失败');
  console.log('                           12 = pip 安装 llm-verifier 失败');
  console.log('                           13 = Node 版本过低');
  console.log('                           14 = 找不到项目根目录');
  console.log('  --help, -h             显示本帮助。');
  console.log('');
  console.log('选项：');
  console.log('  --root <目录>          显式指定项目根目录（支持 "--root 目录" 与 "--root=目录" 两种写法）。');
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

  // --root 既支持 "--root <目录>"（值是下一个 token，需加入白名单），
  // 也支持 "--root=<目录>"。若下一个 token 以 -- 开头则视为没给值。
  const rootFlagIdx = argv.indexOf('--root');
  const rootValueIdx =
    rootFlagIdx !== -1 && argv[rootFlagIdx + 1] && !argv[rootFlagIdx + 1].startsWith('--')
      ? rootFlagIdx + 1
      : -1;

  const unknown = argv.filter((a, i) => {
    if (a === '--fix' || a === '--check' || a === '--root' || a.startsWith('--root=')) return false;
    if (i === rootValueIdx) return false; // 这是 --root 的目录值，不是未知参数
    return true;
  });

  // 退出码纪律：参数错误一律 2（保留自 setup-c）
  if (wantFix && wantCheck) {
    console.error(red('错误：--check 与 --fix 不能同时使用。'));
    printHelp();
    process.exitCode = EXIT.BAD_ARGS;
    return;
  }
  if (unknown.length > 0) {
    console.error(red(`错误：无法识别的参数：${unknown.join(' ')}`));
    printHelp();
    process.exitCode = EXIT.BAD_ARGS;
    return;
  }

  const root = findProjectRoot(argv);
  if (wantFix) {
    runFix(root);
  } else {
    runCheck(root); // 默认行为等价于 --check
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
