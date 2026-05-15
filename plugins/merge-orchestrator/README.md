# merge-orchestrator

Host-side intent-aware merge orchestrator for batches of open GitHub PRs. Runs entirely in your Claude Code session — no Docker, no Sandcastle SDK, no external CI.

Designed for the case where you have 2-7 open PRs (AFK-produced or human-produced) that need to be merged in correct order, with conflict resolution that respects the briefs.

## What it does

For each PR in the wave:

1. **Discover** open PRs targeting the current branch (auto, or from an explicit list).
2. **Gather intent** via cascade: linked issue's `## Agent Brief` → PR description → commits → diff.
3. **Compute topological order** from `## Blocked by` deps; mark semantic-risk pairs by file overlap.
4. **Preview and confirm** before starting.
5. **Per PR, serially:**
   - Refresh base, `gh pr update-branch` (auto-rebase).
   - Create an ephemeral worktree.
   - Run validation (preferring `scripts/sandcastle-validate.sh` if present, otherwise auto-detect package manager).
   - Dispatch the `merge-resolver` Opus subagent with the full intent packet.
   - Subagent recommends `<action>MERGE | HOLD | ABORT</action>` plus `<resolution>RESOLVED | INCOMPATIBLE | NOT_NEEDED</resolution>`.
   - **Host** (your Claude Code session) executes the recommendation: commit + force-push resolved conflicts if any, then `gh pr merge --squash --delete-branch`. The subagent never pushes.
6. **Skip transitive** if a dep blocked. **Stop only on `INCOMPATIBLE`**, otherwise auto-pilot.
7. **Restore stash + render report** (table + expanded section for blocked PRs).

## When to use this plugin

| Scenario | Choose |
|---|---|
| 2-7 open PRs to merge in order, intent-aware | `merge-orchestrator` |
| 8+ PRs, want parallel reviewers, can wait for Docker boot | `sandcastle-max` (`/sandcastle-merge-wave`) |
| One PR | `gh pr merge --squash` directly |
| Need APPROVE/HOLD/BLOCK review judgment first | Review first (manually or via sandcastle-merge-wave Step 1), then come here |

## Files

```
merge-orchestrator/
├── plugin.json
├── README.md
├── skills/
│   └── merge-orchestrator/SKILL.md      # auto-invocable on phrases like
│                                         # "mergeame los PRs", "intent-aware merge"
├── commands/
│   └── merge-orchestrate.md             # explicit /merge-orchestrate
└── agents/
    └── merge-resolver.md                # custom Opus subagent
                                         # (tools: Read, Edit, Bash, Grep, Glob)
```

## Requirements

- `gh` CLI configured (`gh auth login`).
- A git repo with at least one open PR targeting the current branch.
- Opus access on your Claude account (the subagent forces `model: opus`).

## Slash commands

- `/merge-orchestrate` — auto-discover open PRs and run the wave.
- `/merge-orchestrate #5,#7,#9` — explicit PR list.
- `/merge-orchestrate --dry-run` — preview only, no mutations.
- `/merge-orchestrate --step` — confirm before each merge.
- `/merge-orchestrate --strategy=merge|rebase` — override default squash.

## The 5 no-regression criteria

The `merge-resolver` subagent enforces these when resolving conflicts. When a resolution would violate any of them, it emits `INCOMPATIBLE` instead of forcing a merge.

1. **NO eliminate behavior required by any brief.**
2. **NO silence or skip tests to make the build pass.**
3. **NO "simplify" justified duplication.**
4. **NO introduce behavior not in any brief.**
5. **NO change public contracts without brief justification.**

See `agents/merge-resolver.md` for full details.

## What this plugin does NOT do

- No PR creation, no branch creation, no issue management.
- No review judgment (no APPROVE/HOLD/BLOCK pass against the brief).
- No parallelism (serial by design — for parallel reviewers, use `sandcastle-max`).
- No remote CI; validation runs locally (Docker if `sandcastle-validate.sh` is in the repo, otherwise native).
- No checkpoint files. State lives in GitHub — closed PRs stay closed; re-invoking is idempotent.

## Composition with the rest of `toolkit-leopoldo`

```
engineering-workflow:
  /grill-with-docs → /to-prd → /to-issues (ready-for-agent)
                                  │
                                  ▼
sandcastle-max:        /sandcastle-dispatch-wave   ← AFK Docker implementers
                                  │
                                  ▼
                              [N open PRs]
                                  │
                  ┌───────────────┴────────────────┐
                  ▼                                ▼
        host (small batch)                 Docker (large batch)
        /merge-orchestrate         /sandcastle-merge-wave + /sandcastle-pipeline
                  │                                │
                  └────────────────┬───────────────┘
                                   ▼
                             merged to base
```

Both merge tools enforce the same 5 no-regression criteria via similar resolver prompts. They differ in execution substrate (host vs Docker), parallelism (serial vs parallel reviewers), and overhead.

---

Built for Claude Code. Author: Leopoldo Bini. License: MIT.
