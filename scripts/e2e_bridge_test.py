#!/usr/bin/env python3
"""Single-process E2E test client for the verifier-brain bridge.

Speaks the JSON-Lines protocol over a real pipe to the bridge subprocess, so
ProgressTracker state lives in the same bridge process across calls.
"""
import json
import os
import subprocess
import sys
import threading

BRIDGE = os.path.join(os.path.dirname(__file__), "..", "bridge", "verifier_brain_bridge.py")
PYTHON = sys.executable


class BridgeClient:
    def __init__(self) -> None:
        self.proc = subprocess.Popen(
            [PYTHON, "-u", BRIDGE],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding="utf-8",
        )
        self._next_id = 0
        self._responses: dict[int, dict] = {}
        self._lock = threading.Lock()
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

    def _read_loop(self) -> None:
        for line in self.proc.stdout:
            try:
                msg = json.loads(line)
                with self._lock:
                    self._responses[int(msg.get("id", -1))] = msg
            except Exception:
                pass

    def call(self, method: str, params: dict | None = None, timeout: float = 240.0) -> dict:
        with self._lock:
            self._next_id += 1
            req_id = self._next_id
        self.proc.stdin.write(json.dumps({"id": req_id, "method": method, "params": params or {}}) + "\n")
        self.proc.stdin.flush()
        import time
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self._lock:
                msg = self._responses.pop(req_id, None)
            if msg is not None:
                return msg
            time.sleep(0.1)
        return {"ok": False, "error": {"type": "TestTimeout", "message": f"no response in {timeout}s"}}

    def close(self) -> None:
        self.proc.stdin.close()
        self.proc.wait(timeout=30)


def main() -> int:
    client = BridgeClient()

    # v0.7.0: 显式模型——裸桥没有 TS 层的 defaultModel 注入，缺省模型会落到
    # 官方包默认（Vertex/deepseek-chat），在 OpenAI 兼容后端上必然失败。
    model = os.environ.get("OPENAI_MODEL") or "deepseek-v4-flash-vision-exp"

    ping = client.call("ping")
    print("ping:", json.dumps(ping.get("result") or ping.get("error"), ensure_ascii=False))

    # ProgressTracker flow in one bridge process.
    start = client.call("progress_start", {"problem": "Write a function that reverses a string.", "model": model})
    tid = (start.get("result") or {}).get("tracker_id")
    print("progress_start:", json.dumps(start.get("result") or start.get("error")))
    if tid:
        for step in [
            "Read the problem statement",
            "Wrote def rev(s): return s",
            "Changed to def rev(s): return s[::-1]",
            "Tested: rev('abc') returned 'cba'",
        ]:
            upd = client.call("progress_update", {"tracker_id": tid, "step": step})
            res = upd.get("result") or upd.get("error")
            print(f"progress_update ({step[:36]!r}):", json.dumps(res))
        close = client.call("progress_close", {"tracker_id": tid})
        print("progress_close:", json.dumps(close.get("result") or close.get("error")))

    # Select with the official 3-candidate example.
    sel = client.call("select", {
        "problem": "Write a function that reverses a string.",
        "candidates": [
            "def rev(s): return s[::-1]",
            "def rev(s): return s",
            "def rev(s): return ''.join(sorted(s))",
        ],
        "criteria": {"Correctness": "Does the code actually reverse the string?"},
        "n_evaluations": 1,
        "pivots": 2,
        "model": model,
    })
    print("select:", json.dumps(sel.get("result") or sel.get("error")))

    usage = client.call("usage", {})
    print("usage:", json.dumps((usage.get("result") or {}).get("usage")))

    client.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
