#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""discriminative_check.py — 评分模型判别力自检基准（G1，复盘 R-refcomp）。

背景：probe 只验「能不能评」（logprobs / literal-mc 可用），不验「评得好不好」。
换评分模型是用户最常做的变更，而唯一的判别力证据此前是一次性手工实测——无法
在换模型后重放。本脚本把那次实测沉淀为固定微任务集，作为质量回归门：

    .venv/Scripts/python scripts/discriminative_check.py            # 自动取凭据/环境
    python scripts/discriminative_check.py --model X --base-url Y --key Z
    python scripts/discriminative_check.py --json                    # 机器可读输出

用例（好/坏候选 A/B 对照，期望方向：好 > 坏）：
  1. coarse_code   粗判别：公式 vs 死循环
  2. fine_code     细判别：递归 fib vs 迭代 fib（双方均正确，考区分度）
  3. chinese       中文任务 + 中文 criteria
  4. relevance     跑题候选必须输给切题候选

通过标准：全部方向判定正确（margin > 0）。任一失败或调用异常 → exit 1。
成本：4 次 compare 调用（n_evaluations=1）。

接入点：`node scripts/setup.mjs --bench`；RELEASING 清单在换默认评分模型时必跑。
"""

from __future__ import annotations

import argparse
import json
import os
import sys

CASES = [
    {
        "id": "coarse_code",
        "problem": "Write a Python function sum_to(n) that returns 1+2+...+n.",
        "criteria": {"Correctness": "Does the code compute the required result and terminate?"},
        "good": "def sum_to(n):\n    return n * (n + 1) // 2\n",
        "bad": "def sum_to(n):\n    s = 0\n    i = 0\n    while i != n:\n        s += i\n    return s\n",
    },
    {
        "id": "fine_code",
        "problem": "Write a Python function fib(n) returning the n-th Fibonacci number (fib(0)=0, fib(1)=1). Both implementations below are correct; prefer the clearer one for production code with comments explaining the approach.",
        "criteria": {
            "Correctness": "Both must be correct; reward clarity of explanation only when correctness holds.",
            "Clarity": "Which implementation explains its approach more clearly for a maintainer?",
        },
        "good": "def fib(n):\n    # Iterative: O(n) time, O(1) space, no recursion depth limit.\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a\n",
        "bad": "def fib(n):\n    # Classic double recursion; correct but exponential time without memoization.\n    if n < 2:\n        return n\n    return fib(n - 1) + fib(n - 2)\n",
    },
    {
        "id": "chinese",
        "problem": "写一个中文函数「去重保序」：输入列表，返回去掉重复元素且保持首次出现顺序的结果。",
        "criteria": {"正确性": "代码是否实现「去重且保持首次出现顺序」，并能在重复元素密集时正确工作？"},
        "good": "def 去重保序(xs):\n    seen = set()\n    out = []\n    for x in xs:\n        if x not in seen:\n            seen.add(x)\n            out.append(x)\n    return out\n",
        "bad": "def 去重保序(xs):\n    return list(set(xs))\n",
    },
    {
        "id": "relevance",
        "problem": "Summarize the cause of a slow SQL query: full table scan on a large table due to a function-wrapped indexed column.",
        "criteria": {"Relevance": "Does the candidate actually address the stated diagnosis question (index bypassed by function wrap)?"},
        "good": "The query is slow because wrapping the indexed column in LOWER() makes the index unusable, forcing a full table scan; fix with a functional index or rewritten predicate.",
        "bad": "Slow queries are usually caused by network latency between the application server and the database host; upgrading NICs typically resolves them.",
    },
]

PASS_MARGIN = 0.0  # good 必须严格大于 bad


def resolve_client(args):
    """凭据解析顺序：显式参数 > 环境变量 > ~/.dsh/.credentials.yaml 扁平键。"""
    base_url = args.base_url or os.environ.get("OPENAI_BASE_URL") or ""
    api_key = args.key or os.environ.get("OPENAI_API_KEY") or os.environ.get("DEEPSEEK_API_KEY") \
        or os.environ.get("OPENCODE_GO_API_KEY") or os.environ.get("OPENROUTER_API_KEY") or ""
    if not base_url or not api_key:
        cred = os.path.join(os.path.expanduser("~"), ".dsh", ".credentials.yaml")
        try:
            import re
            text = open(cred, encoding="utf-8").read()
            if not api_key:
                m = re.search(r"^\s*(DEEPSEEK_API_KEY|OPENAI_API_KEY|OPENCODE_GO_API_KEY|OPENROUTER_API_KEY)\s*:\s*(.+?)\s*$", text, re.M)
                if m:
                    api_key = m.group(2).strip().strip("'\"")
            if not base_url:
                m = re.search(r"^\s*OPENAI_BASE_URL\s*:\s*(.+?)\s*$", text, re.M)
                if m:
                    base_url = m.group(2).strip().strip("'\"")
        except Exception:
            pass
    if not base_url or not api_key:
        print("ERROR: 未解析到评分后端（--base-url/--key、环境变量或 ~/.dsh/.credentials.yaml）", file=sys.stderr)
        sys.exit(1)

    os.environ.setdefault("DEEPSEEK_EFFORT", "off")  # 与桥 main() 一致：代理端点拒绝 thinking extra_body
    import llm_verifier
    from openai import OpenAI
    client = OpenAI(base_url=base_url, api_key=api_key, max_retries=0)
    # 与生产路径对齐：桥会打标 client 读模型自发 <score_X> 标签——否则官方包在无
    # prefill 支持的端点上把分数静默回退成 0.5/0.5（本次实测踩中后修正）。
    # 同时装上 bridge_fix 路由（literal-mc / reason-first），与桥内行为一致。
    try:
        import bridge_fix
        bridge_fix.install()
    except Exception:
        pass
    try:
        if not getattr(client, "_llm_verifier_deepseek", False) \
                and llm_verifier.fine_grained_reward._is_openai_client(client):
            client._llm_verifier_deepseek = True
    except Exception:
        pass
    return client, base_url


def main() -> int:
    ap = argparse.ArgumentParser(description="verifier 判别力自检基准（G1）")
    ap.add_argument("--model", default=os.environ.get("OPENAI_MODEL") or "deepseek-v4-flash-vision-exp")
    ap.add_argument("--base-url", default=None)
    ap.add_argument("--key", default=None)
    ap.add_argument("--json", action="store_true", help="机器可读输出（JSON 行）")
    args = ap.parse_args()

    client, base_url = resolve_client(args)

    # 复用官方包的配对评分语义：优先 llm_verifier.compare；不可用时退回直接读标签。
    try:
        import llm_verifier
        have_official = True
    except Exception:
        have_official = False

    results = []
    passed = 0
    for case in CASES:
        rec = {"case": case["id"], "ok": False}
        try:
            if have_official:
                ra, rb = llm_verifier.compare(
                    case["problem"], case["good"], case["bad"],
                    criteria=case["criteria"], model=args.model, client=client,
                    n_evaluations=1,
                )
            else:
                raise RuntimeError("llm-verifier 未安装（先运行 setup.mjs --fix）")
            rec.update({"reward_good": float(ra), "reward_bad": float(rb),
                        "margin": round(float(ra) - float(rb), 4)})
            rec["ok"] = rec["margin"] > PASS_MARGIN
        except Exception as exc:
            rec["error"] = str(exc)[:300]
        results.append(rec)
        passed += 1 if rec["ok"] else 0
        if args.json:
            print(json.dumps(rec, ensure_ascii=False))
        else:
            if "error" in rec:
                print(f"[FAIL] {rec['case']}: 调用异常 {rec['error']}")
            else:
                mark = "PASS" if rec["ok"] else "FAIL"
                print(f"[{mark}] {rec['case']}: good={rec['reward_good']:.3f} bad={rec['reward_bad']:.3f} margin={rec['margin']:+.3f}")

    total = len(CASES)
    summary = {"model": args.model, "base_url": base_url, "passed": passed, "total": total, "ok": passed == total}
    if args.json:
        print(json.dumps({"summary": summary}, ensure_ascii=False))
    else:
        verdict = "✅ 全部方向判定正确" if summary["ok"] else "❌ 存在判别失败——该模型不宜作为评分模型（或需 reason-first/换模型）"
        print(f"\n判别力自检：{passed}/{total} 通过 —— {verdict}")
        print(f"模型 {args.model} @ {base_url}")
    return 0 if summary["ok"] else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
