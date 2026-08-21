# -*- coding: utf-8 -*-
"""扫描 opencode 端点哪些模型仍支持 logprobs"""
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")

os.environ["OPENAI_BASE_URL"] = "https://opencode.ai/zen/go/v1"
os.environ["OPENAI_API_KEY"] = sys.argv[1]

from openai import OpenAI

client = OpenAI(
    base_url="https://opencode.ai/zen/go/v1",
    api_key=os.environ["OPENAI_API_KEY"],
)

MODELS = [
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    "kimi-k3",
    "kimi-k2.6",
    "glm-5.3",
    "glm-5.2",
    "qwen3.8-max",
    "minimax-m3",
    "mimo-v2.5",
]

for m in MODELS:
    try:
        resp = client.chat.completions.create(
            model=m,
            messages=[{"role": "user", "content": "hi"}],
            max_tokens=5,
            logprobs=True,
            top_logprobs=3,
        )
        has_lp = resp.choices[0].logprobs is not None
        print(f"{m:24s} OK  logprobs={'yes' if has_lp else 'empty'}")
    except Exception as e:
        msg = str(e)
        short = "DFLASH/logprob 400" if "return_logprob" in msg else msg[:80]
        print(f"{m:24s} FAIL {short}")
