# -*- coding: utf-8 -*-
"""test_fix.py — tests for bridge_fix.py

Offline (default, no network): extraction fallback, router dispatch,
profile logic. Live (--live): one compare() per target model through the
patched path against the real opencode endpoint — asserts the rewards
discriminate a GOOD vs BAD pair (reward_a > reward_b) and no exception.

Usage:
    .venv/Scripts/python E:\\tmp\\fix-e2\\test_fix.py            # offline
    .venv/Scripts/python E:\\tmp\\fix-e2\\test_fix.py --live     # + live scoring
"""
import json
import os
import re
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
# bridge_fix.py lives in the repo's bridge/ directory.
sys.path.insert(0, os.path.join(HERE, "..", "bridge"))

import bridge_fix  # noqa: E402

PASS = 0
FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name} {detail}")


def load_key():
    if os.environ.get("OPENCODE_GO_API_KEY"):
        return os.environ["OPENCODE_GO_API_KEY"]
    p = os.path.join(os.path.expanduser("~"), ".dsh", ".credentials.yaml")
    m = re.search(r"OPENCODE_GO_API_KEY:\s*['\"]?([^\s#'\"]+)", open(p, encoding="utf-8").read())
    return m.group(1) if m else None


# ---------------------------------------------------------------------------
# offline: profile logic
# ---------------------------------------------------------------------------
def test_profiles():
    print("[profile logic]")
    for model in ["mimo-v2.5-pro", "minimax-m3", "minimax-m2.7",
                  "muse-spark-1.2-contributor", "deepseek-v4-flash"]:
        check(f"profile_for({model})", bridge_fix.profile_for(model) is not None)
        check(f"score_mode_for({model}) == literal-mc",
              bridge_fix.score_mode_for(model) == "literal-mc")
        check(f"logprobs_supported({model}) is False",
              bridge_fix.logprobs_supported(model) is False)
    check("score_mode_for(deepseek-v4-pro) == logprobs",
          bridge_fix.score_mode_for("deepseek-v4-pro") == "logprobs")
    check("score_mode_for(qwen3.7-plus) == logprobs",
          bridge_fix.score_mode_for("qwen3.7-plus") == "logprobs")
    check("effective_n_evaluations(literal-mc, None) == 5",
          bridge_fix.effective_n_evaluations("minimax-m3", None) == 5)
    check("effective_n_evaluations(literal-mc, 1) == 5 (MC needs K>1)",
          bridge_fix.effective_n_evaluations("minimax-m3", 1) == 5)
    check("effective_n_evaluations(literal-mc, 8) == 8 (explicit wins)",
          bridge_fix.effective_n_evaluations("minimax-m3", 8) == 8)
    check("effective_n_evaluations(logprobs, None) == 1",
          bridge_fix.effective_n_evaluations("deepseek-v4-pro", None) == 1)


def test_reason_first():
    print("[P2-③ reason-first prompt]")
    import os
    prompt = "Score these candidates."
    # default ON
    os.environ.pop("VERIFIER_BRAIN_REASON_FIRST", None)
    out = bridge_fix._maybe_reason_first(prompt)
    check("default appends reasoning instruction",
          "reason step by step" in out and out.startswith(prompt))
    # idempotent
    out2 = bridge_fix._maybe_reason_first(out)
    check("idempotent (no double append)",
          out2.count("reason step by step") == 1)
    # env OFF
    os.environ["VERIFIER_BRAIN_REASON_FIRST"] = "0"
    check("env=0 disables",
          bridge_fix._maybe_reason_first(prompt) == prompt)
    os.environ.pop("VERIFIER_BRAIN_REASON_FIRST", None)


# ---------------------------------------------------------------------------
# offline: literal-tag extraction through the OFFICIAL extract_score
# ---------------------------------------------------------------------------
def test_extraction():
    print("[literal-tag extraction via official extract_score]")
    from llm_verifier import fine_grained_reward as fgr
    # Real outputs observed in probe2/5 (tail of the model replies).
    cases = [
        # (text, model label, expected_ra, expected_rb)
        ("...analysis...\n<score_A> A </score_A>\n<score_B> S </score_B>", "mimo", 1.0, 0.0526),
        ("...\n<score_A> A </score_A>\n<score_B> T </score_B>", "minimax-m3", 1.0, 0.0),
        ("...\n<score_A> A </score_A>\n<score_B> M </score_B>", "minimax-m2.7", 1.0, 0.3684),
        ("...\n<score_A> B </score_A>\n<score_B> T </score_B>", "minimax-m3 v2", 0.9474, 0.0),
        ("<score_A> A </score_A>\n<score_B> T </score_B>", "flash", 1.0, 0.0),
    ]
    for text, label, ra_exp, rb_exp in cases:
        ra = fgr.extract_score(text, None, None, "<score_A>")
        rb = fgr.extract_score(text, None, None, "<score_B>")
        check(f"extract {label} ra", abs(ra - ra_exp) < 1e-3, f"got {ra}")
        check(f"extract {label} rb", abs(rb - rb_exp) < 1e-3, f"got {rb}")
    # discrete scale: letter -> phi mapping sanity
    check("A -> 1.0", abs(fgr.extract_score("<score_A> A </score_A>", None, None, "<score_A>") - 1.0) < 1e-9)
    check("T -> 0.0", abs(fgr.extract_score("<score_A> T </score_A>", None, None, "<score_A>") - 0.0) < 1e-9)


# ---------------------------------------------------------------------------
# offline: router dispatch with a fake client
# ---------------------------------------------------------------------------
class _FakeResp:
    def __init__(self, text, usage):
        self.choices = [type("C", (), {"message": type("M", (), {"content": text})(), "logprobs": None})()]
        self.usage = type("U", (), {"prompt_tokens": 8, "completion_tokens": 8,
                                    "prompt_tokens_details": None,
                                    "completion_tokens_details": None})()


class _FakeClient:
    """Records every request body; returns canned text with score tags."""
    def __init__(self, text):
        self.calls = []
        self._text = text
        self._llm_verifier_deepseek = True  # mimic the bridge's client tag

    class _Chat:
        def __init__(self, owner):
            self._owner = owner

        class _Completions:
            def __init__(self, owner):
                self._owner = owner

            def create(self, **body):
                self._owner.calls.append(body)
                return _FakeResp(self._owner._text, None)

        @property
        def completions(self):
            return self._Completions(self._owner)

    @property
    def chat(self):
        return self._Chat(self)


def test_router_dispatch():
    print("[router dispatch (fake client)]")
    from llm_verifier import fine_grained_reward as fgr
    bridge_fix.install()
    assert getattr(fgr, "_dsh_literal_router", False), "router not installed"

    # 1) no-logprobs model -> logprobs-free path: body has NO logprobs key,
    #    returns (text, None, None).
    fake = _FakeClient("analysis\n<score_A> A </score_A>\n<score_B> T </score_B>")
    text, tokens, lps = fgr.call_verifier(fake, "some prompt", model="minimax-m3")
    check("minimax-m3 routed to literal path", tokens is None and lps is None)
    body = fake.calls[-1]
    check("no `logprobs` key in body", "logprobs" not in body, str(body.keys()))
    check("no `top_logprobs` key in body", "top_logprobs" not in body)
    check("max_tokens from profile (4096)", body.get("max_tokens") == 4096)
    check("thinking disabled extra_body",
          body.get("extra_body") == {"thinking": {"type": "disabled"}})
    check("text carries tags", "<score_A> A </score_A>" in text)

    # 2) flash: same, and profile max_tokens applies.
    fake2 = _FakeClient("<score_A> A </score_A>\n<score_B> T </score_B>")
    fgr.call_verifier(fake2, "p", model="deepseek-v4-flash")
    body2 = fake2.calls[-1]
    check("flash body has no logprobs key", "logprobs" not in body2)

    # 3) logprobs-capable model -> official path (previous) is called.
    #    previous = official call_verifier; with our fake tagged client it
    #    routes to call_deepseek which needs logprobs -> it should raise;
    #    that proves we DID NOT intercept it (official path attempted).
    fake3 = _FakeClient("hi")
    try:
        fgr.call_verifier(fake3, "p", model="deepseek-v4-pro")
        check("logprobs model went official path (raise expected)", False,
              "call unexpectedly succeeded")
    except Exception:
        check("logprobs model went official path (raised, not intercepted)", True)

    # 4) extract_score on the literal path output of the fake call
    ra = fgr.extract_score(text, tokens, lps, "<score_A>")
    rb = fgr.extract_score(text, tokens, lps, "<score_B>")
    check("fake end-to-end ra=1.0", abs(ra - 1.0) < 1e-9, f"got {ra}")
    check("fake end-to-end rb=0.0", abs(rb - 0.0) < 1e-9, f"got {rb}")


# ---------------------------------------------------------------------------
# live: real scoring through the patched path
# ---------------------------------------------------------------------------
def live_test():
    print("\n[LIVE: compare() through patched path, n_evaluations=3]")
    key = load_key()
    if not key:
        print("  SKIP: no OPENCODE_GO_API_KEY found")
        return
    os.environ.setdefault("OPENAI_BASE_URL", "https://opencode.ai/zen/go/v1")
    os.environ.setdefault("OPENAI_API_KEY", key)
    os.environ.setdefault("DEEPSEEK_EFFORT", "off")
    import llm_verifier

    GOOD = ("I verified the fix by writing a regression test and running the full "
            "suite: all 42 tests pass, including the new one. The root cause was a "
            "missing null check; I added it and confirmed the edge case now works.")
    BAD = "i tried some stuff and it maybe works? not sure, probably fine idk."
    criteria = {"Correctness": "Does the answer correctly solve the problem, with no factual or logical errors?"}

    for model in ["mimo-v2.5-pro", "minimax-m3", "minimax-m2.7",
                  "muse-spark-1.2-contributor", "deepseek-v4-flash"]:
        t0 = time.time()
        try:
            ra, rb = llm_verifier.compare(
                "Fix the bug in the parser", GOOD, BAD,
                criteria=criteria, model=model, n_evaluations=3)
            dt = round(time.time() - t0, 1)
            ok = ra > rb
            check(f"{model}: ra={ra:.4f} rb={rb:.4f} discriminates ({dt}s)",
                  ok, f"ra={ra} rb={rb}")
        except Exception as e:
            check(f"{model}: no exception", False, f"{type(e).__name__}: {str(e)[:200]}")
    usage = llm_verifier.token_usage()
    print(f"  usage: {json.dumps(usage)}")


def main():
    print("=== bridge_fix offline tests ===")
    test_profiles()
    test_extraction()
    test_router_dispatch()
    test_reason_first()
    print(f"\noffline: {PASS} passed, {FAIL} failed")
    if "--live" in sys.argv:
        live_test()
        print(f"\nTOTAL: {PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
