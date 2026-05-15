---
name: merge-orchestrate
description: Run the merge-orchestrator skill — serial intent-aware merge of N open PRs in the current repo. Same flow as the skill auto-invocation, but explicit and discoverable via /help. Usage: `/merge-orchestrate` (auto-discover PRs) or `/merge-orchestrate #5,#7,#9` (explicit list). Flags: --strategy=merge|rebase, --step, --dry-run.
---

# /merge-orchestrate

Explicit invocation of the **merge-orchestrator** skill. Use when you prefer typing a command instead of relying on description matching.

## Behavior

This command is a thin wrapper: it loads the `merge-orchestrator` skill and runs its full flow with the arguments you passed.

The skill itself handles:

1. Pre-flight (gh auth, git repo, base branch detection, stash dirty working tree).
2. PR discovery (auto or from explicit list).
3. Intent gathering (cascade: issue brief → PR body → commits → diff).
4. Topological order from `Blocked by` deps + file-overlap semantic-risk pairs.
5. Preview + initial confirmation.
6. Serial merge loop per PR: refresh base → `gh pr update-branch` → ephemeral worktree → cascade validation → dispatch `merge-resolver` Opus subagent → execute host-side mutation based on `<action>`.
7. Restore stash + final report (table + bloqueados expanded).

## Arguments

- **Positional (optional):** a comma-separated list of PR numbers like `#5,#7,#9`. If omitted, auto-discovers via `gh pr list` filtered by base branch + non-draft + no `do-not-merge` label.
- **Flags:**
  - `--strategy=squash|merge|rebase` — merge strategy passed to `gh pr merge`. Default: `squash`.
  - `--step` — confirm before each merge (instead of only at start + on blocks).
  - `--dry-run` — preview only, never executes mutations.

## Examples

```
/merge-orchestrate
/merge-orchestrate #12,#15,#18
/merge-orchestrate --strategy=merge
/merge-orchestrate #5,#7 --step
/merge-orchestrate --dry-run
```

## When to choose `/merge-orchestrate` vs `/sandcastle-merge-wave`

- **`/merge-orchestrate`** (this command) — host-only, no Docker, serial, 2-7 PRs, fast to start, your context window grows as the wave runs.
- **`/sandcastle-merge-wave`** — Docker AFK, parallel reviewers, 8+ PRs, slower to start (image build, container boot), context window stays clean because containers absorb the load.

If you're hesitant, start with `/merge-orchestrate --dry-run` to see the planned order without executing anything.

## Read me first

The skill assumes **PRs are already reviewed**. It does not run an APPROVE/HOLD/BLOCK pass against the brief. If you want second-opinion review before merging:

- Manual: read each PR.
- Sandcastle: `/sandcastle-merge-wave` Step 1 (Docker, parallel reviewers).
- Matt Pocock's `/review` (when stable): per-PR.

After review, come back to `/merge-orchestrate` for the actual merge orchestration.

---

See the skill file `skills/merge-orchestrator/SKILL.md` for full implementation details.
