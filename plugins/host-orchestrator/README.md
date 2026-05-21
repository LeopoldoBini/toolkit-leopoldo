# host-orchestrator

Host-side orchestrator for parallel implementation **and** serial merge of GitHub issues and PRs. Runs entirely in your Claude Code session using **native subagents + worktree isolation** — no Docker, no Sandcastle SDK, no OAuth token extraction, no external CI.

Two slash commands cover the two phases of the agent pipeline on host:

| Phase | Command | Mode | Volume sweet spot |
|---|---|---|---|
| Implement | `/parallel-implement-wave` | Parallel (sync, N subagents at once) | 2-6 issues |
| Merge | `/merge-orchestrate` | Serial (one PR at a time, auto-pilot between) | 2-7 PRs |

Both commands share the same DNA: Claude Code's native primitives (`Agent` tool with `isolation: "worktree"`, sync parallel dispatch, host-side git mutations), custom Opus subagents, and the host as the **single point of remote mutation** (the subagents never push, never call `gh pr create`, never call `gh pr merge`).

## Migration from `merge-orchestrator` v0.1.0

This plugin is the **rename + augment** of the former `merge-orchestrator` plugin. v2.0.0 changes vs v0.1.0:

- **Renamed** to `host-orchestrator`. The marketplace entry, plugin directory, and `plugin.json` name all changed.
- **Added** the new command `/parallel-implement-wave` + custom subagent `parallel-implementer` (the missing parallel-implementation counterpart to merge-orchestrator).
- **Removed** the auto-invocable skill (`skills/merge-orchestrator/SKILL.md`). The flow it contained is now inlined directly in the slash command `commands/merge-orchestrate.md`. Slash commands only — no auto-invocation by phrase matching.
- **Kept unchanged**: `agents/merge-resolver.md`, the `/merge-orchestrate` command's flags and behavior.

To migrate your local install:

```bash
claude plugin uninstall merge-orchestrator
claude plugin install host-orchestrator@toolkit-leopoldo --scope project
# Repeat in each project where you used merge-orchestrator
```

If you had memory references to `merge-orchestrator` as a plugin name, update them — the plugin name is now `host-orchestrator`, but **`/merge-orchestrate` is still the slash command** (unchanged).

---

## `/parallel-implement-wave` — host-native parallel implementation

Dispatches 2-6 GitHub issues for parallel implementation. Each issue gets its own `parallel-implementer` Opus subagent in an isolated git worktree (created by Claude Code via `isolation: "worktree"`). Host blocks until all subagents return their XML envelopes, then per result runs validation → push → `gh pr create`.

### Mental model

```
You:   /parallel-implement-wave
Host:  pre-flight → dep graph → preview → confirm → compose prompts
Host:  [Agent(#42), Agent(#43), Agent(#44), Agent(#45)]   (parallel, one message)
                ↓         ↓         ↓         ↓
            worktree  worktree  worktree  worktree     (isolated, native)
            Opus impl Opus impl Opus impl Opus impl    (TDD + vertical slice)
                ↓         ↓         ↓         ↓
            <impl-    <impl-    <impl-    <impl-
             result>   result>   result>   result>
                       (all return; host resumes)
Host:  per result:
         rename branch → validate (typecheck + tests)
         if green: push → gh pr create --label afk-agent-pr → cleanup worktree
         if red:   conserve worktree, label issue, comment
Host:  stash pop → final report + audit log path
```

### Discipline of the subagent

The `parallel-implementer` Opus subagent (`agents/parallel-implementer.md`) is bound by:

1. **Vertical slice definition**: must touch all relevant layers of the user story (entry + middle + destination + observable output), not a horizontal cut.
2. **TDD red-green-reality-first per criterion**: one failing test per acceptance criterion before implementation, against real resources (DB / HTTP / queues reachable from the host).
3. **7 anti-patterns of tests are forbidden** (tautologies, existence-only, mocking-the-SUT, magic-number passthrough, `.skip`/`.only`, generic error catching, coverage padding).
4. **Bronze rule self-check**: "would this test fail if I deleted the implementation?" — applied to each new test before emitting COMPLETE.
5. **Hard constraints triple-stated**: no push, no `gh pr create`, no `gh pr merge`, no `cd` outside worktree, no `Agent(...)`. Host owns all remote mutations.

### Flags

| Flag | Default | Purpose |
|---|---|---|
| `--max-parallel=N` | `6` | Cap of simultaneous subagents. Hard ceiling 8 with soft warning when >6 (Opus quota burn). |
| `--issues=#42,#43` | (auto) | Explicit list; skips dep-graph discovery. |
| `--dry-run` | `false` | Pre-flight + preview, no dispatch. |
| `--resume` | `false` | Process orphan worktrees from prior waves only. |
| `--clean-worktrees` | `false` | Remove orphan worktrees before starting. |
| `--keep-worktrees` | `false` | Disable auto-cleanup of successful worktrees (debug). |

### Audit log

Every wave appends to `.host-orchestrator/waves/<TS>.log`. One line per state transition (dispatch / result / validate / push / pr-create / cleanup / blocked). Use this for post-mortem after a wave finishes with mixed outcomes.

### Examples

```
/parallel-implement-wave                                       # auto-discover ready-for-agent issues
/parallel-implement-wave --issues=#42,#43,#44                  # explicit list
/parallel-implement-wave --max-parallel=3                      # conservative cap
/parallel-implement-wave --dry-run                             # preview only
/parallel-implement-wave --resume                              # process orphan worktrees, no new dispatch
/parallel-implement-wave --clean-worktrees                     # clean orphans, then dispatch fresh
```

---

## `/merge-orchestrate` — host-native serial merge

For each PR in the wave:

1. Auto-rebase via `gh pr update-branch`.
2. Ephemeral worktree.
3. Cascade validation (prefers `scripts/sandcastle-validate.sh` if present; otherwise auto-detect package manager + typecheck + tests).
4. Dispatch the `merge-resolver` Opus subagent (`agents/merge-resolver.md`) with the full intent packet (brief / PR body / commits / diff cascade, plus semantic-risk pairs from file overlap analysis).
5. Subagent emits `<action>MERGE | HOLD | ABORT</action>` + `<resolution>RESOLVED | INCOMPATIBLE | NOT_NEEDED</resolution>`. Host executes the recommendation (squash --delete-branch by default).
6. On `INCOMPATIBLE`: label `merge-blocked`, comment with resolver summary, skip transitive deps. Auto-pilot otherwise.

### The 5 no-regression criteria

The `merge-resolver` subagent enforces these explicitly. Violation of any → emit `INCOMPATIBLE` rather than force the merge.

1. **NO eliminate behavior required by any brief.**
2. **NO silence or skip tests to make the build pass.**
3. **NO "simplify" justified duplication.**
4. **NO introduce behavior not in any brief.**
5. **NO change public contracts without brief justification.**

### Flags

| Flag | Default | Purpose |
|---|---|---|
| `--strategy=squash\|merge\|rebase` | `squash` | Merge strategy passed to `gh pr merge`. |
| `--step` | `false` | Confirm before each merge (default only confirms at start + on blocks). |
| `--dry-run` | `false` | Preview only, never mutates. |

### Examples

```
/merge-orchestrate                            # auto-discover open PRs
/merge-orchestrate #5,#7,#9                   # explicit list
/merge-orchestrate --strategy=rebase
/merge-orchestrate --step
/merge-orchestrate --dry-run
```

---

## Decision tree — when to use what

```
Implement                                    Merge
─────────                                    ─────
1 ticket   → Leo directly                    1 PR   → gh pr merge --squash
2-6 host   → /parallel-implement-wave        2-7 host → /merge-orchestrate
7+ Docker  → /sandcastle-dispatch-wave       8+ Docker → /sandcastle-merge-wave
```

The two `host-orchestrator` commands cover the host column. The two `sandcastle-max` commands cover the Docker column. The two share the same brief format (engineering-workflow's `## Agent Brief` invariant) and the same PR label (`afk-agent-pr`), so downstream consumers don't need to distinguish substrate.

---

## Files in this plugin

```
host-orchestrator/
├── plugin.json
├── README.md                              # this file
├── commands/
│   ├── parallel-implement-wave.md         # /parallel-implement-wave
│   └── merge-orchestrate.md               # /merge-orchestrate
└── agents/
    ├── parallel-implementer.md            # Opus subagent for implementation
    └── merge-resolver.md                  # Opus subagent for merge / conflict
```

No `skills/`. No auto-invocation by phrase. The slash commands are the only entry points by design — both actions have non-trivial blast radius and benefit from explicit invocation.

---

## Requirements

- `gh` CLI configured (`gh auth login`) — for PR + issue + comment + label operations.
- A git repo with the base branch (current `HEAD`) tracking a remote.
- Opus access on your Claude account (subagents force `model: opus`).
- For `/parallel-implement-wave`: GH issues labeled `ready-for-agent` (or `state/ready-for-agent`) with a `## Agent Brief` comment following the engineering-workflow ≥ 2.1.0 single-brief invariant.

## What this plugin does NOT do

- **No PR review judgment**: assumes briefs are accepted (implement) or PRs are reviewed (merge). For APPROVE/HOLD/BLOCK reviewer agents, use `/sandcastle-merge-wave` Step 1 or Matt Pocock's `/review`.
- **No remote infrastructure dependency**: doesn't need GitHub Actions, sandcastle-validate-as-a-service, or any external CI. Validation runs in your shell.
- **No Docker. No Sandcastle SDK. No OAuth token extraction.** Subagents inherit your Claude Code session's auth and your host environment.
- **No cross-issue dependency cascade in one invocation**: if issue B depends on issue A, run two waves (A → merge → B). A future `/host-pipeline` command in this same plugin will compose dispatch → CI → merge in a single loop.
- **No checkpoint JSON**: an append-only audit log (`.host-orchestrator/waves/<TS>.log`) is the state. GitHub state (PRs, labels) is the durable truth; re-invoking is idempotent.

---

## Composition with the rest of `toolkit-leopoldo`

```
engineering-workflow:
  /grill-with-docs → /to-prd → /to-issues (label: ready-for-agent + ## Agent Brief)
                                  │
                  ┌───────────────┴───────────────┐
                  ▼                               ▼
        host (small batch)                 Docker (large batch)
        /parallel-implement-wave         /sandcastle-dispatch-wave
                  │                               │
                  ▼                               ▼
                  ────────────[N open PRs, label afk-agent-pr]──────────
                  │                               │
                  ▼                               ▼
        host (small batch)                 Docker (large batch)
        /merge-orchestrate          /sandcastle-merge-wave + /sandcastle-pipeline
                  │                               │
                  └───────────────┬───────────────┘
                                  ▼
                            merged to base
```

Both substrates enforce the same 5 no-regression criteria via similar `merge-resolver` subagent prompts. They differ in execution substrate (host vs Docker), parallelism strategy (sync subagents vs containers), and overhead profile.

---

Built for Claude Code. Author: Leopoldo Bini. License: MIT.
