---
name: context-bootstrap
description: Bootstrap a CONTEXT.md from an existing codebase by mining domain terms from code, comments, and docs, then proposing a draft glossary for the user to review and refine. Use when starting CONTEXT.md from scratch, says "bootstrap context", "create CONTEXT.md", "armar el glosario", or "explorar el dominio".
---

# Context Bootstrap

Generate a draft `CONTEXT.md` from an existing codebase. The output is a starting point for the user to refine — not the final glossary. Run this once when adopting the shared-language workflow on an existing repo, then use `/grill-with-docs` to keep it updated as decisions happen.

## Process

### 1. Detect repo shape

- If the repo already has a `CONTEXT.md` or `CONTEXT-MAP.md`, stop and tell the user — this skill is for greenfield bootstrap, not overwriting.
- Look for monorepo markers (separate `src/<domain>/`, packages, services). If found, ask: "I see this repo has multiple subsystems. Do you want one root `CONTEXT.md`, or a `CONTEXT-MAP.md` with per-subsystem contexts?"
- Otherwise, plan to write a single root `CONTEXT.md`.

### 2. Mine the codebase

Scan for domain vocabulary in this order, weighting later sources more heavily:

1. **README, docs/, top-level comments** — explicit framing.
2. **Top-level type definitions / model files** — entity names (Order, Invoice, Customer).
3. **Database schema / migrations** — table and column names.
4. **API route names / handler names** — verbs and resources.
5. **Test descriptions** — `describe("Order placement", ...)` is gold for naming.
6. **Variable / function names that recur across files** — recurrence is a signal.

Filter out generic programming concepts (config, util, helper, request, response, error). Only keep terms that are meaningful to a domain expert.

### 3. Cluster and de-duplicate

Group synonyms (e.g. `client` / `customer` / `account` may all refer to the same concept). For each cluster, propose **one canonical term** with the others as aliases-to-avoid. Pick the canonical term using:

1. The term most frequent in user-facing strings (UI labels, error messages).
2. The term most frequent in tests (which describe behavior).
3. The term that appears in the most recent code (less stale).

### 4. Draft the glossary

Write a draft `CONTEXT.md` following the format in `../grill-with-docs/CONTEXT-FORMAT.md`. For each term:

- One-sentence definition derived from how it's used in code.
- "Avoid" list with the synonyms found.
- Mark uncertain definitions with `???` so the user spots them.

Add a `## Relationships` section with cardinalities you can infer from foreign keys, type references, or test fixtures.

Add a `## Flagged ambiguities` section listing every cluster where you weren't confident in the canonical pick — these are the highest-value items for the user to review.

### 5. Review with the user

Present the draft and ask:

- "Are the canonical terms right?"
- "Any terms that don't belong (too generic, too implementation-specific)?"
- "Any obvious domain concepts I missed?"
- "Resolve the flagged ambiguities one by one."

Walk the ambiguities one at a time, like a `/grill-with-docs` session focused only on the glossary.

### 6. Write the file

Save the agreed-upon glossary to the planned location. Then suggest the user run `/grill-with-docs` next time they plan a feature, so the glossary stays alive.
