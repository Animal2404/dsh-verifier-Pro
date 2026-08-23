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


def _require_library() -> None:
    if llm_verifier is None:
        raise RuntimeError(
            "llm-verifier is not installed. Run: pip install llm-verifier"
            + (f" (import error: {_IMPORT_ERROR})" if _IMPORT_ERROR else "")
        )


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
    return _jsonable({
        "index": getattr(result, "index", None),
        "ranking": getattr(result, "ranking", None),
        "scores": getattr(result, "scores", None),
    })


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
    kwargs.setdefault("n_evaluations", 1)
    _sanitize_images(kwargs, "compare")
    kwargs["client"] = _get_client()
    kwargs = _filter_kwargs(kwargs, {
        "criteria", "images", "ground_truth_note", "n_evaluations",
        "max_workers", "model", "client",
    })
    reward_a, reward_b = llm_verifier.compare(problem, candidate_a, candidate_b, **kwargs)
    return _jsonable({"reward_a": reward_a, "reward_b": reward_b})


def _handle_track(params: dict[str, Any]) -> dict[str, Any]:
    _require_library()
    kwargs = _params(params)
    problem = kwargs.pop("problem", None)
    steps = kwargs.pop("steps", None)
    if not isinstance(problem, str) or not problem.strip():
        raise ValueError("track requires a non-empty `problem` string")
    if not isinstance(steps, list) or not steps:
        raise ValueError("track requires a non-empty `steps` array")
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
            # If we get numeric rewards without error, logprobs likely worked
            logprobs_supported = isinstance(reward_a, (int, float)) and isinstance(reward_b, (int, float))
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
}


def _write_response(stream: TextIO, payload: dict[str, Any]) -> None:
    # F3: allow_nan=False guarantees every protocol frame is valid JSON — any
    # residual non-finite value raises here and becomes an error response
    # (handled by _process_line) instead of a corrupt frame.
    stream.write(json.dumps(payload, ensure_ascii=False, allow_nan=False) + "\n")
    stream.flush()
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
        _write_response(out, {"id": req_id, "ok": True, "result": result})
    except Exception as exc:
        _write_response(out, {
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
