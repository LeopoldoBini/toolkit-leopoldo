---
name: merge-orchestrate
description: Serial intent-aware merge of N open PRs in the current repo. Host-only. Per PR: gathers intent (issue brief → PR body → commits → diff), computes topological order from `Blocked by` deps + file-overlap risk pairs, refreshes base, `gh pr update-branch`, ephemeral worktree, cascade validation, dispatches `merge-resolver` Opus subagent that enforces 5 no-regression criteria and emits `<action>MERGE|HOLD|ABORT</action>`. Host executes (squash --delete-branch default). Usage `/merge-orchestrate` (auto-discover) or `/merge-orchestrate #5,#7,#9` (explicit). Flags `--strategy=merge|rebase`, `--step`, `--dry-run`.
---

# /merge-orchestrate

## ⛔ Invocation gate — check BEFORE doing anything

Proceed ONLY if one of these holds:

1. The user explicitly typed `/merge-orchestrate` (or `/afk-pipeline`, whose playbook delegates here) in this session.
2. You are inside an active AFK pipeline run (`/goal`-wrapped session launched via `cc-afk`; `.host-orchestrator/pipelines/*.state.json` exists for the current goal).

If you reached this command any other way — e.g. you decided on your own that some open PRs "should be merged now" — **STOP NOW**. Do not merge anything. Tell Leo what you would run and let HIM invoke it. Rule of this marketplace: orchestration commands are never auto-invoked by the model.

Self-contained command. Orchestrates a serial, intent-aware merge of N open GitHub PRs entirely on host — no external CI. Uses the `merge-resolver` custom subagent (Opus) per PR for intent verification and conflict resolution, with the host as the single point of git mutation.

**When to use:**
- 2-7 open PRs you want merged in correct order without manually rebasing each.
- Mixed AFK + human PRs that touch related code (intent-aware resolution matters).

**When NOT to use:**
- 8+ PRs → split into batches of ≤7, ordered by the dependency graph.
- PRs not yet reviewed → review first (`/review-fleet` or manually).
- Single PR → `gh pr merge --squash` directly.

## Arguments

- **Positional (optional)**: comma-separated PR numbers like `#5,#7,#9`. If omitted, auto-discover via `gh pr list` filtered by base branch + non-draft + no `do-not-merge` label.

## Flags

| Flag | Default | Purpose |
|---|---|---|
| `--strategy=squash\|merge\|rebase` | `squash` | Merge strategy passed to `gh pr merge`. |
| `--step` | `false` | Confirm before each merge (default only confirms at start + on blocks). |
| `--dry-run` | `false` | Preview only, never executes mutations. |

## Examples

```
/merge-orchestrate
/merge-orchestrate #12,#15,#18
/merge-orchestrate --strategy=merge
/merge-orchestrate #5,#7 --step
/merge-orchestrate --dry-run
```

---

## Step 1 — Pre-flight checks

Run in parallel via the Bash tool:

```bash
git rev-parse --git-dir
gh auth status

BASE_BRANCH=$(git rev-parse --abbrev-ref HEAD)
BASE_BRANCH_SLUG=$(echo "$BASE_BRANCH" | tr '/' '-' | tr '[:upper:]' '[:lower:]')

git fetch origin "$BASE_BRANCH"
git pull --ff-only origin "$BASE_BRANCH" || {
  echo "ERROR: base branch '$BASE_BRANCH' diverged from remote — resolve manually first"
  exit 1
}
```

**Stash dirty working tree** so worktrees don't see it:

```bash
if ! git diff --quiet HEAD || [ -n "$(git status --porcelain)" ]; then
  STASH_REF=$(git stash create "merge-orchestrate pre-wave $(date -u +%Y%m%dT%H%M%S)")
  git stash store -m "merge-orchestrate pre-wave" "$STASH_REF"
  WAVE_STASHED=1
else
  WAVE_STASHED=0
fi
```

Persist `BASE_BRANCH`, `BASE_BRANCH_SLUG`, `WAVE_STASHED`, `STASH_REF` for final cleanup.

---

## Step 2 — PR discovery

If user passed `#5,#7,#9`, use those numbers. Otherwise:

```bash
gh pr list \
  --state open \
  --base "$BASE_BRANCH" \
  --draft=false \
  --json number,title,headRefName,baseRefName,body,labels,mergeable,files,createdAt,author \
  --limit 50
```

**Filter out:**
- PRs with label `do-not-merge`, `wip`, `hold`.
- PRs from `dependabot[bot]` unless explicitly listed.
- PRs not targeting `$BASE_BRANCH`.

If the candidate set is empty: "No open mergeable PRs found targeting `$BASE_BRANCH`." Exit.

---

## Step 3 — Intent gathering (cascade per PR)

For each PR, build an `intent` packet by cascading until one source resolves:

1. **Issue brief (preferred)**: parse PR body for `Closes #N`, `Fixes #N`, `Resolves #N`. Fetch:

   ```bash
   gh issue view N --json title,body,comments
   ```

   Look for `## Agent Brief` in body OR latest comment (engineering-workflow ≥ 2.1.0 single-brief invariant). If found, that's the canonical intent.

2. **PR description**: if no issue or no brief comment, use PR body.

3. **Commit log**: if PR body is trivial (`fix typo`, etc.):

   ```bash
   gh pr view N --json commits
   ```

4. **Diff only**: last resort. Mark the PR `low-intent`.

Store as `intent[N] = { source, content, issue }`. The `merge-resolver` subagent receives this packet.

---

## Step 4 — Topological order + semantic-risk pairs

### 4a. Dep graph

For each PR, parse `## Blocked by` section from the intent packet. Extract referenced issues; map each to its PR (PR linked via `Closes #N`). Build directed dep graph.

### 4b. File overlap → semantic-risk pairs

For each pair `(A, B)` of PRs, compute `overlap = |files(A) ∩ files(B)| > 0`. Mark pairs where:
- They overlap on ≥ 1 file, AND
- Neither `A→B` nor `B→A` is in the dep graph.

These are **semantic-risk pairs**: same file touched independently. The resolver receives the marker so it expects rebase conflicts and treats both intents as load-bearing.

### 4c. Topological sort

Kahn's algorithm. Stable tie-break: ascending PR number.

If the graph has a cycle: abort with the cycle listed. Cycles mean briefs are mis-decomposed → human intervention required.

Output: `merge_order = [PR1, PR2, ...]`.

---

## Step 5 — Preview + initial confirmation

```
## Merge Wave Preview — base: $BASE_BRANCH

Order (topological + tie-break):

| # | PR  | Title              | Intent source | Risk pairs            |
|---|-----|--------------------|---------------|-----------------------|
| 1 | #5  | feat: schema       | brief         | —                     |
| 2 | #7  | feat: api          | brief         | #2 (overlaps repo.ts) |
| 3 | #9  | feat: ui           | brief         | —                     |
| 4 | #2  | refactor: helpers  | pr-body       | #7 (overlaps repo.ts) |

Strategy: squash --delete-branch
Auto-pilot between merges. Will stop only on INCOMPATIBLE.
```

Ask via `AskUserQuestion`:
- **Proceed** — start the wave.
- **Edit selection** — remove PRs or reorder; re-validate dep graph; re-show preview.
- **Abort** — no mutation.

If `--dry-run`: stop here. Report what would happen.

---

## Step 6 — Serial merge loop

Tracking state:

```
merged = []
blocked = []     # explicit INCOMPATIBLE
skipped = []     # transitive: dep on a blocked PR
```

For each `PR` in `merge_order`:

### 6.0. Skip if transitive

If any dep is in `blocked` or `skipped`: append `PR` to `skipped` with reason `"dep #X blocked"`. Continue.

### 6.1. Refresh base (idempotent)

```bash
git fetch origin "$BASE_BRANCH"
git pull --ff-only origin "$BASE_BRANCH"
```

### 6.2. Auto-rebase via gh

```bash
gh pr update-branch "$PR" 2>&1 | tee /tmp/mo-rebase-$PR.log
```

If clean → `rebase_status=clean`. If conflict → `rebase_status=conflict`.

### 6.3. Ephemeral worktree

```bash
WT=".merge-orchestrate/wt-pr-$PR"
mkdir -p .merge-orchestrate
git worktree add --force "$WT" "$(gh pr view $PR --json headRefName -q .headRefName)" 2>&1
```

If checkout fails after a `gh pr update-branch` force-push: `git fetch --all` and retry once.

### 6.4. Pre-merge validation (cascade auto-detect)

In `$WT`:

```bash
cd "$WT"

if [ -x scripts/wave-validate.sh ]; then
  ./scripts/wave-validate.sh "$PR" 2>&1 | tee /tmp/mo-validate-$PR.log
  validate_exit=$?
else
  if   [ -f bun.lockb ] || [ -f bun.lock ]; then PM=bun
  elif [ -f pnpm-lock.yaml ];                then PM=pnpm
  elif [ -f yarn.lock ];                     then PM=yarn
  elif [ -f package-lock.json ];             then PM=npm
  else PM=""
  fi

  validate_exit=0
  if [ -n "$PM" ]; then
    $PM install --frozen-lockfile 2>&1 | tee /tmp/mo-install-$PR.log || true
    if grep -q '"typecheck"' package.json 2>/dev/null; then
      $PM run typecheck 2>&1 | tee -a /tmp/mo-validate-$PR.log || validate_exit=1
    elif command -v tsc >/dev/null 2>&1 && [ -f tsconfig.json ]; then
      $PM exec tsc --noEmit 2>&1 | tee -a /tmp/mo-validate-$PR.log || validate_exit=1
    fi
    if grep -q '"test"' package.json 2>/dev/null; then
      $PM test 2>&1 | tee -a /tmp/mo-validate-$PR.log || validate_exit=1
    fi
  else
    echo "No detected package manager — skipping validation (low confidence merge)"
  fi
fi
cd - >/dev/null
```

Capture `validate_exit` for the subagent's input packet.

### 6.5. Dispatch `merge-resolver` subagent

```
Agent({
  description: "Resolve PR #$PR",
  subagent_type: "merge-resolver",
  prompt: <packet below>
})
```

Packet template:

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
(For each pair (PR_already_merged, $PR) marked in Step 4b: PR number, intent summary, files overlapping, key diff hunks.)

## Your job
1. Read the intent packet. Understand the contract.
2. If rebase_status=conflict: navigate $WT, resolve conflicts respecting the 5 no-regression criteria in your system prompt.
3. If validation failed: read /tmp/mo-validate-$PR.log, decide if the failure is rebase-induced (resolve) or pre-existing (ABORT).
4. Emit recommendation in this exact XML format:

<resolution>RESOLVED | INCOMPATIBLE | NOT_NEEDED</resolution>
<action>MERGE | HOLD | ABORT</action>
<summary>One sentence on what you did and why.</summary>
<details>Free-form: criteria weighed, conflicts resolved, why this action.</details>
<block-reason>(if HOLD or ABORT) IMPLEMENTATION | BRIEF_AMBIGUOUS | CODEBASE_UNEXPECTED | VALIDATION_FAILED</block-reason>

Do NOT execute `git push`, `gh pr merge`, or any remote-mutating command. Host will execute.
```

Parse the response for `<action>`, `<resolution>`, `<block-reason>`, `<summary>`, `<details>`.

### 6.6. Act on recommendation (host executes mutations)

```bash
case "$action" in
  MERGE)
    if [ "$resolution" = "RESOLVED" ]; then
      cd "$WT"
      git add -A
      git commit -m "chore: resolve merge conflicts with $BASE_BRANCH (intent-aware via merge-resolver)" || true
      git push --force-with-lease origin HEAD
      cd - >/dev/null
    fi
    STRATEGY="${MERGE_STRATEGY:-squash}"
    gh pr merge "$PR" --"$STRATEGY" --delete-branch
    merged+=("$PR")
    ;;
  HOLD|ABORT)
    gh pr edit "$PR" --add-label "merge-blocked"
    gh pr comment "$PR" --body "merge-orchestrate: $action with reason \`$block_reason\`. Resolver summary: $summary"
    blocked+=("$PR:$block_reason:$summary")
    ;;
esac
```

### 6.7. Cleanup worktree

```bash
git worktree remove --force "$WT" || rm -rf "$WT"
rmdir .merge-orchestrate 2>/dev/null || true
```

### 6.8. Step mode (optional)

If `--step`: after each PR, `AskUserQuestion`: continue / stop here.

---

## Step 7 — Final cleanup + report

### 7a. Restore stash

```bash
if [ "$WAVE_STASHED" = "1" ]; then
  git stash pop || echo "WARN: stash pop had conflicts — preserved at $(git stash list | head -1)"
fi
```

### 7b. Render report

```markdown
## Merge Wave Report — $BASE_BRANCH ($(date -u +%Y-%m-%dT%H:%M))

| PR  | Title              | Status   | Reason                              |
|-----|--------------------|----------|-------------------------------------|
| #5  | feat: schema       | merged   | clean rebase                        |
| #7  | feat: api          | merged   | resolved 2 conflicts (intent-aware) |
| #9  | feat: ui           | skipped  | dep on #5 → merged                  |
| #2  | refactor: helpers  | blocked  | INCOMPATIBLE                        |

### Bloqueados

**#2 — refactor: helpers**

> "Cannot resolve without violating criterion 3: #2's brief says 'remove validateOrder duplication',
>  but #7's brief (already merged) says 'keep validateOrder separate in orderService vs paymentService'.
>  Intents are mutually exclusive — requires human re-design."
```

If everything merged clean, omit "Bloqueados".

---

## Error handling

- **gh not configured** → abort Step 1 with `gh auth login` instruction.
- **Not a git repo** → "Run from a git repository root."
- **Stash pop conflict** → warn, point to `git stash list`. Do NOT auto-fix.
- **Worktree dir exists** (previous crash) → `git worktree remove --force` then recreate.
- **`gh pr merge` fails after subagent said MERGE** (branch protection, required reviews) → label `merge-blocked`, comment with gh error, continue to next PR.
- **Subagent emits malformed XML** → retry once with appended `Reply ONLY with the XML envelope, no prose.`. If still malformed: label `merge-blocked` + reason `resolver-malformed-output`.

---

## Tip

Start with `/merge-orchestrate --dry-run` to see the planned order without executing anything.

---

## What this command does NOT do

- **No review judgment**: assumes PRs are reviewed. For a review pass, use `/review-fleet` (engineering-workflow) or `/review`.
- **No PR creation, no branch creation**: only operates on already-open PRs. For PR creation use `/parallel-implement-wave` (same plugin).
- **No remote infrastructure**: no GH Actions, no service dependencies.
- **No parallelism**: serial by design.
- **No checkpoint recovery**: state lives in GitHub itself (closed PRs stay closed); re-invoking is idempotent.
