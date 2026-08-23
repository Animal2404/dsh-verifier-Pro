# -*- coding: utf-8 -*-
"""璇婃柇: opencode 绔偣 DFLASH return_logprob 400 閿欒鐨勫奖鍝嶉潰"""
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")

os.environ["OPENAI_BASE_URL"] = "https://opencode.ai/zen/go/v1"
os.environ["OPENAI_API_KEY"] = sys.argv[1]
os.environ["DEEPSEEK_EFFORT"] = "off"

import llm_verifier

print("=== test 1: compare (logprob path) ===")
try:
    r = llm_verifier.compare(
        problem="What is 2+2?",
        candidate_a="4",
        candidate_b="5",
        criteria={"Correctness": "correct?"},
        model="deepseek-v4-pro",
    )
    print("OK:", r)
except Exception as e:
    print("FAIL:", type(e).__name__, str(e)[:250])

print()
print("=== test 2: plain chat completion with logprobs param ===")
try:
    from openai import OpenAI

    client = OpenAI(
        base_url="https://opencode.ai/zen/go/v1",
        api_key=os.environ["OPENAI_API_KEY"],
    )
    resp = client.chat.completions.create(
        model="deepseek-v4-pro",
        messages=[{"role": "user", "content": "hi"}],
        max_tokens=5,
        logprobs=True,
        top_logprobs=3,
    )
    print("OK: logprobs accepted, has content:", bool(resp.choices[0].logprobs))
except Exception as e:
    print("FAIL:", type(e).__name__, str(e)[:250])
