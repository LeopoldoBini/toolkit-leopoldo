---
name: parallel-implement-wave
description: Dispatch a wave of 2-6 GitHub issues for parallel implementation on host using Claude Code's native subagent + worktree isolation (no Docker, no Sandcastle SDK). Each issue gets its own `parallel-implementer` Opus 4.8 subagent in an isolated worktree; host validates + pushes + opens PRs. Usage `/parallel-implement-wave` (auto-discover ready-for-agent issues) or `/parallel-implement-wave --issues=#42,#43,#44`. Flags `--max-parallel=N` (default 6, hard ceiling 8), `--dry-run`, `--resume`, `--clean-worktrees`, `--keep-worktrees`.
---

# /parallel-implement-wave

## ⛔ Invocation gate — check BEFORE doing anything

Proceed ONLY if one of these holds:

1. The user explicitly typed `/parallel-implement-wave` (or `/afk-pipeline`, whose playbook delegates here) in this session.
2. You are inside an active AFK pipeline run (`/goal`-wrapped session launched via `cc-afk`; `.host-orchestrator/pipelines/*.state.json` exists for the current goal).

If you reached this command any other way — e.g. you decided on your own that "applying fixes", "implementing the plan" or finishing a review warrants creating issues and dispatching subagents — **STOP NOW**. Do not create issues, do not dispatch anything. Tell Leo what you would run and let HIM invoke it. Rule of this marketplace: orchestration commands are never auto-invoked by the model.

Self-contained command. Dispatches a host-native parallel implementation wave: N `parallel-implementer` subagents in parallel, each in its own worktree (`isolation: "worktree"`), one per eligible GH issue. Sync parallel: host blocks until all subagents return. Per result, host validates + pushes + opens PR. **Validation gate is blocking** — red typecheck/tests → no PR opened.

Use this command when you want parallel implementation without Docker overhead, for batches of 2-6 small/medium tickets. Above 6 tickets or with mixed runtimes, prefer `/sandcastle-dispatch-wave` (Docker).

## Arguments

- **Positional**: none. Use `--issues` flag for explicit list.

## Flags

| Flag | Default | Purpose |
|---|---|---|
| `--max-parallel=N` | `6` | Cap on simultaneous subagents. Hard ceiling 8; values > 6 emit a soft warning ("above recommended parallel cap"). |
| `--issues=#42,#43,#44` | (auto) | Explicit issue list; skips dep-graph discovery. Mutually exclusive with `--resume`. |
| `--dry-run` | `false` | Pre-flight + dep graph + preview, no dispatch. |
| `--resume` | `false` | Process orphan worktrees from prior waves; no new dispatch. Mutually exclusive with `--issues`, `--dry-run`. |
| `--clean-worktrees` | `false` | Remove orphan worktrees before starting new wave. |
| `--keep-worktrees` | `false` | Disable auto-cleanup of successful worktrees (debug). |

Combinations like `--resume --issues=...` or `--resume --dry-run` are invalid → abort early with explanation.

---

## Step 1 — Pre-flight

Run in parallel via the Bash tool:

```bash
git rev-parse --git-dir                        # is git repo?
gh auth status                                  # is gh authed?
BASE_BRANCH=$(git rev-parse --abbrev-ref HEAD)
BASE_BRANCH_SLUG=$(echo "$BASE_BRANCH" | tr '/' '-' | tr '[:upper:]' '[:lower:]')
git fetch origin "$BASE_BRANCH"
git pull --ff-only origin "$BASE_BRANCH" || {
  echo "ERROR: base branch '$BASE_BRANCH' diverged from remote — resolve manually first"
  exit 1
}
```

If `gh auth status` fails, attempt `GH_TOKEN`-based fallback (read from `gh auth token` or env). If still no auth, abort with instructions.

**Stash dirty working tree** so worktrees don't inherit modifications:

```bash
if ! git diff --quiet HEAD || [ -n "$(git status --porcelain)" ]; then
  STASH_REF=$(git stash create "host-orchestrator pre-wave $(date -u +%Y%m%dT%H%M%S)")
  git stash store -m "host-orchestrator pre-wave" "$STASH_REF"
  WAVE_STASHED=1
else
  WAVE_STASHED=0
fi
```

Persist `BASE_BRANCH`, `BASE_BRANCH_SLUG`, `WAVE_STASHED`, `STASH_REF` in session for final cleanup.

**Orphan worktree detection** (always runs):

```bash
git worktree list --porcelain | grep -E '^worktree .*\.claude/worktrees/' | awk '{print $2}'
```

For each entry that's not the current main worktree:
- Check `git -C <path> log --oneline -1` for commit subject (gives a hint about which issue).
- Collect into `ORPHAN_WORKTREES` list with detected issue number if possible.

If `--clean-worktrees`: remove each via `git worktree remove --force <path>`. Continue.
If `--resume`: jump to Step 7 with `ORPHAN_WORKTREES` as the result set. No dispatch.
Otherwise: surface in the preview (Step 3) so user knows they exist.

**Explicitly NOT done in pre-flight**:
- No `docker info` check (we don't use Docker).
- No `.sandcastle/resources.json` reality probe (subagents share the host environment).
- No `CLAUDE_CODE_OAUTH_TOKEN` extraction (subagents use the host's session auth).

---

## Step 2 — Dep graph read

Skip this step if `--issues=...` was passed. Otherwise:

```bash
gh issue list \
  --search 'label:"ready-for-agent" no:pr' \
  --state open \
  --json number,title,labels,body,assignees \
  --limit 50
```

Accept both label conventions: `ready-for-agent` AND `state/ready-for-agent` (the dispatcher tolerates either, mirror sandcastle).

For each issue, parse `## Blocked by #N` from body. For each blocker:

```bash
gh issue view N --json closedAt
```

A blocker is satisfied if `closedAt` is non-null. Map blocker issues to PRs they correspond to (PR linked to issue via `Closes #N` cascade is irrelevant here — we only care about issue closure).

For each candidate issue:

```bash
gh pr list --search "in:title issue-${N}" --state open --json number,state
```

If a PR is open for this issue, it's **in flight**; skip.

### Bucketing

- **eligible**: deps closed, no in-flight PR, label `ready-for-agent` (or alias).
- **blocked-by-dep**: at least one blocker not closed.
- **skipped (manual)**: label `agent-blocked` (generic, human gate).
- **retry**: label `agent-stuck`, `agent-crashed`, `agent-push-failed`, or `agent-blocked-rebrief` AND no in-flight PR → re-include as eligible, marked `[RETRY]`.

---

## Step 3 — Preview

Render this exact table (monospace unicode). Sort eligible by issue number ascending. Cap by `--max-parallel`:

```
WAVE PREVIEW — host-orchestrator / parallel-implement-wave
Base: <BASE_BRANCH>   Max parallel: <N>   Substrate: host (no Docker)

┌────────┬────────────────────────────────────┬─────────────┬─────────┬────────────────────────┐
│ Issue  │ Title                              │ Status      │ Deps    │ Notes                  │
├────────┼────────────────────────────────────┼─────────────┼─────────┼────────────────────────┤
│ #42    │ Add payment provider abstraction   │ ELIGIBLE    │ -       │                        │
│ #43    │ Wire checkout to payment provider  │ ELIGIBLE    │ -       │ [RETRY: agent-crashed] │
│ #44    │ Add Stripe adapter                 │ ELIGIBLE    │ -       │                        │
│ #45    │ Add MercadoPago adapter            │ ELIGIBLE    │ -       │                        │
│ #46    │ Checkout success page              │ BLOCKED-DEP │ #43     │ waits                  │
│ #47    │ Receipt email                      │ SKIPPED     │ -       │ label: agent-blocked   │
└────────┴────────────────────────────────────┴─────────────┴─────────┴────────────────────────┘

Will dispatch: 4 issues in parallel (#42, #43, #44, #45)
Will skip:     2 issues (#46 deps, #47 manual)
```

If eligible count > `--max-parallel`, render a second "Próxima ola" table with the overflow.

If orphan worktrees exist:

```
⚠ Worktrees conservados de waves anteriores:
   .claude/worktrees/<id>  (issue #38, BLOCKED:BRIEF_AMBIGUOUS)
   .claude/worktrees/<id>  (issue #39, agent-push-failed)

   Para procesarlos: /parallel-implement-wave --resume
   Para limpiarlos:  /parallel-implement-wave --clean-worktrees
```

If `--dry-run`: stop here. Print "DRY-RUN — no dispatch."

---

## Step 4 — Confirmation

Call `AskUserQuestion` with this exact shape (single-select):

- **"Lanzar todos"** — Dispatch the N eligible issues in parallel.
- **"Seleccionar subset"** — Open a second `AskUserQuestion` (multi-select) listing each eligible issue, then dispatch the chosen ones.
- **"Cancelar"** — Abort. No mutation. Stash NOT restored yet (user may re-invoke).

On cancel: print "Wave cancelada. Stash preservado en `$STASH_REF` (corré `git stash pop` para restaurar manualmente o re-invocá el comando)."

---

## Step 5 — Compose per-issue prompts (in-memory)

For each issue in the launch set, **without writing to disk**, build the prompt the host will pass to `Agent(...)`. Structure:

```
You are parallel-implementer for issue #N.

## Your worktree
Claude Code has created an isolated git worktree for you and switched your CWD into it. Run `pwd` to confirm. All your commits go here. Do NOT cd elsewhere. Do NOT push.

## Base branch
$BASE_BRANCH (synced with origin moments ago)

## Reading order (do this first)
1. CLAUDE.md (root + subdirs relevant to the slice)
2. CONTEXT.md if present
3. The brief below
4. docs/phase1-decisions.md or any doc linked in the brief (skip silently if missing)
5. Relevant code (Read + Grep + Glob — anchor to the brief, do not boil the ocean)

## Issue brief (inlined)
$(gh api repos/{owner}/{repo}/issues/N/comments --jq '[.[] | select(.body | contains("## Agent Brief"))] | last | .body')

If no `## Agent Brief` comment exists, fall back to:
$(gh issue view N --json body --jq .body)

## Your contract
Follow your system prompt's 5 sections exactly:
  1. Vertical slice (all relevant layers, one observable output)
  2. TDD red-green-reality-first per acceptance criterion
  3. Tests must be useful (7 anti-patterns forbidden, bronze rule self-applied)
  4. Self-check before emitting COMPLETE
  5. Hard constraints (no push, no gh pr create, no cd outside worktree, no Agent)

## Output
Emit the <implementation-result>...</implementation-result> XML envelope at the end. No prose around it.
```

Pass this string as the `prompt` argument to `Agent(...)`. The Agent's own system prompt (from `agents/parallel-implementer.md`) provides the full discipline; this composed prompt only inlines per-issue context.

---

## Step 6 — Sync parallel dispatch (the core diff vs Docker)

In **one Bash-free message**, emit N `Agent(...)` tool calls in parallel:

```
Agent({
  description: "Implement issue #42",
  subagent_type: "parallel-implementer",
  isolation: "worktree",
  prompt: <composed prompt for #42 from Step 5>
})
Agent({
  description: "Implement issue #43",
  subagent_type: "parallel-implementer",
  isolation: "worktree",
  prompt: <composed prompt for #43 from Step 5>
})
... (N total, one per eligible-selected issue)
```

Claude Code creates an isolated worktree per subagent automatically (via `isolation: "worktree"`). Host blocks until all N return. Each result will include:

- The subagent's final XML envelope (parse for `<implementation-result>`).
- The worktree path (in result metadata) — needed by Step 7 for git ops.
- The branch name Claude Code generated.

**Write to audit log** before and after dispatch:

```bash
TS=$(date -u +%Y-%m-%dT%H-%M-%S)
LOG=".host-orchestrator/waves/${TS}.log"
mkdir -p .host-orchestrator/waves
echo "$(date -u +%FT%TZ)  wave-start  issues=[$ISSUES_JOINED]" >> "$LOG"
# (After dispatch returns)
echo "$(date -u +%FT%TZ)  dispatch-complete  count=$N" >> "$LOG"
```

---

## Step 7 — Per-result processing (serial, on host)

Iterate results in ascending issue-number order. For each:

### 7.0. Parse XML

Extract from the subagent's final message the `<implementation-result>...</implementation-result>` block. If malformed: treat as `<promise>BLOCKED</promise>` with `<block-reason>UNEXPECTED_ERROR</block-reason>` and `<details>` = the raw output.

```bash
echo "$(date -u +%FT%TZ)  result  issue=$N  promise=$PROMISE  branch=$BRANCH" >> "$LOG"
```

### 7.1. If BLOCKED

```bash
# Label by block-reason
case "$BLOCK_REASON" in
  BRIEF_AMBIGUOUS)        LBL="agent-blocked-rebrief" ;;
  RESOURCE_UNREACHABLE)   LBL="agent-stuck" ;;
  INCOMPATIBLE_WITH_BASE) LBL="agent-blocked" ;;
  OUT_OF_SCOPE)           LBL="agent-blocked" ;;
  UNEXPECTED_ERROR|*)     LBL="agent-crashed" ;;
esac

gh issue edit "$N" --add-label "$LBL"
gh issue comment "$N" --body "$(cat <<EOF
**parallel-implement-wave — BLOCKED**

Reason: \`$BLOCK_REASON\`

$DETAILS

${SUGGESTED_CLARIFICATION:+## Suggested clarification\n$SUGGESTED_CLARIFICATION}

Worktree conservado en: \`$WORKTREE_PATH\`
EOF
)"

echo "$(date -u +%FT%TZ)  blocked  issue=$N  reason=$BLOCK_REASON  worktree=$WORKTREE_PATH" >> "$LOG"
# Do NOT remove worktree — kept for inspection
```

Continue to next result.

### 7.2. If COMPLETE — rename branch

```bash
NEW_BRANCH="agent/${BASE_BRANCH_SLUG}/issue-${N}"

# Delete any stale local + remote branch with this name (retries from prior waves)
git branch -D "$NEW_BRANCH" 2>/dev/null || true
git push origin --delete "$NEW_BRANCH" 2>/dev/null || true

# Rename the auto-generated branch inside the worktree
git -C "$WORKTREE_PATH" branch -m "$NEW_BRANCH"
```

### 7.3. Validation gate (blocking)

```bash
cd "$WORKTREE_PATH"

if [ -x scripts/sandcastle-validate.sh ]; then
  ./scripts/sandcastle-validate.sh "$N" 2>&1 | tee /tmp/ho-validate-$N.log
  VALIDATE_EXIT=$?
else
  # Auto-detect package manager
  if   [ -f bun.lockb ] || [ -f bun.lock ]; then PM=bun
  elif [ -f pnpm-lock.yaml ];                then PM=pnpm
  elif [ -f yarn.lock ];                     then PM=yarn
  elif [ -f package-lock.json ];             then PM=npm
  else PM=""
  fi

  VALIDATE_EXIT=0
  if [ -n "$PM" ]; then
    $PM install --frozen-lockfile 2>&1 | tee /tmp/ho-install-$N.log || true
    # typecheck if defined or tsc available
    if grep -q '"typecheck"' package.json 2>/dev/null; then
      $PM run typecheck 2>&1 | tee /tmp/ho-validate-$N.log || VALIDATE_EXIT=1
    elif command -v tsc >/dev/null 2>&1 && [ -f tsconfig.json ]; then
      $PM exec tsc --noEmit 2>&1 | tee /tmp/ho-validate-$N.log || VALIDATE_EXIT=1
    fi
    # tests if "test" script present
    if grep -q '"test"' package.json 2>/dev/null; then
      $PM test 2>&1 | tee -a /tmp/ho-validate-$N.log || VALIDATE_EXIT=1
    fi
  else
    echo "No package manager detected — skipping JS validation, agent self-validated."
  fi
fi

cd - >/dev/null

echo "$(date -u +%FT%TZ)  validate  issue=$N  status=$([ $VALIDATE_EXIT -eq 0 ] && echo green || echo red)" >> "$LOG"
```

If `$VALIDATE_EXIT != 0`:

```bash
gh issue edit "$N" --add-label "afk-checks-failed"
gh issue comment "$N" --body "$(cat <<EOF
**parallel-implement-wave — VALIDATION FAILED**

The subagent emitted COMPLETE but the host validation gate (typecheck + tests) failed.
No PR was opened.

\`\`\`
$(tail -200 /tmp/ho-validate-$N.log)
\`\`\`

Worktree conservado en: \`$WORKTREE_PATH\`. Inspeccioná y o corregís ahí + push manual, o limpiás con \`git worktree remove --force $WORKTREE_PATH\` y volvés a despachar.
EOF
)"
# Do NOT cleanup worktree
```

Continue to next result.

### 7.4. Push (with retry)

```bash
PUSH_OK=0
for ATTEMPT in 1 2; do
  if git -C "$WORKTREE_PATH" push -u origin "$NEW_BRANCH" 2>/tmp/ho-push-$N.log; then
    PUSH_OK=1
    break
  fi
  sleep 3
done

echo "$(date -u +%FT%TZ)  push  issue=$N  branch=$NEW_BRANCH  ok=$PUSH_OK" >> "$LOG"
```

If `PUSH_OK=0` after 2 attempts:

```bash
gh issue edit "$N" --add-label "agent-push-failed"
gh issue comment "$N" --body "$(cat <<EOF
**parallel-implement-wave — PUSH FAILED**

\`\`\`
$(cat /tmp/ho-push-$N.log)
\`\`\`

Branch local en: \`$WORKTREE_PATH\` (\`$NEW_BRANCH\`).
Para pushear manualmente: \`git -C $WORKTREE_PATH push -u origin $NEW_BRANCH\`
EOF
)"
# Do NOT cleanup worktree
```

Continue to next result.

### 7.5. Open PR (with retry)

Save the agent-provided PR body to a temp file (preserves multi-line):

```bash
PR_BODY_FILE=$(mktemp)
cat > "$PR_BODY_FILE" <<'EOF'
<pr-body content from XML>
EOF

PR_OK=0
PR_URL=""
for ATTEMPT in 1 2; do
  if PR_URL=$(gh pr create \
      --base "$BASE_BRANCH" \
      --head "$NEW_BRANCH" \
      --title "<pr-title from XML>" \
      --body-file "$PR_BODY_FILE" \
      --label "afk-agent-pr" 2>/tmp/ho-pr-$N.log); then
    PR_OK=1
    break
  fi
  sleep 3
done

echo "$(date -u +%FT%TZ)  pr-create  issue=$N  ok=$PR_OK  url=$PR_URL" >> "$LOG"
```

If `PR_OK=0`:

```bash
# Salvage the PR body so it isn't lost
mkdir -p .host-orchestrator/orphan-prs
cp "$PR_BODY_FILE" ".host-orchestrator/orphan-prs/issue-${N}.md"

gh issue comment "$N" --body "$(cat <<EOF
**parallel-implement-wave — PR CREATE FAILED (branch pushed OK)**

Branch \`$NEW_BRANCH\` is pushed. Recreate the PR manually:

\`\`\`bash
gh pr create --base $BASE_BRANCH --head $NEW_BRANCH \\
  --title "<original title>" \\
  --body-file .host-orchestrator/orphan-prs/issue-${N}.md \\
  --label afk-agent-pr
\`\`\`

Error:
\`\`\`
$(cat /tmp/ho-pr-$N.log)
\`\`\`
EOF
)"
# Do NOT cleanup worktree (orphan-prs file is salvage)
```

### 7.6. Cleanup worktree (only on full success)

If COMPLETE + validate green + push OK + PR OK AND `--keep-worktrees` was NOT passed:

```bash
git worktree remove --force "$WORKTREE_PATH"
echo "$(date -u +%FT%TZ)  cleanup  issue=$N  worktree_removed=$WORKTREE_PATH" >> "$LOG"
```

Otherwise conserve.

---

## Step 8 — Stash pop

```bash
if [ "$WAVE_STASHED" = "1" ]; then
  git stash pop 2>&1 || echo "WARN: stash pop conflict — stash preserved at $(git stash list | head -1)"
fi
```

---

## Step 9 — Final report

Render this exact format:

```markdown
## Wave Report — host-orchestrator / parallel-implement-wave
Timestamp: <ISO>
Base: <BASE_BRANCH>
Dispatched: N

| Issue | Outcome             | Detail                                                |
|-------|---------------------|-------------------------------------------------------|
| #42   | PR_OPENED           | #56 — feat(pay): add provider abstraction             |
| #43   | PR_OPENED           | #57 — feat(checkout): wire to provider                |
| #44   | VALIDATION_FAILED   | typecheck red; worktree conservado                    |
| #45   | BLOCKED             | BRIEF_AMBIGUOUS — see issue comment                   |

### Worktrees conservados (N)

- `#44` → `.claude/worktrees/<id>` (validation failed)
- `#45` → `.claude/worktrees/<id>` (BRIEF_AMBIGUOUS)

### Resumen
- PRs abiertos: 2  (#56, #57)
- Bloqueados:    1  (#45) — labeled `agent-blocked-rebrief`
- Failed:        1  (#44) — labeled `afk-checks-failed`

Audit log completo: `.host-orchestrator/waves/<TS>.log`
```

---

## Audit log format reference

`.host-orchestrator/waves/<TS>.log` is append-only. Each line is `<iso-utc>  <event>  <key=value>...`:

```
2026-05-21T14:23:11Z  wave-start          issues=[42,43,44,45]
2026-05-21T14:23:11Z  dispatch-complete   count=4
2026-05-21T14:31:02Z  result              issue=42  promise=COMPLETE  branch=...
2026-05-21T14:31:15Z  validate            issue=42  status=green
2026-05-21T14:31:22Z  push                issue=42  branch=agent/main/issue-42  ok=1
2026-05-21T14:31:30Z  pr-create           issue=42  ok=1  url=https://github.com/.../pull/56
2026-05-21T14:31:30Z  cleanup             issue=42  worktree_removed=.claude/worktrees/...
2026-05-21T14:31:31Z  result              issue=44  promise=COMPLETE  branch=...
2026-05-21T14:32:03Z  validate            issue=44  status=red
2026-05-21T14:32:04Z  blocked             issue=44  reason=afk-checks-failed  worktree=.claude/worktrees/...
```

The host writes one line per state transition. Reading this log post-mortem tells you exactly how far the wave got and what worktrees remain to inspect.

---

## When to choose `/parallel-implement-wave` vs `/sandcastle-dispatch-wave`

| Scenario | Choose |
|---|---|
| 2-6 small/medium issues, same runtime, want fast start | `/parallel-implement-wave` (this) |
| 7+ issues, or runtime-mixed, or want full AFK (close laptop) | `/sandcastle-dispatch-wave` (Docker) |
| 1 issue | Implement it yourself directly |

The two share the brief format (engineering-workflow ≥ 2.1.0 single-`## Agent Brief` invariant) and the PR label (`afk-agent-pr`), so downstream CI and merge workflows don't need to distinguish substrate.

---

## What this command does NOT do

- **No automatic merging**: opens PRs only. Use `/merge-orchestrate` (same plugin) for serial merge of the resulting PRs.
- **No review pass**: assumes the brief is the contract. For APPROVE/HOLD/BLOCK reviewer agents, use `/sandcastle-merge-wave` Step 1.
- **No Level 2 / Level 3 resource reality checks**: subagents share the host environment; reality is already aligned. If your project needs Level 1/2/3 anti-mock infrastructure, use `/sandcastle-dispatch-wave`.
- **No cross-issue dependency cascade in one invocation**: if issue B depends on issue A, you must run two waves (A first, then merge, then B). For chained pipelines, a future `/host-pipeline` command (same plugin) will cover that.
