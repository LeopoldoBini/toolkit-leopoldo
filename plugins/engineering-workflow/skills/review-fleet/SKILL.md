---
name: review-fleet
description: Multi-agent review — parallel reviewers per module/area (deep-modules lens + critical implementation review) and a judge that rules each finding applicable or not. Default is REPORT-ONLY (no code changes); with --apply, applier subagents on the best available model also fix what the judge approved. Use when the user asks for a review fleet, "review fleet", "revisión profunda", "manda los revisores", "revisá todo con subagentes".
disable-model-invocation: true
---

# Review Fleet

Run a **reviewers → judge** pipeline over a scope, using parallel subagents. Reviewers only read; a judge decides what is actually worth fixing.

Two modes:

- **Default (standalone, report-only)** — reviewers + judge, then a report with verdicts. **No code is modified.** Leo reads the result and decides.
- **`--apply`** — the full pipeline: after the judge, applier subagents (best available model) fix the approved findings. This mode exists for orchestrated pipelines (e.g. `/afk-pipeline`'s final review wave); only use it interactively if the user explicitly passed `--apply` or asked for fixes to be applied.

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

## Phase 3 — Appliers (ONLY with `--apply`)

Without `--apply`, SKIP this phase entirely and go to the report — the APLICAR list is delivered as recommendations, not executed.

With `--apply`: for the APLICAR list only, launch applier subagents on the **best available model** (Fable 5 → Opus → inherit):

- Group fixes by file/module cluster; one applier per cluster so they never touch the same files. If clusters can't be isolated, apply serially.
- When appliers run in parallel over a git repo, use worktree isolation.
- Each applier: apply the fix, run the project's build/tests for the touched area, report `done + evidence` or `failed + why`. A fix that breaks the build gets reverted, not "fixed forward".

## Phase 4 — Report

Single final report:

- **Report-only (default):** **Para aplicar** (finding → proposed fix → judge's reasoning, in application order), **Rechazadas** (finding → one-line reason), **Para Leo (HUMANO)** (finding → what decision is needed).
- **With `--apply`:** **Aplicadas** (finding → fix → verification evidence), **Rechazadas**, **Para Leo (HUMANO)**, plus build/test status after all fixes.

End with a TL;DR (estado final + pendientes de decisión), per Leo's communication preferences.

## Invariants

- Reviewers and judge never modify code. Without `--apply`, NOBODY modifies code — the deliverable is the judged report.
- With `--apply`, only appliers modify code, and only what the judge approved.
- If the judge approves nothing, say so plainly — an empty APLICAR list is a valid outcome, not a failure.
- This skill is explicit-invocation only (expensive: spawns 3+ subagents minimum).
