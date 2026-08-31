#!/usr/bin/env python3
"""bridge.test.mjs 用的桩桥：实现协议子集，模拟正常/崩溃/坏帧/慢响应/错误响应。

方法:
  echo       -> 原样回显 params
  err        -> 返回 {ok: false, error: {type, message}}
  badframe   -> 先打一行非 JSON（触发 TS 侧畸形帧关联），再回正常响应
  slow       -> sleep 30s 再回（配合短超时测 BridgeTimeout）
  crash      -> 直接退出（测崩溃后下一请求自动重启）
"""
import json
import sys
import time


def main() -> int:
    for line in sys.stdin:
        if not line.strip():
            continue
        req = json.loads(line)
        rid = req.get("id")
        method = req.get("method")
        params = req.get("params") or {}
        if method == "echo":
            _write({"id": rid, "ok": True, "result": params})
        elif method == "err":
            _write({"id": rid, "ok": False, "error": {"type": "TestError", "message": "boom"}})
        elif method == "badframe":
            # 截断的 JSON 帧（带 id，形似对象但不可解析）——TS 侧应关联到
            # 该请求并快速失败（R3-F3：纯文本日志行不关联，不误杀无辜请求）。
            truncated = json.dumps({"id": rid, "ok": True, "result": {"truncated": True}})[:-8] + "\n"
            sys.stdout.write(truncated)
            sys.stdout.flush()
            _write({"id": rid, "ok": True, "result": {"after_bad_frame": True}})
        elif method == "slow":
            time.sleep(30)
            _write({"id": rid, "ok": True, "result": {"late": True}})
        elif method == "crash":
            # N2（2026-08-29 第二轮）：投递计数——每次收到 crash 请求打 stderr，
            # bridge.test.mjs 据此断言「已写入后崩溃只投递 1 次」（双计费护栏）。
            sys.stderr.write("DELIVERY:crash\n")
            sys.stderr.flush()
            sys.exit(3)
        else:
            _write({"id": rid, "ok": False, "error": {"type": "UnknownMethod", "message": method}})
    return 0


def _write(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    raise SystemExit(main())
