#!/usr/bin/env python3
"""verifier-brain stdio bridge: DSH host plugin <-> official llm-verifier.

Protocol: one JSON object per line over stdin/stdout.

Request:
    {"id": 1, "method": "select", "params": {...}}

Response (success):
    {"id": 1, "ok": true, "result": {...}}

Response (error):
    {"id": 1, "ok": false, "error": {"type": "...", "message": "..."}}

Methods:
    ping            -> {"pong": true, "version": ..., "available": bool}
    select          -> llm_verifier.select(...)          {index, ranking, scores}
    compare         -> llm_verifier.compare(...)         {reward_a, reward_b}
    track           -> llm_verifier.track(...)           {scores}
    progress_start  -> create ProgressTracker            {tracker_id}
    progress_update -> feed one step                     {score}
    progress_close  -> drop tracker                      {closed}
    usage           -> process-wide token accounting     {usage}

Enhancements over the reference implementation (lanbaolu/dsh-llm-verifier):
- Concurrent request handling: each stdin line is dispatched to a thread pool
  (LLM scoring is I/O bound), so queued async tasks no longer serialize the
  whole bridge. ProgressTracker instances are guarded by per-tracker locks.
- Windows-first: no POSIX assumptions; plugin root discovery works with
  Windows paths; the venv python is chosen by the TS side.

The Python surface stays thin: validate/forward arguments, convert results to
plain JSON. All heavy logic lives in the official `llm_verifier` package.
"""

from __future__ import annotations

import json
import math
import os
import re
import sys
import tempfile
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from typing import Any, TextIO

# E2-fix (Round E): logprobs-free scoring router for models that never return
# token-level logprobs. Imported at module level so handlers can call
# bridge_fix.effective_n_evaluations / probe_model_v2 directly.
try:
    import bridge_fix  # type: ignore
except Exception:
    bridge_fix = None  # type: ignore[assignment]

try:
    import llm_verifier
except Exception as exc:  # pragma: no cover - exercised only when dep missing
    llm_verifier = None
    _IMPORT_ERROR = exc
else:
    _IMPORT_ERROR = None

# ProgressTracker instances, keyed by the ids we hand out. Guards: one global
# dict lock + a per-tracker lock so concurrent progress_update calls on the
# same tracker stay strictly ordered.
_TRACKERS: dict[str, Any] = {}
_TRACKER_LOCKS: dict[str, threading.Lock] = {}
_TRACKERS_GUARD = threading.Lock()
_NEXT_TRACKER_ID = 1
# v0.7.3（外部评审 #8）：ProgressTracker 只靠 progress_close 清理，agent 忘 close
# （常见）→ 随桥进程寿命泄漏。TTL 兜底：每次新建时淘汰超过 1 小时的 tracker。
# F5（复盘 R-refcomp）：TTL 基准改为「最近访问时间」——按创建时间计会把活跃使用
# 超 1h 的长任务在下一次 progress_start 时误杀（随后 update 报 unknown tracker_id）。
_TRACKER_LAST_SEEN: dict[str, float] = {}
_TRACKER_TTL_S = 3600


def _prune_trackers(now: float) -> None:
    stale = [tid for tid, ts in _TRACKER_LAST_SEEN.items() if now - ts > _TRACKER_TTL_S]
    for tid in stale:
        _TRACKERS.pop(tid, None)
        _TRACKER_LOCKS.pop(tid, None)
        _TRACKER_LAST_SEEN.pop(tid, None)


def _touch_tracker(tracker_id: str) -> None:
    _TRACKER_LAST_SEEN[tracker_id] = time.time()

# Worker count for concurrent request handling (env-overridable).
_WORKERS = max(1, int(os.environ.get("VERIFIER_BRAIN_WORKERS", "4") or "4"))
_POOL: ThreadPoolExecutor | None = None
_POOL_GUARD = threading.Lock()

# U-N6 (P3-7): bounded request queue. TS-side semaphores gate the well-known
# paths, but a direct bridge caller (service.direct / third-party plugin) can
# still flood stdin. Beyond MAX_PENDING queued requests we answer immediately
# with a loud error instead of queueing unbounded work (worker starvation →
# cascading timeouts + wasted API spend).
_MAX_PENDING = 200
_PENDING_COUNT = 0
_PENDING_GUARD = threading.Lock()


def _jsonable(value: Any) -> Any:
    """Convert numpy/Python objects to plain JSON-safe values.

    F3: non-finite floats (NaN/inf/-inf) are washed to None. json.dumps would
    otherwise emit bare NaN/Infinity tokens — invalid JSON that the TS side
    cannot parse, leaving the request dangling until its full budget timeout.
    """
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if value is None or isinstance(value, (str, int, bool)):
        return value
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_jsonable(v) for v in value]
    item = getattr(value, "item", None)
    if callable(item):
        try:
            return _jsonable(item())
        except Exception:
            pass
    return str(value)


def _params(params: dict[str, Any] | None) -> dict[str, Any]:
    return dict(params or {})


def _shape_warning(shapes: dict[str, int]) -> str | None:
    """Human-readable warning for response-shape anomalies (counts included)."""
    if not shapes:
        return None
    label = {"incomplete": "截断", "repetitive": "循环重复", "refusal": "拒绝回答"}
    parts = [f"{label.get(s, s)}×{n}" for s, n in sorted(shapes.items())]
    return f"⚠️ 评分模型输出形态异常（{'、'.join(parts)}）——分数不可信，请人工复核。"


def _attach_scoring_observations(out: dict[str, Any], since: float) -> None:
    """F3/F2（复盘 R-refcomp）：把本次调用窗口内的响应形态异常与 literal-mc 部分
    丢标签事件挂到结果上。事件由官方包的内层 ThreadPoolExecutor 线程写入
    （bridge_fix 进程级事件表），只有按 t0 窗口化 drain 才能跨线程回收——
    旧的 thread-local 读法在 select / 多 job compare 上恒为 None（死代码）。

    since = time.monotonic() 取自发起官方调用之前；并发请求窗口重叠时个别
    事件可能跨请求互串（只影响告警，不影响分数）。"""
    if bridge_fix is None:
        return
    msg = _shape_warning(bridge_fix.consume_response_events(since))
    if msg:
        out["anomaly"] = out.get("anomaly") or "response_shape_anomaly"
        out["warning"] = f"{out['warning']}；{msg}" if out.get("warning") else msg
    lost = bridge_fix.consume_partial_tag_losses(since)
    if lost > 0:
        out["anomaly"] = out.get("anomaly") or "literal_mc_partial_tag_loss"
        pmsg = (f"⚠️ literal-mc：{lost} 个样本未返回完整 <score_X> 标签对，已按官方字面回退值 "
                "0.5 计入均值——结果可能被稀释，建议换 logprobs 模型或人工复核。")
        out["warning"] = f"{out['warning']}；{pmsg}" if out.get("warning") else pmsg


def _filter_kwargs(kwargs: dict[str, Any], allowed: set[str]) -> dict[str, Any]:
    """Only forward parameters the official API accepts (avoids TypeErrors).

    D4（2026-08-28 审计）：未知参数此前静默丢弃——用户传错参数名（如给
    track 传 criteria）时无任何提示，与「criteria 缺失要响亮报错」的纪律
    不一致。丢弃时打 stderr 告警。
    """
    dropped = [k for k in kwargs if k not in allowed]
    if dropped:
        sys.stderr.write(
            "[verifier-brain] dropped unknown params (not forwarded to the "
            f"official API): {', '.join(sorted(dropped))}\n"
        )
    return {k: v for k, v in kwargs.items() if k in allowed}


def _validate_image_paths(images: Any, method: str) -> None:
    """B1（2026-08-28 审计）：images 白名单 + 大小上限（放行模式下）。

    与 TS 侧 sanitizeImagesParam 同规则、同环境变量（双保险）：
      LLM_VERIFIER_IMAGE_ROOTS   允许的根目录（os.pathsep 分隔；缺省 =
                                 cwd + 系统临时目录 + DSH_HOME + ~/.dsh）
      LLM_VERIFIER_IMAGE_MAX_MB  单文件上限（缺省 8）
    违规路径响亮报错（ValueError → 错误响应），绝不静默放行。
    R2-2（2026-08-28 二次审计）：前缀判定用 os.path.realpath——词法前缀可被
    白名单根内的 symlink/junction 绕过（指向根外文件）。
    """
    refs: list[str] = []
    if isinstance(images, (str, os.PathLike)):
        refs = [str(images)]
    elif isinstance(images, (list, tuple)):
        refs = [str(i) for i in images if isinstance(i, (str, os.PathLike))]
    roots_env = os.environ.get("LLM_VERIFIER_IMAGE_ROOTS", "")
    roots = [os.path.abspath(r) for r in (
        roots_env.split(os.pathsep) if roots_env else
        [os.getcwd(), tempfile.gettempdir(), os.environ.get("DSH_HOME", ""),
         os.path.join(os.path.expanduser("~"), ".dsh")]
    ) if r]
    # N10（2026-08-29 第二轮，原版 PROA）：MAX_MB=0 是合法配置（拒绝任何文件）——
    # `or "8"` 会把 "0" 吞成 8，语义回退。空串才回落默认 8。
    _max_mb_raw = os.environ.get("LLM_VERIFIER_IMAGE_MAX_MB", "")
    max_mb = float(_max_mb_raw) if _max_mb_raw not in ("", None) else 8.0
    max_bytes = max_mb * 1024 * 1024

    def _norm(s: str) -> str:
        # F9（2026-08-29 公平审计）：Windows 文件系统大小写不敏感——前缀判定前
        # 规范化，避免 realpath 真实大小写与小写配置根误拒（fail-closed 不变）。
        return s.lower() if os.name == "nt" else s

    for img in refs:
        if not os.path.isfile(img):
            raise ValueError(f"verifier images: 路径不存在或不是文件（{img}）——images 只接受本地文件路径")
        # R2-2：先解析符号链接再做前缀判定。
        p = os.path.realpath(img)
        pn = _norm(p)
        if not any(pn == _norm(r) or pn.startswith(_norm(r) + os.sep) for r in roots):
            raise ValueError(
                f"verifier images: 路径不在白名单内（{img}）。允许的根目录：{'; '.join(roots)}"
                "（可用环境变量 LLM_VERIFIER_IMAGE_ROOTS 扩展）——images 是任意文件读取+外发通道"
            )
        size = os.path.getsize(p)
        if size > max_bytes:
            raise ValueError(
                f"verifier images: 文件过大（{img} = {size / 1024 / 1024:.1f}MB > {max_mb:.0f}MB，"
                "LLM_VERIFIER_IMAGE_MAX_MB 可调）"
            )


def _sanitize_images(kwargs: dict[str, Any], method: str) -> None:
    """Strip `images` unless the backend is known to accept image_url parts.

    The official package base64-encodes non-empty `images` into
    {"type": "image_url", ...} content; text-only endpoints (DeepSeek) reject
    that with a 400. Default policy (safe first): drop images and note the
    refs on stderr. Set LLM_VERIFIER_ALLOW_IMAGES=1 for multimodal
    backends (Vertex/Gemini).

    B1（2026-08-28 审计）：即便 ALLOW_IMAGES=1，images 也是 agent 可控的
    本地文件路径（任意文件读取+外发向量）——放行前强制白名单+大小校验。
    """
    images = kwargs.get("images")
    if not images:
        return
    allow = os.environ.get("LLM_VERIFIER_ALLOW_IMAGES", "").strip().lower()
    if allow in ("1", "true", "yes", "on"):
        _validate_image_paths(images, method)
        return
    refs: list[str] = []
    if isinstance(images, (str, os.PathLike)):
        refs = [str(images)]
    elif isinstance(images, (list, tuple)):
        refs = [str(i) for i in images if isinstance(i, (str, os.PathLike))]
    kwargs.pop("images", None)
    # R2（2026-08-28 二次审计）：剥离模式不再写 ground_truth_note——该字段只在
    # select/compare 的允许集里；track/progress_start 的 _filter_kwargs 会把它
    # 当未知参数告警（D4 自产噪音、狼来了效应）。忽略提示已由下方 stderr 承担。
    sys.stderr.write(
        f"[verifier-brain] {method}: stripped images (text-only backend); "
        "set LLM_VERIFIER_ALLOW_IMAGES=1 to pass them through\n"
    )


# D-9: the bridge relies on post-0.2.0 official APIs (token_usage() hook,
# ProgressTracker signatures, tagged-call path). Reject older installs loudly.
_MIN_LLM_VERIFIER = (0, 2, 0)


def _version_tuple(version: str) -> tuple[int, int, int] | None:
    """'0.2.0' / '0.2.0rc1' → (0,2,0); unparseable → None."""
    import re
    m = re.match(r"(\d+)\.(\d+)(?:\.(\d+))?", version)
    if not m:
        return None
    return (int(m.group(1)), int(m.group(2)), int(m.group(3) or 0))


# D-1x: models cap top_logprobs below the official default of 20 (e.g. Qwen
# on this proxy only accepts [0,5]). Cap per-model so those models can score
# instead of 400-ing. 20 remains the default for models without a known cap.
_TOP_LOGPROBS_CAP = {"qwen": 5}


def _top_logprobs_cap(model: str) -> int:
    lowered = (model or "").lower()
    for needle, cap in _TOP_LOGPROBS_CAP.items():
        if needle in lowered:
            return cap
    return 20


def _require_library() -> None:
    if llm_verifier is None:
        raise RuntimeError(
            "llm-verifier is not installed. Run: pip install 'llm-verifier>=0.2.0'"
            + (f" (import error: {_IMPORT_ERROR})" if _IMPORT_ERROR else "")
        )
    ver = getattr(llm_verifier, "__version__", "") or ""
    vt = _version_tuple(ver)
    if vt is None:
        raise RuntimeError(f"llm-verifier version unparseable: {ver!r} — please upgrade: pip install -U 'llm-verifier>=0.2.0'")
    if vt < _MIN_LLM_VERIFIER:
        raise RuntimeError(
            f"llm-verifier {ver} is too old (need >= 0.2.0). Run: pip install -U 'llm-verifier>=0.2.0'"
        )
    # D-1x: every scoring call funnels through fine_grained_reward.call_verifier
    # (compare/select/track/progress). Wrap it to cap top_logprobs per model so
    # models like qwen (cap 5) can score; the official default of 20 stays for
    # models with no known cap.
    try:
        from llm_verifier import fine_grained_reward as _fgr
        if not getattr(_fgr, "_dsh_capped", False):
            _orig = _fgr.call_verifier

            def _capped(client, prompt, model=_fgr.DEFAULT_MODEL, top_logprobs=20, images=None):
                capped = min(int(top_logprobs or 20), _top_logprobs_cap(str(model)))
                return _orig(client, prompt, model=model, top_logprobs=capped, images=images)

            _fgr.call_verifier = _capped
            _fgr._dsh_capped = True
    except Exception:
        # Patching is best-effort; without it some models 400 on top_logprobs.
        pass

    # E2-fix (Round E): logprobs-free scoring router. For the 5 models that
    # never return token-level logprobs (mimo-v2.5-pro / minimax-m3 /
    # minimax-m2.7 / muse-spark-1.2-contributor / deepseek-v4-flash), intercept
    # call_verifier and route to a no-logprobs call + literal score-tag parsing
    # + n_evaluations majority-voting (Monte-Carlo). Must install AFTER the
    # top_logprobs cap wrapper above (it reuses that wrapper internally).
    try:
        import bridge_fix  # type: ignore
        bridge_fix.install()
    except Exception:
        pass


_CLIENT = None
_CLIENT_GUARD = threading.Lock()


def _get_client():
    """Build (once) the verifier client with the tagged-call path.

    The official package routes generic OpenAI-compatible endpoints through
    a vLLM/SGLang-only "prefill" trick; on proxies without prefill support
    (e.g. opencode) every score silently degrades to a flat 0.5. Empirically
    the models on these proxies DO emit their own <score_X> tags and the
    responses carry token-level logprobs — so tag the client to read the
    model's own tags (the DeepSeek call path), which also fails loudly
    instead of scoring 0.5 when logprobs are missing. Set
    VERIFIER_BRAIN_NO_TAG=1 to keep the official default behavior.
    """
    global _CLIENT
    with _CLIENT_GUARD:
        if _CLIENT is None:
            _require_library()
            client = llm_verifier.fine_grained_reward.create_client()
            no_tag = os.environ.get("VERIFIER_BRAIN_NO_TAG", "").strip().lower() in ("1", "true", "yes", "on")
            if not no_tag and not getattr(client, "_llm_verifier_deepseek", False) \
                    and llm_verifier.fine_grained_reward._is_openai_client(client):
                client._llm_verifier_deepseek = True
                sys.stderr.write("[verifier-brain] client tagged: reading model-emitted score tags "
                                 "(prefill path unsupported on this endpoint)\n")
            _CLIENT = client
        return _CLIENT


def _load_plugin_env() -> None:
    """Load .env from the plugin root (walk up from bridge/ to package.json)."""
    try:
        from llm_verifier import load_dotenv  # type: ignore[attr-defined]
    except Exception:
        try:
            from dotenv import load_dotenv  # type: ignore[import-not-found]
        except Exception:
            return
    cur = os.path.dirname(os.path.abspath(__file__))
    for _ in range(4):
        if os.path.exists(os.path.join(cur, "package.json")):
            break
        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent
    try:
        load_dotenv(cur)
    except Exception:
        pass


def _handle_ping(params: dict[str, Any]) -> dict[str, Any]:
    _ = params
    return {
        "pong": True,
        "version": getattr(llm_verifier, "__version__", "unknown") if llm_verifier else None,
        "available": llm_verifier is not None,
        "workers": _WORKERS,
        "import_error": str(_IMPORT_ERROR) if _IMPORT_ERROR else None,
    }


def _handle_select(params: dict[str, Any]) -> dict[str, Any]:
    _require_library()
    kwargs = _params(params)
    problem = kwargs.pop("problem", None)
    candidates = kwargs.pop("candidates", None)
    if not isinstance(problem, str) or not problem.strip():
        raise ValueError("select requires a non-empty `problem` string")
    if not isinstance(candidates, list) or not candidates:
        raise ValueError("select requires a non-empty `candidates` array")
    criteria = kwargs.pop("criteria", None)
    # P3-7: no silent DEFAULT_CRITERIA substitution — the TS/service layers
    # require explicit criteria (U-N1); a direct bridge caller omitting it gets
    # a loud error instead of a silently-changed scoring rubric.
    if criteria is None:
        raise ValueError("select requires `criteria` (a preset name or a {\"name\": \"description\"} object)")
    kwargs["criteria"] = criteria
    # Keep evaluation cost bounded by default; explicit caller params win.
    # E2-fix (Round E): literal-mc (no-logprobs) models default to K=5 samples
    # (single draw is a 1/20 quantized estimate — too noisy).
    _model = kwargs.get("model")
    if _model and bridge_fix is not None:
        kwargs["n_evaluations"] = bridge_fix.effective_n_evaluations(str(_model), kwargs.get("n_evaluations"))
    else:
        kwargs.setdefault("n_evaluations", 1)
    kwargs.setdefault("pivots", 2)
    # F4（复盘 R-refcomp）：maxWorkers 只限桥请求层并发；官方包在 max_workers 缺省时
    # 取 default_max_workers()=50/500 路直打供应商——单次 select 内部即可 ~200 在飞。
    # 桥内 worker 数作为内层 fan-out 的默认钳制，显式传参仍可覆盖（TS 侧上限 16）。
    kwargs.setdefault("max_workers", _WORKERS)
    _sanitize_images(kwargs, "select")
    kwargs["client"] = _get_client()
    kwargs = _filter_kwargs(kwargs, {
        "criteria", "images", "ground_truth_note", "n_evaluations",
        "pivots", "seed", "max_workers", "model", "cache", "progress",
        "on_error", "client",
    })
    _t0 = time.monotonic()
    result = llm_verifier.select(problem=problem, candidates=candidates, **kwargs)
    out = {
        "index": getattr(result, "index", None),
        "ranking": getattr(result, "ranking", None),
        "scores": getattr(result, "scores", None),
    }
    # Panel transparency (item ②): tag the scoring path.
    if bridge_fix is not None and kwargs.get("model"):
        mode = bridge_fix.score_mode_for(str(kwargs["model"]))
        if mode in ("logprobs", "literal-mc"):
            out["score_mode"] = mode
    _attach_scoring_observations(out, _t0)
    return _jsonable(out)


def _handle_compare(params: dict[str, Any]) -> dict[str, Any]:
    _require_library()
    kwargs = _params(params)
    problem = kwargs.pop("problem", None)
    candidate_a = kwargs.pop("candidate_a", kwargs.pop("candidateA", None))
    candidate_b = kwargs.pop("candidate_b", kwargs.pop("candidateB", None))
    if not isinstance(problem, str) or not problem.strip():
        raise ValueError("compare requires a non-empty `problem` string")
    if not isinstance(candidate_a, str):
        raise ValueError("compare requires `candidate_a` string")
    if not isinstance(candidate_b, str):
        raise ValueError("compare requires `candidate_b` string")
    criteria = kwargs.pop("criteria", None)
    # P3-7: see _handle_select — criteria must be explicit, never silently
    # substituted with DEFAULT_CRITERIA.
    if criteria is None:
        raise ValueError("compare requires `criteria` (a preset name or a {\"name\": \"description\"} object)")
    kwargs["criteria"] = criteria
    # E2-fix (Round E): literal-mc models default to K=5 (see _handle_select).
    _model = kwargs.get("model")
    if _model and bridge_fix is not None:
        kwargs["n_evaluations"] = bridge_fix.effective_n_evaluations(str(_model), kwargs.get("n_evaluations"))
    else:
        kwargs.setdefault("n_evaluations", 1)
    # F4: see _handle_select — bound the inner fan-out too.
    kwargs.setdefault("max_workers", _WORKERS)
    _sanitize_images(kwargs, "compare")
    kwargs["client"] = _get_client()
    kwargs = _filter_kwargs(kwargs, {
        "criteria", "images", "ground_truth_note", "n_evaluations",
        "max_workers", "model", "client",
    })
    _t0 = time.monotonic()
    reward_a, reward_b = llm_verifier.compare(problem, candidate_a, candidate_b, **kwargs)
    # Panel transparency (item ②): tag which scoring path produced the reward —
    # 'logprobs' (official) vs 'literal-mc' (sampled score-tag fallback).
    out = {"reward_a": reward_a, "reward_b": reward_b}
    if bridge_fix is not None and kwargs.get("model"):
        mode = bridge_fix.score_mode_for(str(kwargs["model"]))
        if mode in ("logprobs", "literal-mc"):
            out["score_mode"] = mode
    _attach_scoring_observations(out, _t0)
    return _jsonable(out)


def _handle_track(params: dict[str, Any]) -> dict[str, Any]:
    _require_library()
    kwargs = _params(params)
    problem = kwargs.pop("problem", None)
    steps = kwargs.pop("steps", None)
    if not isinstance(problem, str) or not problem.strip():
        raise ValueError("track requires a non-empty `problem` string")
    if not isinstance(steps, list) or not steps:
        raise ValueError("track requires a non-empty `steps` array")
    # E2-fix (Round E): literal-mc models default to K=5 (see _handle_select).
    _model = kwargs.get("model")
    if _model and bridge_fix is not None:
        kwargs["n_evaluations"] = bridge_fix.effective_n_evaluations(str(_model), kwargs.get("n_evaluations"))
    else:
        kwargs.setdefault("n_evaluations", 1)
    # F4: see _handle_select — bound the inner fan-out too.
    kwargs.setdefault("max_workers", _WORKERS)
    _sanitize_images(kwargs, "track")
    kwargs["client"] = _get_client()
    kwargs = _filter_kwargs(kwargs, {
        "images", "checkpoint_steps", "n_evaluations",
        "max_workers", "model", "client",
    })
    _t0 = time.monotonic()
    result = llm_verifier.track(problem=problem, steps=steps, **kwargs)
    out = {
        "scores": getattr(result, "scores", None),
        # F9（复盘 R-refcomp）：透传官方 checkpoint 步号（默认内点 2..T-1，显式
        # 传入时原样返回）——此前只回 scores，evaluate_session 导出表只能标
        # i+1，与真实步号错位。
        "checkpoint_steps": getattr(result, "steps", None),
        # F6（复盘 R-refcomp）：官方对「某 checkpoint 全部 repeat 都不可读」静默记
        # 0.5（progress.py:309-310）——整条轨迹全 0.5 时在桥侧先打上标记，TS 层
        # 与面板才能区分「真实平局曲线」和「批量失败被掩蔽」。
    }
    scores = out["scores"]
    if isinstance(scores, list) and scores and all(
        isinstance(v, (int, float)) and not isinstance(v, bool) and float(v) == 0.5 for v in scores
    ):
        out["anomaly"] = out.get("anomaly") or "exact_flat"
        out["warning"] = ("⚠️ 全部 checkpoint 精确等于 0.5 —— 官方对不可读 checkpoint 静默记 0.5 "
                          "的特征（评分批量失败/标签丢失），不是真实平局曲线；请人工复核或换模型。")
    _attach_scoring_observations(out, _t0)
    return _jsonable(out)


# DeepVerifier 分解验证移植（rubric ③）——诚实适配说明：
# DeepVerifier 的 CONTEXT_PROMPT 三阶段是「轨迹摘要 → 失败分类 → 核查问题」，
# 然后派独立 agent 实查（rollout）。我们移植前两阶段 + 核查问题【生成】，
# 不做独立实查（我们没有 rollout 能力）；生成的核查问题供用户/团队人工核查。
# 失败分类学直接采用 DeepVerifier 的 14 类（见 template.py POTENTIAL ERRORS）。

_DEEPVERIFIER_ERRORS = (
    "1. Failure to consult the right sources, selecting/observing the wrong item\n"
    "2. Premature conclusion and incomplete exploration\n"
    "3. Misinterpreting or misunderstanding the instructions or questions\n"
    "4. Reliance on generic searches, secondary sources, not consulting primary sources\n"
    "5. UI interaction failure or tool failure\n"
    "6. Source/information not available or not accessible, or login wall\n"
    "7. Goal drift to partial/less relevant task, misfocusing on secondary details\n"
    "8. Hallucinated/overconfident claims, conflated concepts, inferential leaps\n"
    "9. Max step reached\n"
    "10. Ignored/missed key words or key information that is available in the instructions or sources\n"
    "11. Text format error\n"
    "12. Anchored on less relevant information\n"
    "13. Ambiguity-driven guesses\n"
    "14. Did not use proper modality (image or text or video or audio)"
)

_DECOMPOSE_PROMPT = """You are verifying an agent's trajectory on a task. Perform three tasks **in order**. Return **only** the JSON object below, no extra text.

Inputs: task, steps (each step is one agent action).

### 1) STEP SUMMARY
For each step, state what the agent did and (if it consulted a source) what key info it obtained.

### 2) POTENTIAL ERRORS
Identify suspicious behaviors in the steps and map each to **one** error from this list:
{errors}

### 3) CHECK QUESTIONS
Propose the **fewest** (<=3) concrete yes-no verification questions that would confirm or refute the agent's key claims, each tied to a specific source/check the question would require.

Return JSON exactly like:
{{
  "step_summary": [{{"step": 1, "action": "...", "source": "..." or null, "info": "..." or null}}],
  "potential_errors": [{{"behavior": "...", "error": "<one from list>"}}],
  "check_questions": [{{"question": "...", "requires": "..."}}]
}}

Task: {task}
Steps:
{steps}
"""


def _repair_truncated_json(raw: str) -> str:
    """审查 #3：按括号栈补全被截断的 JSON。

    扫描字符串（感知引号/转义），用栈记录未闭合的 `{[`，按 LIFO 补对应的
    闭括号（`[`→`]`，`{`→`}`）。对「对象/数组嵌套截断在完整值之后」的
    常见截断点可靠；截断在数组元素中间时尽力而为（补出的 JSON 可能仍
    非法，调用方会退回原始片段）。用于 decompose 在 finish_reason=length
    下的部分修复。
    """
    stack: list[str] = []
    in_str = False
    esc = False
    for ch in raw:
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch in "{[":
            stack.append(ch)
        elif ch in "}]" and stack:
            stack.pop()
    closes = ("]" if op == "[" else "}" for op in reversed(stack))
    return raw + "".join(closes)


def _handle_decompose(params: dict[str, Any]) -> dict[str, Any]:
    """DeepVerifier-style rubric decomposition of a trajectory (③).

    Returns { step_summary, potential_errors, check_questions } — the
    decomposition structure. Verification of the check questions is left to
    the caller (we generate, not execute, per honest adaptation).
    """
    _require_library()
    problem = str(params.get("problem") or "")
    steps = params.get("steps")
    model = str(params.get("model") or "") if params.get("model") else None
    if not problem.strip():
        raise ValueError("decompose requires a non-empty `problem` string")
    if not isinstance(steps, list) or not steps:
        raise ValueError("decompose requires a non-empty `steps` array")

    client = _get_client()
    from llm_verifier import fine_grained_reward as fgr
    resolved = fgr.resolve_model(client, model) if model else getattr(client, "model", None) or fgr.DEFAULT_MODEL

    steps_text = "\n".join(f"Step {i + 1}: {s}" for i, s in enumerate(steps))
    prompt = _DECOMPOSE_PROMPT.format(errors=_DEEPVERIFIER_ERRORS, task=problem, steps=steps_text)

    # No logprobs needed — decomposition is a structural analysis, not scoring.
    # 审查 #3：显式禁用 thinking —— 评分路径（call_no_logprobs）同样带
    # {"thinking": {"type": "disabled"}}。decompose 是结构分析，不需要模型推理；
    # 开着推理会吃掉 max_tokens 预算，中文长 JSON 输出偶发被截断
    # （finish_reason=length）或整段空响应（raw=""）。
    body = dict(
        model=resolved,
        messages=[{"role": "user", "content": prompt}],
        max_tokens=8192,
        temperature=0.0,
        extra_body={"thinking": {"type": "disabled"}},
    )
    response = client.chat.completions.create(**body)
    text = response.choices[0].message.content or ""
    finish = getattr(response.choices[0], "finish_reason", None)
    if not text.strip():
        # 隐藏推理/空输出 → 一次重试（同 call_no_logprobs 的 muse-spark 模式）
        response = client.chat.completions.create(**body)
        text = response.choices[0].message.content or ""
        finish = getattr(response.choices[0], "finish_reason", None)

    # Parse the JSON object out of the reply (tolerate ```json fences / stray text).
    m = re.search(r"\{[\s\S]*\}", text)
    if not m:
        return {"error": "decompose: 模型未返回结构化 JSON", "raw": text[:800], "finish_reason": finish}
    raw_json = m.group(0)
    try:
        parsed = json.loads(raw_json)
    except Exception as exc:
        # Truncated JSON (finish_reason=length) — attempt partial repair:
        # close unbalanced brackets (more reliable than appending "}"*3),
        # then retry once; else surface the fragment.
        if finish == "length":
            repaired = _repair_truncated_json(raw_json)
            try:
                parsed = json.loads(repaired)
            except Exception:
                return {"error": f"decompose: JSON 被截断且修复失败: {exc}", "raw": raw_json[:800], "finish_reason": finish}
        else:
            return {"error": f"decompose: JSON 解析失败: {exc}", "raw": raw_json[:800], "finish_reason": finish}
    return _jsonable({
        "step_summary": parsed.get("step_summary", []),
        "potential_errors": parsed.get("potential_errors", []),
        "check_questions": parsed.get("check_questions", []),
        "finish_reason": finish,
    })


def _handle_progress_start(params: dict[str, Any]) -> dict[str, Any]:
    global _NEXT_TRACKER_ID
    _require_library()
    kwargs = _params(params)
    problem = kwargs.pop("problem", None)
    if not isinstance(problem, str) or not problem.strip():
        raise ValueError("progress_start requires a non-empty `problem` string")
    # E2-fix (Round E): literal-mc models default to K=5 (see _handle_select).
    _model = kwargs.get("model")
    if _model and bridge_fix is not None:
        kwargs["n_evaluations"] = bridge_fix.effective_n_evaluations(str(_model), kwargs.get("n_evaluations"))
    else:
        kwargs.setdefault("n_evaluations", 1)
    # F4: ProgressTracker.update scores too — bound its inner fan-out likewise.
    kwargs.setdefault("max_workers", _WORKERS)
    _sanitize_images(kwargs, "progress_start")
    kwargs["client"] = _get_client()
    kwargs = _filter_kwargs(kwargs, {
        "images", "n_evaluations", "max_workers", "model", "client",
    })
    with _TRACKERS_GUARD:
        _prune_trackers(time.time())  # v0.7.3（评审 #8）：TTL 淘汰防泄漏
        tracker_id = f"tracker-{_NEXT_TRACKER_ID}"
        _NEXT_TRACKER_ID += 1
        _TRACKERS[tracker_id] = llm_verifier.ProgressTracker(problem, **kwargs)
        _TRACKER_LOCKS[tracker_id] = threading.Lock()
        _touch_tracker(tracker_id)
    return {"tracker_id": tracker_id}


def _handle_progress_update(params: dict[str, Any]) -> dict[str, Any]:
    _require_library()
    tracker_id = params.get("tracker_id")
    step = params.get("step")
    with _TRACKERS_GUARD:
        tracker = _TRACKERS.get(tracker_id)  # type: ignore[arg-type]
        lock = _TRACKER_LOCKS.get(tracker_id)  # type: ignore[arg-type]
        # F5: TTL 按最近访问滚动——活跃长任务不会被下一次 progress_start 的清理误杀。
        if tracker is not None:
            _touch_tracker(tracker_id)  # type: ignore[arg-type]
    if tracker is None or lock is None:
        raise ValueError(f"unknown tracker_id: {tracker_id!r}")
    if not isinstance(step, str):
        raise ValueError("progress_update requires a `step` string")
    # R2-1（2026-08-28 二次审计）：tracker_id/step 是已消费参数——pop 后再过滤，
    # 否则 D4 告警会每次 progress_update 都刷「dropped unknown params」噪音。
    kwargs = dict(params)
    kwargs.pop("tracker_id", None)
    kwargs.pop("step", None)
    kwargs = _filter_kwargs(kwargs, {"images"})
    _sanitize_images(kwargs, "progress_update")
    with lock:
        score = tracker.update(step, **kwargs)
    return _jsonable({"score": score})


def _handle_progress_close(params: dict[str, Any]) -> dict[str, Any]:
    tracker_id = params.get("tracker_id")
    with _TRACKERS_GUARD:
        tracker = _TRACKERS.pop(tracker_id, None)  # type: ignore[arg-type]
        _TRACKER_LOCKS.pop(tracker_id, None)  # type: ignore[arg-type]
        _TRACKER_LAST_SEEN.pop(tracker_id, None)
    if tracker is None:
        raise ValueError(f"unknown tracker_id: {tracker_id!r}")
    return {"closed": True}


def _handle_usage(params: dict[str, Any]) -> dict[str, Any]:
    _ = params
    _require_library()
    token_usage = getattr(llm_verifier, "token_usage", None)
    return {"usage": _jsonable(token_usage()) if callable(token_usage) else None}


def _handle_probe(params: dict[str, Any]) -> dict[str, Any]:
    """Probe the verifier backend for logprobs support and model info.

    #16: 此前用一次完整 compare 探测 logprobs——启动即计费。改为 1-token
    max_tokens=1 探测（与 probe_model 一致，约 1-2 token），成本可忽略。
    """
    _ = params
    _require_library()
    try:
        client = _get_client()
        # str(): OpenAI SDK exposes httpx.URL here, which json.dumps rejects.
        model = str(getattr(client, "model", None) or os.environ.get("OPENAI_MODEL", "unknown"))
        base_url = str(getattr(client, "base_url", None) or os.environ.get("OPENAI_BASE_URL", "unknown"))

        if bridge_fix is not None:
            r = bridge_fix.probe_model_v2(client, str(model))
            return {
                "model": r.get("model") or model,
                "base_url": base_url,
                "logprobs_supported": r.get("logprobs_supported") is True,
                "logprobs_error": r.get("logprobs_error"),
                "score_mode": r.get("score_mode"),
                "llm_verifier_version": getattr(llm_verifier, "__version__", "unknown"),
            }
        return {
            "model": model,
            "base_url": base_url,
            "logprobs_supported": False,
            "logprobs_error": "bridge_fix unavailable — probe_model_v2 not installed",
            "llm_verifier_version": getattr(llm_verifier, "__version__", "unknown"),
        }
    except Exception as e:
        return {
            "model": "unknown",
            "base_url": "unknown",
            "logprobs_supported": False,
            "logprobs_error": f"Probe failed: {str(e)}",
            "llm_verifier_version": getattr(llm_verifier, "__version__", "unknown") if llm_verifier else "not installed",
        }


def _handle_probe_model(params: dict[str, Any]) -> dict[str, Any]:
    """Cheap per-model logprobs capability check (~1-2 tokens).

    ``call_deepseek`` burns the full 32K max_tokens budget when a model
    either thinks the whole budget away or does not return token-level
    logprobs — and the failure only surfaces AFTER all that spend (the
    fail-closed raise). This handler answers the same question with a
    max_tokens=1 completion: if the model returns logprobs.content, it can
    be scored with; otherwise fail fast with a clear message instead of
    burning 32K tokens. D-1x: mirrors the official package's own
    prefilled-position trick (fine_grained_reward.py max_tokens=1).
    """
    _require_library()
    model = str(params.get("model") or "").strip()
    if not model:
        return {"ok": False, "error": "probe_model requires `model`"}
    try:
        client = _get_client()
        # E2-fix (Round E): v2 probe — classifies models into score modes
        # ('logprobs' | 'text-tags' | 'unsupported') via the profile table.
        import bridge_fix  # type: ignore
        return bridge_fix.probe_model_v2(client, model)
    except Exception as e:
        return {
            "ok": False,
            "model": model,
            "logprobs_supported": False,
            "score_mode": None,
            "logprobs_error": f"probe_model failed: {str(e)}",
        }


_HANDLERS: dict[str, Any] = {
    "ping": _handle_ping,
    "select": _handle_select,
    "compare": _handle_compare,
    "track": _handle_track,
    "decompose": _handle_decompose,
    "progress_start": _handle_progress_start,
    "progress_update": _handle_progress_update,
    "progress_close": _handle_progress_close,
    "usage": _handle_usage,
    "probe": _handle_probe,
    "probe_model": _handle_probe_model,
}


def _write_response(stream: TextIO, payload: dict[str, Any]) -> None:
    # F3: allow_nan=False guarantees every protocol frame is valid JSON — any
    # residual non-finite value raises here and becomes an error response
    # (handled by _process_line) instead of a corrupt frame.
    stream.write(json.dumps(payload, ensure_ascii=False, allow_nan=False) + "\n")
    stream.flush()


def _process_line(line: str, out: TextIO) -> None:
    """Handle one request line; runs on a pool worker thread."""
    req_id = None
    try:
        request = json.loads(line)
        if not isinstance(request, dict):
            raise ValueError("request must be a JSON object")
        req_id = request.get("id")
        method = request.get("method")
        params = request.get("params") or {}
        if not isinstance(method, str):
            raise ValueError("request missing string `method`")
        handler = _HANDLERS.get(method)
        if handler is None:
            raise ValueError(f"unknown method: {method!r}")
        result = handler(params)
        _write_response_locked(out, {"id": req_id, "ok": True, "result": result})
    except Exception as exc:
        _write_response_locked(out, {
            "id": req_id,
            "ok": False,
            "error": {"type": type(exc).__name__, "message": str(exc)},
        })


def _get_pool() -> ThreadPoolExecutor:
    global _POOL
    with _POOL_GUARD:
        if _POOL is None:
            _POOL = ThreadPoolExecutor(max_workers=_WORKERS, thread_name_prefix="verifier-brain")
        return _POOL


_WRITE_GUARD = threading.Lock()


def _write_response_locked(stream: TextIO, payload: dict[str, Any]) -> None:
    # Responses may be produced concurrently by pool workers; keep each
    # JSON line atomic on stdout.
    with _WRITE_GUARD:
        _write_response(stream, payload)


def _submit_with_backpressure(line: str, out: TextIO, pool: ThreadPoolExecutor) -> None:
    """Submit one request line under the pending-queue bound (U-N6).

    Over capacity: echo a loud error response (with the caller's id when the
    line parses) instead of queueing unbounded work. The counter is decremented
    when the worker finishes, so this is a real bound, not a rate limiter.
    """
    global _PENDING_COUNT
    req_id = None
    try:
        req = json.loads(line)
        req_id = req.get("id") if isinstance(req, dict) else None
    except Exception:
        pass
    with _PENDING_GUARD:
        if _PENDING_COUNT >= _MAX_PENDING:
            _write_response_locked(out, {
                "id": req_id,
                "ok": False,
                "error": {"type": "BridgeOverload", "message": f"bridge queue full ({_MAX_PENDING} pending) — retry later"},
            })
            return
        _PENDING_COUNT += 1

    def _run() -> None:
        global _PENDING_COUNT
        try:
            _process_line_safe(line, out)
        finally:
            with _PENDING_GUARD:
                _PENDING_COUNT -= 1

    pool.submit(_run)


def main() -> int:
    _load_plugin_env()
    # Proxy endpoints reject DeepSeek's thinking extra_body; "off" sends the
    # simple {"thinking": {"type": "disabled"}} shape (verified working) and
    # keeps the score tags fast. Set DEEPSEEK_EFFORT explicitly to override.
    os.environ.setdefault("DEEPSEEK_EFFORT", "off")
    # Force UTF-8 on the protocol streams: on Windows the default locale
    # encoding (e.g. cp936) turns multibyte UTF-8 payload bytes into lone
    # surrogates, which then crash utf-8 encoding downstream.
    try:
        sys.stdin.reconfigure(encoding="utf-8", errors="strict")
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    out = sys.stdout
    pool = _get_pool()
    try:
        # stderr is reserved for diagnostics; stdout carries protocol lines only.
        for line in sys.stdin:
            if not line.strip():
                continue
            _submit_with_backpressure(line, out, pool)
    finally:
        # Drain in-flight scoring work before interpreter shutdown, otherwise
        # a fast-close stdin kills queued requests mid-flight.
        pool.shutdown(wait=True)
    return 0


def _process_line_safe(line: str, out: TextIO) -> None:
    try:
        _process_line(line, out)
    except Exception:  # never let a worker thread die silently
        traceback.print_exc(file=sys.stderr)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
    except Exception:
        traceback.print_exc(file=sys.stderr)
        raise SystemExit(1)
