---
name: init-workflow
description: Seed (or refresh) the engineering-workflow pipeline block in this repo's CLAUDE.md so future Claude sessions follow the canonical order automatically. Idempotent — uses HTML markers to update in place instead of duplicating. Run once per repo when adopting the engineering-workflow plugin.
---

# /init-workflow

You are seeding (or refreshing) the **engineering-workflow** pipeline block in the current repository's `CLAUDE.md`. This is what makes the canonical pipeline order discoverable to every future session in this repo.

## What you must do

1. **Locate the repo root.** Use `git rev-parse --show-toplevel`. If not a git repo, use the current working directory and warn the user this is not a git repo (proceed anyway).

2. **Determine the target file**: `<repo-root>/CLAUDE.md`.

3. **Check current state**:
   - If `CLAUDE.md` does not exist → create it with the block as the only content.
   - If `CLAUDE.md` exists and contains `<!-- engineering-workflow:pipeline:start -->` → replace the entire region between `:start -->` and `<!-- engineering-workflow:pipeline:end -->` with the fresh block (idempotent refresh).
   - If `CLAUDE.md` exists and does not contain the markers → append the block at the end, separated by a blank line.

4. **The block to insert** (verbatim, between the markers):

```markdown
<!-- engineering-workflow:pipeline:start -->
## Pipeline de trabajo (engineering-workflow)

Orden default cuando se arranca o retoma trabajo en este repo. Cada paso se invoca con un slash command del plugin `engineering-workflow`.

1. **`/context-bootstrap`** — solo si el repo ya tiene código pero no hay `CONTEXT.md`. One-shot por repo.
2. **`/grill-with-docs`** (o `/grill-me` para no-código) — alineación: el agente te interroga hasta que el plan esté claro. Actualiza `CONTEXT.md` y propone ADRs cuando hay decisiones grandes.
3. **`/to-prd`** — sintetiza un PRD durable a partir de la conversación. Misma sesión que el grilling.
4. **`/to-issues`** — rompe el PRD en **vertical slices** (tracer bullets). Anti-horizontal.
5. **`/agent-brief <issue>`** — opcional: contrato durable (acceptance criteria, out-of-scope, sin paths frágiles) para handoff a un AFK agent vía `/schedule`.
6. **`/tdd-vertical`** + **`/diagnose`** — ejecutar issue por issue con red-green-refactor; `/diagnose` cuando algo se rompe.
7. **`/zoom-out`** + **`/deep-modules`** — cada 3-5 issues cerrados, sanidad arquitectónica (mapeo de alto nivel + deepening opportunities).
8. **`/triage`** — cuando el backlog crece, máquina de estados sobre los issues.

### Reglas
- Saltarse el paso 2 (alineación) es la causa #1 de retrabajo. No saltearlo.
- TDD obligatorio en código con lógica; saltearlo en boilerplate puro (config, ENV).
- Vertical > horizontal siempre. Una rebanada que anda end-to-end > tres capas a medias.
- `CONTEXT.md` (lenguaje compartido) y `CLAUDE.md` (cómo es el sistema) y `MEMORY.md` (qué aprendí) son tres artefactos distintos — no mezclarlos.

### Refrescar este bloque
Volver a correr `/init-workflow` reemplaza el contenido entre los marcadores HTML sin tocar el resto del archivo.
<!-- engineering-workflow:pipeline:end -->
```

5. **Implementation hints**:
   - Use the `Read` tool to inspect `CLAUDE.md` first if it exists.
   - For the in-place update, prefer the `Edit` tool with `old_string` capturing from `<!-- engineering-workflow:pipeline:start -->` through `<!-- engineering-workflow:pipeline:end -->` and replace with the fresh block.
   - For a brand-new file or append, use `Write` (new file) or `Edit` (append by replacing the file's tail).
   - Do **not** use `sed`/`awk` — use the dedicated file tools.

6. **Confirm to the user**: report which of the three paths happened (created, refreshed in place, appended) and the absolute path of the file. Keep it to one or two sentences. No extra commentary.
