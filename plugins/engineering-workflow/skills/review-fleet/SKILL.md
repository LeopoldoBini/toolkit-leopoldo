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

### Step 1 — Integral analysis FIRST

Before partitioning anything, study the scope **as one integrated whole**: read the full diff (all PRs/commits in scope together, not one by one), map which modules it touches, and how the touched pieces interact — new seams, changed contracts, shared state. This pass is yours (the orchestrating agent's); its output is the map you partition from. Skipping it and jumping straight to per-PR review is the failure mode this skill exists to avoid.

### Step 2 — Re-partition into review units

Split the scope into **review units** = cohesive review surfaces of the FINAL state. Draw lines using `CONTEXT.md` domain language and repo structure — NOT the implementation history. How the work was dispatched (waves, issues, PRs) reflects scheduling convenience; the review partition must be fresh: a unit is a module plus its seams as the code stands now, even if it was built across three different waves. If the user didn't enumerate units, identify them yourself — do not ask.

**How many units:** size each unit to what one reviewer can actually hold — one module (or a few tightly coupled files) plus the interfaces it exposes/consumes, roughly ≤ ~1.5k lines of relevant code. Minimum 1 (small scope or small codebase, ≲ 20 source files → review it whole). Cap ~6 units per wave; if the scope demands more, queue additional waves rather than diluting reviewers. State the partition and why before launching: "N units: X, Y, Z — because …".

## Phase 1 — Reviewers (parallel, read-only)

Launch read-only subagents in parallel. Two lenses, always:

1. **Architecture lens** — per review unit, one subagent applying the `deep-modules` skill criteria (depth, seams, deletion test, interface-as-test-surface) restricted to that unit. Tell it to read `CONTEXT.md` and `docs/adr/` first if they exist.
2. **Implementation lens** — per review unit, one subagent doing critical implementation review: correctness bugs, security (OWASP), error handling, consistency with the project's conventions, code smells. If the `review-flow` plugin is installed, use its `revisor_de_trabajo` agent for this lens; otherwise a general subagent with those criteria.

3. **Integration lens** — when there are 2+ units, ONE extra subagent that reviews only the seams BETWEEN units: the contracts, data flow and invariants the integral analysis (Phase 0, Step 1) surfaced. Per-unit reviewers can't see these; this is where multi-wave implementations break.

Scale: 2 subagents total for a single-unit scope; one pair per unit plus the integration reviewer when there are several (cap ~6 units per wave; queue the rest). Each reviewer must return **structured findings**: `title · file:line · severity (alta/media/baja) · why it matters · proposed fix`. No prose reports.

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
