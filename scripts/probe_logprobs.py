#!/usr/bin/env python3
"""Probe an OpenAI-compatible endpoint for logprobs support (verifier requirement)."""
import json
import sys

from openai import OpenAI

base_url, api_key, model = sys.argv[1], sys.argv[2], sys.argv[3]
client = OpenAI(base_url=base_url, api_key=api_key, max_retries=0)
try:
    resp = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": "Reply with exactly: A"}],
        max_tokens=8,
        temperature=0,
        logprobs=True,
        top_logprobs=5,
    )
    choice = resp.choices[0]
    lp = choice.logprobs
    if lp is None or not lp.content:
        print(json.dumps({"ok": False, "reason": "no logprobs in response", "model": model}))
    else:
        tokens = [{"token": t.token, "logprob": t.logprob} for t in lp.content[:3]]
        print(json.dumps({"ok": True, "model": model, "sample": tokens}))
except Exception as exc:
    msg = str(exc)[:300]
    print(json.dumps({"ok": False, "reason": msg, "model": model}))
