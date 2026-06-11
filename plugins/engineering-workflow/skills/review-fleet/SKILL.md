---
name: review-fleet
description: Multi-agent review pipeline — parallel reviewers per module/area (deep-modules lens + critical implementation review), a judge that rules each finding applicable or not, and applier subagents on the best available model that fix what was approved. Use when the user asks for a full review fleet, "review fleet", "revisión profunda", "manda los revisores", "revisá todo con subagentes", or wants findings reviewed AND applied in one pass.
disable-model-invocation: true
---

# Review Fleet

Run a **reviewers → judge → appliers** pipeline over a scope, using parallel subagents. Reviewers only read; a judge decides what is actually worth fixing; appliers (best available model) apply only the approved corrections. Nothing gets applied without passing the judge.

## Phase 0 — Resolve scope

From `$ARGUMENTS`, resolve ONE of:

- **`session`** (default when no args and there is recent work in the conversation) — what was just implemented: collect from the conversation + `git diff`/`git log` of the working session.
- **`epic #N` / `milestone:<name>` / `parent:#N`** — everything those issues touched (`gh issue list` + linked PR diffs).
- **`module <name>` / a path** — that module or directory.
- **`app` / "toda la app"** — the whole codebase.

Then split the scope into **review units**: the distinct modules/areas it spans (use `CONTEXT.md` domain language and repo structure to draw lines). If the user didn't enumerate them, identify them yourself — do not ask. For a whole-app review on a small codebase (≲ 20 source files), one unit is fine; otherwise one unit per module.

## Phase 1 — Reviewers (parallel, read-only)

Launch read-only subagents in parallel. Two lenses, always:

1. **Architecture lens** — per review unit, one subagent applying the `deep-modules` skill criteria (depth, seams, deletion test, interface-as-test-surface) restricted to that unit. Tell it to read `CONTEXT.md` and `docs/adr/` first if they exist.
2. **Implementation lens** — per review unit, one subagent doing critical implementation review: correctness bugs, security (OWASP), error handling, consistency with the project's conventions, code smells. If the `review-flow` plugin is installed, use its `revisor_de_trabajo` agent for this lens; otherwise a general subagent with those criteria.

Scale: 2 subagents total for a single-unit scope; one pair per unit when there are several (cap ~6 units per wave; queue the rest). Each reviewer must return **structured findings**: `title · file:line · severity (alta/media/baja) · why it matters · proposed fix`. No prose reports.

## Phase 2 — Judge

ONE judge subagent (best available model: Fable 5, else Opus) receives ALL findings plus the scope description. It must:

- Deduplicate overlapping findings across reviewers.
- Rule each finding: **APLICAR** / **RECHAZAR** / **HUMANO** (needs Leo's call), with one-line reasoning.
- Weigh: is it real (not speculative)? in scope? does the fix's risk exceed its benefit? does it contradict an ADR or CONTEXT.md?
- Order the APLICAR list so independent fixes can be applied in parallel and dependent ones serially.

The judge does not edit code.

## Phase 3 — Appliers

For the APLICAR list only, launch applier subagents on the **best available model** (Fable 5 → Opus → inherit):

- Group fixes by file/module cluster; one applier per cluster so they never touch the same files. If clusters can't be isolated, apply serially.
- When appliers run in parallel over a git repo, use worktree isolation.
- Each applier: apply the fix, run the project's build/tests for the touched area, report `done + evidence` or `failed + why`. A fix that breaks the build gets reverted, not "fixed forward".

## Phase 4 — Report

Single final report:

- **Aplicadas** — finding → fix → verification evidence.
- **Rechazadas** — finding → judge's one-line reason.
- **Para Leo (HUMANO)** — finding → what decision is needed.
- Build/test status after all fixes.

End with a TL;DR (estado final + pendientes de decisión), per Leo's communication preferences.

## Invariants

- Reviewers and judge never modify code; only appliers do, and only what the judge approved.
- If the judge approves nothing, say so plainly — an empty APLICAR list is a valid outcome, not a failure.
- This skill is explicit-invocation only (expensive: spawns 3+ subagents minimum).
