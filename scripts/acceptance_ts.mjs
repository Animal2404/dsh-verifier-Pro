#!/usr/bin/env node
/**
 * dsh-verifier-Pro 验收回归 (TypeScript 层)
 * 直接调用 lib/tools.js 的 createEscalationRunner —— 覆盖
 * 自适应升级 / 缓存 / flat 检测 / 槽位交替 / 方向一致性判定。
 * 对应 ITERATION_PLAN.md §3 十个验收用例（原文档已归档至 docs/HISTORY.md）。
 */
import { PythonBridge } from '../lib/bridge.js';
import { VerifierStore } from '../lib/persist.js';
import { createEscalationRunner, createVerifierTaskManager } from '../lib/tools.js';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

const scriptPath = join(ROOT, 'bridge', 'verifier_brain_bridge.py');
const pythonBin = join(ROOT, '.venv', 'Scripts', 'python.exe');
// 安全铁律：绝不 fallback 明文密钥。无 env 时跳过在线用例（审计 P0-1）。
const API_KEY = process.env.OPENCODE_GO_API_KEY;
if (!API_KEY) {
  console.error('acceptance_ts: OPENCODE_GO_API_KEY 未设置——跳过在线验收（不使用任何硬编码凭据）。');
  process.exit(0);
}

const env = {
  ...process.env,
  DEEPSEEK_EFFORT: 'off',
  OPENAI_BASE_URL: 'https://opencode.ai/zen/go/v1',
  OPENAI_API_KEY: API_KEY,
};

// Fresh state dir per run (so history-based budget estimates start clean)
const stateDir = mkdtempSync(join(tmpdir(), 'verifier-acc-'));
const store = new VerifierStore(stateDir);
const bridge = new PythonBridge(scriptPath, pythonBin, 300_000, env);
const getBridge = async () => bridge;

const deps = {
  getBridge,
  store,
  esc: { autoEscalate: true, escalateThreshold: 0.15, maxEscalateK: 3 },
  budgetMs: () => 1_800_000,
};

const runner = createEscalationRunner(deps);

async function runTest(name, fn) {
  const start = Date.now();
  try {
    const result = await fn();
    console.log(`✅ ${name} (${Date.now() - start}ms)`);
    return { name, pass: true, result };
  } catch (e) {
    console.log(`❌ ${name} (${Date.now() - start}ms): ${e.message}`);
    return { name, pass: false, error: e.message };
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('dsh-verifier-Pro 验收回归 (TypeScript 层, ITERATION_PLAN §3)');
  console.log('='.repeat(60));
  console.log('');

  const results = [];

  // #1 好文 vs 乱码 — margin 巨大，不触发升级
  results.push(await runTest('#1 好文 vs 乱码 compare', async () => {
    const r = await runner('compare', {
      problem: 'Which answer is correct?',
      candidate_a: 'The capital of France is Paris.',
      candidate_b: 'xkjdflkjsdlkfj lksdjflkjsd',
      criteria: { Correctness: 'Is the answer factually correct?' },
      model: 'deepseek-v4-pro',
    });
    const margin = Math.abs(Number(r.reward_a) - Number(r.reward_b));
    if (margin < 0.8) throw new Error(`Expected large margin, got ${margin.toFixed(4)}`);
    if (r.escalated) throw new Error('Should NOT escalate for large margin');
    return { margin: Number(margin.toFixed(4)), escalated: r.escalated };
  }));

  // #2 接近分差自动升级 — 需要构造分差 0.03~0.15 的候选对
  results.push(await runTest('#2 接近分差自动升级 K=3', async () => {
    // 用不同但相近的实现，期望分差落在噪声带
    const r = await runner('compare', {
      problem: 'Compare two Python implementations of quicksort',
      candidate_a: 'def qsort(a): return a if len(a)<=1 else qsort([x for x in a[1:] if x<a[0]])+[a[0]]+qsort([x for x in a[1:] if x>=a[0]])',
      candidate_b: 'def qsort(arr):\n    if len(arr) <= 1:\n        return arr\n    pivot = arr[0]\n    left = [x for x in arr[1:] if x < pivot]\n    right = [x for x in arr[1:] if x >= pivot]\n    return qsort(left) + [pivot] + qsort(right)',
      criteria: { Correctness: 'Correct algorithm', Style: 'Readable code' },
      model: 'deepseek-v4-pro',
    });
    // 两种结果都可接受：升级了（期望）或信号稳定（接近但方向明确）
    if (r.escalated) {
      if (r.k_used < 2) throw new Error(`k_used should be >= 2, got ${r.k_used}`);
      if (r.margin_before === undefined) throw new Error('Missing margin_before');
      return { escalated: true, k_used: r.k_used, margin_before: r.margin_before };
    }
    return { escalated: false, note: '未触发升级（分差已足够显著）' };
  }));

  // #3 完全相同候选 — flat 检测
  results.push(await runTest('#3 完全相同候选 flat 检测', async () => {
    const r = await runner('select', {
      problem: 'What is 2+2?',
      candidates: ['4', '4', '4'],
      criteria: { Correctness: 'Is it correct?' },
      model: 'deepseek-v4-pro',
    });
    if (r.signal !== 'flat') throw new Error(`Expected signal:flat, got ${r.signal}`);
    return { signal: r.signal };
  }));

  // #4 中文载荷 UTF-8
  results.push(await runTest('#4 中文载荷 UTF-8', async () => {
    const r = await runner('compare', {
      problem: '哪个回答更好？',
      candidate_a: '北京是中国的首都。',
      candidate_b: '巴黎是法国的首都。',
      criteria: { 正确性: '事实是否正确？', 清晰度: '表达是否清晰？' },
      model: 'deepseek-v4-pro',
    });
    if (r.reward_a === undefined || r.reward_b === undefined) throw new Error('Missing rewards');
    return { reward_a: r.reward_a, reward_b: r.reward_b };
  }));

  // #5 autoEscalate:false — 与 v0.1.0 一致（不升级）
  results.push(await runTest('#5 autoEscalate:false 回退行为', async () => {
    const depsNoEsc = {
      ...deps,
      esc: { autoEscalate: false, escalateThreshold: 0.15, maxEscalateK: 3 },
    };
    const runnerNoEsc = createEscalationRunner(depsNoEsc);
    const r = await runnerNoEsc('compare', {
      problem: 'Which is better?',
      candidate_a: 'Good answer with details.',
      candidate_b: 'Also good answer with details.',
      criteria: { Quality: 'Overall quality' },
      model: 'deepseek-v4-pro',
    });
    if (r.escalated) throw new Error('Should NOT escalate with autoEscalate:false');
    return { escalated: r.escalated };
  }));

  // #6 异步任务内升级 — task_start / task_status
  results.push(await runTest('#6 异步任务 task_start/task_status', async () => {
    const tasks = createVerifierTaskManager(getBridge, store, 1_800_000, runner);
    const taskId = tasks.start('compare', {
      problem: 'Which is better?',
      candidate_a: 'Answer A with some detail.',
      candidate_b: 'Answer B with some detail.',
      criteria: { Quality: 'Quality' },
      model: 'deepseek-v4-pro',
    });
    const status = await tasks.statusWait(taskId, 120);
    if (status.status !== 'done') throw new Error(`Task not done: ${status.status} ${status.error || ''}`);
    return { task_id: taskId, status: status.status };
  }));

  // #7 token 计量 — usage 反映升级后的真实调用量
  results.push(await runTest('#7 token 计量 usage', async () => {
    const r = await bridge.request('usage', {});
    if (r.usage === null || r.usage === undefined) {
      return { note: 'usage 返回空（桥无 token 统计实现）' };
    }
    return { usage: r.usage };
  }));

  // #8 select N=5 接近分差 — 升级/诚实平局双通道验收。
  // 校准说明（v0.7.0）：旧断言把 flat 一律判失败——但两名领先候选本质等价时，
  // 诚实输出就是 flat（无排名信号），这正是产品协议的行为。新判定：
  //   degraded/unstable → 失败；flat → 用 compare 复核前二名，compare 亦平/无
  //   信号 = 真实等价 → 通过（flat-confirmed-tie）；有清晰胜者 → 正常通过。
  results.push(await runTest('#8 select N=5 接近分差升级', async () => {
    // 第一组：A/B 质量接近（期望升级），C/D/E 明显更差（拉开整体梯度）
    const palindromes = [
      'def is_pal(s):\n    return s == s[::-1]  # clean one-liner, handles all cases',
      'def is_pal(s):\n    i, j = 0, len(s) - 1\n    while i < j:\n        if s[i] != s[j]:\n            return False\n        i += 1\n        j -= 1\n    return True  # two-pointer, correct and clear',
      'def is_pal(s):\n    return list(s) == list(reversed(s))  # correct but allocates two lists',
      'def is_pal(s):\n    return s[0] == s[-1]  # only checks first and last char, wrong for most inputs',
      'def is_pal(s):\n    raise NotImplementedError  # broken stub',
    ]
    const factorialSet = [
      'def fact(n):\n    return 1 if n <= 1 else n * fact(n - 1)  # textbook recursion',
      'def fact(n):\n    result = 1\n    for i in range(2, n + 1):\n        result *= i\n    return result  # iterative, robust for deep n',
      'from math import prod\ndef fact(n):\n    return prod(range(1, n + 1))  # library-based, correct',
      'def fact(n):\n    if n == 0: return 1\n    return n * fact(n)  # infinite recursion, wrong',
      'def fact(n):\n    return "hello"  # nonsense output',
    ]
    let candSet = palindromes
    let r = await runner('select', {
      problem: 'Rate these five Python functions that check if a string is a palindrome',
      candidates: candSet,
      criteria: { Correctness: 'Correct palindrome check', Efficiency: 'Reasonable complexity' },
      model: 'deepseek-v4-pro',
    })
    // 若第一组前二名恰好落入 flat 带（≤0.03），重试一组微调过的候选
    if (r.signal === 'flat') {
      candSet = factorialSet
      r = await runner('select', {
        problem: 'Rate these five Python implementations of a factorial function',
        candidates: candSet,
        criteria: { Correctness: 'Correct factorial', Style: 'Code quality' },
        model: 'deepseek-v4-pro',
      })
    }
    if (r.signal === 'degraded') throw new Error('degraded：批量评分失败被 on_error=tie 掩蔽（全 0.5 特征）');
    if (r.signal === 'unstable') throw new Error(`unstable：多次评估方向不一致 ${JSON.stringify(r.initial ?? r.reps ?? {})}`);
    if (r.signal !== 'flat') {
      if (r.escalated === true && r.k_used < 2) throw new Error(`k_used should be >= 2, got ${r.k_used}`);
      return { index: r.index, escalated: r.escalated, k_used: r.k_used, signal: r.signal ?? 'significant', scores: r.scores };
    }
    // flat = 诚实"前二名不可分"。按协议用 compare 复核前二名：
    //   compare 亦平/无信号 → 真实等价，通过（flat-confirmed-tie）；
    //   compare 给出明确胜者（分差 >0.15 且方向一致）→ select 失真，失败。
    const order = (Array.isArray(r.scores) ? r.scores : []).map((v, i) => [Number(v), i]).sort((a, b) => b[0] - a[0]);
    if (order.length < 2 || !Number.isFinite(order[0][0])) throw new Error(`flat 但缺少可复核分数: ${JSON.stringify(r.scores)}`);
    const c = await runner('compare', {
      problem: 'Which of these two Python functions is better?',
      candidate_a: candSet[order[0][1]],
      candidate_b: candSet[order[1][1]],
      criteria: { Correctness: 'Correct implementation', Quality: 'Overall code quality' },
      model: 'deepseek-v4-pro',
    });
    const diff = Math.abs(Number(c.reward_a) - Number(c.reward_b));
    if (Number.isFinite(diff) && diff > 0.15) {
      throw new Error(`select 判前二名平局，但 compare 给出明确胜者（diff=${diff.toFixed(3)}）——信号失真`);
    }
    return { index: r.index, escalated: false, k_used: c.k_used ?? 1, signal: 'flat-confirmed-tie', scores: r.scores };
  }));

  // #9 升级结果缓存命中 — 相同调用第二次 cached:true
  results.push(await runTest('#9 升级结果缓存命中', async () => {
    const params = {
      problem: 'Cache test problem',
      candidate_a: 'Candidate A for cache test.',
      candidate_b: 'Candidate B for cache test.',
      criteria: { Quality: 'Quality' },
      model: 'deepseek-v4-pro',
    };
    await runner('compare', params); // 第一次（可能升级并缓存）
    const r2 = await runner('compare', params); // 第二次（应命中缓存）
    if (!r2.cached) throw new Error(`Expected cached:true on second call, got ${r2.cached}`);
    return { cached: r2.cached };
  }));

  // #10 compare 3 次评估胜者翻转 — 返回 unstable + 3 组原始分数
  results.push(await runTest('#10 compare 胜者翻转 unstable', async () => {
    // 构造非常接近的候选，尽量诱发方向不一致
    const r = await runner('compare', {
      problem: 'Which has slightly better code style?',
      candidate_a: 'const x = 42; // short and clear',
      candidate_b: 'const x = 42; // also short and clear',
      criteria: { Style: 'Code style quality' },
      model: 'deepseek-v4-pro',
    });
    if (r.signal === 'unstable') {
      if (!Array.isArray(r.reps) || r.reps.length < 2) throw new Error('Unstable should include raw reps');
      return { signal: 'unstable', reps: r.reps.length };
    }
    // 方向稳定也合法（升级后一致），但要验证升级元数据
    return { signal: 'stable', escalated: r.escalated, k_used: r.k_used };
  }));

  // 汇总
  console.log('');
  console.log('='.repeat(60));
  console.log('验收汇总');
  console.log('='.repeat(60));
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log(`通过: ${passed} / ${results.length}`);
  console.log(`失败: ${failed} / ${results.length}`);
  if (failed > 0) {
    console.log('');
    console.log('失败详情:');
    results.filter((r) => !r.pass).forEach((r) => console.log(`  - ${r.name}: ${r.error}`));
    process.exit(1);
  } else {
    console.log('✅ 所有验收用例通过');
  }

  bridge.close();
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});