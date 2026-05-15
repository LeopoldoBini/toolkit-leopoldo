---
name: merge-orchestrator
description: Intent-aware orchestrator for merging a batch of open GitHub PRs serially on host (no Docker). Discovers candidate PRs, computes topological order from `Blocked by` deps + file overlap, dispatches one fresh Opus `merge-resolver` subagent per PR with the issue brief + diff + base, executes squash merges serially with auto-rebase, uses ephemeral worktrees for conflict resolution, enforces 5 explicit no-regression criteria, applies skip-transitive on INCOMPATIBLE. Triggers when user says "mergeame los PRs", "orquestá los merges", "fijate los PRs y merge-eos en orden", "merge wave en host", "intent-aware merge", "cerrá los PRs pendientes en orden", "mergeá la cola de PRs". Use this skill when the user wants AGENT-driven merge orchestration on host (not Docker AFK — that's `/sandcastle-merge-wave`).
---

# Merge Orchestrator (host)

Orchestrates a serial, intent-aware merge of N open GitHub PRs in your current Claude Code session. Runs entirely on host — no Docker, no Sandcastle SDK, no external CI. Uses the `merge-resolver` custom subagent (Opus) per PR for intent verification and conflict resolution, with the host as the single point of git mutation.

**When NOT to use this skill:**
- Volume of 8+ PRs with no time pressure → `/sandcastle-merge-wave` parallelizes reviewers in Docker.
- PRs not yet reviewed (need APPROVE/HOLD/BLOCK judgment) → review them first (manually or via sandcastle-merge-wave Step 1). This skill assumes "ready to merge".
- A single PR → `gh pr merge --squash` directly is simpler.

**When to use this skill:**
- 2-7 open PRs you want merged in correct order without manually rebasing each one.
- Mixed AFK + human PRs that touch related code (intent-aware resolution matters).
- You want the resolver to be aware of the brief, not just the diff.

---

## Inputs

- **Implicit:** discovers PRs from `gh pr list --state open --json ...` in current repo.
- **Optional explicit selection:** user passes `PRs: #5,#7,#9` inline, which overrides auto-discovery.
- **Optional flags (recognized in the user's message):**
  - `--strategy=merge|rebase` (default: squash)
  - `--step` (confirm before each merge instead of only at start + on blocks)
  - `--dry-run` (preview only, never executes mutations)

---

## Step 1 — Pre-flight checks

Run these in parallel:

```bash
# Working directory must be a git repo with gh CLI configured
git rev-parse --git-dir
gh auth status

# Detect base branch (HEAD of current worktree)
BASE_BRANCH=$(git rev-parse --abbrev-ref HEAD)
BASE_BRANCH_SLUG=$(echo "$BASE_BRANCH" | tr '/' '-' | tr '[:upper:]' '[:lower:]')

# Sync base with remote so the merge target is current
git fetch origin "$BASE_BRANCH"
git pull --ff-only origin "$BASE_BRANCH" || {
  echo "ERROR: base branch '$BASE_BRANCH' diverged from remote — resolve manually first"
  exit 1
}
```

**Untracked / dirty working tree handling:**

```bash
# Stash anything modified or untracked so worktrees don't see it
if ! git diff --quiet HEAD || [ -n "$(git status --porcelain)" ]; then
  STASH_REF=$(git stash create "merge-orchestrator pre-wave $(date -u +%Y%m%dT%H%M%S)")
  git stash store -m "merge-orchestrator pre-wave" "$STASH_REF"
  echo "Stashed working tree as: $STASH_REF (restored at end of wave)"
  WAVE_STASHED=1
else
  WAVE_STASHED=0
fi
```

Persist `BASE_BRANCH`, `BASE_BRANCH_SLUG`, `WAVE_STASHED`, and `STASH_REF` in the session so the final cleanup step can restore.

---

## Step 2 — PR discovery

If the user provided explicit PRs (`#5,#7,#9`), use those. Otherwise auto-detect:

```bash
gh pr list \
  --state open \
  --base "$BASE_BRANCH" \
  --draft=false \
  --json number,title,headRefName,baseRefName,body,labels,mergeable,files,createdAt,author \
  --limit 50
```

**Filter out:**
- PRs with label `do-not-merge`, `wip`, or `hold`.
- PRs from `dependabot[bot]` unless explicitly included (these usually merge themselves via auto-merge).
- PRs not targeting `$BASE_BRANCH`.

If the candidate set is empty, exit with "No open mergeable PRs found targeting `$BASE_BRANCH`."

---

## Step 3 — Intent gathering (cascade per PR)

For each candidate PR, build an "intent packet" by cascading these sources until one resolves:

1. **Issue brief (preferred):** parse PR body for `Closes #N`, `Fixes #N`, `Resolves #N`. Fetch:
   ```bash
   gh issue view N --json title,body,comments
   ```
   Look for a `## Agent Brief` section in the body or latest comment (engineering-workflow v2.1.0+ single-brief invariant). If found, that's the canonical intent.
2. **PR description:** if no issue or no brief comment, use the PR body itself.
3. **Commit log:** if PR body is empty/trivial (`fix typo`, etc.), use `gh pr view N --json commits`.
4. **Diff only:** last resort — mark this PR as `low-intent`.

Store as `intent[N] = { source: brief|pr-body|commits|diff-only, content: "...", issue: N|null }`. The `merge-resolver` subagent receives this packet.

---

## Step 4 — Topological order + risk pairs

### 4a. Dependency graph

For each PR, parse the intent packet for a `## Blocked by` section (engineering-workflow convention). Extract referenced issues, map them to their PRs in the wave (PR linked to issue N has `Closes #N`). This builds the directed dep graph.

### 4b. File overlap (semantic-risk pairs)

For each pair of PRs (A, B), compute `overlap(A, B) = |files(A) ∩ files(B)| > 0`. Mark pairs where:
- A and B overlap on at least one file, AND
- Neither A→B nor B→A appears in the dep graph.

These are **semantic-risk pairs**: same file touched independently. The resolver will receive the marker so it expects rebase conflicts and treats both intents as load-bearing.

### 4c. Topological sort

Kahn's algorithm on the dep graph. Stable tie-break: ascending PR number. Output: `merge_order = [PR1, PR2, ...]`.

If the graph has a cycle, abort with a clear error listing the cycle. Cycles in deps mean the briefs are mis-decomposed and need human intervention.

---

## Step 5 — Preview + initial confirmation

Show the user a compact preview:

```
## Merge Wave Preview — base: $BASE_BRANCH

Order (topological + tie-break):

| # | PR  | Title              | Intent source | Risk pairs       |
|---|-----|--------------------|---------------|--------------------|
| 1 | #5  | feat: schema       | brief         | —                  |
| 2 | #7  | feat: api          | brief         | #2 (overlaps repo.ts) |
| 3 | #9  | feat: ui           | brief         | —                  |
| 4 | #2  | refactor: helpers  | pr-body       | #7 (overlaps repo.ts) |

Strategy: squash --delete-branch
Auto-pilot between merges. Will stop only on INCOMPATIBLE.

Proceed?
```

Ask the user via `AskUserQuestion`: `[y] proceed`, `[N] abort`, `[edit] adjust order/exclude`. If `edit`, allow them to remove PRs from the wave or reorder; re-validate dep graph; re-show preview.

If `--dry-run`, stop here and report what would happen without executing.

---

## Step 6 — Serial merge loop

Initialize tracking:

```
merged = []
blocked = []     # explicit INCOMPATIBLE
skipped = []     # transitive: dep on a blocked PR
```

For each PR in `merge_order`:

### 6.0. Skip if transitive

If any dep of this PR is in `blocked` or `skipped`, append to `skipped` with reason `"dep #X blocked"` and continue.

### 6.1. Refresh base (idempotent)

```bash
git fetch origin "$BASE_BRANCH"
git pull --ff-only origin "$BASE_BRANCH"
```

### 6.2. Auto-rebase via gh

```bash
gh pr update-branch "$PR" 2>&1 | tee /tmp/mo-rebase-$PR.log
```

If `gh` reports clean rebase, set `rebase_status=clean`. If it reports conflict, set `rebase_status=conflict`.

### 6.3. Ephemeral worktree

```bash
WT=".merge-orchestrator/wt-pr-$PR"
mkdir -p .merge-orchestrator
git worktree add --force "$WT" "$(gh pr view $PR --json headRefName -q .headRefName)" 2>&1
```

If checkout fails (branch ref stale after `gh pr update-branch` force-push), `git fetch --all` and retry once.

### 6.4. Pre-merge validation (cascade auto-detect)

In `$WT`:

```bash
cd "$WT"

# Cascade: prefer scripts/sandcastle-validate.sh if present (sandcastle-max users share infra)
if [ -x scripts/sandcastle-validate.sh ]; then
  ./scripts/sandcastle-validate.sh "$PR" 2>&1 | tee /tmp/mo-validate-$PR.log
  validate_exit=$?
else
  # Auto-detect package manager and run minimal CI
  if [ -f bun.lockb ] || [ -f bun.lock ]; then PM=bun
  elif [ -f pnpm-lock.yaml ]; then PM=pnpm
  elif [ -f yarn.lock ]; then PM=yarn
  elif [ -f package-lock.json ]; then PM=npm
  else PM=""
  fi

  if [ -n "$PM" ]; then
    $PM install --frozen-lockfile 2>&1 | tee /tmp/mo-install-$PR.log || true
    # typecheck if present
    if grep -q '"typecheck"' package.json 2>/dev/null; then
      $PM run typecheck 2>&1 | tee -a /tmp/mo-validate-$PR.log || validate_exit=1
    elif command -v tsc >/dev/null 2>&1 && [ -f tsconfig.json ]; then
      $PM exec tsc --noEmit 2>&1 | tee -a /tmp/mo-validate-$PR.log || validate_exit=1
    fi
    # tests if present
    if grep -q '"test"' package.json 2>/dev/null; then
      $PM test 2>&1 | tee -a /tmp/mo-validate-$PR.log || validate_exit=1
    fi
  else
    echo "No detected package manager — skipping validation (low confidence merge)"
    validate_exit=0
  fi
fi
```

Capture `validate_exit` for the subagent's input packet.

### 6.5. Dispatch `merge-resolver` subagent (Opus, always 1 per PR)

Invoke the custom subagent. The subagent reads files, optionally edits conflict markers in `$WT`, and emits a recommendation. Host does the git mutations.

Call `Agent(subagent_type="merge-resolver", prompt=<packet>)` where the packet is:

```
You are merge-resolver for PR #$PR.

## Workspace
- Worktree: $WT
- Base branch: $BASE_BRANCH
- Rebase status: $rebase_status   (clean | conflict)
- Validation exit: $validate_exit (0 = green, non-zero = failed)

## Intent packet
Source: $intent_source
$intent_content

## PR diff (post-rebase)
$(gh pr diff $PR)

## Files touched
$(gh pr view $PR --json files --jq '.files[].path')

## Semantic-risk pairs (already merged in this wave)
(For each pair (PR_already_merged, $PR) marked in Step 4b, embed the already-merged PR's intent + its diff stats here.)

## Your job
1. Read the intent packet. Understand the contract.
2. If rebase_status=conflict: navigate $WT, locate conflict markers (`git status --short | grep ^UU`), resolve them respecting the 5 no-regression criteria embedded in your agent prompt.
3. If validation failed: read /tmp/mo-validate-$PR.log, decide if the failure is caused by the rebase merge (then resolve) or by a pre-existing issue (then ABORT).
4. Emit recommendation in this exact XML format:

<resolution>RESOLVED | INCOMPATIBLE | NOT_NEEDED</resolution>
<action>MERGE | HOLD | ABORT</action>
<summary>One sentence on what you did and why.</summary>
<details>
Free-form: which criteria you weighed, which conflicts were resolved, why you chose this action.
</details>
<block-reason>(only if action=HOLD or ABORT) IMPLEMENTATION | BRIEF_AMBIGUOUS | CODEBASE_UNEXPECTED | VALIDATION_FAILED</block-reason>

Do NOT execute `git push`, `gh pr merge`, or any remote-mutating command. Host will execute the recommendation.
```

Parse the subagent's response for `<action>` and `<resolution>`.

### 6.6. Act on recommendation (host executes mutations)

```bash
case "$action" in
  MERGE)
    # If subagent resolved conflicts in $WT, commit + push first
    if [ "$resolution" = "RESOLVED" ]; then
      cd "$WT"
      git add -A
      git commit -m "chore: resolve merge conflicts with $BASE_BRANCH (intent-aware via merge-resolver)" || true
      git push --force-with-lease origin HEAD
      cd -
    fi
    # Squash merge with strategy
    STRATEGY="${MERGE_STRATEGY:-squash}"
    gh pr merge "$PR" --"$STRATEGY" --delete-branch
    merged+=("$PR")
    ;;
  HOLD|ABORT)
    gh pr edit "$PR" --add-label "merge-blocked"
    gh pr comment "$PR" --body "Merge-orchestrator: $action with reason \`$block_reason\`. Resolver summary: $summary"
    blocked+=("$PR:$block_reason:$summary")
    ;;
esac
```

### 6.7. Cleanup worktree

```bash
git worktree remove --force "$WT" || rm -rf "$WT"
rmdir .merge-orchestrator 2>/dev/null || true
```

### 6.8. (Optional) Step mode

If user passed `--step`, ask via `AskUserQuestion` after each PR: `[y] continue`, `[N] stop here`.

---

## Step 7 — Final cleanup + report

### 7a. Restore stashed working tree

```bash
if [ "$WAVE_STASHED" = "1" ]; then
  git stash pop || {
    echo "WARN: stash pop had conflicts — your stash is preserved at: $(git stash list | head -1)"
  }
fi
```

### 7b. Render the report

Use this exact format (markdown table renders well in the Claude Code UI):

```markdown
## Merge Wave Report — $BASE_BRANCH ($(date -u +%Y-%m-%dT%H:%M))

| PR  | Title              | Status       | Reason                          |
|-----|--------------------|--------------|---------------------------------|
| #5  | feat: schema       | merged       | clean rebase                    |
| #7  | feat: api          | merged       | resolved 2 conflicts (intent-aware) |
| #9  | feat: ui           | skipped      | dep on #5 (which actually merged → re-eval) |
| #2  | refactor: helpers  | blocked      | INCOMPATIBLE                    |

### Bloqueados

**#2 — refactor: helpers**

> "No puedo resolver sin violar criterio 3: el brief de #2 dice 'eliminar duplicación de validateOrder',
>  pero el brief de #7 (ya mergeado) tiene 'mantener validateOrder en orderService separado del paymentService'.
>  Los dos intents son contradictorios — requiere re-design humano."

Acción humana sugerida: re-discutir scope de #2, posiblemente cerrar como dup o re-abrir como issue arquitectónico.
```

If everything merged clean, the "Bloqueados" section is omitted.

---

## Error handling

- **gh CLI not configured** → abort Step 1 with instructions to run `gh auth login`.
- **Not a git repo** → abort with "Run from a git repository root."
- **Base branch dirty + stash conflict on pop** → emit warning, do NOT auto-fix, point to stash list. Worse case the user runs `git stash pop` themselves.
- **Worktree directory already exists** (previous crash) → `git worktree remove --force` then recreate.
- **gh pr merge fails after subagent said MERGE** (e.g., branch protection, required reviews) → mark PR as `merge-blocked`, label, comment with the actual gh error, continue to next PR.
- **Subagent emits malformed XML** → retry once with appended `Reply ONLY with the XML envelope, no prose around it.`. If still malformed, mark PR as `merge-blocked` with reason `resolver-malformed-output`.

---

## What this skill does NOT do

- **No review judgment**: assumes PRs are already reviewed. If you need APPROVE/HOLD/BLOCK against the brief, do that first (manually, with `/sandcastle-merge-wave` Step 1, or with Matt Pocock's `/review`).
- **No PR creation, no branch creation**: only operates on already-open PRs.
- **No remote infrastructure**: doesn't depend on GitHub Actions, sandcastle-validate as a service, or any CI hosting.
- **No parallelism**: PRs merge serially by design. For parallel review of large batches, use `/sandcastle-merge-wave` (Docker).
- **No checkpoint recovery**: state lives in GitHub itself (closed PRs stay closed). Re-invoking the skill is idempotent — already-merged PRs are filtered out at discovery.
