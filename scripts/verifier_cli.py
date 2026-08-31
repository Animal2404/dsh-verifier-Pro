#!/usr/bin/env python3
"""verifier CLI: drive the verifier-brain stdio bridge from any shell.

Host-independent front end for the scoring brain (ZCode / any agent that can
run commands):

    python scripts/verifier_cli.py ping
    python scripts/verifier_cli.py probe
    python scripts/verifier_cli.py compare --problem "..." --a "..." --b "..." --criteria deep_review
    python scripts/verifier_cli.py select  --problem "..." --cand @a.html --cand @b.html --cand @c.html --criteria deep_review
    python scripts/verifier_cli.py track   --problem "..." --step "..." --step "..."

Credentials resolve in this order (--backend picks the pair):
    1. explicit --base-url / --api-key flags
    2. OPENAI_API_KEY / OPENAI_BASE_URL already in the environment
    3. ~/.dsh/.credentials.yaml known keys (DEEPSEEK_API_KEY / OPENCODE_GO_API_KEY / ...)
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
BRIDGE_SCRIPT = PLUGIN_ROOT / "bridge" / "verifier_brain_bridge.py"
CRITERIA_DIR = PLUGIN_ROOT / "criteria"

BACKENDS = {
    # name: (credential key, base url, default model)
    "opencode": ("OPENCODE_GO_API_KEY", "https://opencode.ai/zen/go/v1", "deepseek-v4-flash-vision-exp"),
    "deepseek": ("DEEPSEEK_API_KEY", "https://api.deepseek.com", "deepseek-chat"),
    "openrouter": ("OPENROUTER_API_KEY", "https://openrouter.ai/api/v1", "deepseek/deepseek-chat"),
}

CRED_FILE_KEYS = {v[0] for v in BACKENDS.values()} | {
    "OPENAI_API_KEY", "OPENAI_BASE_URL", "VERTEX_API_KEY", "GEMINI_API_KEY",
}


def load_cred_file() -> dict[str, str]:
    """Minimal parser for ~/.dsh/.credentials.yaml known keys (flat or nested)."""
    path = Path.home() / ".dsh" / ".credentials.yaml"
    out: dict[str, str] = {}
    try:
        text = path.read_text("utf-8")
    except OSError:
        return out
    for raw in text.splitlines():
        m = re.match(r"\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.+?)\s*$", raw)
        if not m:
            continue
        # F8（2026-08-29 公平审计）：与 D7/P3-4 同式——值先剥行内注释再剥引号，
        # 否则 `sk-x # note` 整串被当 key（D7 修掉的 bug 家族曾在新文件回归）。
        key, value = m.group(1), re.sub(r"\s+#.*$", "", m.group(2)).strip().strip("'\"")
        if key in CRED_FILE_KEYS and value and value not in ("~", "null"):
            out.setdefault(key, value)
    return out


def resolve_backend(args: argparse.Namespace) -> tuple[str, str, str]:
    """Return (base_url, api_key, model)."""
    model = args.model
    if args.base_url and args.api_key:
        return args.base_url, args.api_key, model or ""
    env = os.environ
    cred = load_cred_file()
    if args.backend == "custom":
        base = args.base_url or env.get("OPENAI_BASE_URL") or cred.get("OPENAI_BASE_URL", "")
        key = args.api_key or env.get("OPENAI_API_KEY") or cred.get("OPENAI_API_KEY", "")
        return base, key, model or ""
    cred_key, default_base, default_model = BACKENDS[args.backend]
    base = args.base_url or default_base
    key = args.api_key or env.get(cred_key) or cred.get(cred_key) or ""
    return base, key, model or default_model


def resolve_criteria(raw: str | None) -> object | None:
    """JSON object > criteria/<name>.md template > raw passthrough."""
    if not raw:
        return None
    t = raw.strip()
    if t.startswith("{"):
        return json.loads(t)
    if re.fullmatch(r"[A-Za-z0-9_-]+", t):
        doc = CRITERIA_DIR / f"{t}.md"
        if doc.exists():
            out: dict[str, str] = {}
            cur: str | None = None
            buf: list[str] = []
            for line in doc.read_text("utf-8").splitlines():
                h = re.match(r"^##\s+(.+?)\s*$", line)
                if h:
                    if cur and "".join(buf).strip():
                        out[cur] = "\n".join(buf).strip()
                    cur, buf = h.group(1), []
                elif cur:
                    buf.append(line)
            if cur and "".join(buf).strip():
                out[cur] = "\n".join(buf).strip()
            if out:
                return out
    return t


def read_arg(value: str) -> str:
    """`@path` reads file content; anything else is a literal."""
    if value.startswith("@"):
        return Path(value[1:]).read_text("utf-8")
    return value


class Bridge:
    """One-shot JSONL request over a spawned bridge process."""

    def __init__(self, base_url: str, api_key: str) -> None:
        env = dict(os.environ)
        env["OPENAI_BASE_URL"] = base_url
        env["OPENAI_API_KEY"] = api_key
        env["PYTHONIOENCODING"] = "utf-8"
        self.proc = subprocess.Popen(
            [sys.executable, str(BRIDGE_SCRIPT)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=env, cwd=str(PLUGIN_ROOT), text=True, encoding="utf-8",
        )

    def request(self, method: str, params: dict, timeout: float) -> dict:
        req_id = 1
        line = json.dumps({"id": req_id, "method": method, "params": params}, ensure_ascii=False)
        self.proc.stdin.write(line + "\n")
        self.proc.stdin.flush()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            reply_line = self.proc.stdout.readline()
            if not reply_line:
                err = self.proc.stderr.read() if self.proc.poll() is not None else ""
                raise RuntimeError(f"bridge exited (code={self.proc.poll()}): {err[-2000:]}")
            reply_line = reply_line.strip()
            if not reply_line:
                continue
            msg = json.loads(reply_line)
            if msg.get("id") != req_id:
                continue
            if not msg.get("ok"):
                err = msg.get("error", {})
                raise RuntimeError(f"{err.get('type', 'bridge_error')}: {err.get('message', msg)}")
            return msg.get("result", {})
        self.proc.kill()
        raise TimeoutError(f"bridge call '{method}' timed out after {timeout}s")

    def close(self) -> None:
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()


def main() -> int:
    p = argparse.ArgumentParser(description="LLM-as-a-Verifier scoring CLI")
    p.add_argument("command", choices=["ping", "probe", "compare", "select", "track"])
    p.add_argument("--problem")
    p.add_argument("--a"); p.add_argument("--b")
    p.add_argument("--cand", action="append", default=[], help="candidate (@file or literal; repeatable)")
    p.add_argument("--step", action="append", default=[], help="trajectory step (repeatable)")
    p.add_argument("--criteria", help='preset name (deep_review / root_cause / criteria/*.md) or JSON object')
    p.add_argument("--model"); p.add_argument("--n-evaluations", type=int)
    p.add_argument("--pivots", type=int); p.add_argument("--seed", type=int)
    p.add_argument("--checkpoint-steps", help="comma-separated 1-based indices for track")
    p.add_argument("--backend", choices=list(BACKENDS) + ["custom"], default="opencode")
    p.add_argument("--base-url"); p.add_argument("--api-key")
    p.add_argument("--timeout", type=float, default=300.0)
    args = p.parse_args()

    base_url, api_key, model = resolve_backend(args)
    if args.command not in ("ping",) and not api_key:
        print(json.dumps({"error": f"no API key resolved for backend '{args.backend}' "
                                  f"(looked in env and ~/.dsh/.credentials.yaml)"}, ensure_ascii=False))
        return 2

    params: dict = {}
    if model:
        params["model"] = model
    crit = resolve_criteria(args.criteria)
    if crit is not None:
        params["criteria"] = crit
    if args.n_evaluations:
        params["n_evaluations"] = max(1, min(args.n_evaluations, 8))

    if args.command == "compare":
        params.update({"problem": read_arg(require(args.problem, "--problem")),
                       "candidate_a": read_arg(require(args.a, "--a")),
                       "candidate_b": read_arg(require(args.b, "--b"))})
    elif args.command == "select":
        if not args.cand:
            p.error("select requires at least one --cand")
        params.update({"problem": read_arg(require(args.problem, "--problem")),
                       "candidates": [read_arg(c) for c in args.cand]})
        if args.pivots:
            params["pivots"] = max(1, min(args.pivots, 20))
        if args.seed is not None:
            params["seed"] = args.seed
    elif args.command == "track":
        if not args.step:
            p.error("track requires at least one --step")
        params.update({"problem": read_arg(require(args.problem, "--problem")),
                       "steps": [read_arg(s) for s in args.step]})
        if args.checkpoint_steps:
            params["checkpoint_steps"] = [int(x) for x in args.checkpoint_steps.split(",")]
    elif args.command == "probe":
        # `probe` reads the model off the client object (unreliable across SDK
        # versions); `probe_model` takes an explicit model and answers in ~1-2 tokens.
        if not model:
            raise SystemExit("probe requires --model (no default resolvable)")
        args.command = "probe_model"
        params = {"model": model}

    bridge = Bridge(base_url, api_key)
    try:
        result = bridge.request(args.command, params, args.timeout)
    finally:
        bridge.close()
    result.setdefault("_backend", {"base_url": base_url, "model": model or "(default)", "backend": args.backend})
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def require(value: str | None, flag: str) -> str:
    if not value:
        raise SystemExit(f"missing required flag {flag}")
    return value


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BrokenPipeError:
        raise SystemExit(1)
