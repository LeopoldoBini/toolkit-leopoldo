---
name: afk-pipeline
description: Thin playbook for goal-driven AFK pipelines. Designed to run inside a `/goal`-wrapped session — Claude Code's native `/goal` handles the verifier loop (Haiku evaluates condition between turns); this command tells the model WHAT to do in each productive turn. Per turn checks current state (open issues / open PRs) and dispatches the next action: implement wave (via `/parallel-implement-wave` host OR `/sandcastle-dispatch-wave` Docker), merge wave (via `/merge-orchestrate` host OR `/sandcastle-merge-wave` Docker), or — once all issues are merged — a final review wave (via `/review-fleet`, engineering-workflow: reviewers → judge → appliers; fixes land as one more PR through the normal merge wave). Maintains PROGRESS.md + state.json for resumability. Defaults `--implement=docker --merge=host` (Leo's tested combo). Usage `/afk-pipeline --goal=<spec>`. Flags `--implement=host\|docker`, `--merge=host\|docker`.
---

# /afk-pipeline

**Thin playbook** for AFK (away-from-keyboard) goal-driven pipelines. This command is designed to be invoked **inside a `/goal`-wrapped session**:

- `/goal` (native, Claude Code v2.1.139+) handles the **loop**: a Haiku verifier evaluates the goal condition between turns; if unmet, the harness re-invokes the main agent.
- `/afk-pipeline` handles the **playbook**: tells the main agent what to do in each productive turn — check state, dispatch the next wave, maintain progress files, stop on blockers.

This separation matters: this command **does not loop internally**. One invocation = one productive turn. The verifier loop is `/goal`'s job.

## When to use

- You have a defined goal (milestone, label, list of issues) and want the agent to drive it to completion AFK.
- You're inside a `/goal` session (or you're about to start one via `cc-afk` alias — see README).
- The pipeline is **dispatch + merge cycles** until the goal condition holds.

## Arguments

- **`--goal=<spec>`** (required) — the scope:
  - `milestone:<name>` — all issues in a GH milestone
  - `label:<label>` — all issues with a label
  - `parent:#<N>` — all issues with `Part of #N` in their body
  - `#42,#43,#44` — explicit issue list

- **`--implement=host|docker`** (default `docker`) — substrate for implementation waves.
- **`--merge=host|docker`** (default `host`) — substrate for merge waves.

The defaults match Leo's tested combo (Docker implement + host merge). Override per invocation if needed.

## Pre-conditions (all enforced by the slash commands this delegates to)

- `gh` authed (`gh auth status`).
- Git repo with base branch tracking a remote.
- For `--implement=docker` or `--merge=docker`: `sandcastle-max` plugin installed + `.sandcastle/` scaffolded (`/sandcastle-init` ran once).
- Issues use engineering-workflow ≥ 2.1.0 brief format (`## Agent Brief` single-comment invariant).

If any precondition fails, **emit a "BLOCKED — needs human" message in this turn**. The `/goal` verifier will see no progress; you'll need to fix the precondition and re-launch.

---

## Playbook (this is what you, the agent, follow per turn)

### Step 1 — Hydrate / initialize state

Look for `.host-orchestrator/pipelines/<slug>.state.json` and `PROGRESS.md`:

```bash
SLUG=$(echo "$GOAL_SPEC" | tr ':/' '-' | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]//g')
STATE=".host-orchestrator/pipelines/${SLUG}.state.json"
mkdir -p .host-orchestrator/pipelines
```

- If `$STATE` exists: read it. Know which phases completed, what's the next action proposed.
- If `$STATE` does NOT exist: bootstrap.
  - Discover all issues matching `--goal`:
    ```bash
    # examples:
    gh issue list --milestone "Q2-Checkout" --state all --json number,title,state,labels --limit 100
    gh issue list --label "slice/checkout" --state all --json number,title,state,labels --limit 100
    ```
  - Write `$STATE`:
    ```json
    {
      "goal_spec": "$GOAL_SPEC",
      "implement_substrate": "$IMPLEMENT",
      "merge_substrate": "$MERGE",
      "started_at": "<ISO>",
      "issues_total": <N>,
      "issues_closed": <K>,
      "phases_history": [],
      "last_phase": null,
      "last_status": "INITIALIZED"
    }
    ```
  - Write `PROGRESS.md` (human-readable):
    ```markdown
    # AFK Pipeline — Goal: $GOAL_SPEC
    Started: <ISO>
    Implement substrate: $IMPLEMENT
    Merge substrate: $MERGE

    ## Issues in scope (<N>)
    - [ ] #42 — Add payment provider abstraction
    - [ ] #43 — Wire checkout to payment provider
    - ...

    ## Phases history
    (empty — about to start)

    ## Decisions / constraints
    (none yet)
    ```

### Step 2 — Inspect current state of the goal

For each issue in scope:

```bash
gh issue view $N --json number,state,closedAt
gh pr list --search "issue-$N in:title" --state open --json number,state,statusCheckRollup,mergeable,headRefName,labels
```

Bucket each issue into ONE of:

- **DONE** — issue closed AND its PR is merged.
- **MERGE_READY** — PR open, label `afk-agent-pr`, status checks green, no conflicts, no `merge-blocked` label.
- **IN_REVIEW** — PR open but blocked by branch protection, failed checks, or merge-blocked label.
- **IMPLEMENTABLE** — no open PR, label `ready-for-agent` (or `state/ready-for-agent`), `## Blocked by` deps closed, no `agent-blocked` label.
- **BLOCKED_BY_DEP** — has `## Blocked by #X` where X is not closed.
- **HUMAN_GATED** — label `agent-blocked` or `agent-blocked-rebrief` or similar; needs human action.

### Step 3 — Decide next action this turn

Priority cascade (first match wins):

1. **All DONE and `review.status == "done"`** → emit goal-completion message: "Goal `$GOAL_SPEC` reached: $K/$N issues merged + review fleet applied." Update PROGRESS.md final summary. End turn. (The `/goal` verifier will confirm and close.)

1b. **All issues DONE but `review.status` is null** → run the **review wave** (Leo always does this manually after AFK work; now it's part of the pipeline):
   - Invoke `/review-fleet --apply` (engineering-workflow ≥ 2.6.0; the `--apply` flag is what enables the appliers — without it the skill is report-only) with scope = the goal spec (`epic`/`milestone`/issue list), so it reviews exactly what this pipeline merged. It runs reviewers (deep-modules + critical implementation, per module) → judge (rules each finding APLICAR/RECHAZAR/HUMANO) → appliers on the best available model. Do NOT pre-partition the review by this pipeline's waves/issues: review-fleet first analyzes everything merged as one integrated whole and then draws its OWN review units by surface (plus an integration reviewer across seams) — wave boundaries are scheduling artifacts, not review surfaces.
   - If the judge approves nothing → set `review.status = "done"`, note "review clean" in PROGRESS.md. End turn.
   - If fixes were applied → commit them on branch `review/<slug>`, open ONE PR labeled `afk-agent-pr` + `review-fix`, set `review.status = "pr_open"` + `review.pr = <N>`. End turn. (Next turns: the PR rides the normal merge wave; when it merges, set `review.status = "done"`.)
   - Findings ruled HUMANO go to PROGRESS.md under "Decisiones / constraints" — they do NOT block goal completion.

2. **Any MERGE_READY** → run a merge wave on them:
   - If `--merge=host` → invoke `/merge-orchestrate` with the explicit PR list.
   - If `--merge=docker` → invoke `/sandcastle-merge-wave` (Docker).
   - If the review PR (`review.pr`) was among the merged → set `review.status = "done"`.
   - After: re-read state, append phase to `phases_history`, update `PROGRESS.md`. End turn.

3. **Any IMPLEMENTABLE** → run an implementation wave on them (cap by `--max-parallel` of the underlying command):
   - If `--implement=host` → invoke `/parallel-implement-wave --issues=<list>`.
   - If `--implement=docker` → invoke `/sandcastle-dispatch-wave` (Docker).
   - After: re-read state, append phase, update `PROGRESS.md`. End turn.

4. **Only BLOCKED_BY_DEP / HUMAN_GATED remain (nothing else actionable)** → emit a clear BLOCKED message naming each blocker + what human action is needed. End turn.
   - Examples:
     - "#46 needs #43 merged first, but #43 is BLOCKED:BRIEF_AMBIGUOUS (see issue comment) — Leo needs to clarify the brief."
     - "#47 has label `agent-blocked` — Leo's decision required before this can proceed."
   - The `/goal` verifier will see no progress next turn and stop the loop. Leo intervenes.

5. **Some IN_REVIEW (PR open but not mergeable) remain** → describe each + what's blocking (failed checks, branch protection, merge-blocked label). End turn. Human may need to push fixes or override.

### Step 4 — Update `PROGRESS.md` AND `$STATE` before ending this turn

This is non-negotiable. Even if the action this turn was "dispatch wave", you write down:

- Which issues you dispatched / merged / found blocked.
- The phase ID + outcome.
- Updated checkboxes in PROGRESS.md per issue.
- Updated counts (`issues_closed`).

If you skip this step, the next turn (after Haiku says "not done yet") will have to re-discover state from scratch, wasting a turn. PROGRESS.md is also your survival kit if `/compact` fires — write decisions explicitly so they survive compression.

### Step 5 — End the turn cleanly

After completing one action (dispatch / merge / report-blocker / declare-done), STOP. Do not start another phase in the same turn. The `/goal` verifier will check the condition; if unmet, you get another turn.

Why one-action-per-turn:
- Keeps each turn small → less context burn.
- Auto-compact fires between turns at safe boundaries.
- Easier to debug if something goes sideways.
- Verifier sees clear progress per turn.

---

## Recommended `/compact` hint when verifier fires re-invocation

If you (the agent) observe that the next turn is starting and the context feels heavy (typically after 2-3 phases), include a hint in your end-of-turn message:

```
💡 Considerá `/compact preservá el goal "$GOAL_SPEC", el contenido actual de PROGRESS.md, las decisiones de arquitectura del .host-orchestrator/pipelines/$SLUG.state.json. Descartá output verboso de comandos gh ya completados y diffs de PRs ya mergeados.`
```

Leo decides whether to compact manually. You cannot trigger `/compact` yourself; the env var `CLAUDE_CODE_AUTO_COMPACT_WINDOW` set by his `cc-afk` alias takes care of auto-compaction at ~180K tokens regardless.

---

## State file schema (`.host-orchestrator/pipelines/<slug>.state.json`)

```json
{
  "goal_spec": "milestone:Q2-Checkout",
  "implement_substrate": "docker",
  "merge_substrate": "host",
  "started_at": "2026-05-22T14:00:00Z",
  "issues_total": 8,
  "issues_closed": 3,
  "phases_history": [
    {
      "phase_id": "phase-001",
      "started_at": "2026-05-22T14:00:00Z",
      "action": "dispatch",
      "substrate": "docker",
      "issues": [42, 43, 44],
      "outcome": "3 PRs opened (#56, #57, #58)",
      "completed_at": "2026-05-22T14:12:30Z"
    },
    {
      "phase_id": "phase-002",
      "started_at": "2026-05-22T14:15:00Z",
      "action": "merge",
      "substrate": "host",
      "prs": [56, 57, 58],
      "outcome": "All 3 merged",
      "completed_at": "2026-05-22T14:18:00Z"
    }
  ],
  "last_phase": "phase-002",
  "last_status": "MERGE_COMPLETED",
  "review": {
    "status": null,
    "pr": null
  }
}
```

`review.status`: `null` (not run yet) → `"pr_open"` (fixes committed, PR riding the merge wave) → `"done"` (review clean, or review PR merged). Older state files without the `review` key: treat as `null`.

## `PROGRESS.md` shape (human-readable)

```markdown
# AFK Pipeline — Goal: milestone:Q2-Checkout
Started: 2026-05-22T14:00Z
Implement substrate: docker
Merge substrate: host

## Issues in scope (8)
- [x] #42 — Add payment provider abstraction (merged PR #56)
- [x] #43 — Wire checkout to payment provider (merged PR #57)
- [x] #44 — Add Stripe adapter (merged PR #58)
- [ ] #45 — Add MercadoPago adapter
- [ ] #46 — Checkout success page (blocked by #43 → now unblocked)
- [ ] #47 — Receipt email
- [ ] #48 — Tax calculation
- [ ] #49 — Refund endpoint

## Phases history
- phase-001 (14:00 → 14:12): dispatch docker → 3 PRs opened (#42, #43, #44 → #56, #57, #58)
- phase-002 (14:15 → 14:18): merge host → 3 PRs merged
- phase-003 (14:20 → in progress): dispatching #45, #46, #47

## Decisions / constraints
- Tax calculation (#48) deferred until #45 (MercadoPago) merged (legal requirement to bind tax computation to provider).
- #49 (refunds) needs sandbox credentials in env — Leo gated it via label `agent-blocked` until creds available.
```

---

## What this command does NOT do

- **No internal loop** — `/goal` handles re-invocation between turns via Haiku verifier.
- **No auto-`/compact`** — the env var `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (set by `cc-afk` alias) handles this. Compact fires at safe boundaries (between turns), never mid-tool.
- **No goal verification** — `/goal` does this with Haiku. You just check state per turn and act.
- **No retries on a single turn** — if a dispatch / merge fails, the turn ends. Next turn the verifier sees the state and the playbook re-evaluates (probably finding the same actions retryable, or surfacing the blocker).
- **No new orchestration substrate** — this command **delegates** to existing commands (`/parallel-implement-wave`, `/sandcastle-dispatch-wave`, `/merge-orchestrate`, `/sandcastle-merge-wave`). All the heavy lifting lives there.

## How to invoke (typical)

The expected entry point is the `cc-afk` bash function (defined in the README):

```bash
cc-afk milestone:Q2-Checkout
```

This sets env vars (auto-compact 180K, max 50 turns, disable thinking, etc.), launches `claude --dangerously-skip-permissions` with an initial prompt that:

1. Invokes `/goal "todas las issues que matchean '<spec>' están cerradas con su PR mergeado"`.
2. Tells the agent to advance via `/afk-pipeline --goal=<spec> --implement=docker --merge=host`.

You can also invoke this command interactively in any session:

```
/afk-pipeline --goal=milestone:Q2-Checkout
```

(without `/goal`, it just does one playbook turn and stops — no verifier loop).

## Composition summary

```
cc-afk <goal>
  ├─ exports env vars (auto-compact 180K, max turns, etc.)
  └─ launches: claude --dangerously-skip-permissions "/goal <cond>. Run /afk-pipeline --goal=<spec>"

/goal harness (Claude Code native, v2.1.139+)
  └─ per turn:
       ├─ main agent runs /afk-pipeline (this command)
       └─ after turn ends, Haiku verifier checks goal condition
            ├─ met → done
            └─ not met → next turn (main agent re-invokes /afk-pipeline)

/afk-pipeline (this command, per-turn playbook)
  ├─ Step 1: hydrate state from .host-orchestrator/pipelines/<slug>.state.json
  ├─ Step 2: inspect goal scope (gh issue list / pr list)
  ├─ Step 3: pick ONE next action (merge if any MERGE_READY, else implement if any IMPLEMENTABLE, else review wave if all issues done but review pending, else report blocker, else declare done)
  ├─ Step 4: update PROGRESS.md + state.json
  └─ Step 5: end turn

(Each turn delegates the actual work to:)
  /parallel-implement-wave OR /sandcastle-dispatch-wave   ← implement
  /merge-orchestrate       OR /sandcastle-merge-wave      ← merge
  /review-fleet (engineering-workflow)                    ← final review
```
