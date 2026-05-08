---
name: sandcastle-dispatch-wave
description: Detect and dispatch a wave of AFK Claude Code agents in parallel via Sandcastle, using the user's Claude Max subscription. Reads the dependency graph from GH issues (parsing `## Blocked by` from issue bodies), shows a preview of eligible issues, and on user confirmation launches one Docker container per eligible issue concurrently. Each agent works on a dedicated branch (`agent/issue-N`), reads the latest `## Agent Brief` comment as its contract, and is expected to open a PR + comment on the issue when done. Triggers when the user says "dispatch wave", "lanzar ola AFK", "dispatch issues", "correr los agentes AFK".
---

# /sandcastle-dispatch-wave

Wave-based dispatcher for AFK agents. Reads the GH issue tracker, computes the next wave (issues whose dependencies are merged), shows you a preview, and on confirmation launches Sandcastle containers in parallel — one per eligible issue.

This command implements the design decisions from the `/grill-me` round of 2026-05-08:
- **Q6 (hybrid prompt)**: brief is inlined into a per-issue `prompt.md`; agent gets a header with callback instructions (PR, comment, COMPLETE/BLOCKED tokens).
- **Q9 (wave-based parallelism)**: no fixed N; runs all eligible in parallel, capped by the natural max from the dep graph.
- **Q10 (auto-detection + confirmation)**: parse `## Blocked by` from issue bodies, preview, ask y/N before launching.
- **Q11 (failure isolation)**: container-level failures don't kill siblings; env-level failures (Docker daemon, OAuth) abort the wave.
- **Q12 (smart wave)**: a single invocation handles first-try and retries uniformly. Issues with `agent-blocked` label are skipped (need user input on the brief).

## Pre-conditions (verify in parallel before doing anything)

Run these checks via Bash; report what fails and stop if any is missing:

- `git rev-parse --show-toplevel` — must be inside a git repo. If not, abort.
- `[[ -f .sandcastle/main.mts ]]` — the repo must have been scaffolded with `/sandcastle-init`. If not, suggest running it first.
- `docker info >/dev/null 2>&1` — Docker daemon must be running.
- `[[ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]]` — OAuth token must be in env. If not, suggest `source scripts/claude-oauth-env.sh`.
- `[[ -n "$GH_TOKEN" || -n "$GITHUB_TOKEN" ]]` — GH token must be available so the container can `gh issue comment` / `gh pr create`. If not, suggest `export GH_TOKEN=$(gh auth token)`.
- `gh repo view --json nameWithOwner --jq .nameWithOwner` — must resolve to the GH repo (config sane).
- `docker image inspect sandcastle-max >/dev/null 2>&1` — the Docker image must exist. If not, suggest `bun run sandcastle:build`.

If any check fails, **stop**. Print actionable instructions for each missing item.

## Step 1 — Read dependency graph

Query the GH issue tracker for issues that are ready for agent work:

```bash
gh issue list \
  --state open \
  --label state/ready-for-agent \
  --json number,title,body,labels \
  --limit 100
```

For each returned issue:
1. Parse the `## Blocked by` section in `body`. Each `#N` reference is a dep.
2. For each dep `#N`, query `gh issue view N --json state,closedAt`. If `state == 'CLOSED'`, dep is met.
3. Also check via `gh pr list --search "fixes #X OR closes #X"` whether a PR for THIS issue is already open. If yes, skip (a previous dispatch is in flight).

Compute three buckets:
- **Eligible** (this wave): all deps closed AND no open PR for this issue.
- **Blocked** (waiting on upstream): at least one dep still open. Show which.
- **Skipped** (need input): has label `agent-blocked` (a previous dispatch flagged the brief as ambiguous).

## Step 2 — Show preview

Print a structured preview:

```
Wave detected (N issues, all deps merged):

  #2  F2 — Primitives library            (deps: none)            [first try]
  #5  F5 — Org context resolver          (deps: none)            [retry — was stuck]

Issues blocked (waiting for upstream):
  #6  F6 — Plan limits enforcer          (waiting on #5)
  #10 VS4 — Lista v2                     (waiting on #2)

Issues SKIPPED (require your input first):
  #14 VS8 — agent-blocked: brief unclear about share token expiry behavior

Image: sandcastle-max  ·  Mode: parallel  ·  Concurrency: N (natural wave size)

Launch wave? [y/N/select <issue numbers comma-separated>]:
```

`[first try]` vs `[retry — was X]` is determined by the presence of labels `agent-stuck` / `agent-crashed` (see Step 5).

## Step 3 — User confirmation

Wait for user input:
- `y` or `Y` → launch the entire eligible set.
- `N` or empty → abort, do nothing.
- `select 2,5` (or `2,5`) → launch only those issues from the eligible list.
- Anything else → re-prompt.

## Step 4 — Per-issue preparation

For each issue in the launch set, do these BEFORE launching anything:

1. **Extract the brief.** Run:
   ```bash
   gh api repos/$REPO/issues/$N/comments \
     --jq '[.[] | select(.body | contains("## Agent Brief"))] | last | .body'
   ```
   This gets the LATEST `## Agent Brief` comment (per the single-brief invariant from engineering-workflow v2.1.0). If no brief exists, abort with error: "issue #N has no Agent Brief comment. Run /triage on it first."

2. **Compose `prompt.md` for this issue.** Write to `.sandcastle/prompts/issue-N.md` using the template below. Mkdir `-p` `.sandcastle/prompts/` if needed.

3. **Pre-create the branch base.** Determine the base branch (default: `main`). Verify locally:
   ```bash
   git fetch origin main
   ```
   Sandcastle will create `agent/issue-N` from HEAD inside the container. If `agent/issue-N` already exists locally OR remotely, **delete it first** (this is a retry path):
   ```bash
   git branch -D agent/issue-$N 2>/dev/null || true
   git push origin --delete agent/issue-$N 2>/dev/null || true
   ```

### Per-issue `prompt.md` template

```markdown
You are an AFK Claude Code agent working on a GitHub issue inside a Sandcastle Docker container.

## Issue context

- **Repo:** {{REPO}}
- **Issue:** #{{N}} — {{TITLE}}
- **Branch:** {{BRANCH}} (Sandcastle created this from main)
- **Base for PR:** main

## Your contract

The block below is the durable contract for this work. The original
issue body and discussion are context only — this brief is the contract.

---

{{BRIEF_INLINE}}

---

## Reading order

1. `CLAUDE.md` (auto-loaded by Claude Code) — repo conventions, stack, architecture.
2. The contract above.
3. `docs/phase1-decisions.md` — IF the brief mentions a P-decision (e.g. "see P11"),
   open this file and read the relevant section before implementing.
4. Explore the codebase as needed. Use the project's CONTEXT.md vocabulary.

## What you must do

1. Implement the contract above — produce a complete vertical slice (schema → API → UI → tests, as applicable).
2. Run the project's test suite locally inside the container before committing:
   - `bun run typecheck:ui` (UI typecheck)
   - `tsc --noEmit` (backend typecheck)
   - `bun test` (unit tests)
   - `bun run test:ui` (UI tests, if applicable)
3. Commit your work to the current branch (`{{BRANCH}}`) with conventional-commit style messages.
4. Open a PR:
   ```bash
   gh pr create \
     --base main \
     --head {{BRANCH}} \
     --title "feat(#{{N}}): <one-line summary>" \
     --body "Closes #{{N}}.

     <Summary of what you implemented and why>

     ### Acceptance criteria
     <Copy each criterion from the brief, mark [x] if implemented>

     🤖 Generated by Sandcastle AFK agent."
   ```
   Add the label `afk-agent-pr` to the PR so the auto-merge workflow recognizes it:
   ```bash
   gh pr edit <PR_NUMBER> --add-label afk-agent-pr
   ```
5. Comment on the issue with a short summary + PR link:
   ```bash
   gh issue comment {{N}} --body "Implemented by AFK agent. PR: <link>. Acceptance criteria: <N/N>."
   ```

## Completion signals (REQUIRED)

End your run with EXACTLY one of these tokens. The dispatcher reads them to determine outcome:

- `<promise>COMPLETE</promise>` — you implemented the contract, opened a PR, commented on the issue. CI will decide auto-merge per its tier rules.
- `<promise>BLOCKED</promise>` — you cannot complete the contract because the brief is ambiguous, the codebase is in unexpected state, or a dep is missing. **Before printing this, you MUST**:
  1. `gh issue comment {{N}} --body "@LeopoldoBini blocked: <reason>. Need clarification on <X>."`
  2. `gh issue edit {{N}} --add-label agent-blocked`
  Then output `<promise>BLOCKED</promise>`.
- (no token) — your run will time out as `agent-stuck`. Don't do this. If you're truly stuck after best effort, use BLOCKED.

## Anti-patterns (do not do these)

- Do not edit files unrelated to the contract.
- Do not modify CI workflows or repo-wide config unless the brief explicitly asks.
- Do not push to `main` directly — only to `{{BRANCH}}`.
- Do not skip tests with `--no-verify` or `it.skip()` to make CI pass.
- Do not invent API endpoints or types not described in the brief or implied by `CONTEXT.md`.
```

When generating this file, substitute:
- `{{REPO}}` → `Cuenta-Norte/monitor-contrataciones` (or whatever `gh repo view` resolves to)
- `{{N}}` → issue number
- `{{TITLE}}` → issue title from the GH API
- `{{BRANCH}}` → `agent/issue-{{N}}`
- `{{BRIEF_INLINE}}` → the entire body of the latest `## Agent Brief` comment

## Step 5 — Launch in parallel

For each issue in the launch set, kick off a background process. Use Bash subshell with env-var injection:

```bash
mkdir -p .sandcastle/logs
for N in $LAUNCH_SET; do
  ISSUE_PROMPT=".sandcastle/prompts/issue-${N}.md"
  ISSUE_BRANCH="agent/issue-${N}"
  LOG=".sandcastle/logs/issue-${N}-$(date +%Y%m%d-%H%M%S).log"
  (
    SANDCASTLE_ISSUE_NUMBER="$N" \
    SANDCASTLE_BRANCH="$ISSUE_BRANCH" \
    SANDCASTLE_PROMPT_FILE="$ISSUE_PROMPT" \
      bunx tsx .sandcastle/main.mts > "$LOG" 2>&1 &
    echo $! > ".sandcastle/logs/issue-${N}.pid"
  )
done
```

Then enter monitor mode:
- Every 30s, check `docker info` to detect daemon failures (Q11 wave-fatal).
- Every 30s, list still-running PIDs from `.sandcastle/logs/issue-*.pid`.
- For each completed PID, parse the tail of its log for `<promise>COMPLETE</promise>` or `<promise>BLOCKED</promise>` or `AgentIdleTimeoutError` or other.
- Apply the outcome:
  - `COMPLETE` + PR opened → ✓
  - `BLOCKED` → already commented + labeled by the agent, just record outcome
  - idle timeout (`AgentIdleTimeoutError`) → `gh issue edit N --add-label agent-stuck` + `gh issue comment N --body "Agent idle-timed out. Inspect logs at $LOG. Re-run /sandcastle-dispatch-wave to retry."`
  - non-zero exit without COMPLETE/BLOCKED → `gh issue edit N --add-label agent-crashed` + `gh issue comment N --body "Agent crashed. Inspect logs at $LOG."`

If `docker info` fails during the wave, this is wave-fatal:
- `docker stop` all running containers from the launch set.
- Print "WAVE-FATAL: docker daemon error. Aborting siblings."
- Apply `agent-aborted` label to in-flight issues with a comment.

## Step 6 — Final report

When all PIDs have exited (success or failure), print:

```
Wave summary (3/4 success, 1 blocked):

  #2  ✓  PR #45 opened, CI in progress, holding for manual review (slice/foundation)
  #5  ✓  PR #46 opened, CI in progress, holding for manual review (slice/foundation)
  #6  ✗  BLOCKED — see issue comment + agent-blocked label
  #10 ✓  PR #47 opened, CI in progress, will auto-merge on green (VS slice)

Logs: .sandcastle/logs/issue-*-<timestamp>.log
Next wave: re-run /sandcastle-dispatch-wave after CI completes / you merge foundation PRs.
```

Save a structured wave report to `.sandcastle/wave-reports/<timestamp>.json` for postmortem.

## Cleanup

After the wave finishes, remove `.sandcastle/logs/issue-*.pid` files (PIDs no longer valid). Keep the `.log` and `prompts/` files for debugging.

## Arguments

- `--issues <list>` — explicit launch set, skipping detection (e.g. `--issues 2,5`). Useful when you want to override the dep graph.
- `--max-parallel <N>` — cap concurrency to N (default: launch all eligible). Useful if your sv resources are limited.
- `--dry-run` — do everything except actually launching containers. Print the prompt files, the env vars, the docker commands. Useful for verifying brief extraction.
- `--no-confirm` — skip the y/N prompt, launch immediately. Use only in scripts.

## Notes for future maintainers

This command is the user-facing entry to AFK execution. It depends on:

- **engineering-workflow plugin (>=2.1.0)** — `/triage` and `/agent-brief` enforce the single-brief invariant. If a project uses an older version, this dispatcher MAY pick the wrong brief. Verify before deploying.
- **`docs/phase1-decisions.md`** (project-specific) — referenced from briefs via P-anchors. The dispatcher does NOT inline this file; the agent reads it on-demand inside the container per the prompt's reading order. If the file path differs in another project, the prompt template should be parameterized.
- **`afk-agent-pr` label** — applied by the agent to its PR, recognized by `.github/workflows/afk-automerge.yml` to determine auto-merge eligibility per Q8 tier rules.

If Sandcastle's underlying behavior changes (new version, new flags), the `branchStrategy: { type: 'branch', branch: ... }` shape may need updating. See the `sandcastle-afk` skill for grep targets in the Sandcastle source.
