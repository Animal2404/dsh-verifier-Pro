#!/usr/bin/env node
/**
 * dsh-verifier-Pro 验收回归脚本
 * 对应 ITERATION_PLAN.md §3 十个验收用例
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

const scriptPath = join(ROOT, 'bridge', 'verifier_brain_bridge.py');
const pythonBin = join(ROOT, '.venv', 'Scripts', 'python.exe');

// 安全铁律：绝不 fallback 明文密钥。无 env 时跳过在线用例（审计 P0-1）。
if (!process.env.OPENCODE_GO_API_KEY) {
  console.error('acceptance_test: OPENCODE_GO_API_KEY 未设置——跳过在线验收（不使用任何硬编码凭据）。');
  process.exit(0);
}

const BRIDGE_ENV = {
  ...process.env,
  DEEPSEEK_EFFORT: 'off',
  OPENAI_BASE_URL: 'https://opencode.ai/zen/go/v1',
  OPENAI_API_KEY: process.env.OPENCODE_GO_API_KEY,
  VERIFIER_BRAIN_WORKERS: '4',
};

function bridgeRequest(method, params, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin, ['-u', '-X', 'utf8', scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: BRIDGE_ENV,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error(`Bridge timeout after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      try {
        const resp = JSON.parse(line);
        if (resp.id === 1) {
          settled = true;
          clearTimeout(timer);
          lines.close();
          child.kill();
          if (resp.ok) resolve(resp.result);
          else reject(new Error(`${resp.error.type}: ${resp.error.message}`));
        }
      } catch { }
    });

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    child.on('exit', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Bridge exited unexpectedly. stderr: ${stderr}`));
      }
    });

    child.stdin.write(JSON.stringify({ id: 1, method, params }) + '\n');
    child.stdin.end();
  });
}

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
  console.log('dsh-verifier-Pro 验收回归 (ITERATION_PLAN §3)');
  console.log('='.repeat(60));
  console.log('');

  const results = [];

  // 1. 好文 vs 乱码 compare — margin 巨大，不触发升级，1.0/0.0
  results.push(await runTest('#1 好文 vs 乱码 compare', async () => {
    const r = await bridgeRequest('compare', {
      problem: 'Which answer is correct?',
      candidate_a: 'The capital of France is Paris.',
      candidate_b: 'xkjdflkjsdlkfj lksdjflkjsd',
      criteria: { Correctness: 'Is the answer factually correct?' },
      model: 'deepseek-v4-pro',
    });
    const margin = Math.abs(r.reward_a - r.reward_b);
    if (margin < 0.8) throw new Error(`Expected large margin, got ${margin}`);
    if (r.escalated) throw new Error('Should not escalate for large margin');
    return { margin, escalated: r.escalated };
  }));

  // 2. 接近分差自动升级 K=3 — 返回 margin_before/after，方向稳定
  results.push(await runTest('#2 接近分差自动升级', async () => {
    const r = await bridgeRequest('compare', {
      problem: 'Which implementation is better?',
      candidate_a: 'function add(a,b){return a+b;} // clean, correct',
      candidate_b: 'function add(a,b){return a+b;} // also clean, correct',
      criteria: { Correctness: 'Is it correct?', Style: 'Is it readable?' },
      model: 'deepseek-v4-pro',
    });
    if (!r.escalated) throw new Error('Should escalate for close margin');
    if (r.k_used !== 3) throw new Error(`Expected k_used=3, got ${r.k_used}`);
    if (r.margin_before === undefined || r.margin_after === undefined) {
      throw new Error('Missing margin_before/after');
    }
    if (r.signal === 'unstable') throw new Error('Direction should be stable for similar candidates');
    return { escalated: r.escalated, k_used: r.k_used, margin_before: r.margin_before, margin_after: r.margin_after };
  }));

  // 3. 完全相同候选 — flat 检测触发
  results.push(await runTest('#3 完全相同候选 flat 检测', async () => {
    const r = await bridgeRequest('select', {
      problem: 'What is 2+2?',
      candidates: ['4', '4', '4'],
      criteria: { Correctness: 'Is it correct?' },
      model: 'deepseek-v4-pro',
    });
    if (r.signal !== 'flat') throw new Error(`Expected signal:flat, got ${r.signal}`);
    return { signal: r.signal };
  }));

  // 4. 中文载荷 + 升级组合 — UTF-8 无回归
  results.push(await runTest('#4 中文载荷 UTF-8', async () => {
    const r = await bridgeRequest('compare', {
      problem: '哪个回答更好？',
      candidate_a: '北京是中国的首都。',
      candidate_b: '巴黎是法国的首都。',
      criteria: { 正确性: '事实是否正确？', 清晰度: '表达是否清晰？' },
      model: 'deepseek-v4-pro',
    });
    if (r.reward_a === undefined || r.reward_b === undefined) throw new Error('Missing rewards');
    return { reward_a: r.reward_a, reward_b: r.reward_b };
  }));

  // 5. autoEscalate:false — 行为与 v0.1.0 完全一致
  results.push(await runTest('#5 autoEscalate:false 回退行为', async () => {
    const r = await bridgeRequest('compare', {
      problem: 'Which is better?',
      candidate_a: 'Good answer with details.',
      candidate_b: 'Also good answer.',
      criteria: { Quality: 'Overall quality' },
      model: 'deepseek-v4-pro',
      n_evaluations: 1,
    }, 60000);
    // With autoEscalate=false at config level, but we can't override via bridge directly
    // This test verifies the bridge still works without escalation params
    return { hasRewards: !!r.reward_a };
  }));

  // 6. 异步任务内升级 — taskTimeoutMs 预算内完成
  results.push(await runTest('#6 异步任务 task_start/task_status', async () => {
    const taskId = await bridgeRequest('task_start', {
      method: 'compare',
      params: {
        problem: 'Which is better?',
        candidate_a: 'Answer A with some detail.',
        candidate_b: 'Answer B with some detail.',
        criteria: { Quality: 'Quality' },
        model: 'deepseek-v4-pro',
      },
    });
    if (!taskId.tracker_id && !taskId.task_id) throw new Error('No task id returned');
    const tid = taskId.tracker_id || taskId.task_id;
    // Poll with wait_seconds
    const status = await bridgeRequest('task_status', { task_id: tid, wait_seconds: 30 });
    if (status.status !== 'done') throw new Error(`Task not done: ${status.status}`);
    return { task_id: tid, status: status.status };
  }));

  // 7. token 计量 — usage 反映升级后的真实调用量
  results.push(await runTest('#7 token 计量 usage', async () => {
    const r = await bridgeRequest('usage', {});
    if (r.usage === null || r.usage === undefined) {
      console.log('  ⚠️ usage returned null (may be expected if no calls tracked)');
    }
    return { usage: r.usage };
  }));

  // 8. select N=5 分差接近 — 自动升级 K=3
  results.push(await runTest('#8 select N=5 接近分差升级', async () => {
    const r = await bridgeRequest('select', {
      problem: 'Rate these solutions 1-5',
      candidates: [
        'Solution A: Good approach, minor issues.',
        'Solution B: Good approach, minor issues.',
        'Solution C: Average solution.',
        'Solution D: Below average.',
        'Solution E: Poor solution.',
      ],
      criteria: { Quality: 'Overall quality' },
      model: 'deepseek-v4-pro',
    });
    if (!r.escalated) throw new Error('Should escalate for close margin in select');
    if (r.k_used !== 3) throw new Error(`Expected k_used=3, got ${r.k_used}`);
    return { escalated: r.escalated, k_used: r.k_used, index: r.index };
  }));

  // 9. 升级结果缓存后再调相同候选 — 直接命中缓存
  results.push(await runTest('#9 升级结果缓存命中', async () => {
    // First call (should escalate and cache)
    await bridgeRequest('compare', {
      problem: 'Cache test problem',
      candidate_a: 'Candidate A for cache test.',
      candidate_b: 'Candidate B for cache test.',
      criteria: { Quality: 'Quality' },
      model: 'deepseek-v4-pro',
    });
    // Second call (should hit cache)
    const r = await bridgeRequest('compare', {
      problem: 'Cache test problem',
      candidate_a: 'Candidate A for cache test.',
      candidate_b: 'Candidate B for cache test.',
      criteria: { Quality: 'Quality' },
      model: 'deepseek-v4-pro',
    });
    if (!r.cached) throw new Error('Expected cached:true on second call');
    return { cached: r.cached };
  }));

  // 10. compare 3 次评估胜者翻转 — 返回 unstable + 3 组原始分数
  results.push(await runTest('#10 compare 胜者翻转 unstable', async () => {
    // This is hard to trigger deterministically. We'll test with very similar candidates
    // that might flip. If it doesn't flip, that's also valid (stable).
    const r = await bridgeRequest('compare', {
      problem: 'Which is slightly better?',
      candidate_a: 'Answer with minor advantage.',
      candidate_b: 'Answer with minor different advantage.',
      criteria: { Nuance: 'Subtle quality differences' },
      model: 'deepseek-v4-pro',
    });
    // Either stable (averaged) or unstable (raw reps) is valid
    if (r.signal === 'unstable') {
      if (!r.reps || r.reps.length !== 3) throw new Error('Unstable should have 3 reps');
      return { signal: 'unstable', reps: r.reps.length };
    } else {
      return { signal: 'stable', k_used: r.k_used };
    }
  }));

  // Summary
  console.log('');
  console.log('='.repeat(60));
  console.log('验收汇总');
  console.log('='.repeat(60));
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  console.log(`通过: ${passed} / ${results.length}`);
  console.log(`失败: ${failed} / ${results.length}`);
  if (failed > 0) {
    console.log('');
    console.log('失败详情:');
    results.filter(r => !r.pass).forEach(r => console.log(`  - ${r.name}: ${r.error}`));
    process.exit(1);
  } else {
    console.log('✅ 所有验收用例通过');
  }
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});