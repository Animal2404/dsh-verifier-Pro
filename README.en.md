# dsh-verifier-Pro

<div align="center">

[简体中文](./README.md) | **English**

</div>

A [LLM-as-a-Verifier](https://github.com/llm-as-a-verifier/llm-as-a-verifier) brain plugin for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — built for
[dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams) multi-agent teams in particular.

> 🧠 **Brain: LLM-as-a-Verifier · Torso: dsh-agent-teams.**
> This plugin wraps the official framework's fine-grained verification (expected reward over
> the score-token logprob distribution — not the single-point scoring of a plain LLM-as-a-Judge)
> into DSH agent tools, and injects a system-prompt policy that turns it into the built-in
> review organ of a multi-agent team.

```
DSH Agent
  ↓ verifier tool (one tool × 8 actions: select/compare/track/progress_*/task_*/…)
dsh-verifier-Pro (Node/TS host plugin)
  ↓ JSON Lines over stdio (id-correlated, concurrent)
bridge/verifier_brain_bridge.py (ThreadPool × N)
  ↓
llm-verifier 0.2.0 (official PyPI package)
  ↓ logprobs backend (OpenAI-compatible / DeepSeek / Vertex / Gemini)
```

## Three core scenarios

| Scenario | Usage | Notes |
|---|---|---|
| Test-time scaling | `verifier` action=`select` | N candidates → PPT tournament O(Nk) selection |
| Progress tracking | `verifier` action=`progress_*` | Live per-step scoring; sustained <0.05 = likely wrong direction |
| Quality gate / RL | `verifier` action=`compare` / `track` | Pairwise review, trajectory replay, reward data export |

One tool, eight actions: `select` / `compare` / `track` / `progress_start` / `progress_update` / `progress_close` / `task_start` / `task_status`. Just tell your agent "run a verifier compare".

## Install

Requires Node 18+, Python 3.10+, and backend credentials whose model returns logprobs.

### One-click (recommended)

```sh
git clone https://github.com/Animal2404/dsh-verifier-Pro.git
cd dsh-verifier-Pro
node scripts/setup.mjs --check    # diagnose: what's missing + recommended scoring-backend config for YOUR credentials
node scripts/setup.mjs --fix      # auto-repair: create .venv + install llm-verifier
```

`--check` reads `~/.dsh/.credentials.yaml`, picks a scoring-backend config matching credentials
you already hold, and points out exactly where the author's hardcoded defaults differ from your
environment — fixing the two config lines is all it takes.

### Scoring backend configuration (important!)

The default `verifierModel` / `backendBaseUrl` in `cordis.patch.yml` reflect the **author's
environment** — adjust these two lines to match your own credentials:

| Credentials you hold | verifierModel | backendBaseUrl | Tested |
|---|---|---|---|
| `DEEPSEEK_API_KEY` (DeepSeek official) | `deepseek-chat` | `https://api.deepseek.com` | ✅ recommended |
| `OPENCODE_GO_API_KEY` (opencode) | `deepseek-v4-flash-vision-exp` | `https://opencode.ai/zen/go/v1` | ✅ verified (default) |
| `OPENROUTER_API_KEY` | `deepseek/deepseek-chat` | `https://openrouter.ai/api/v1` | unverified |

> ✅ **Default: `deepseek-v4-flash-vision-exp`** (logprobs path, cheap, verified).
> Also verified on the opencode endpoint: `qwen3.7-plus`, `qwen3.6-plus` (logprobs path),
> and via the literal-mc sampling path: `minimax-m3`, `minimax-m2.7`, `mimo-v2.5-pro`,
> `muse-spark-1.2-contributor`, `deepseek-v4-flash` (no logprobs needed — bridge routes them
> through literal score-tag sampling).
> `deepseek-v4-pro` remains available but is **lowest priority** (expensive; use only when
> the cheaper verified models are unavailable or for escalation-tier scoring).
> ⚠️ `deepseek-v4-flash` (without vision-exp) rejects logprobs requests (DFLASH 400) — it
> works only via the literal-mc path above; plain `hy3` is unsupported entirely.

Your chosen model must return **logprobs** — that's the foundation of fine-grained rewards.
Verify with `node scripts/probe_logprobs.py <model>`, or batch-scan candidates via
`python scripts/scan_logprob_models.py <your-key>`.

## Usage

Talk to your agent; the injected system-prompt policy drives invocation:

> Here are three candidate implementations — use the verifier to pick the best, then merge their strengths
> (agent → verifier select ranking → integrator merge → verifier compare gate)

> Run a team Best-of-N with AgentTeams: three members each write one, verifier selects, merge
> (captain fan-out → verifier select → integrator pass → final compare gate)

> This task has been running long — tell me how close we are
> (agent → verifier progress_start/update; sustained low scores suggest a strategy change)

### Best-of-N = merge, not just rank

1. **Rank**: verifier select (large pools) or compare (2-3 candidates — cheaper, more discriminating);
2. **Merge**: hand ALL survivors + scores to an integrator agent; taking only the champion is "ranking", not Best-of-N;
3. **Gate**: verifier compare(merged, champion) — adopt merged only if it scores no lower than the champion.

The verifier stays a pure reward function; writing is done by agents — a deliberate boundary.

### /bestofn one-click command (dual-track since v0.7.0)

```
/bestofn <goal> [N]                        # BUILD track: spawn N lens-diverse members → plan gate → evidence chain → select → revision loop → merge → gate
/bestofn --local <c1> <c2> ... [--summary name=text]   # local mode: evidence chain on existing artifacts → select → report
/bestofn <audit goal description>          # AUDIT track: auto-selected when the deliverable is a report
```

Smart input detection: plain text = goal; existing file paths = local scoring mode.

- **BUILD track**: N lens-diverse members (boldest / most defensive / performance-and-edge-cases — same complete scope, different angle) → **plan gate** (compare plans first, merge losers' strengths) → evidence chain per artifact (crash = out, unknown = out) → `select("deep_review")` → **revision loop** (findings go back verbatim, fixed with evidence, re-scored; cap 2 rounds) → integrate all survivors → compare gate.
- **AUDIT track** (report/analysis deliverables): scope freeze + anti-contamination → parallel audits where EVERY claim cites file:line + quoted snippet → captain mechanically verifies ≥30% of citations plus ALL fatal findings (fabrication invalidates the finding and halves member weight) → mandatory cross-review → `select("root_cause")` → final report labels every finding **VERIFIED / REPORTED**.
- **Stable candidate tags**: select results carry `tags`, compare carries `tag_a/tag_b` (first 8 hex of the candidate text). Positional letters shift between chained evaluations; tags never do.
- Budget gate: state N and maxCostPerVerification before spawning.

### /vselftest one-click self-test (v0.7.0+)

Zero-argument AUDIT-track team audit of the plugin's own bestofn↔smoke boundary (N=2 lens-diverse members, citation verification fully on):

```
/vselftest                # default focus: artifactName hash ↔ smokeOk lookup + parseArgs edges
/vselftest <focus note>   # custom focus
```

This is the "test ourselves with our own doctrine" entry point — its first run caught 4 bugs that three manual audit rounds had missed.

### Depth criteria presets (v0.7.0+)

Generic Correctness/Completeness/Clarity rubrics reward breadth and punish insight — LLM judges favor candidates that list many shallow observations over one that nails the root cause. For "which candidate is BETTER" questions use the built-in presets (expanded automatically on every scoring path):

- `deep_review` — root cause pinned with evidence · failure modes & boundaries · tradeoffs · actionability
- `root_cause` — root cause · evidence · impact

Unknown names (e.g. official `terminal_bench`) pass through unchanged.

## Configuration

```yaml
- insert:
    - id: verifier-brain
      name: '@dsh-external/dsh-verifier-pro'
      config:
        bridgeTimeoutMs: 300000
        taskTimeoutMs: 1800000
        verifierModel: deepseek-v4-flash-vision-exp
        backendBaseUrl: https://opencode.ai/zen/go/v1
        maxWorkers: 4
        promptSection: true
        autoEscalate: true
        escalateThreshold: 0.15
        maxEscalateK: 3
        # optional tiered scoring: stronger model for escalation reps only —
        # v4-pro is the expensive last-resort tier; leave unset to reuse verifierModel
        # escalationModel: deepseek-v4-pro
```

| Key | Default | Notes |
|---|---|---|
| `pythonBin` | auto-detect `.venv` | Python executable |
| `bridgeTimeoutMs` | `300000` | SYNC tool-call bridge timeout |
| `taskTimeoutMs` | `1800000` | ASYNC task budget (long tournaments) |
| `verifierModel` | — | Default scoring model (must return logprobs) |
| `backendBaseUrl` / `backendApiKey` | credential auto-detect | Explicit OpenAI-compatible backend |
| `maxWorkers` | `4` | Concurrent workers in the Python bridge |
| `stateDir` | `~/.dsh/verifier-brain` | Persistence dir (history/tasks/score-cache JSONL) |
| `promptSection` | `true` | Inject usage policy into system prompt |
| `autoEscalate` / `escalateThreshold` / `maxEscalateK` | true / 0.15 / 3 | Adaptive verification scaling |
| `escalationModel` | unset | Tiered scoring: stronger model for escalation reps only |

## Reference projects

- [llm-as-a-verifier/llm-as-a-verifier](https://github.com/llm-as-a-verifier/llm-as-a-verifier) — the official framework (logprob expected reward, PPT tournament), consumed via PyPI `llm-verifier`
- [NanmiCoder/dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams) — the multi-agent torso; integrated via system-prompt policy + service calls, no fork
- [uson1x/dsh-plugin-llm-verifier](https://github.com/uson1x/dsh-plugin-llm-verifier) — product-shape reference (parallel N attempts); not its non-logprob route
- [lanbaolu/dsh-llm-verifier](https://github.com/lanbaolu/dsh-llm-verifier) — same-route pioneer (stdio bridge); independently rewritten with concurrency/persistence/Windows fixes

## Differences vs reference implementations

Bridge concurrency (async tasks no longer serialize), durable state (survives restarts),
first-class Windows, bridge crash auto-restart, team integration protocol (best-of-N merge /
reviewer gates / progress sensors in system prompt), adaptive verification scaling
(noise-band margins auto re-evaluated at K=3 with honest metadata), evidence-chain automation
(smoke + visual description + source labeling; crashed candidates eliminated), and the
/bestofn one-command loop (goal → N members → evidence → select → merge → gate).

## License

BSD-3-Clause
