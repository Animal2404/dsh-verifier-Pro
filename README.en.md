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
  ↓ verifier tool (one tool × 12 actions: select/compare/track/decompose/evaluate_session/progress_*/task_*/usage/config)
dsh-verifier-Pro (Node/TS host plugin)
  ↓ JSON Lines over stdio (id-correlated, concurrent)
bridge/verifier_brain_bridge.py (ThreadPool × N)
  ↓
llm-verifier 0.2.0 (official PyPI package)
  ↓ logprobs backend (OpenAI-compatible / DeepSeek / Vertex / Gemini)
```

One tool, twelve actions: `select` / `compare` / `track` / `decompose` / `evaluate_session` /
`progress_start` / `progress_update` / `progress_close` / `task_start` / `task_status` /
`usage` / `config`. Just tell your agent "run a verifier compare".

## Install

Requires Node 18+ (`engines: >=18`), Python 3.10+, and a scoring-backend credential whose
model returns logprobs.

### One-click (recommended)

```sh
git clone https://github.com/Animal2404/dsh-verifier-Pro.git
cd dsh-verifier-Pro
node scripts/setup.mjs --check    # diagnose: what's missing + recommended backend config for YOUR credentials
node scripts/setup.mjs --fix      # fully automatic: .venv → llm-verifier → dual-write config →
                                  #         build lib/ → mount into profile (default: web)
```

`--fix` runs all six steps: ① create `.venv` → ② pip install llm-verifier → ③ re-verify →
④ dual-write the credential-matched `verifierModel` / `backendBaseUrl` into BOTH the repo patch
and the profile patch (the layer that actually takes effect — see "Configuration details") →
⑤ `npm run build` → ⑥ auto-mount via `dsh plugin --profile web add <dir>` when the dsh CLI is on
PATH. Then **restart dsh**; if the web UI was already open, **reload the browser tab once** to
pick up the panel bundle.

| Flag | Purpose |
|---|---|
| `--profile <name>` | Mount target profile (default `web`) |
| `--no-mount` | Stop after build; skip auto-mount |
| `--check --strict` | exit 1 when items are missing (CI-friendly; plain `--check` always exits 0) |
| `--bench` | Discriminative self-check — quality regression gate after changing the scoring model |

### Manual install (what --fix automates)

```sh
# 1) Python side: official llm-verifier into the project venv
python -m venv .venv
.venv/Scripts/python -m pip install llm-verifier     # Windows
# .venv/bin/python -m pip install llm-verifier        # macOS/Linux

# 2) Build (pure Node entry — no bash required on Windows; build.sh kept for bash users)
npm run build

# 3) Mount into your profile (restart dsh to take effect)
dsh plugin --profile web add <this package directory>
```

> **Dev assembly note**: this repo's dev install relies on the DSH host injector's junction
> mechanism — peer packages under `node_modules` are links into the host's global install.
> **`npm ci`/`npm install` is NOT a supported assembly method** (`package-lock.json` is not
> committed). Local development mounts via `dev_install_package` / the supermod injector.

### Scoring backend configuration (important!)

The default `verifierModel` / `backendBaseUrl` bundled in `cordis.patch.yml` reflect the
**author's environment** — adjust these two lines to match your own credentials:

| Credentials you hold | verifierModel | backendBaseUrl | Tested |
|---|---|---|---|
| `DEEPSEEK_API_KEY` (DeepSeek official) | `deepseek-chat` | `https://api.deepseek.com` | ✅ recommended (logprob distribution not verified in-repo — run probe first) |
| `OPENCODE_GO_API_KEY` (opencode) | `deepseek-v4-flash-vision-exp` | `https://opencode.ai/zen/go/v1` | ✅ verified (default) |
| `OPENROUTER_API_KEY` | `deepseek/deepseek-chat` | `https://openrouter.ai/api/v1` | unverified |

> ✅ **Default: `deepseek-v4-flash-vision-exp`** (logprobs path, cheap, verified).
> Also verified on opencode: `qwen3.7-plus`, `qwen3.6-plus` (logprobs path); via the literal-mc
> sampling path: `minimax-m3`, `minimax-m2.7`, `mimo-v2.5-pro`, `muse-spark-1.2-contributor`,
> `deepseek-v4-flash` (bridge routes them automatically).
> Profile self-healing (fail-closed): a literal-mc model emitting no score tags for 3 consecutive
> replies is marked DEGRADED — scoring refused instead of silently mis-scored; a passing probe
> recheck restores it.

Your chosen model must return **logprobs** — that's the foundation of fine-grained rewards.
Verify with (Windows; macOS/Linux use `.venv/bin/python`):

```sh
.venv/Scripts/python scripts/probe_logprobs.py <base_url> <api_key> <model>
.venv/Scripts/python scripts/scan_logprob_models.py <your-key>
```

## Usage

Talk to your agent; the injected system-prompt policy drives invocation:

> Here are three candidate implementations — use the verifier to pick the best, then merge their strengths

> This task has been running long — tell me how close we are

Smoke test (30 seconds): after install + restart, say *"use the verifier to compare X and Y"* —
a verifier compare card with scores/badges means it works.

### Best-of-N = merge, not just rank

1. **Rank**: verifier select (large pools) or compare (2-3 candidates — cheaper, more discriminating);
2. **Merge**: hand ALL survivors + scores to an integrator agent;
3. **Gate**: verifier compare(merged, champion) — adopt merged only if it scores no lower.

### /bestofn one-click command (dual-track since v0.7.0)

```
/bestofn <goal> [N]                        # BUILD track: N lens-diverse members → plan gate → evidence chain → select → revision loop → merge → gate
/bestofn --local <c1> <c2> ... [--summary name=text]   # local mode on existing artifacts
/bestofn <audit goal description>          # AUDIT track: auto-selected for report deliverables
```

BUILD/AUDIT track details, stable candidate tags (sha256[:12]) and budget gates: see the
Chinese README section «/bestofn 一键命令» — the protocol is identical.

### /vselftest one-click self-test (v0.7.0+)

Zero-argument AUDIT-track team audit of the plugin itself:

```
/vselftest                # default focus
/vselftest <focus note>   # custom focus
```

## Configuration

```yaml
- insert:
    - id: verifier-brain
      name: '@dsh-external/dsh-verifier-pro'
      config:
        bridgeTimeoutMs: 300000
        taskTimeoutMs: 1800000
        verifierModel: deepseek-v4-flash-vision-exp
        backendBaseUrl: https://opencode.ai/zen/go/v1   # change to match YOUR credentials
        maxWorkers: 4
        promptSection: true
        autoEscalate: true
        escalateThreshold: 0.15
        maxEscalateK: 3
```

| Key | Default | Notes |
|---|---|---|
| `pythonBin` | auto-detect `.venv` | Python executable |
| `bridgeTimeoutMs` | `300000` | SYNC tool-call bridge timeout |
| `taskTimeoutMs` | `1800000` | ASYNC task budget (long tournaments) |
| `verifierModel` | — | Default scoring model |
| `backendBaseUrl` / `backendApiKey` | credential auto-detect | Explicit OpenAI-compatible backend |
| `maxWorkers` | `4` | Bridge request concurrency AND the default inner fan-out `max_workers` (since v0.7.4); explicit args cap at 16 |
| `stateDir` | `~/.dsh/verifier-brain` | Persistence dir (history/tasks JSONL — contains submitted candidate text) |
| `promptSection` | `true` | Inject usage policy into system prompt |
| `autoEscalate` / `escalateThreshold` / `maxEscalateK` | true / 0.15 / 3 | Adaptive verification scaling |
| `escalationModel` | unset | Tiered scoring: stronger model for escalation reps only |
| `maxCostPerVerification` | `0` (unlimited) | Per-verification USD budget — enforced on every scoring path |
| `costPer1kInputTokens` / `costPer1kOutputTokens` | `0` | Rates feeding the budget guard (real token usage preferred, duration heuristic as fallback) |

### Configuration details (which file actually wins?)

There can be THREE `cordis.patch.yml` files — know which one you are editing:

1. **Profile patch** `~/.dsh/profiles/<profile>/cordis.patch.yml` — THE effective layer;
   overrides everything below. Edit the `verifier-brain` entry here. Restart dsh to apply.
2. The copy shipped inside the installed package (bundle patch).
3. The copy in your clone (what `setup.mjs --fix` writes).

`--fix` writes both ① and ③ when they exist. Ask the agent for `verifier config` to echo the
effective settings read-only.

**Credential → backend resolution**: plugin-config `backendBaseUrl`/`backendApiKey` always win;
otherwise known keys are read from `~/.dsh/.credentials.yaml` (flat `KEY: value`, nested `refs:`,
or `provider:` + `api_key:` sections) then plain env vars. Binding: opencode baseUrl ↔
`OPENCODE_GO_API_KEY`; api.deepseek.com ↔ `DEEPSEEK_API_KEY`; openrouter ↔ `OPENROUTER_API_KEY`;
anything else needs an explicit `backendApiKey`.

## Version pinning & upgrade

Avoid floating on `main` — pin:

```sh
dsh plugin --profile web add github:Animal2404/dsh-verifier-Pro#a1b2c3d     # commit
dsh plugin --profile web add github:Animal2404/dsh-verifier-Pro@<latest published tag>   # tag — see Releases page
```

**To upgrade**: re-run the add command pointing at the newest published tag (clone installs:
`git pull && node scripts/setup.mjs --fix`), then restart dsh. Release notes:
[Releases](https://github.com/Animal2404/dsh-verifier-Pro/releases).

## Uninstall & leftovers

| Leftover | Location | Cleanup |
|---|---|---|
| Patch entry | `- id: verifier-brain` block in the profile's `cordis.patch.yml` | delete the block |
| Installed copy | plugin dir inside the profile package dir | remove dir |
| **Score history (contains submitted candidate text — sensitive)** | `~/.dsh/verifier-brain/history.jsonl`, `tasks.jsonl` | delete the whole `~/.dsh/verifier-brain/` dir |
| Python venv | `.venv/` inside your clone | delete |
| Patch backups | `cordis.patch.yml.bak.*` (last 3 kept) | delete manually |

## Troubleshooting FAQ (by layer)

### Layer 1: LLM backend (most common)

| Symptom | Cause | Fix |
|---|---|---|
| `DFLASH speculative decoding does not support return_logprob` (400) | using `deepseek-v4-flash` | use `deepseek-v4-flash-vision-exp` or qwen3.7/3.6-plus |
| `Range of top_logprobs should be [0, 5]` (400) | qwen models cap top_logprobs at 5 | handled automatically by the bridge |
| `Invalid API key` (401) | missing/wrong backend credential | check `~/.dsh/.credentials.yaml`; `setup.mjs --check` diagnoses |
| `no answer logprobs` | model returns no token-level logprobs | literal-mc fallback engages automatically; otherwise switch models |
| All scores exactly 0.5 (degraded) | batch scoring failure masked as ties | switch backend/model and retry |

### Layer 2: Python bridge

| Error | Cause | Fix |
|---|---|---|
| `llm-verifier is not installed` | venv missing the package | `.venv/Scripts/python -m pip install "llm-verifier>=0.2.0,<0.3.0"` |
| `python bridge timed out` | cold start or slow model | retry; verify the model (layer 1) |
| `Connection error` | bridge process crashed | auto-restarts; otherwise restart dsh |

### Layer 3: DSH host / config

| Symptom | Cause | Fix |
|---|---|---|
| Tool not registered | plugin not mounted | check the `cordis.patch.yml` insert entry; restart dsh |
| Config changes ignored | config is read at load time | **restart dsh** |
| `Cannot find module` | broken dependency links | re-run `npm run build` |

## Naming

Repo `Animal2404/dsh-verifier-Pro` ↔ package `@dsh-external/dsh-verifier-pro` ↔ internal name
`dsh-verifier-brain` / `verifier_brain_bridge.py`: historical; they all refer to the same plugin.
`package.json`'s name is authoritative.

## Criteria presets & quality gate

Depth presets `deep_review` / `root_cause` expand on every scoring path; hot-loadable
`criteria/*.md` templates override them (see Chinese README or `criteria/TEMPLATE.md`).
After switching scoring models run the discriminative gate: `node scripts/setup.mjs --bench`.

### criteria security boundary (v0.7.5, 2026-08-29 N1)

String `criteria` values are whitelisted to `[A-Za-z0-9_-]+` (no path characters) —
the official backend may otherwise treat a string as a local file path and read
arbitrary files into the scoring prompt (`llm_verifier/prompts.py:_read_criteria`).
Free-form strings fail loudly; use a preset name or a description object (object
values pass the same transport sanitizer as candidates).

## Multimodal images: security boundary (v0.7.5+)

`images` paths are agent-controlled local files — by default they are stripped
(text-only backends). With `LLM_VERIFIER_ALLOW_IMAGES=1` every path must be inside
the whitelist roots (`LLM_VERIFIER_IMAGE_ROOTS`; default: process cwd + system temp
dir + `DSH_HOME` + `~/.dsh`) and ≤ `LLM_VERIFIER_IMAGE_MAX_MB` (default 8; `0` =
reject every file). Both the TS tool layer and the Python bridge validate; symlinks
are resolved (`realpath`) before the prefix check, and violations fail loudly. See
SECURITY.md for the full disclosure.

## Tooling / audit scripts

`scripts/audit_checks.mjs` — mechanized Playbook self-check (static assertions;
`--full` adds the npm test baseline; required before every release, RELEASING step 2).
`scripts/mutation_check.mjs` — regression-test fidelity / mutation verification
(a test that stays green while its fix is mutated away is a fake test; mutation
scenarios need the repo-form `tests/`).

## Reference projects

- [llm-as-a-verifier/llm-as-a-verifier](https://github.com/llm-as-a-verifier/llm-as-a-verifier) — the official framework, consumed via PyPI `llm-verifier`
- [NanmiCoder/dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams) — the multi-agent torso
- [uson1x/dsh-plugin-llm-verifier](https://github.com/uson1x/dsh-plugin-llm-verifier) — product-shape reference
- [lanbaolu/dsh-llm-verifier](https://github.com/lanbaolu/dsh-llm-verifier) — same-route pioneer (stdio bridge)

## Differences vs reference implementations

Bridge concurrency (async tasks no longer serialize), durable state (survives restarts),
first-class Windows (pure Node build), bridge crash auto-restart, team integration protocol,
adaptive verification scaling, evidence-chain automation, hard cost guards fed by real token
usage, and the /bestofn one-command loop.

## License

BSD-3-Clause
