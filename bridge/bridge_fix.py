# -*- coding: utf-8 -*-
"""bridge_fix.py — logprobs-free scoring path for models whose backend never
returns token-level logprobs (or rejects the logprobs request outright).

Problem (all evidence in E:\\tmp\\fix-e2\\*.md / probe*_results.json):

  The official llm-verifier reads the token distribution at <score_X> from
  `choice.logprobs.content`. The bridge tags every OpenAI-compatible client
  `_llm_verifier_deepseek = True` (verifier_brain_bridge.py:228-230), which
  routes ALL scoring through `call_deepseek`
  (llm_verifier/fine_grained_reward.py:565-571), which RAISES when the reply
  carries no token logprobs (fine_grained_reward.py:555-561). Five models on
  the opencode endpoint (https://opencode.ai/zen/go/v1) never return logprobs
  (mimo-v2.5-pro / minimax-m3 / minimax-m2.7 / muse-spark-1.2-contributor) or
  are rejected outright when logprobs are requested (deepseek-v4-flash: 400
  "DFLASH speculative decoding does not support return_logprob yet"). Every
  scoring call for those models therefore fails, degrades to on_error="tie"
  and returns a flat 0.5/0.5.

Fix:

  Route those models to a logprobs-FREE call path that returns
  `(text, None, None)`. The official `extract_score`
  (fine_grained_reward.py:645-689) then falls back to parsing the literal
  `<score_A> LETTER </score_A>` / `<score_B> LETTER </score_B>` tags the
  models reliably emit (verified: 1.0/0.0..0.37 on a GOOD-vs-BAD pair). Each
  call is one temperature=1.0 draw, so the framework's existing
  `n_evaluations=K` repetition mechanism turns the mean into a Monte-Carlo
  estimate of the score expectation (the same idea as
  uson1x/dsh-plugin-llm-verifier's K-sample tag parsing, but reusing the
  official API surface — no new sampling code needed).

  Per-model constraints baked into the profile table:
    * deepseek-v4-flash: the logprobs key must be ABSENT from the request
      body (`False` works, `None` is serialised as null and 400s on sglang).
    * muse-spark-1.2-contributor: hidden reasoning burns output budget; with
      max_tokens <= ~2048 the reply comes back with content=null. Needs a
      large budget (>= 4096, we default 8192). finish_reason is null even on
      complete replies, so the path must not rely on it.

Usage:
    import bridge_fix
    bridge_fix.install()                     # patch llm_verifier + bridge
    result = bridge_fix.probe_model_v2(client, model)   # preflight
"""

from __future__ import annotations

import os
import re
import sys
import threading
import time
from typing import Any

# ---------------------------------------------------------------------------
# Per-model scoring profiles
# ---------------------------------------------------------------------------
#
# keys:
#   logprobs      - None        : backend returns token logprobs -> official path
#                  "absent-ok"  : backend never returns logprobs, but the model
#                                 emits literal <score_X> tags -> logprobs-free
#                                 call path (logprobs key omitted from body)
#   max_tokens    - output budget override for the logprobs-free path
#   thinking      - extra_body thinking policy for the logprobs-free path
#   mc_n_evaluations - recommended n_evaluations (= Monte-Carlo sample count)
#                      for the logprobs-free path; None = caller decides.
#   note          - one-line reason (for probe / docs)
#
# The four "absent-ok" models + flash were verified 2026-08-23 against
# https://opencode.ai/zen/go/v1 with the score prompt: they emit
# <score_A>/<score_B> letters and extract_score (literal fallback) yields
# discriminating rewards (see E:\tmp\fix-e2\probe2/5_results.json).

MODEL_PROFILES: dict[str, dict[str, Any]] = {
    "mimo-v2.5-pro": {
        "logprobs": "absent-ok",
        "max_tokens": 4096,
        "thinking": "disabled",
        "mc_n_evaluations": 5,
        "note": "200 but never returns logprobs; emits score tags",
    },
    "minimax-m3": {
        "logprobs": "absent-ok",
        "max_tokens": 4096,
        "thinking": "disabled",
        "mc_n_evaluations": 5,
        "note": "200 but never returns logprobs; emits score tags",
    },
    "minimax-m2.7": {
        "logprobs": "absent-ok",
        "max_tokens": 4096,
        "thinking": "disabled",
        "mc_n_evaluations": 5,
        "note": "200 but never returns logprobs; emits score tags",
    },
    "muse-spark-1.2-contributor": {
        "logprobs": "absent-ok",
        "max_tokens": 8192,
        "thinking": "disabled",
        "mc_n_evaluations": 5,
        "note": "content=null unless max_tokens>=4096 (hidden reasoning); never logprobs",
    },
    "deepseek-v4-flash": {
        "logprobs": "absent-ok",
        "max_tokens": 4096,
        "thinking": "disabled",
        "mc_n_evaluations": 5,
        "note": "400 'DFLASH speculative decoding does not support return_logprob yet'; plain chat emits tags",
    },
}

# Models known to support logprobs on this backend (controls; official path).
_KNOWN_LOGPROBS_MODELS = {
    "deepseek-v4-pro",
    "deepseek-v4-flash-vision-exp",
    "qwen3.5-plus",
    "qwen3.6-plus",
    "qwen3.7-plus",
    "qwen3.8-max",
}

# Models with profiles but where live probing is trusted from config (no extra
# probe call on the fast path). Anything else gets a live tag-emission probe.
_TRUSTED_NO_LOGPROBS = set(MODEL_PROFILES.keys())


# ---------------------------------------------------------------------------
# Profile self-healing (审查 #1): passive score-tag observation + fail-closed
# ---------------------------------------------------------------------------
# MODEL_PROFILES is baked at ship time. If upstream changes a model's behavior
# (tags stop being emitted, format drift), literal-mc scoring would silently
# degrade. Every literal-mc reply is observed for <score_X> tags: N consecutive
# tag-less replies mark the model DEGRADED; probe_model_v2 then reports
# ok=false so the TS gate refuses scoring (never silently wrong scores). One
# tagged reply clears the streak (self-heal). Degraded models get a live
# tag-emission recheck in probe so recovery is automatic.

MAX_TAG_FAILURES = 3

_TAG_FAILURES: dict[str, int] = {}
_DEGRADED_MODELS: set[str] = set()
_STATE_LOCK = threading.Lock()

# P2-4: 降级模型的 live 复核探测是真实计费调用（max_tokens 4096-8192）。
# 每次评分尝试都触发一次 = 用户反复重试 N 次就白烧 N 次探测费。加时间窗：
# 探测后 TTL 秒内对同一模型直接返回 fail-closed，不再重复探测。
_DEGRADED_PROBE_TS: dict[str, float] = {}
_DEGRADED_PROBE_TTL = 300  # seconds

# v0.7.3（外部评审 #4-矛盾链）：
# 1) probe_model_v2 对表外模型可动态判定 literal-mc（logprobs 失败 + 标签发射成功），
#    但 _make_router/score_mode_for 只查静态表 → 表外模型在真正评分时按 unknown 走
#    官方 logprobs 路径 → 必然 raise "no answer logprobs"。这里把 probe 动态确认的
#    literal-mc 模型记入进程内集合（TTL），router 据此刻意走 literal-mc 路径。
# 2) probe 结果完全无缓存：同步路径每次传非默认 model 都重新探测，而表外模型的
#    标签探测是 4096+ token 的真实计费调用——反复调用反复烧钱。_PROBE_CACHE 兜底。
_PROBE_TTL_S = 5 * 60
_DYNAMIC_LITERAL_MC: dict[str, float] = {}          # model_lower -> expires_ts
_PROBE_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}  # resolved -> (expires_ts, result)

def _degraded_recheck_due(model: str) -> bool:
    """True when a live recheck is due for a degraded model (throttled)."""
    import time as _time
    with _STATE_LOCK:
        last = _DEGRADED_PROBE_TS.get(model, 0.0)
        due = (_time.time() - last) >= _DEGRADED_PROBE_TTL
        if due:
            _DEGRADED_PROBE_TS[model] = _time.time()
        return due


def _observe_score_tags(model: str, text: str) -> None:
    """Called after every literal-mc scoring reply. Tag present -> clear the
    streak; missing -> increment; >= MAX_TAG_FAILURES -> mark degraded.

    F2（复盘 R-refcomp）：部分丢失（只有单侧 <score_X> 标签）不改降级语义——
    带任意标签仍算自愈信号；但单独记录成逐请求事件，由桥处理器在本次评分结果上
    挂警告。否则「K 个样本里丢了几个标签 → 官方 extract_score 字面回退 0.5 静默
    稀释 Monte-Carlo 均值」完全不可见。"""
    if not model:
        return
    lowered = (text or "").lower()
    has_tag = "<score" in lowered
    # 不同字母数：完整 compare 配对应出现 A、B 两侧；只有一侧 = 另一侧已回退 0.5。
    n_letters = len(set(re.findall(r"<score_([a-t])>", lowered)))
    with _STATE_LOCK:
        if has_tag:
            _TAG_FAILURES.pop(model, None)
            _DEGRADED_MODELS.discard(model)
        else:
            n = _TAG_FAILURES.get(model, 0) + 1
            _TAG_FAILURES[model] = n
            if n >= MAX_TAG_FAILURES:
                _DEGRADED_MODELS.add(model)
        if has_tag and n_letters < 2:
            record_partial_tag_loss(max(1, 2 - n_letters))


def is_degraded(model: str) -> bool:
    """True when `model` (or a substring key it contains) is in the degraded set."""
    lowered = (model or "").lower()
    with _STATE_LOCK:
        for key in _DEGRADED_MODELS:
            if key in lowered:
                return True
        return False


def _clear_degraded(model: str) -> None:
    with _STATE_LOCK:
        _DEGRADED_MODELS.discard(model)
        _TAG_FAILURES.pop(model, None)


def profile_for(model: str) -> dict[str, Any] | None:
    """Profile for a model id (case-insensitive substring match)."""
    lowered = (model or "").lower()
    if not lowered:
        return None
    for key, profile in MODEL_PROFILES.items():
        if key in lowered:
            return profile
    return None


def logprobs_supported(model: str) -> bool:
    """True when the official logprobs path can score this model."""
    lowered = (model or "").lower()
    if lowered in _KNOWN_LOGPROBS_MODELS:
        return True
    p = profile_for(model)
    if p is None:
        return True  # unknown model: assume official path; probe will verify
    return p.get("logprobs") is None


def score_mode_for(model: str) -> str:
    """'logprobs' | 'literal-mc' | 'degraded' | 'unknown'."""
    lowered = (model or "").lower()
    if lowered in _KNOWN_LOGPROBS_MODELS:
        return "logprobs"
    p = profile_for(model)
    if p is None:
        # v0.7.3（评审 #4）：表外模型若已被 probe 动态确认为 literal-mc（TTL 内），
        # 路由到 literal-mc——否则返回 unknown（router 会误走官方 logprobs 路径必挂）。
        with _STATE_LOCK:
            exp = _DYNAMIC_LITERAL_MC.get(lowered, 0.0)
        if exp > time.time():
            return "literal-mc"
        return "unknown"
    if p.get("logprobs") == "absent-ok":
        # 审查 #1：档案模型若已被观测到连续无标签输出，进入 degraded 状态——
        # 评分走 fail-closed（TS 门禁拒绝），不再静默按旧档案出分。
        return "degraded" if is_degraded(model) else "literal-mc"
    return "logprobs"


def mc_n_evaluations_for(model: str) -> int | None:
    p = profile_for(model)
    return p.get("mc_n_evaluations") if p else None


# ---------------------------------------------------------------------------
# Logprobs-free call path
# ---------------------------------------------------------------------------

def call_no_logprobs(client, prompt: str, model: str, max_tokens: int | None = None,
                     images: Any = None, top_logprobs: int = 0,
                     _observe: bool = True) -> tuple[str, None, None]:
    """One plain chat completion WITHOUT the logprobs key.

    Returns (text, None, None) so the official `extract_score` uses its
    literal-tag fallback (fine_grained_reward.py:670-689). Retries once when
    the reply is empty (muse-spark sometimes spends the whole budget on
    hidden reasoning). Records usage in the official USAGE counter.
    Also records the response TEXT SHAPE (CompassVerifier C-class: incomplete/
    repetitive/refusal) into a thread-local so the bridge handler can surface
    it as an anomaly — the score numbers alone cannot see a truncated or
    loop-repeating model output.
    _observe=True (default): feeds the reply into the profile self-healing
    counter (审查 #1) — tag-less replies accumulate toward degraded state.
    Probe calls pass _observe=False so a failed probe is not misread as a
    scoring-format regression.
    """
    from llm_verifier import fine_grained_reward as fgr

    profile = profile_for(model) or {}
    budget = max_tokens or profile.get("max_tokens") or 4096
    thinking = profile.get("thinking", "disabled")

    def _call() -> tuple[str, str | None, None]:
        body = dict(
            model=fgr.resolve_model(client, model),
            messages=[{"role": "user", "content": prompt}],
            max_tokens=budget,
            temperature=1.0,
        )
        if thinking == "disabled":
            body["extra_body"] = {"thinking": {"type": "disabled"}}
        # NOTE: never send logprobs/top_logprobs here — flash 400s on True,
        # and the sglang upstream 400s on explicit null.
        response = client.chat.completions.create(**body)
        fgr.USAGE.record(response)
        choice = response.choices[0]
        text = choice.message.content or ""
        finish = getattr(choice, "finish_reason", None)
        return text, finish, None

    text, finish, _ = _call()
    if not text.strip():
        # Hidden reasoning consumed the budget (muse-spark); one retry.
        text, finish, _ = _call()
    # CompassVerifier C-class response-shape detection (mechanical):
    # incomplete (finish_reason=length) / repetitive (n-gram loop) / refusal.
    record_response_event(detect_response_shape(text, finish))
    if _observe:
        # 审查 #1：评分响应观测——无 <score_X> 标签会累积到降级状态。
        _observe_score_tags(model, text)
    return text, None, None


# ---------------------------------------------------------------------------
# CompassVerifier C-class response-shape detection
# ---------------------------------------------------------------------------

# F3（复盘 R-refcomp）：形态/部分丢失事件不再存 thread-local——官方包把配对打分
# 放进了内层 ThreadPoolExecutor（fine_grained_reward.run_phase 无条件开池），写入
# 发生在池线程、读取发生在桥处理器线程，thread-local 恒为 None → 检测在 select /
# 多 job compare 上是死代码。改为进程级有界事件表：写入方任意线程，读取方在调用
# 官方 API 前记 t0=monotonic()、结束后 drain(t0) 取走窗口内事件。并发请求窗口
# 重叠时个别事件可能跨请求互串（罕见，且只影响告警不影响分数）——这是让主路径
# 检测真正生效的代价，已知并接受。

_MAX_OBS_EVENTS = 256

_RESPONSE_EVENTS: list[tuple[float, str]] = []
_PARTIAL_TAG_LOSSES: list[tuple[float, int]] = []  # (ts, 丢失侧数)
_OBS_LOCK = threading.Lock()


def record_response_event(shape: str | None) -> None:
    if not shape:
        return
    with _OBS_LOCK:
        _RESPONSE_EVENTS.append((time.monotonic(), shape))
        if len(_RESPONSE_EVENTS) > _MAX_OBS_EVENTS:
            del _RESPONSE_EVENTS[: len(_RESPONSE_EVENTS) - _MAX_OBS_EVENTS]


def record_partial_tag_loss(missing: int) -> None:
    with _OBS_LOCK:
        _PARTIAL_TAG_LOSSES.append((time.monotonic(), max(1, missing)))
        if len(_PARTIAL_TAG_LOSSES) > _MAX_OBS_EVENTS:
            del _PARTIAL_TAG_LOSSES[: len(_PARTIAL_TAG_LOSSES) - _MAX_OBS_EVENTS]


def consume_response_events(since: float | None = None) -> dict[str, int]:
    """Drain response-shape events recorded at/after `since` (monotonic ts),
    returning {shape: count}. `since=None` drains everything."""
    with _OBS_LOCK:
        if since is None:
            picked, _RESPONSE_EVENTS[:] = list(_RESPONSE_EVENTS), []
        else:
            picked = [e for e in _RESPONSE_EVENTS if e[0] >= since]
            _RESPONSE_EVENTS[:] = [e for e in _RESPONSE_EVENTS if e[0] < since]
    counts: dict[str, int] = {}
    for _, s in picked:
        counts[s] = counts.get(s, 0) + 1
    return counts


def consume_partial_tag_losses(since: float | None = None) -> int:
    """F2: drain partial-tag-loss events, returning the number of samples that
    fell back to the literal 0.5 because one side of the <score_X> pair was
    missing from an otherwise tagged reply."""
    with _OBS_LOCK:
        if since is None:
            picked, _PARTIAL_TAG_LOSSES[:] = list(_PARTIAL_TAG_LOSSES), []
        else:
            picked = [e for e in _PARTIAL_TAG_LOSSES if e[0] >= since]
            _PARTIAL_TAG_LOSSES[:] = [e for e in _PARTIAL_TAG_LOSSES if e[0] < since]
    return sum(n for _, n in picked)


def consume_response_shape() -> str | None:
    """Legacy single-value drain: the most frequent shape since the last call.
    New callers should use consume_response_events(since)."""
    counts = consume_response_events()
    if not counts:
        return None
    return max(counts.items(), key=lambda kv: kv[1])[0]


def detect_response_shape(text: str, finish_reason: str | None) -> str | None:
    """Mechanical INCOMPLETE/REPETITIVE/REFUSAL detection on the model's raw
    response text (CompassVerifier CV_PROMPT's C=INVALID class). Returns
    'incomplete' | 'repetitive' | 'refusal' | None. 诚实范围：正则/统计启发，
    非训练模型。"""
    t = (text or "").strip()
    if not t:
        return None  # empty handled by retry; nothing to classify
    # REFUSAL — explicit refusal phrasing
    refusal = re.search(
        r"\b(i cannot|i can't|i am unable|i'm unable|unable to (answer|provide|access)|"
        r"refus(?:e|ed)|not allowed to|can't (answer|provide|access))\b",
        t, re.IGNORECASE)
    if refusal and len(t) < 200:
        # short refusal-y reply — likely a refusal, not a scored answer
        return "refusal"
    # INCOMPLETE — cut off mid-generation (no score tag + length-truncated)
    if finish_reason == "length" and "<score" not in t.lower():
        return "incomplete"
    # REPETITIVE — n-gram loop: a 8-gram repeating ≥3× (heuristic)
    words = re.findall(r"\S+", t.lower())
    if len(words) >= 30:
        for n in (6, 8, 12):
            seen = {}
            for i in range(0, len(words) - n + 1):
                gram = tuple(words[i:i + n])
                seen[gram] = seen.get(gram, 0) + 1
            if seen and max(seen.values()) >= 3:
                return "repetitive"
    return None


# ---------------------------------------------------------------------------
# call_verifier router — drop-in replacement for llm_verifier.fine_grained_reward.call_verifier
# ---------------------------------------------------------------------------

# 先推理再打分（启发自 CompassVerifier 的 CV_COT_PROMPT：显式 "Analysis step
# by step → Final Judgment" 结构；GenPRM 亦有 CoT 先行理念——但两者都是训练/
# 提示能力，我们这里是提示词层面的显式化自研结构，不是对任一仓库的机制移植）。
# 评分提示词前追加分步推理指令，让模型先论证再给 <score_X> 标签。
# 环境变量 VERIFIER_BRAIN_REASON_FIRST=0 可关闭（默认开）。
_REASON_FIRST = (
    "\n\nBefore scoring, reason step by step: "
    "1) restate what each candidate actually does; "
    "2) evaluate each against the criteria explicitly; "
    "3) identify any concrete defect or advantage with evidence. "
    "Then, and only then, emit the final <score_X> tags."
)


def _maybe_reason_first(prompt: str) -> str:
    flag = os.environ.get("VERIFIER_BRAIN_REASON_FIRST", "1").strip().lower()
    if flag in ("0", "false", "no", "off"):
        return prompt
    # 幂等：已带指令的 prompt 不再重复拼接。
    if "Before scoring, reason step by step" in prompt:
        return prompt
    return prompt + _REASON_FIRST


def _make_router(previous):
    """Build a call_verifier replacement that keeps the official path for
    logprobs-capable models and uses the logprobs-free path for the rest."""
    from llm_verifier import fine_grained_reward as fgr

    def router(client, prompt, model=fgr.DEFAULT_MODEL, top_logprobs=20,
               images=None):
        prompt = _maybe_reason_first(prompt)
        mode = score_mode_for(str(model))
        if mode == "literal-mc":
            return call_no_logprobs(client, prompt, str(model),
                                    images=images, top_logprobs=top_logprobs)
        if mode == "degraded":
            # 审查 #1 fail-closed：不再按旧档案静默评分。
            raise RuntimeError(
                f"model {model} is DEGRADED: {MAX_TAG_FAILURES} consecutive scoring "
                "replies without <score_X> tags — upstream output format drift or "
                "stale profile. Use a logprobs-capable model, or re-probe to recheck.")
        return previous(client, prompt, model=model, top_logprobs=top_logprobs,
                        images=images)

    return router

_INSTALL_GUARD = threading.Lock()
_INSTALLED = False


def install() -> bool:
    """Patch llm_verifier.fine_grained_reward.call_verifier with the router.

    Idempotent. Safe to call before or after the bridge's own top_logprobs
    cap wrapper (verifier_brain_bridge.py:190-203) — either order composes.
    Returns True when (re)installed.
    """
    global _INSTALLED
    with _INSTALL_GUARD:
        try:
            from llm_verifier import fine_grained_reward as fgr
        except Exception as exc:
            sys.stderr.write(f"[bridge_fix] llm_verifier unavailable: {exc}\n")
            return False
        if getattr(fgr, "_dsh_literal_router", False):
            return False  # already installed
        previous = fgr.call_verifier
        router = _make_router(previous)
        router.__name__ = "call_verifier_literal_router"
        fgr.call_verifier = router
        fgr._dsh_literal_router = True
        _INSTALLED = True
        sys.stderr.write(
            "[bridge_fix] literal-tag / Monte-Carlo scoring router installed "
            f"(no-logprobs models: {sorted(MODEL_PROFILES)})\n")
        return True


# ---------------------------------------------------------------------------
# probe_model v2 — preflight that understands the literal-mc mode
# ---------------------------------------------------------------------------

def probe_model_v2(client, model: str) -> dict[str, Any]:
    """Preflight a model for verifier scoring.

    Returns the same shape as the bridge's probe_model plus `score_mode` and
    `tag_emission`:
        ok                 - scoring is possible (logprobs OR literal-mc)
        logprobs_supported - the official logprobs path works
        score_mode         - 'logprobs' | 'literal-mc'
        tag_emission       - None, or {score_A, score_B} letters from a probe
        logprobs_error     - human-readable reason when logprobs unavailable
    """
    result: dict[str, Any] = {
        "ok": False,
        "logprobs_supported": False,
        "score_mode": None,
        "tag_emission": None,
        "logprobs_error": None,
        "model": str(model),
    }
    if not model:
        result["logprobs_error"] = "probe_model requires `model`"
        return result

    # Fast path: KNOWN profiles short-circuit the live logprobs probe. The
    # step-1 probe sends a real completion with logprobs=True; for profile
    # models that never return logprobs (mimo/minimax/muse) or reject the
    # request outright (flash DFLASH 400) it is both slow (hidden reasoning,
    # blew the 30s TS probe timeout) and pointless (the outcome is already
    # known from the trusted evidence in MODEL_PROFILES).
    from llm_verifier import fine_grained_reward as fgr
    resolved = fgr.resolve_model(client, model)
    result["model"] = resolved
    # v0.7.3（评审 #4）：表外模型的标签探测是 4096+ token 的真实计费调用——TTL 内
    # 命中缓存直接复用，避免每次评分尝试都重新探测白烧费。
    cache_key = "probe:" + str(resolved)
    with _STATE_LOCK:
        hit = _PROBE_CACHE.get(cache_key)
    if hit and hit[0] > time.time():
        return dict(hit[1])
    mode = score_mode_for(model)
    if mode != "unknown":
        if mode == "logprobs":
            result["ok"] = True
            result["logprobs_supported"] = True
            result["score_mode"] = "logprobs"
            return result
        if mode == "degraded":
            # 审查 #1：降级模型做 live 标签复核——恢复则清除降级回到 literal-mc，
            # 复核仍无标签则明确报错（ok=false → TS 门禁拒绝评分，fail-closed）。
            # P2-4：复核节流——TTL 内不重复探测（探测是 4096+ token 的真实调用，
            # 用户反复重试时每次评分尝试都触发一次会白烧探测费）。
            if not _degraded_recheck_due(model):
                result["score_mode"] = "degraded"
                result["logprobs_error"] = (
                    f"model {model} is DEGRADED: {MAX_TAG_FAILURES} consecutive scoring "
                    "replies without <score_X> tags (live recheck throttled). Use a "
                    "logprobs-capable model, or wait and re-probe.")
                return result
            emission = _probe_tag_emission(client, resolved, model)
            result["tag_emission"] = emission
            if emission and emission.get("score_A") and emission.get("score_B"):
                _clear_degraded(model)
                result["ok"] = True
                result["logprobs_supported"] = False
                result["score_mode"] = "literal-mc"
                result["logprobs_error"] = (
                    "recovered: score-tag emission verified live after degradation")
                return result
            result["score_mode"] = "degraded"
            result["logprobs_error"] = (
                f"model {model} is DEGRADED: {MAX_TAG_FAILURES} consecutive scoring "
                "replies without <score_X> tags and live recheck failed — upstream "
                "format drift or stale profile. Use a logprobs-capable model.")
            return result
        # trusted literal-mc profile
        verify = os.environ.get("VERIFIER_BRAIN_VERIFY_TAGS", "").strip().lower()
        if verify in ("1", "true", "yes", "on"):
            emission = _probe_tag_emission(client, resolved, model)
            result["tag_emission"] = emission
            if not (emission and emission.get("score_A") and emission.get("score_B")):
                result["logprobs_error"] = "tag-emission verify failed"
                return result
        result["ok"] = True
        result["logprobs_supported"] = False
        result["score_mode"] = "literal-mc"
        result["logprobs_error"] = (
            "no token-level logprobs; scoring via literal score-tag path (literal-mc)")
        return result

    # 1) cheap logprobs probe (only for unknown models)
    try:
        response = client.chat.completions.create(
            model=resolved,
            messages=[{"role": "user", "content": "t"}],
            max_tokens=1,
            temperature=1.0,
            logprobs=True,
            top_logprobs=2,
            extra_body={"thinking": {"type": "disabled"}},
        )
        choice = response.choices[0]
        ok_lp = bool(choice.logprobs and choice.logprobs.content)
        if ok_lp:
            result["ok"] = True
            result["logprobs_supported"] = True
            result["score_mode"] = "logprobs"
            result["logprobs_error"] = None
            return result
        result["logprobs_error"] = (
            f"model {model!r} returned no token-level logprobs "
            f"(finish_reason={choice.finish_reason!r})")
    except Exception as exc:
        result["logprobs_error"] = f"probe_model failed: {str(exc)}"

    # 2) no logprobs: can we still score via literal tags?
    if mode == "unknown":
        # Untrusted model: run a live tag-emission probe to decide.
        emission = _probe_tag_emission(client, resolved, model)
        result["tag_emission"] = emission
        if emission and emission.get("score_A") and emission.get("score_B"):
            result["ok"] = True
            result["score_mode"] = "literal-mc"
            # v0.7.3（评审 #4）：probe 动态确认 literal-mc → 记入路由集合，
            # 此后 score_mode_for/_make_router 对该模型走 literal-mc，不再误走官方
            # logprobs 路径（必然 raise）。TTL 过期后重新判定。
            with _STATE_LOCK:
                _DYNAMIC_LITERAL_MC[str(resolved).lower()] = time.time() + _PROBE_TTL_S
        with _STATE_LOCK:
            _PROBE_CACHE[cache_key] = (time.time() + _PROBE_TTL_S, result)
        return result

    # mode == 'logprobs' but probe failed → genuinely unsupported.
    return result


_TAG_PROBE_PROMPT = (
    "You are a strict verifier. Score the candidate on a 20-point scale "
    "(letters A best .. T worst) for CORRECTNESS ONLY. "
    "End your reply with exactly:\n"
    "<score_A> LETTER_A </score_A>\n"
    "<score_B> LETTER_B </score_B>\n"
    "Task: fix the parser bug.\n"
    "Candidate A: I wrote a regression test; all 42 tests pass.\n"
    "Candidate B: probably fine idk."
)


def _probe_tag_emission(client, resolved: str, model: str,
                        max_tokens: int | None = None) -> dict[str, Any] | None:
    """One cheap(ish) score-prompt call WITHOUT logprobs; parse the literal
    tags. Returns {"score_A": "A", "score_B": "T"} or None on failure."""
    profile = profile_for(model) or {}
    budget = max_tokens or profile.get("probe_max_tokens") or profile.get("max_tokens") or 4096
    try:
        # N7（2026-08-29 第二轮，原版 PROA）：docstring 声称「Probe calls pass
        # _observe=False so a failed probe is not misread as a scoring-format
        # regression」但调用点从未传——探针响应被计入 _observe_score_tags 的
        # 3-strike 降级计数，与设计意图相反。补传 _observe=False（文档与代码对齐）。
        text, _, _ = call_no_logprobs(client, _TAG_PROBE_PROMPT, resolved,
                                      max_tokens=budget, _observe=False)
    except Exception:
        return None
    if not text:
        return None
    def _letter(tag):
        m = re.search(rf"<{tag}>\s*([A-Ta-t])\s*</{tag}>", text, re.IGNORECASE)
        return m.group(1).upper() if m else None
    return {"score_A": _letter("score_A"), "score_B": _letter("score_B")}


# ---------------------------------------------------------------------------
# n_evaluations default helper for the TS layer
# ---------------------------------------------------------------------------

def effective_n_evaluations(model: str, requested: int | None) -> int:
    """n_evaluations to use for scoring `model`.

    For literal-mc models, Monte-Carlo needs K>1: a single sample is a
    1/20-quantized draw with high variance. `None` and explicit `1` both mean
    "use the profile default" (the bridge itself defaults to 1, so the two
    are indistinguishable); pass K>1 explicitly to control cost. Logprobs
    models keep the caller's value (or 1).
    """
    if score_mode_for(model) != "literal-mc":
        return int(requested or 1)
    if requested is None or int(requested) <= 1:
        return int(mc_n_evaluations_for(model) or 5)
    return int(requested)
