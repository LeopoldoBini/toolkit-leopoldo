# host-orchestrator

Host-side orchestrator for the full AFK pipeline. **v4: the pipeline engine is a deterministic Workflow script** — rules run as JS code (loops, conditions, numeric gates); agents only implement, measure and resolve. Spec: `docs/SPEC-v4-workflow-engine.md` (grillada + validada por el Piloto 1, jul-2026).

Three slash commands:

| Command | Phase | Mode |
|---|---|---|
| `/prd-pipeline` (v4) | **Pipeline driver** | Deterministic Workflow: waves implement+merge sobre rama integradora, gate como código, review fleet nativa, PR final draft |
| `/parallel-implement-wave` | Implementation (standalone) | Sync parallel, N subagents in own worktrees, 2-6 issues |
| `/merge-orchestrate` | Merge (standalone) | Serial, one PR at a time, auto-pilot, 2-7 PRs |

All share the same DNA: native CC primitives, custom subagents, and a **single serialized point of remote mutation** (implementers never push, never `gh pr create`, never `gh pr merge` — in v4 that point is the *serializer* agent stage, ordered by the script).

## v4 core principles (from the spec)

- **Rules are code.** The pass/fail gate is a pure JS `if` over numbers reported by a validator agent. Zero gate decisions made by a model. Ratchet semantics: no metric worsens vs the wave baseline, no before-green test goes red, the diff must touch tests.
- **Capability tiers, not model names.** Script and spec speak T0 (frontier) / T1 (reasoner) / T2 (operative) / T3 (ultra-cheap); the tier→model mapping lives ONLY in `model_map` (repo config, default `{T0:fable, T1:opus, T2:sonnet, T3:haiku}`). The launching session is the T0 orchestrator and pins each node's tier at design time — nothing re-decides at runtime.
- **Integration branch policy.** The pipeline creates `prd/<milestone>` (or `batch/<slug>`), issue PRs target it, base is merged in before every wave (merge, never rebase), and the run ends with ONE draft PR `prd/X → base` for Leo's green button. Base stays deployable.
- **GitHub is the only source of truth.** No state.json, no PROGRESS.md. The Workflow journal handles resume; the append-only audit log (`.host-orchestrator/waves/*.log`) survives on disk.
- **Crash-safe by design.** Serializers are idempotent (check-then-act, keyed by work identity — PR/issue — not branch). Resume rule: `resumeFromRunId` only if nothing changed by hand; otherwise a fresh run is always safe.

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

Dispatches 2-6 GitHub issues for parallel implementation. Each issue gets its own `parallel-implementer` Opus 4.8 subagent in an isolated git worktree (created by Claude Code via `isolation: "worktree"`). Host blocks until all subagents return their XML envelopes, then per result runs validation → push → `gh pr create`.

### Mental model

```
You:   /parallel-implement-wave
Host:  pre-flight → dep graph → preview → confirm → compose prompts
Host:  [Agent(#42), Agent(#43), Agent(#44), Agent(#45)]   (parallel, one message)
                ↓         ↓         ↓         ↓
            worktree  worktree  worktree  worktree     (isolated, native)
            Opus 4.8  Opus 4.8  Opus 4.8  Opus 4.8     (TDD + vertical slice)
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

The `parallel-implementer` Opus 4.8 subagent (`agents/parallel-implementer.md`) is bound by:

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
3. Cascade validation (prefers `scripts/wave-validate.sh` if present; otherwise auto-detect package manager + typecheck + tests).
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

## `/prd-pipeline` — the v4 engine (Workflow-native)

One command launches the whole pipeline as a **deterministic background Workflow** (`workflows/prd-pipeline.js`). The session that types it acts as the **T0 orchestrator**: it reads the repo contract, picks each node's tier (within the spec §3.1 ranges, minimum-sufficient-model principle), shows the plan, and launches. Everything else is code.

```
/prd-pipeline milestone:PRD-0016 +800k        # scope + token budget (recommended)
/prd-pipeline label:slice/checkout +500k
/prd-pipeline "#42,#43,#44" --dry-run          # plan + args, no launch
```

### Engine flow (per run)

```
Setup     serializer: crea/actualiza rama integradora prd/X (o batch/X) + worktree local
Wave N    scout T3 → buckets · refresh base→rama (conflicto → merge-resolver)
          baseline (validator) · merge wave SERIAL (validar → resolver → merge)
          impl wave PARALELA (parallel-implementer en worktrees) · gate = if(números)
          publish SERIAL (push + PR hacia la rama integradora)
Review    partición → reviewers (arch/impl/integración) → judge → applier → gate → merge
Cierre    PR DRAFT rama → base para el botón verde de Leo + reporte estructurado
```

Cortes limpios: budget agotado (en boundary de wave, con pendientes reportados), scope bloqueado (todo BLOCKED_BY_DEP/HUMAN_GATED), refresh incompatible. Gate rojo por issue: 1 reintento con los motivos numéricos; segundo rojo → label `agent-blocked` + comment, la wave sigue.

### Agent roles (tiers pinned per run by the T0 session)

| Role | Range | Job |
|---|---|---|
| scout | T2–T3 | `gh --json` → buckets. Never judges, never mutates. |
| validator | T2–T3 | Runs `wave-validate.sh --json` (or autodetect) → NUMBERS. `status: ok\|error` — an invalid measurement is never success. |
| implementer | T0–T1 (T2 mechanical) | `parallel-implementer` discipline in an isolated worktree. Never pushes. |
| serializer | T1–T2 | ALL remote mutations, sequential, check-then-act, audit-logged. |
| merge-resolver | T0–T1 | Conflict/intent verdicts (5 no-regression criteria). Recommends; serializer executes. |
| reviewers/judge/applier | T0–T2 | Native review fleet over the integrated diff. |

### Monitoring & resume

- `/workflows` = live view; the script's `log()` lines tell the whole story (dispatch, gate PASS/FAIL with numbers, PRs, mutations, cuts).
- Audit log on disk: `.host-orchestrator/waves/<runLabel>.log` (append-only, written by serializers).
- Crash → `resumeFromRunId` ONLY if nothing changed by hand; otherwise fresh run with the same args (always safe).

### Repo contract (optional, with defaults)

`.host-orchestrator/config.json`: `base_branch`, `validate_hook`, `test_globs`, `model_map`, `role_tiers`, `labels`, `deny_paths` (orthogonal ratchets/guards the agents must never touch), `required_checks`, `max_parallel`. Hook contract: `scripts/wave-validate.sh --json` → `{"status":"ok"|"error","metrics":{...},"tests":{...}}`.

---

## The `cc-afk` bash function (v4 — AFK entry point)

```bash
# AFK pipeline launcher — host-orchestrator v4 (Workflow-native)
cc-afk() {
  if [ -z "$*" ]; then
    echo "usage: cc-afk <scope> [+800k]   (ej: cc-afk milestone:PRD-0016 +800k)"
    return 1
  fi
  API_TIMEOUT_MS=1200000 \
  BASH_DEFAULT_TIMEOUT_MS=300000 \
  BASH_MAX_TIMEOUT_MS=1200000 \
    claude --dangerously-skip-permissions "/prd-pipeline $*"
}
alias cc-afk-host=cc-afk   # memoria muscular histórica
```

Dead vs v3 (the Workflow made them obsolete): `/goal` + Haiku verifier, `CLAUDE_CODE_MAX_TURNS`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `CLAUDE_CODE_DISABLE_THINKING`, state.json, PROGRESS.md. Only the Bash/API timeouts survive (agents still run long commands). `--dangerously-skip-permissions` remains AFK-only — for supervised runs use a normal interactive session and answer the prompts.

---

## Decision tree — when to use what

```
Implement                                    Merge
─────────                                    ─────
1 ticket   → Leo directly                    1 PR   → gh pr merge --squash
2-6        → /parallel-implement-wave        2-7 → /merge-orchestrate
7+         → multiple waves (dep order)      8+  → multiple batches (dep order)
```

Both commands share the brief format (engineering-workflow's `## Agent Brief` invariant) and the PR label (`afk-agent-pr`).

---

## Files in this plugin

```
host-orchestrator/
├── plugin.json
├── README.md                              # this file
├── docs/
│   └── SPEC-v4-workflow-engine.md         # la spec del motor (grillada + Piloto 1)
├── workflows/
│   └── prd-pipeline.js                    # EL MOTOR v4 (Workflow script determinístico)
├── commands/
│   ├── prd-pipeline.md                    # /prd-pipeline             (pipeline driver v4)
│   ├── parallel-implement-wave.md         # /parallel-implement-wave  (impl wave standalone)
│   └── merge-orchestrate.md               # /merge-orchestrate        (merge wave standalone)
└── agents/
    ├── parallel-implementer.md            # implementer discipline (TDD vertical slice)
    └── merge-resolver.md                  # merge/conflict resolver (5 no-regression criteria)
```

No `skills/`. No auto-invocation by phrase. The slash commands are the only entry points by design — all actions have non-trivial blast radius and benefit from explicit invocation.

---

## Requirements

- `gh` CLI configured (`gh auth login`) — for PR + issue + comment + label operations.
- A git repo with the base branch (current `HEAD`) tracking a remote.
- Access to the models your `model_map` names (default map needs Haiku/Sonnet/Opus; the explicit per-node model always overrides the agents' frontmatter).
- For `/parallel-implement-wave`: GH issues labeled `ready-for-agent` (or `state/ready-for-agent`) with a `## Agent Brief` comment following the engineering-workflow ≥ 2.1.0 single-brief invariant.

## What this plugin does NOT do

- **No PR review judgment in the standalone commands**: `/prd-pipeline` DOES run its own native review fleet (partition → reviewers → judge → applier) over the integrated diff; for interactive reviews use `/review-fleet` (engineering-workflow) or `/review`.
- **No remote infrastructure dependency**: doesn't need GitHub Actions or any external CI. Validation runs in your shell.
- **No containers. No OAuth token extraction.** Subagents inherit your Claude Code session's auth and your host environment.
- **No cross-issue dependency cascade in the standalone commands**: if issue B depends on issue A, run two waves (A → merge → B) — or use `/prd-pipeline`, whose wave loop handles the cascade (scout re-buckets per wave; deps unblock as PRs merge).
- **No checkpoint JSON**: an append-only audit log (`.host-orchestrator/waves/<TS>.log`) is the state. GitHub state (PRs, labels) is the durable truth; re-invoking is idempotent.

---

## Composition with the rest of `toolkit-leopoldo`

```
engineering-workflow:
  /grill-with-docs → /to-prd → /to-issues (label: ready-for-agent + ## Agent Brief)
                                  │
                                  ▼
              /prd-pipeline milestone:X +800k        (v4 engine, one command)
                waves: scout → refresh → merge → implement → gate → publish
                review fleet nativa → PR DRAFT prd/X → base
                                  │
                                  ▼
                     botón verde de Leo (merge manual del PR final)

(standalone, for surgical use: /parallel-implement-wave · /merge-orchestrate)
```

---

Built for Claude Code. Author: Leopoldo Bini. License: MIT.
