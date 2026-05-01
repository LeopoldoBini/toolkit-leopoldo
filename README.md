# toolkit-leopoldo

A curated, opinionated engineering toolkit for Claude Code. Five plugins that work together: alignment before coding, disciplined coding, shared domain language, backlog flow, and optional response modes.

## Plugins

| Plugin | What it gives you |
|---|---|
| **grill-me** | Stress-test a plan branch by branch before writing code. |
| **engineering-discipline** | `/diagnose`, `/deep-modules`, `/tdd-vertical`, `/zoom-out` — disciplined coding with a shared depth/seam/leverage vocabulary. |
| **shared-language** | `/grill-with-docs` and `/context-bootstrap` — maintain a `CONTEXT.md` (shared domain vocabulary) and write ADRs sparingly. |
| **backlog-flow** | `/to-prd`, `/to-issues`, `/triage`, `/agent-brief` — pipeline from raw context to AFK-agent-ready issues. |
| **response-modes** | Optional output styles: caveman (terse) and no-tldr (override always-on TL;DR rule). |

## Install

```bash
/plugin marketplace add LeopoldoBini/toolkit-leopoldo
/plugin install <plugin-name>@toolkit-leopoldo
```

## Attribution

Several skills (`grill-me`, `grill-with-docs`, `diagnose`, `deep-modules`, `tdd-vertical`, `zoom-out`, `to-prd`, `to-issues`, `triage`, `agent-brief`, `caveman` output style) are adapted from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT). See `LICENSE` for full attribution. Modifications include bilingual triggers, output-style packaging, and integration with the `CONTEXT.md` / MEMORY.md / CLAUDE.md three-artifact convention.

## License

MIT — see `LICENSE`.
