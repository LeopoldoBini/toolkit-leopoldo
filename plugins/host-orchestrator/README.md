# host-orchestrator

Host-side orchestrator for the full AFK pipeline (implementation + merge + goal-driven loop) using Claude Code's native primitives — subagents, worktree isolation, and `/goal` with its Haiku verifier. No Docker required (but supported for the heavy phases via `sandcastle-max` delegation).

Three slash commands:

| Command | Phase | Mode |
|---|---|---|
| `/parallel-implement-wave` | Implementation | Sync parallel, N subagents in own worktrees, 2-6 issues |
| `/merge-orchestrate` | Merge | Serial, one PR at a time, auto-pilot, 2-7 PRs |
| `/afk-pipeline` (v2.1.0) | **Pipeline driver** | Per-turn playbook for `/goal`-wrapped sessions |

All share the same DNA: native CC primitives, custom subagents (Fable 5 for implementation, Opus for merge), host as the **single point of remote mutation** (subagents never push, never `gh pr create`, never `gh pr merge`).

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

Dispatches 2-6 GitHub issues for parallel implementation. Each issue gets its own `parallel-implementer` Fable 5 subagent in an isolated git worktree (created by Claude Code via `isolation: "worktree"`). Host blocks until all subagents return their XML envelopes, then per result runs validation → push → `gh pr create`.

### Mental model

```
You:   /parallel-implement-wave
Host:  pre-flight → dep graph → preview → confirm → compose prompts
Host:  [Agent(#42), Agent(#43), Agent(#44), Agent(#45)]   (parallel, one message)
                ↓         ↓         ↓         ↓
            worktree  worktree  worktree  worktree     (isolated, native)
            Fable 5   Fable 5   Fable 5   Fable 5      (TDD + vertical slice)
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

The `parallel-implementer` Fable 5 subagent (`agents/parallel-implementer.md`) is bound by:

1. **Vertical slice definition**: must touch all relevant layers of the user story (entry + middle + destination + observable output), not a horizontal cut.
2. **TDD red-green-reality-first per criterion**: one failing test per acceptance criterion before implementation, against real resources (DB / HTTP / queues reachable from the host).
3. **7 anti-patterns of tests are forbidden** (tautologies, existence-only, mocking-the-SUT, magic-number passthrough, `.skip`/`.only`, generic error catching, coverage padding).
4. **Bronze rule self-check**: "would this test fail if I deleted the implementation?" — applied to each new test before emitting COMPLETE.
5. **Hard constraints triple-stated**: no push, no `gh pr create`, no `gh pr merge`, no `cd` outside worktree, no `Agent(...)`. Host owns all remote mutations.

### Flags

| Flag | Default | Purpose |
|---|---|---|
| `--max-parallel=N` | `6` | Cap of simultaneous subagents. Hard ceiling 8 with soft warning when >6 (quota burn). |
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

## `/afk-pipeline` — goal-driven AFK loop (v2.1.0)

**Thin per-turn playbook** designed to run **inside a `/goal`-wrapped session** (Claude Code v2.1.139+). The combination gives you a truly autonomous agentic loop:

- **`/goal <condition>`** (native) → Haiku verifier evaluates the condition between turns; if unmet, the harness re-invokes the main agent automatically. You don't write a loop.
- **`/afk-pipeline --goal=<spec>`** (this plugin) → tells the main agent **what to do per turn**: inspect goal scope, pick the next productive action (merge if any PR ready, implement if any issue ready, report blocker, or declare done), update progress files, end the turn.

Together they realize the AFK dream: type one command, walk away, come back when the goal is reached or a real blocker requires your attention.

### Flags

| Flag | Default | Purpose |
|---|---|---|
| `--goal=<spec>` | (required) | Scope: `milestone:<name>`, `label:<label>`, `parent:#N`, or `#42,#43,...` |
| `--implement=host\|docker` | `docker` | Substrate for implementation waves |
| `--merge=host\|docker` | `host` | Substrate for merge waves |

Defaults (`docker+host`) reflect the combo Leo has tested as the most reliable: Docker for parallel implementation (isolation), host for serial merge (intent-aware speed).

### State persistence

Every turn writes:
- **`.host-orchestrator/pipelines/<slug>.state.json`** — machine-readable phase history
- **`PROGRESS.md`** — human-readable checklist + decisions + constraints (survives `/compact` because it's on disk, not in context)

### Per-turn priority cascade

Inside the playbook, the agent picks the FIRST matching action:

1. **All DONE** → emit goal-completion message, end (verifier closes the loop)
2. **Any MERGE_READY** → run merge wave (delegates to `/merge-orchestrate` or `/sandcastle-merge-wave`)
3. **Any IMPLEMENTABLE** → run implement wave (delegates to `/parallel-implement-wave` or `/sandcastle-dispatch-wave`)
4. **Only blocked-by-dep / human-gated remain** → report blockers, end (verifier sees no progress next turn → halts)
5. **Some IN_REVIEW (PR open, not mergeable)** → describe blockers (failed checks, branch protection), end

One action per turn. Auto-compact (set by env var) fires at safe boundaries between turns.

### Examples

```
/afk-pipeline --goal=milestone:Q2-Checkout
/afk-pipeline --goal=label:slice/checkout --implement=host
/afk-pipeline --goal=#42,#43,#44,#45 --merge=docker
/afk-pipeline --goal=parent:#100  # all issues with "Part of #100" in body
```

---

## The `cc-afk` bash function (recommended entry point)

Goal-driven AFK pipelines work best when you launch them with the right env vars already set (auto-compact threshold, max turns, etc.). The full incantation is verbose; wrap it in a shell function once.

Add this to your `~/.zshrc` or `~/.bashrc`:

```bash
# AFK pipeline launcher — Claude Code with Leo's host-orchestrator + /goal
cc-afk() {
  if [ -z "$*" ]; then
    echo "usage: cc-afk <goal-spec>"
    echo "  examples:"
    echo "    cc-afk milestone:Q2-Checkout"
    echo "    cc-afk label:slice/checkout"
    echo "    cc-afk \"#42,#43,#44,#45\""
    return 1
  fi
  local goal="$*"
  CLAUDE_CODE_AUTO_COMPACT_WINDOW=180000 \
  CLAUDE_CODE_MAX_TURNS=50 \
  CLAUDE_CODE_DISABLE_THINKING=1 \
  CLAUDE_CODE_EFFORT_LEVEL=medium \
  CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1 \
  CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING=1 \
  DISABLE_TELEMETRY=1 \
  API_TIMEOUT_MS=1200000 \
  BASH_DEFAULT_TIMEOUT_MS=300000 \
  BASH_MAX_TIMEOUT_MS=1200000 \
    claude --dangerously-skip-permissions \
      "/goal Todas las GH issues que matchean '$goal' están cerradas con su PR mergeado a la base branch (issue closed AND linked PR merged).

Para avanzar en cada turn, ejecutá:
  /afk-pipeline --goal=\"$goal\" --implement=docker --merge=host

Mantené PROGRESS.md actualizado en la raíz del repo y .host-orchestrator/pipelines/<slug>.state.json. Una acción productiva por turn, no más."
}

# Variants (optional):
cc-afk-host() {
  local goal="$*"
  CLAUDE_CODE_AUTO_COMPACT_WINDOW=180000 \
  CLAUDE_CODE_MAX_TURNS=50 \
  CLAUDE_CODE_DISABLE_THINKING=1 \
  CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1 \
  DISABLE_TELEMETRY=1 \
  API_TIMEOUT_MS=1200000 \
  BASH_MAX_TIMEOUT_MS=1200000 \
    claude --dangerously-skip-permissions \
      "/goal Todas las GH issues que matchean '$goal' están cerradas con su PR mergeado.
Ejecutá /afk-pipeline --goal=\"$goal\" --implement=host --merge=host"
}

cc-afk-docker() {
  local goal="$*"
  CLAUDE_CODE_AUTO_COMPACT_WINDOW=180000 \
  CLAUDE_CODE_MAX_TURNS=50 \
  CLAUDE_CODE_DISABLE_THINKING=1 \
  CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1 \
  DISABLE_TELEMETRY=1 \
  API_TIMEOUT_MS=1200000 \
  BASH_MAX_TIMEOUT_MS=1200000 \
    claude --dangerously-skip-permissions \
      "/goal Todas las GH issues que matchean '$goal' están cerradas con su PR mergeado.
Ejecutá /afk-pipeline --goal=\"$goal\" --implement=docker --merge=docker"
}
```

### Usage

```bash
cc-afk milestone:Q2-Checkout       # default (docker impl + host merge)
cc-afk-host label:slice/checkout   # full-host (no Docker required)
cc-afk-docker "#42,#43,#44"        # full-sandcastle (Docker both phases)
```

### Env vars set by `cc-afk` and why

| Variable | Value | Why |
|---|---|---|
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | `180000` | Auto-compact at 180K tokens (~18% of the 1M context window). Keeps context lean. |
| `CLAUDE_CODE_MAX_TURNS` | `50` | Hard cap. Prevents runaway `/goal` loops if verifier never confirms. |
| `CLAUDE_CODE_DISABLE_THINKING` | `1` | Disable extended thinking. AFK rewards velocity over depth. |
| `CLAUDE_CODE_EFFORT_LEVEL` | `medium` | Balanced effort. `xhigh`/`max` is slow; `low` may miss nuance. |
| `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY` | `1` | No "rate this response" interruptions mid-AFK. |
| `CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING` | `1` | `/rewind` not needed in AFK; saves overhead. |
| `DISABLE_TELEMETRY` | `1` | Less network overhead. |
| `API_TIMEOUT_MS` | `1200000` (20 min) | AFK tool calls can be long. |
| `BASH_DEFAULT_TIMEOUT_MS` | `300000` (5 min) | Default for validate gates etc. |
| `BASH_MAX_TIMEOUT_MS` | `1200000` (20 min) | Ceiling for long tests / installs. |

### What `--dangerously-skip-permissions` means

Equivalent to `--permission-mode bypassPermissions`. Saltea todos los permission prompts session-wide. **Solo usar en sesiones AFK** — para sesiones interactivas mantenés el modo normal con permission prompts.

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
│   ├── parallel-implement-wave.md         # /parallel-implement-wave  (impl wave, host)
│   ├── merge-orchestrate.md               # /merge-orchestrate        (merge wave, host)
│   └── afk-pipeline.md                    # /afk-pipeline             (per-turn playbook for /goal-wrapped sessions)
└── agents/
    ├── parallel-implementer.md            # Fable 5 subagent for implementation
    └── merge-resolver.md                  # Opus subagent for merge / conflict
```

No `skills/`. No auto-invocation by phrase. The slash commands are the only entry points by design — all actions have non-trivial blast radius and benefit from explicit invocation.

---

## Requirements

- `gh` CLI configured (`gh auth login`) — for PR + issue + comment + label operations.
- A git repo with the base branch (current `HEAD`) tracking a remote.
- Fable 5 + Opus access on your Claude account (`parallel-implementer` forces `model: fable`; `merge-resolver` forces `model: opus`).
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
