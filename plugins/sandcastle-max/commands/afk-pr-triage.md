---
name: afk-pr-triage
description: Triage open PRs from AFK Claude Code agents (label `afk-agent-pr`). For each PR, fetches the original Agent Brief from the closed issue, validates the branch locally (typecheck + tests), parses acceptance criteria, classifies into AUTO-MERGE / HOLD-FOR-REVIEW / BLOCK, and asks for confirmation before merging. Pairs with /sandcastle-dispatch-wave as the second half of the AFK loop. Triggers when the user says "triage AFK PRs", "merge wave", "revisar PRs AFK", "cerrar la wave", "afk pr triage".
---

# /afk-pr-triage

Second half of the AFK loop. The dispatcher launched agents and they opened PRs; this command evaluates and (with your confirmation) merges them.

Design (decided 2026-05-09 with Leo):

- **Tier inference from issue title** — no `tier/*` labels; infer from prefix: `Foundation:` / `Bootstrap` / `Setup` → foundation; `OPT-A:` / `VS\d+:` / `feat\(` / `fix\(` → vertical-slice; ambiguous → foundation (safe).
- **Strict AC parsing** — any `- [ ]` (unchecked) in the PR body forces HOLD. Captures honest agent deviations like #3 leaving "validación visual pendiente".
- **Confirmation per bucket** by default — one prompt per classification group, not per PR. `--per-pr` for granular.
- **Local validation by default** — re-run `tsc --noEmit` and the test script against the PR branch in a worktree. `--no-validate` to trust the agent's claim.
- **No agent reviewer** — runs in the user's session, no Sandcastle container, no extra OAuth tokens.

## Args

- `--prs 7,8` — explicit PR list, skipping label discovery.
- `--no-validate` — skip local typecheck/test re-run; trust the PR body's claim.
- `--per-pr` — confirm one PR at a time instead of per-bucket batch.
- `--no-confirm` — merge AUTO-MERGE bucket without prompting (use only in scripts).

## Pre-conditions (single Bash, self-recovering)

```bash
set -e
git rev-parse --show-toplevel >/dev/null || { echo "✗ not a git repo"; exit 1; }
gh repo view --json nameWithOwner --jq .nameWithOwner >/dev/null || { echo "✗ gh repo unresolved"; exit 1; }

# Auto-recover GH token (gh CLI is the source of truth for our flows)
if [[ -z "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ]]; then
  if gh auth status >/dev/null 2>&1; then
    export GH_TOKEN=$(gh auth token)
  fi
  [[ -n "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ]] || { echo "✗ no GH token and gh not authenticated"; exit 1; }
fi

# Detect package manager from lockfile (validation step needs this)
if   [[ -f pnpm-lock.yaml ]];     then PKG=pnpm
elif [[ -f bun.lockb ]];           then PKG=bun
elif [[ -f yarn.lock ]];           then PKG=yarn
elif [[ -f package-lock.json ]];   then PKG=npm
else                                    PKG=none
fi
echo "✓ pre-flight ok (repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner), pkg=$PKG)"

# Warn (don't block) on dirty working tree — we use worktrees, won't touch HEAD
if [[ -n "$(git status -s)" ]]; then
  echo "⚠ working tree has changes (using isolated worktrees, won't be touched)"
fi
```

If `PKG=none` and the user did not pass `--no-validate`, ask whether to proceed without local validation or abort.

## Step 1 — Discover PRs

```bash
gh pr list --state open --label afk-agent-pr \
  --json number,title,body,headRefName,labels,mergeable,files,additions,deletions \
  --limit 50 > /tmp/afk-prs.json
jq 'length' /tmp/afk-prs.json
```

If `--prs N,M`, filter `/tmp/afk-prs.json` to that subset before continuing.

If zero PRs, exit cleanly: "No open AFK PRs to triage. Run /sandcastle-dispatch-wave to launch a new wave."

## Step 2 — Per-PR analysis

For each PR (run analyses in parallel where possible — typecheck/test are slow, the rest are gh API calls):

### 2a — Resolve the closing issue and its brief

Parse `Closes #N` (or `Fixes #N`, `Resolves #N`, case-insensitive) from the PR body. If multiple, the first wins. If none, mark the PR as `NO-ISSUE` (treat as HOLD with reason "no closing-issue link — cannot fetch brief or AC").

```bash
ISSUE=$(echo "$PR_BODY" | grep -oiE '(closes|fixes|resolves) #[0-9]+' | head -1 | grep -oE '[0-9]+')
BRIEF=$(gh api "repos/${REPO}/issues/${ISSUE}/comments" \
  --jq '[.[] | select(.body | contains("## Agent Brief"))] | last | .body')
ISSUE_TITLE=$(gh issue view $ISSUE --json title --jq .title)
```

### 2b — Tier inference

Apply this regex on the issue title (NOT the PR title — the issue title is the original work item):

```
^(Foundation|Bootstrap|Setup|Infra|Scaffold|Docs|Migration)[:\s]   → foundation
^(OPT-[A-Z]|VS\d+|feat\(|fix\(|enhancement|bug)                    → vertical-slice
otherwise                                                          → foundation (safe default)
```

Foundation = "touches shared scaffolding everyone else depends on; deserves human eyes". Vertical-slice = "self-contained feature/fix; if green, low blast radius".

### 2c — Local validation

If `--no-validate` is set, skip this step and record `validation: skipped`.

Otherwise:

```bash
WT=".sandcastle/worktrees/agent-issue-${ISSUE}"
TMP_WT="/tmp/triage-${ISSUE}"

# Reuse sandcastle worktree if present (faster — node_modules already there)
if [[ -d "$WT" ]]; then
  TARGET="$WT"
  (cd "$TARGET" && git fetch origin "$BRANCH" >/dev/null 2>&1 && git reset --hard "origin/${BRANCH}")
else
  # Create temp worktree
  git worktree add --force "$TMP_WT" "$BRANCH" >/dev/null 2>&1 || git worktree add --force "$TMP_WT" -b "triage-${ISSUE}" "origin/${BRANCH}"
  TARGET="$TMP_WT"
fi

cd "$TARGET"

# Install deps if not already (only when needed — node_modules absent or lockfile changed)
if [[ ! -d node_modules ]]; then
  $PKG install --frozen-lockfile 2>&1 | tail -3
fi

# Typecheck — required, must pass
$PKG exec tsc --noEmit > /tmp/triage-tsc-${ISSUE}.log 2>&1
TSC_RC=$?

# Tests — only if a "test" script exists in package.json
if jq -e '.scripts.test' package.json >/dev/null 2>&1; then
  $PKG test > /tmp/triage-test-${ISSUE}.log 2>&1
  TEST_RC=$?
else
  TEST_RC=0
  echo "no test script — skipping" > /tmp/triage-test-${ISSUE}.log
fi

cd - >/dev/null
```

Record `validation: { tsc: pass|fail, tests: pass|fail|skipped, log_paths: ... }`.

### 2d — AC parsing (strict)

```bash
UNCHECKED=$(echo "$PR_BODY" | grep -cE '^\s*-\s*\[\s\]\s' || true)
CHECKED=$(echo "$PR_BODY"   | grep -cE '^\s*-\s*\[x\]\s' || true)
TOTAL=$((UNCHECKED + CHECKED))
```

Record `ac: { checked: N, unchecked: M, total: N+M, status: complete|incomplete|absent }`. Treat `total == 0` as `absent` (no AC list found in PR body — HOLD with reason).

### 2e — Risk signals

- `mergeable != "MERGEABLE"` → BLOCK reason "merge conflict".
- Files-changed includes `convex/schema.ts`, `*.sql`, `migrations/`, `prisma/migrations/` → HOLD reason "schema/migration touch".
- Files-changed > 15 OR additions+deletions > 500 → HOLD reason "large change".
- Labels include `agent-blocked` → BLOCK reason "agent flagged this PR".

## Step 3 — Classify

Apply in order; first match wins:

1. **BLOCK** — any of: merge conflict, tsc failed, tests failed, `agent-blocked` label.
2. **HOLD-FOR-REVIEW** — any of: tier=foundation, ac.unchecked > 0, ac.absent, schema/migration touch, large-change.
3. **AUTO-MERGE** — none of the above, AND tier=vertical-slice, AND ac.checked > 0.

## Step 4 — Show preview

```
AFK PR triage — N PRs evaluated:

  AUTO-MERGE (eligible, awaiting your confirmation):
    #X  feat(#5): ...                       tier=slice  AC=8/8  tsc=✓  tests=✓  files=4

  HOLD-FOR-REVIEW (need your eye):
    #7  feat(#2): Foundation rich-text...   tier=foundation  AC=9/9  tsc=✓  tests=50/50  reason: foundation tier
    #8  fix(#3): bug fixes...                tier=slice  AC=14/15  tsc=✓  tests=skip  reason: AC #15 (validación visual) unchecked

  BLOCK (cannot proceed):
    #12 ...                                 reason: tsc failed (3 errors in convex/budgets.ts)
                                            log: /tmp/triage-tsc-12.log

Validation: ran in .sandcastle/worktrees/agent-issue-{N}/ when present, /tmp/triage-{N}/ otherwise.
```

## Step 5 — Confirmation per bucket (default)

Use AskUserQuestion. Three independent prompts (only show buckets with PRs):

- **AUTO-MERGE bucket** — "Merge these N PRs now?" Options: `Sí, mergear todos`, `Per-PR`, `Skip`.
- **HOLD-FOR-REVIEW bucket** — "Open in browser to review?" Options: `Abrir todos en browser`, `Per-PR`, `Skip`. (Don't merge from this bucket without explicit per-PR override.)
- **BLOCK bucket** — "Comment on issues with diagnosis + apply agent-blocked label?" Options: `Sí, marcar para retry`, `Per-PR`, `Skip`. Comments include the failure log tail (last 30 lines).

If `--per-pr`, skip the bucket prompts and ask one question per PR with options `Mergear`, `Abrir browser`, `Skip`, `Comment + retry` (last only for BLOCK).

If `--no-confirm`, merge the AUTO-MERGE bucket without asking; HOLD and BLOCK still get the comment-or-skip prompt (never silent on those).

## Step 6 — Apply actions

For each AUTO-MERGE confirmed:
```bash
gh pr merge $N --squash --delete-branch --subject "feat(#$ISSUE): <PR title>"
```

For each BLOCK confirmed:
```bash
LOG_TAIL=$(tail -30 /tmp/triage-tsc-${ISSUE}.log /tmp/triage-test-${ISSUE}.log 2>/dev/null)
gh pr comment $N --body "$(cat <<EOF
AFK triage failed validation. Tagging for retry.

\`\`\`
$LOG_TAIL
\`\`\`
EOF
)"
gh issue edit $ISSUE --add-label agent-blocked
gh pr edit $N --add-label agent-blocked
```

For each HOLD opened in browser:
```bash
gh pr view $N --web
```

After all merges:
```bash
git fetch origin main
```

## Step 7 — Cleanup worktrees of merged PRs

```bash
for ISSUE in $MERGED_ISSUES; do
  WT=".sandcastle/worktrees/agent-issue-${ISSUE}"
  TMP_WT="/tmp/triage-${ISSUE}"
  [[ -d "$WT" ]]     && git worktree remove --force "$WT"     || true
  [[ -d "$TMP_WT" ]] && git worktree remove --force "$TMP_WT" || true
done
```

Worktrees of HOLD/BLOCK PRs stay — user may want to inspect.

## Step 8 — Final report + dep graph hint

```
Triage complete:

  Merged:   #X (PR #..)
  On hold:  #7 (foundation review), #8 (visual AC pending)
  Blocked:  #12 (tsc fail, retry queued via agent-blocked label)

Newly unblocked issues (deps now closed):
  #4 — OPT-A layout       (was waiting on #2; ready for next dispatch)
  #5 — Anexo Técnico      (was waiting on #2; ready for next dispatch)

Next: /sandcastle-dispatch-wave to launch the unblocked set.
```

The dep-graph hint is computed by re-reading `## Blocked by` from open `ready-for-agent` issues (same parser as `/sandcastle-dispatch-wave` Step 1) and reporting the issues whose deps are now all closed.

Persist a triage report at `.sandcastle/triage-reports/<timestamp>.json` for postmortem.

## Anti-patterns (do NOT do these in the implementation)

- Do not check out branches into the user's main working tree — always use a worktree (sandcastle's existing one or `/tmp/triage-N`).
- Do not run `npm install` / `pnpm install` from inside the user's working tree — only from the worktree.
- Do not skip the AC strictness rule. Unchecked AC = HOLD, no exceptions. The whole point is catching honest agent deviations.
- Do not silently merge BLOCK PRs even with `--no-confirm`. Confirmation can be skipped only for the AUTO-MERGE bucket.
- Do not delete the worktree of a HOLD or BLOCK PR — user may want to inspect / re-validate.
- Do not modify CI workflows or `.github/` files — out of scope for this command.

## Notes

- Pairs with `/sandcastle-dispatch-wave`. The natural cadence: `dispatch-wave` → wait for agents to finish → `afk-pr-triage` → merge what's clean → `dispatch-wave` again with newly-unblocked issues.
- Tier inference is a heuristic. If your issue titles don't match the regex, the PR will land in HOLD (safe default). To force vertical-slice tier on a stubborn case, edit the issue title or pass `--prs N` and review manually.
- Validation runs in worktrees so the user's working tree is never touched. The sandcastle worktree (`.sandcastle/worktrees/agent-issue-N`) is preferred when present because it already has `node_modules`.
- The `agent-blocked` label propagates to the issue so the next `/sandcastle-dispatch-wave` skips it (see Q12 of the dispatcher's design — "Issues with agent-blocked label are skipped").
