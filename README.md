# toolkit-leopoldo

A curated, opinionated engineering toolkit for Claude Code. Three plugins: the full engineering workflow (alignment → PRD → vertical-slice issues → AFK handoff → TDD execution → architectural sanity → triage), plus standalone alignment and response-mode tools.

## Plugins

| Plugin | What it gives you |
|---|---|
| **engineering-workflow** | The full pipeline: `/grill-with-docs`, `/context-bootstrap`, `/to-prd`, `/to-issues`, `/agent-brief`, `/triage`, `/tdd-vertical`, `/diagnose`, `/zoom-out`, `/deep-modules`. Plus `/init-workflow` to seed the canonical order into the repo's `CLAUDE.md`. |
| **grill-me** | Stress-test a plan branch by branch before writing code. Standalone — useful for non-code planning sessions. |
| **response-modes** | Optional output styles: caveman (terse) and no-tldr (override always-on TL;DR rule). |

## Install

```bash
/plugin marketplace add LeopoldoBini/toolkit-leopoldo
/plugin install engineering-workflow@toolkit-leopoldo
```

Then, in each repo where you want the pipeline visible to future sessions, run once:

```
/init-workflow
```

This seeds (or refreshes, idempotently) a `## Pipeline de trabajo (engineering-workflow)` block into the repo's `CLAUDE.md`, between HTML markers, so any future Claude session sees the canonical order.

## The pipeline

1. **`/context-bootstrap`** — only if the repo has code but no `CONTEXT.md`. One-shot.
2. **`/grill-with-docs`** (or `/grill-me` for non-code) — alignment session.
3. **`/to-prd`** — synthesise a PRD from the conversation.
4. **`/to-issues`** — break the PRD into vertical slices.
5. **`/agent-brief`** — durable handoff for AFK agents (optional).
6. **`/tdd-vertical`** + **`/diagnose`** — execute one slice at a time.
7. **`/zoom-out`** + **`/deep-modules`** — every 3-5 closed issues, architectural sanity check.
8. **`/triage`** — when the backlog grows.

## Migration v1 → v2 (BREAKING)

In v1, the workflow was split across three plugins (`engineering-discipline`, `shared-language`, `backlog-flow`). v2 unifies them into a single `engineering-workflow` plugin because the skills are not independently useful — they form one indivisible pipeline.

If you had v1 installed, replace it:

```
/plugin uninstall engineering-discipline@toolkit-leopoldo
/plugin uninstall shared-language@toolkit-leopoldo
/plugin uninstall backlog-flow@toolkit-leopoldo
/plugin install   engineering-workflow@toolkit-leopoldo
```

All slash commands keep the same names (`/grill-with-docs`, `/to-prd`, `/diagnose`, etc.) — only the plugin packaging changed.

`grill-me` and `response-modes` are unchanged.

## Attribution

Several skills (`grill-me`, `grill-with-docs`, `diagnose`, `deep-modules`, `tdd-vertical`, `zoom-out`, `to-prd`, `to-issues`, `triage`, `agent-brief`, `caveman` output style) are adapted from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT). See `LICENSE` for full attribution. Modifications include bilingual triggers, output-style packaging, the `/init-workflow` seeding command, and integration with the `CONTEXT.md` / `MEMORY.md` / `CLAUDE.md` three-artifact convention.

## License

MIT — see `LICENSE`.
