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
import sys
import threading
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

# Worker count for concurrent request handling (env-overridable).
_WORKERS = max(1, int(os.environ.get("VERIFIER_BRAIN_WORKERS", "4") or "4"))
_POOL: ThreadPoolExecutor | None = None
_POOL_GUARD = threading.Lock()

# Official select/compare require keyword-only `criteria`; fall back to a
# generic rubric when the caller omits it, avoiding a TypeError.
DEFAULT_CRITERIA: dict[str, str] = {
    "Correctness": "Does the answer correctly solve the problem, with no factual or logical errors?",
    "Completeness": "Does the answer fully address every part of the problem without missing key requirements?",
    "Clarity": "Is the answer clear, well-structured, and easy to understand?",
}


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


def _filter_kwargs(kwargs: dict[str, Any], allowed: set[str]) -> dict[str, Any]:
    """Only forward parameters the official API accepts (avoids TypeErrors)."""
    return {k: v for k, v in kwargs.items() if k in allowed}


def _sanitize_images(kwargs: dict[str, Any], method: str) -> None:
    """Strip `images` unless the backend is known to accept image_url parts.

    The official package base64-encodes non-empty `images` into
    {"type": "image_url", ...} content; text-only endpoints (DeepSeek) reject
    that with a 400. Default policy (safe first): drop images and note the
    refs in ground_truth_note. Set LLM_VERIFIER_ALLOW_IMAGES=1 for multimodal
    backends (Vertex/Gemini).
    """
    images = kwargs.get("images")
    if not images:
        return
    allow = os.environ.get("LLM_VERIFIER_ALLOW_IMAGES", "").strip().lower()
    if allow in ("1", "true", "yes", "on"):
        return
    refs: list[str] = []
    if isinstance(images, (str, os.PathLike)):
        refs = [str(images)]
    elif isinstance(images, (list, tuple)):
        refs = [str(i) for i in images if isinstance(i, (str, os.PathLike))]
    kwargs.pop("images", None)
    note = (
        "[image refs] " + "; ".join(refs[:20])
        + " (backend does not accept image_url messages; images ignored; "
        "set LLM_VERIFIER_ALLOW_IMAGES=1 for multimodal backends)"
    )
    existing = kwargs.get("ground_truth_note")
    kwargs["ground_truth_note"] = f"{existing}\n{note}" if existing else note
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
    kwargs["criteria"] = criteria if criteria is not None else DEFAULT_CRITERIA
    # Keep evaluation cost bounded by default; explicit caller params win.
    # E2-fix (Round E): literal-mc (no-logprobs) models default to K=5 samples
    # (single draw is a 1/20 quantized estimate — too noisy).
    _model = kwargs.get("model")
    if _model and bridge_fix is not None:
        kwargs["n_evaluations"] = bridge_fix.effective_n_evaluations(str(_model), kwargs.get("n_evaluations"))
    else:
        kwargs.setdefault("n_evaluations", 1)
    kwargs.setdefault("pivots", 2)
    _sanitize_images(kwargs, "select")
    kwargs["client"] = _get_client()
    kwargs = _filter_kwargs(kwargs, {
        "criteria", "images", "ground_truth_note", "n_evaluations",
        "pivots", "seed", "max_workers", "model", "cache", "progress",
        "on_error", "client",
    })
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
    kwargs["criteria"] = criteria if criteria is not None else DEFAULT_CRITERIA
    # E2-fix (Round E): literal-mc models default to K=5 (see _handle_select).
    _model = kwargs.get("model")
    if _model and bridge_fix is not None:
        kwargs["n_evaluations"] = bridge_fix.effective_n_evaluations(str(_model), kwargs.get("n_evaluations"))
    else:
        kwargs.setdefault("n_evaluations", 1)
    _sanitize_images(kwargs, "compare")
    kwargs["client"] = _get_client()
    kwargs = _filter_kwargs(kwargs, {
        "criteria", "images", "ground_truth_note", "n_evaluations",
        "max_workers", "model", "client",
    })
    reward_a, reward_b = llm_verifier.compare(problem, candidate_a, candidate_b, **kwargs)
    # Panel transparency (item ②): tag which scoring path produced the reward —
    # 'logprobs' (official) vs 'literal-mc' (sampled score-tag fallback).
    out = {"reward_a": reward_a, "reward_b": reward_b}
    if bridge_fix is not None and kwargs.get("model"):
        mode = bridge_fix.score_mode_for(str(kwargs["model"]))
        if mode in ("logprobs", "literal-mc"):
            out["score_mode"] = mode
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
    _sanitize_images(kwargs, "track")
    kwargs["client"] = _get_client()
    kwargs = _filter_kwargs(kwargs, {
        "images", "checkpoint_steps", "n_evaluations",
        "max_workers", "model", "client",
    })
    result = llm_verifier.track(problem=problem, steps=steps, **kwargs)
    return _jsonable({"scores": getattr(result, "scores", None)})


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
    _sanitize_images(kwargs, "progress_start")
    kwargs["client"] = _get_client()
    kwargs = _filter_kwargs(kwargs, {
        "images", "n_evaluations", "max_workers", "model", "client",
    })
    with _TRACKERS_GUARD:
        tracker_id = f"tracker-{_NEXT_TRACKER_ID}"
        _NEXT_TRACKER_ID += 1
        _TRACKERS[tracker_id] = llm_verifier.ProgressTracker(problem, **kwargs)
        _TRACKER_LOCKS[tracker_id] = threading.Lock()
    return {"tracker_id": tracker_id}


def _handle_progress_update(params: dict[str, Any]) -> dict[str, Any]:
    _require_library()
    tracker_id = params.get("tracker_id")
    step = params.get("step")
    with _TRACKERS_GUARD:
        tracker = _TRACKERS.get(tracker_id)  # type: ignore[arg-type]
        lock = _TRACKER_LOCKS.get(tracker_id)  # type: ignore[arg-type]
    if tracker is None or lock is None:
        raise ValueError(f"unknown tracker_id: {tracker_id!r}")
    if not isinstance(step, str):
        raise ValueError("progress_update requires a `step` string")
    kwargs = _filter_kwargs(dict(params), {"images"})
    _sanitize_images(kwargs, "progress_update")
    with lock:
        score = tracker.update(step, **kwargs)
    return _jsonable({"score": score})


def _handle_progress_close(params: dict[str, Any]) -> dict[str, Any]:
    tracker_id = params.get("tracker_id")
    with _TRACKERS_GUARD:
        tracker = _TRACKERS.pop(tracker_id, None)  # type: ignore[arg-type]
        _TRACKER_LOCKS.pop(tracker_id, None)  # type: ignore[arg-type]
    if tracker is None:
        raise ValueError(f"unknown tracker_id: {tracker_id!r}")
    return {"closed": True}


def _handle_usage(params: dict[str, Any]) -> dict[str, Any]:
    _ = params
    _require_library()
    token_usage = getattr(llm_verifier, "token_usage", None)
    return {"usage": _jsonable(token_usage()) if callable(token_usage) else None}


def _handle_probe(params: dict[str, Any]) -> dict[str, Any]:
    """Probe the verifier backend for logprobs support and model info."""
    _ = params
    _require_library()
    
    try:
        client = _get_client()
        # Make a minimal compare call to test logprobs
        # Use a trivial problem to minimize cost
        test_problem = "test"
        candidate_a = "a"
        candidate_b = "b"
        criteria = {"Test": "test"}
        
        # Try to get the client's model info
        model = getattr(client, "model", None) or os.environ.get("OPENAI_MODEL", "unknown")
        base_url = getattr(client, "base_url", None) or os.environ.get("OPENAI_BASE_URL", "unknown")
        
        # Test logprobs with a minimal compare call
        logprobs_supported = False
        logprobs_error = None
        try:
            # Use minimal params to test logprobs
            reward_a, reward_b = llm_verifier.compare(
                test_problem, candidate_a, candidate_b,
                criteria=criteria,
                n_evaluations=1,
                client=client
            )
            # If we get numeric rewards without error, logprobs likely worked —
            # UNLESS both rewards are exactly 0.5, the signature of an
            # on_error="tie" masked failure (the very pattern this repo's
            # exact-flat guard exists for). R3-15: never report "supported"
            # on a tie-shaped probe.
            numeric = isinstance(reward_a, (int, float)) and isinstance(reward_b, (int, float))
            tie_shaped = numeric and reward_a == 0.5 and reward_b == 0.5
            logprobs_supported = numeric and not tie_shaped
            if tie_shaped:
                logprobs_error = "probe returned tie-shaped 0.5/0.5 (likely on_error='tie' masking a logprobs failure)"
        except Exception as e:
            logprobs_error = str(e)
            # F7: fail-closed classification. Auth (401), quota (402),
            # network and rate-limit failures used to fall into the "other
            # error → assume logprobs might work" branch, green-lighting a
            # broken backend. Only a successful numeric compare proves
            # logprobs support; every exception reports unsupported so the
            # host warns instead of silently scoring 0.5.
            logprobs_supported = False
        
        return {
            "model": model,
            "base_url": base_url,
            "logprobs_supported": logprobs_supported,
            "logprobs_error": logprobs_error,
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
            pool.submit(_process_line_safe, line, out)
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
