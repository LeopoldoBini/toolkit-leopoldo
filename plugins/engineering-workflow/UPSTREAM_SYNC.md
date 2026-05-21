# Upstream Sync Log

This plugin is forked from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT). This file tracks selective syncs from upstream.

## Last sync

- **Date**: 2026-05-21
- **Upstream commit**: `b8be62f` (HEAD as of sync)
- **Fork commit before sync**: prior was `f304057` sync at 2026-05-13 (v2.3.0)
- **Resulting version**: 2.4.0
- **Files touched**: adopted `prototype` skill verbatim (SKILL.md + LOGIC.md + UI.md) into `skills/prototype/`. Also extracted `handoff` and `caveman` (productivity skills) as standalone plugins in toolkit-leopoldo — not part of engineering-workflow, but logged here since they came from the same upstream sync.

## Sync history

- **2026-05-13 → `f304057`**: 6 skills, 13 changes, v2.2.0 → v2.3.0 (see prior entry below).

## Meta-decision driving this sync

**Integration > portability.** This fork is opinionated for a single user with a specific convention (`CONTEXT.md` + `MEMORY.md` + `CLAUDE.md` three-artifact model, `/init-workflow` seeding, `/deep-modules` skill, bilingual triggers). Upstream evolved towards portability cross-repo (ADR-0001: skills no longer hard-code GitHub, label strings, or domain doc layout; everything externalised to `setup-matt-pocock-skills`). We deliberately **don't** follow that direction — the abstraction costs auto-documentation and integration value that this fork's only user (Leo) prefers to keep.

## Filters applied (descartado por meta-decisión)

When reviewing a future upstream commit, **discard by default**:

- **Bilingual triggers eliminated** — upstream is English-only; fork explicitly bilingual.
- **`CONTEXT.md` → "domain glossary"** — fork uses the literal convention, not the abstracted vocabulary.
- **References to `/deep-modules` removed** — fork keeps the name (upstream renamed to `improve-codebase-architecture`).
- **References to `/setup-matt-pocock-skills`** — fork's equivalent is `/init-workflow`; setup info lives in `CLAUDE.md` post-init.
- **`AGENT-BRIEF.md` subordinated to `triage/`** — fork keeps `agent-brief` as a top-level skill (it has its own pipeline role).
- **Eliminations of single-brief invariant** — the invariant is a fork-specific addition (v2.1.0) consumed by `/sandcastle-dispatch-wave`.
- **Em-dash → hyphen regressions** — typographic regression from upstream's prose migration; not adopted.
- **Renames** (`tdd-vertical → tdd`, `deep-modules → improve-codebase-architecture`) — fork keeps the more descriptive names.
- **Vague-prose rewrites** — fork values concrete, structured headings over softer prose.

## Adopt by default

- **New skills upstream** that fill a genuine gap in the pipeline. Adopted 2026-05-21: `prototype` (engineering, lives inside engineering-workflow), `handoff` (productivity, extracted as its own plugin), `caveman` (productivity, extracted as its own plugin alongside the existing response-modes output-style). All adopted verbatim — no fork-specific deviations applied.
- **Refinements to examples** that add concreteness (e.g. concrete code snippet in `OUT-OF-SCOPE.md`, anti-example with the actual vague phrase quoted).
- **Cross-references to canonical format docs** (e.g. links to `CONTEXT-FORMAT.md`, `ADR-FORMAT.md`) — reduce drift when those formats evolve.
- **Subagent delegations** (e.g. `subagent_type=Explore` for codebase walks) — keep main context clean.
- **Procedural anchoring to workflow state** (e.g. "the issue may sit in `ready-for-agent`" instead of the abstract "the brief may sit unused") — ties skill text to actual labels.

## Skills with zero upstream changes adopted in this sync

- `tdd-vertical`, `zoom-out`, `diagnose` — all upstream changes fell under the discard filters.
- `context-bootstrap` — does not exist upstream (100% this fork's).

## Process for next sync

1. Clone upstream to a tmpdir, identify last sync commit (recorded above).
2. `git log --oneline <last_sync>..HEAD` upstream — read commit messages.
3. For each touched skill: `diff -u <local>/SKILL.md <upstream>/SKILL.md` and supporting files.
4. Apply the discard filters above to mechanically reject portability-driven changes.
5. Evaluate the remaining changes one-by-one — adopt only those with independent value.
6. Update this file with the new sync date, commit, and any new filters discovered.
