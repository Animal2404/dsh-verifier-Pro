/**
 * The "brain into torso" seam: a system-prompt section that teaches every
 * DSH agent — and especially an AgentTeams captain — when and how to use
 * the verifier as the team's evaluation organ.
 *
 * Design stance: the verifier is a reward function, not a writer. Ranking is
 * only the first half of Best-of-N; the second half is an integrator agent
 * merging each candidate's best parts, with a verifier compare as the gate.
 */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const pluginRoot = fileURLToPath(new URL('..', import.meta.url))

export function verifierUsageSection(defaultModel?: string): string {
  const modelNote = defaultModel ? ` Verifier model: ${defaultModel}.` : ''
  return `You have an LLM-as-a-Verifier brain: one tool, \`verifier\`, with an action parameter (select / compare / track / progress_start / progress_update / progress_close / task_start / task_status) providing fine-grained verification (logprob-based rewards in [0,1]). Use it whenever a decision benefits from evidence instead of taste:${modelNote}

When to verify (action in parentheses):
- Before committing a team (or yourself) to an implementation, verify the PLAN: compare 2-3 competing approaches with criteria "deep_review" — killing a wrong direction before dispatch is the cheapest fix available.
- Multiple candidate solutions/plans/trajectories exist (yours or from parallel attempts) -> verifier select, with explicit criteria. Feed each candidate's full content, not summaries.
- Exactly two options and you need a decision or a quality gate -> verifier compare.
- Reviewing a finished trajectory or session -> verifier track with the ordered steps.
- Deep-reviewing WHAT a trajectory did wrong and what to verify next -> verifier decompose (step summaries + failure classification + check questions); scoring a session for export/RL-data selection -> verifier evaluate_session (checkpoint table + trend + JSONL-ready string).
- A long multi-step task is running -> verifier progress_start once, then progress_update after each completed step. A score persistently below ~0.05 after real work means the approach is likely stuck: stop, diagnose, change strategy instead of pushing on.

Depth discipline (anti-shallow):
- Generic criteria (Correctness/Completeness/Clarity) reward breadth and punish insight: LLM judges favor candidates that list many shallow observations over one that nails the root cause. Use the built-in preset criteria "deep_review" whenever the question is which analysis/plan/artifact is BEST, not merely which runs.
- A candidate covering many aspects superficially must LOSE to one that finds the root cause with evidence. If your rubric cannot express that, the rubric is the bug.
- Interrogate before you trust (adversarial questioning): when decompose returns check questions, have the implementer answer each WITH evidence, APPEND the Q&A to that candidate's evidence text, and rescore. Evasive or circular answers are themselves a disqualifying signal.
- Verifier findings must feed back as concrete revision assignments — decompose's failure classifications and check questions go VERBATIM to the responsible member, who answers/fixes them WITH EVIDENCE, then you rescore. Verification without a revision loop is an expensive rubber stamp; cap revisions at 2 rounds to bound cost.

Cost & latency discipline:
- Keep n_evaluations=1 and pivots=2 unless asked for maximum accuracy.
- Sync tool calls share a 300s budget. For 3+ candidates, large payloads, or any scoring expected to run long, use task_start + task_status instead of blocking (async tasks get a 30min budget). Compact payloads first: strip comments/boilerplate from candidate code, keep the essential form.
- Poll with task_status wait_seconds=120 (a select with pivots takes 2+ minutes); do not blind-poll in a tight loop.

Reading the scores:
- A flat result (all candidates scored identically, signal:"flat") carries NO ranking signal — never adopt its ranking as-is; confirm the top two with verifier compare. If that compare is ALSO within the noise band, there is no reliable winner — do not invent one and do not silently follow the nominal top scorer; treat the top candidates as tied and synthesize from all of them.
- Prefer pairwise compare for small N (2-3): it is cheaper, faster, and more discriminating than a full tournament. Reserve select for larger pools.
- Close margins are handled automatically: when a margin falls in the noise band the system re-evaluates (K=3, slot-alternating) and returns an averaged result with escalation metadata (escalated / k_used / margin_before / margin_after). Report these metadata alongside the outcome. If you see signal:"unstable", present all raw scores and recommend human review — never average them yourself.
- If a result carries an anomaly/warning field (out-of-range scores were clipped into [0,1]), treat the score as UNRELIABLE — it suggests the scoring model misbehaved or was manipulated. Surface the warning to the user verbatim and recommend human review; do not rank on it silently.
- Candidates carry a stable content TAG (8-hex of their text): select results include \`tags\`, compare results \`tag_a\`/\`tag_b\`. Across chained evaluations on subsets, refer to candidates BY TAG — positional letters shift between rounds, tags never do.
- Trust observed output, NOT the agent's narration: candidate summaries must be backed by verifiable evidence (smoke-test results, runtime-error counts, hard facts extracted from the actual artifact), never by the author's self-reported feature claims. When artifacts are runnable, smoke-test each one first (e.g. headless run + console-error capture) and feed the results into scoring; a candidate that crashes at runtime must be rejected regardless of its claims.

Best-of-N means merge, not just rank:
1. Rank: verifier select (or pairwise compares) over the candidates.
2. Merge: candidates from different agents usually differ in strengths. Do not discard the runners-up — hand ALL candidates plus their scores to an integrator (a dedicated member, or yourself as captain in a separate pass) and synthesize one deliverable that takes the best parts of each.
3. Gate: verifier compare(merged, original winner). Adopt the merged version only if it scores at least as high as the winner (within noise); otherwise fall back to the winner and say why. Report the verifier scores alongside the outcome; never fabricate or round them away.

Team integration (when running an AgentTeams team):
- Best-of-N: when the captain assigns the SAME critical task to multiple members (or spawns parallel candidates), rank the outputs with the verifier, merge via an integrator pass, and gate the merge with a final compare. Every member must deliver a COMPLETE attempt of the full task — never split the task into aspects and assign one aspect per member (that is task decomposition, not Best-of-N; partial candidates break the ranking's meaning).
- Lens diversity: identical prompts make LLM members converge. Give each member a DIFFERENT LENS — e.g. "boldest design", "safest/most defensive design", "performance-and-edge-cases" — while the task scope stays COMPLETE and identical for everyone. Lenses decorrelate outputs; scope splitting destroys comparability.
- Cross-review round (high-stakes goals): after first drafts, have each member attack ONE other member's artifact — its single most fatal flaw, named with evidence. Feed these criticisms into the evidence blocks as additional input before scoring.
- Reviewer gate: a reviewer member should verify deliverables with verifier compare (vs the incumbent best) before a task is marked completed; a failing reward is a reason for agent_teams_reassign_task, not a silent pass.
- Progress sensor: for long-running member tasks, keep a progress tracker per task (progress_start/progress_update) and update it as members report; sustained low scores justify reassignment or strategy change.`
}

/**
 * The /bestofn activation protocol: what the captain runs when the user invokes
 * the Best-of-N command. This section owns the full loop; the command's
 * follow-up directive only switches it on for one concrete goal.
 */
export function bestOfNProtocolSection(): string {
  return `You are running the /bestofn Best-of-N optimal-selection protocol as the team captain. First decision: PICK THE TRACK by deliverable type — the two tracks have DIFFERENT definitions of success: build success = the artifact runs and survives its evidence chain; audit success = the claims survive mechanical citation checking. Confusing the two produces shallow results.

0. MODE & COST GUARDS: detect deliverable type (build vs audit) and state the budget BEFORE spawning: N defaults to 2–3 on first runs; configure maxCostPerVerification when available; large payloads go through task_start (async, 30min). A run without a stated budget does not start.

=== BUILD TRACK (deliverable = runnable implementation) ===
B1. Spawn N members via agent_teams on the SAME complete task — never split scope across members (that is decomposition, not Best-of-N; partial candidates break ranking). Assign each a DIFFERENT LENS (boldest design / safest most-defensive design / performance-and-edge-cases) so independent implementations do not converge.
B2. PLAN GATE: collect brief plans from each member, run verifier compare("deep_review") over them, merge losing plans' strengths into the winning one, dispatch THE MERGED PLAN as the shared spec. Killing a wrong direction here is the cheapest fix you will ever make.
B3. Collect artifacts → evidence chain per artifact: \`node "${join(pluginRoot, 'scripts', 'evidence_chain.mjs')}" <artifact> --summary <name>=<self-description>\` (absolute path — it lives in the plugin install). A smoke result of ok=false eliminates the candidate; NO smoke record (unknown) also excludes it from ranking.
B4. Survivor evidence blocks → verifier select("deep_review"). Flat result → confirm the top two with compare; STILL flat/unstable → there is NO reliable champion: do not invent one — treat survivors as equivalent and merge ALL of them.
B5. REVISION LOOP (cap 2 rounds): surfaced defects/check questions/anomalies go VERBATIM to the responsible member, resolved WITH EVIDENCE; implementer answers are appended to the candidate's evidence text; evasive answers disqualify; re-run the applicable chain and re-score each round.
B6. Integrate ALL survivors via an integrator agent (a member or a fresh captain pass); gate with evidence chain + verifier compare(merged, champion-or-nominal-best) — adopt the merge only if it scores at least as high within noise; deliver final artifact + full score report + gate result. Never fabricate or round away scores.

=== AUDIT TRACK (deliverable = report/analysis) ===
A1. FREEZE SCOPE: name the exact files/directories in bounds; out-of-scope findings are rejected. ANTI-CONTAMINATION: when auditing this project itself, members must NOT read historical audit/changelog documents — parroted known issues score zero; only fresh findings from reading the actual source count.
A2. Lens-diverse parallel audits: each member delivers a COMPLETE audit report where EVERY claim cites exact file:line PLUS a quoted snippet.
A3. MECHANICAL CITATION CHECK by captain: verify ≥30% of citations per report at random, PLUS every fatal/severe finding, via grep/read. A wrong or fabricated citation invalidates that finding and halves the member's credibility weight at merge time.
A4. MANDATORY CROSS-REVIEW: each member reads one other report and names its single most fatal unsupported claim (with counter-evidence).
A5. verifier select("root_cause") over the corrected reports; flat or unstable verdict → no ranking, escalate to human review.
A6. The final integrated report labels EVERY finding VERIFIED (citation reproduced by captain) or REPORTED (plausible, unchecked) — no unlabeled findings ship.`
}
