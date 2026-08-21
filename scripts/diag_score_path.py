#!/usr/bin/env python3
"""Diagnose the 0.5-everywhere degradation.

Reproduces the official call path against an OpenAI-compatible proxy and
answers three questions:
  1. Does the model emit <score_A>/<score_B> tags in its own response?
  2. Does the response carry token-level top_logprobs at the tag positions?
  3. Do scores computed from those logprobs (skipping the vLLM-only prefill)
     actually discriminate good vs bad candidates?
"""
import os
import sys

from openai import OpenAI

from llm_verifier import fine_grained_reward as fgr

BASE_URL = os.environ["VB_BASE_URL"]
API_KEY = os.environ["VB_KEY"]
MODEL = os.environ.get("VB_MODEL", "deepseek-v4-flash")

GOOD = "人工智能不会让所有人失业。历史上每次技术革命都消灭了旧岗位、创造了新岗位：工业革命让农民进城当工人，互联网催生了程序员和电商。AI 会替代客服、翻译等重复劳动，也会创造提示词工程师、AI 训练师等新职业。医生用 AI 读片更快，但沟通仍需要人。应对之道是培训与教育改革，帮助劳动者转型，让人做机器做不到的事。总之 AI 改变工作而非消灭工作，关键在于主动适应。"
BAD = "asdkjh qwerty 12345 %%% zzzz ??? ai work job no yes maybe 42 hello world foo bar baz."

client = OpenAI(base_url=BASE_URL, api_key=API_KEY, timeout=180)

criterion = {"name": "Correctness", "description": "Does the passage make a coherent, evidence-based argument about AI and jobs?"}
prompt = fgr.build_prompt("Essay: AI and the future of work", GOOD, BAD, criterion, "")

print(f"=== model={MODEL} base={BASE_URL}")
print(f"prompt chars: {len(prompt)}")

params = dict(
    model=MODEL,
    messages=[{"role": "user", "content": prompt}],
    max_tokens=4096,
    temperature=1.0,
    logprobs=True,
    top_logprobs=20,
)
try:
    response = client.chat.completions.create(
        extra_body={"chat_template_kwargs": {"enable_thinking": False}}, **params)
except Exception as exc:
    print(f"[enable_thinking rejected: {str(exc)[:80]}] -> plain call")
    response = client.chat.completions.create(**params)

choice = response.choices[0]
text = choice.message.content or ""
print(f"finish_reason: {choice.finish_reason!r}, text chars: {len(text)}")
print(f"has <score_A>: {'<score_A>' in text}, has <score_B>: {'<score_B>' in text}")
print(f"--- text tail ---\n{text[-300:]}\n---")

tokens, position_logprobs = [], []
if choice.logprobs and choice.logprobs.content:
    for pos in choice.logprobs.content:
        tokens.append(pos.token)
        alts = [(alt.token, alt.logprob) for alt in (pos.top_logprobs or [])]
        if not alts:
            alts = [(pos.token, pos.logprob)]
        position_logprobs.append(alts)
    print(f"logprobs: {len(tokens)} positions")
else:
    print("logprobs: NONE in response")

# Simulate the tagged path (skip prefill): extract from the model's own tags.
ra = fgr.extract_score(text, tokens or None, position_logprobs or None, "<score_A>")
rb = fgr.extract_score(text, tokens or None, position_logprobs or None, "<score_B>")
print(f"\nextracted (no prefill): reward_a={ra:.4f} reward_b={rb:.4f}")

# Show the letter distribution right after <score_A> if present.
if tokens:
    found_at = None
    acc = ""
    for i, tok in enumerate(tokens):
        acc += tok
        if acc.rstrip().endswith(("<score_A>", "<score_A")) and i + 1 < len(position_logprobs):
            found_at = i + 1
    if found_at is not None:
        alts = position_logprobs[found_at]
        print(f"top tokens after <score_A>: {[(t, round(p, 3)) for t, p in alts[:8]]}")
    else:
        print("no <score_A> tag found in token stream")
