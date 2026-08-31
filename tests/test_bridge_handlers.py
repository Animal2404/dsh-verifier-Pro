#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""E3（2026-08-28 审计）：Python 桥 handler 层单元测试（此前零自动化测试）。

覆盖纯函数：_filter_kwargs（白名单 + D4 未知参数告警）、_sanitize_images
（剥离策略 + B1 放行模式白名单/大小校验）、_version_tuple。
运行：python tests/test_bridge_handlers.py（无需 llm-verifier 安装）。
"""
from __future__ import annotations

import io
import os
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stderr
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "bridge"))

import verifier_brain_bridge as vbb  # noqa: E402


class FilterKwargsTest(unittest.TestCase):
    def test_allows_only_whitelisted_keys(self) -> None:
        out = vbb._filter_kwargs({"model": "m", "criteria": {"A": "b"}, "bogus": 1}, {"model", "criteria"})
        self.assertEqual(out, {"model": "m", "criteria": {"A": "b"}})

    def test_dropped_keys_emit_stderr_warning(self) -> None:
        buf = io.StringIO()
        with redirect_stderr(buf):
            vbb._filter_kwargs({"model": "m", "nope": 1, "also_nope": 2}, {"model"})
        self.assertIn("nope", buf.getvalue())
        self.assertIn("also_nope", buf.getvalue())

    def test_no_warning_when_nothing_dropped(self) -> None:
        buf = io.StringIO()
        with redirect_stderr(buf):
            vbb._filter_kwargs({"model": "m"}, {"model"})
        self.assertEqual(buf.getvalue(), "")


class SanitizeImagesTest(unittest.TestCase):
    def _tmpfile(self, size: int = 16) -> str:
        fd, path = tempfile.mkstemp(prefix="vbb-img-", suffix=".png")
        os.write(fd, b"x" * size)
        os.close(fd)
        self.addCleanup(os.unlink, path)
        return path

    def test_strips_when_not_allowed(self) -> None:
        # R2（2026-08-28 二次审计）：剥离模式只 pop images 并 stderr 提示，
        # 不再写 ground_truth_note（track/progress_start 允许集不含它，写了会
        # 被 D4 误报为未知参数）；显式传入的 ground_truth_note 原样保留。
        img = self._tmpfile()
        kwargs = {"images": [img], "ground_truth_note": "orig"}
        buf = io.StringIO()
        with patch.dict(os.environ, {}, clear=False):
            with redirect_stderr(buf):
                vbb._sanitize_images(kwargs, "compare")
        self.assertNotIn("images", kwargs)
        self.assertEqual(kwargs["ground_truth_note"], "orig", "剥离模式不得改写 ground_truth_note")
        self.assertIn("stripped images", buf.getvalue())

    def test_passthrough_when_allowed_and_in_roots(self) -> None:
        img = self._tmpfile()
        kwargs = {"images": [img]}
        with patch.dict(os.environ, {"LLM_VERIFIER_ALLOW_IMAGES": "1"}, clear=False):
            vbb._sanitize_images(kwargs, "compare")
        self.assertEqual(kwargs["images"], [img])

    def test_allowed_but_outside_roots_raises(self) -> None:
        img = self._tmpfile()
        outside = tempfile.mkdtemp(prefix="vbb-outside-")
        self.addCleanup(lambda: __import__("shutil").rmtree(outside, ignore_errors=True))
        # 把白名单根指到一个空目录，img 在系统临时目录 → 必然越界。
        with patch.dict(os.environ, {
            "LLM_VERIFIER_ALLOW_IMAGES": "1",
            "LLM_VERIFIER_IMAGE_ROOTS": outside,
        }, clear=False):
            with self.assertRaises(ValueError) as ctx:
                vbb._sanitize_images({"images": [img]}, "select")
        self.assertIn("白名单", str(ctx.exception))

    def test_allowed_but_too_large_raises(self) -> None:
        img = self._tmpfile(size=4096)
        with patch.dict(os.environ, {
            "LLM_VERIFIER_ALLOW_IMAGES": "1",
            "LLM_VERIFIER_IMAGE_MAX_MB": "0.001",  # ~1KB 上限
        }, clear=False):
            with self.assertRaises(ValueError) as ctx:
                vbb._sanitize_images({"images": [img]}, "track")
        self.assertIn("过大", str(ctx.exception))

    def test_missing_file_raises(self) -> None:
        with patch.dict(os.environ, {"LLM_VERIFIER_ALLOW_IMAGES": "1"}, clear=False):
            with self.assertRaises(ValueError) as ctx:
                vbb._sanitize_images({"images": ["C:/definitely/not/here.png"]}, "select")
        self.assertIn("不存在", str(ctx.exception))


class ProgressUpdateParamsTest(unittest.TestCase):
    """R2-1（2026-08-28 二次审计）：progress_update 的已消费参数不得触发 D4 告警。

    N5（2026-08-29 第二轮，原版 PROA）：旧『模拟构造』用例
    （test_consumed_params_do_not_warn——测试体内自己 pop）已删除——那是假测试：
    把 handler 里的 pop 删掉它照样绿。真正的护栏是
    ProgressUpdateHandlerIntegrationTest（驱动真实 _handle_progress_update）。
    此处只保留 _filter_kwargs 自身契约的测试（与 handler pop 无关）。
    """

    def test_unconsumed_params_still_warn(self) -> None:
        # 反向对照：未 pop 的原样 params 必须告警（_filter_kwargs 契约本身）。
        buf = io.StringIO()
        with redirect_stderr(buf):
            vbb._filter_kwargs(dict(tracker_id="t1", step="s1"), {"images"})
        self.assertIn("tracker_id", buf.getvalue())
        self.assertIn("step", buf.getvalue())


class SanitizeImagesSymlinkTest(unittest.TestCase):
    """R2-2（2026-08-28 二次审计）：白名单根内的 symlink 指向根外必须被拒。"""

    def test_symlink_outside_roots_rejected(self) -> None:
        outside_dir = tempfile.mkdtemp(prefix="vbb-symlink-out-")
        self.addCleanup(lambda: __import__("shutil").rmtree(outside_dir, ignore_errors=True))
        target = os.path.join(outside_dir, "secret.png")
        with open(target, "wb") as f:
            f.write(b"x" * 16)
        root = tempfile.mkdtemp(prefix="vbb-symlink-root-")
        self.addCleanup(lambda: __import__("shutil").rmtree(root, ignore_errors=True))
        link = os.path.join(root, "evil.png")
        try:
            os.symlink(target, link)
        except OSError:
            self.skipTest("symlink 不可用（Windows 无开发者模式/无权限）")
        with patch.dict(os.environ, {
            "LLM_VERIFIER_ALLOW_IMAGES": "1",
            "LLM_VERIFIER_IMAGE_ROOTS": root,
        }, clear=False):
            with self.assertRaises(ValueError) as ctx:
                vbb._sanitize_images({"images": [link]}, "select")
        self.assertIn("白名单", str(ctx.exception))


class ProgressUpdateHandlerIntegrationTest(unittest.TestCase):
    """F7（2026-08-29 公平审计）：真集成——驱动真实 `_handle_progress_update`。

    旧版『模拟构造』测试在测试体内自己 pop，把 handler 里的 pop 删掉它照样绿
    （假测试，被原版审计员人眼看穿）。本测试用桩 tracker 走完整 handler 路径，
    对修复代码**变异敏感**：删掉 pop → kwargs 带 tracker_id/step → 本测试红。
    """

    def test_handler_drives_real_pop_and_filter(self) -> None:
        class FakeTracker:
            def __init__(self) -> None:
                self.seen = None

            def update(self, step, **kwargs):
                self.seen = (step, kwargs)
                return 0.5

        fake = FakeTracker()
        vbb._TRACKERS["t-fidelity"] = fake
        vbb._TRACKER_LOCKS["t-fidelity"] = threading.Lock()
        self.addCleanup(vbb._TRACKERS.pop, "t-fidelity", None)
        self.addCleanup(vbb._TRACKER_LOCKS.pop, "t-fidelity", None)
        buf = io.StringIO()
        with redirect_stderr(buf):
            out = vbb._handle_progress_update({"tracker_id": "t-fidelity", "step": "s1", "images": None})
        self.assertEqual(out["score"], 0.5)
        self.assertIsNotNone(fake.seen)
        step, kwargs = fake.seen
        self.assertEqual(step, "s1")
        self.assertNotIn("tracker_id", kwargs)
        self.assertNotIn("step", kwargs)
        self.assertNotIn("dropped", buf.getvalue())


class VersionTupleTest(unittest.TestCase):
    def test_parses(self) -> None:
        self.assertEqual(vbb._version_tuple("0.2.0"), (0, 2, 0))
        self.assertEqual(vbb._version_tuple("0.2.0rc1"), (0, 2, 0))
        self.assertEqual(vbb._version_tuple("1.0"), (1, 0, 0))
        self.assertIsNone(vbb._version_tuple("not-a-version"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
