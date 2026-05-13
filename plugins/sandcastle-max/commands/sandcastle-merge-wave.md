---
name: sandcastle-merge-wave
description: Review and merge a wave of open AFK agent PRs (label `afk-agent-pr`) using parallel Opus reviewer containers, a topological coordinator, and a serial merge loop with intent-aware conflict resolution. Mirror of `/sandcastle-dispatch-wave` for the second half of the AFK loop. Each PR is reviewed by a fresh Opus container against its original brief, verdicts are aggregated, you confirm the approved bucket, and the command merges serially with auto-rebase + a conflict-resolver agent for non-trivial conflicts. Triggers when the user says "merge wave", "ola de merge", "revisar y mergear PRs AFK", "cerrar la ola".
---

# /sandcastle-merge-wave

Second half of the AFK loop, complementing `/sandcastle-dispatch-wave`. The dispatcher launches implementers in parallel; this command launches reviewers in parallel, computes a topological merge order, and serially merges with auto-rebase + intent-aware conflict resolution.

This command implements the design decisions from the planning rounds of 2026-05-13:
- **3 steps internos**: review paralelo (N PRs) → coordinator topológico (1 invocación) → merge serial con auto-rebase y conflict-resolver agent.
- **Single-axis review (Spec)** por ahora. Two-axis (Standards + Spec) se incorporará en Fase 6 cuando `/review` de Matt Pocock gradúe a stable.
- **Intent-aware conflict resolver** con outputs `RESOLVED` / `INCOMPATIBLE`, criterios de no-regresión explícitos.
- **Fixer-container** para BLOCK con subtipo `IMPLEMENTATION`; re-brief para `BRIEF_AMBIGUOUS`. Cap 2 rounds por issue.
- **Sin GH Actions**: la validación post-rebase la hace `sandcastle-validate` local (Fase 3).

## Pre-conditions (verify + auto-recover before doing anything)

Same self-recovering pre-flight pattern as `/sandcastle-dispatch-wave`. Run via a SINGLE Bash invocation so env vars persist across subsequent steps:

```bash
set -e

# Hard checks — abort if any fail.
git rev-parse --show-toplevel >/dev/null || { echo "✗ not a git repo"; exit 1; }
[[ -f .sandcastle/main.mts ]] || { echo "✗ .sandcastle/ not scaffolded — run /sandcastle-init first"; exit 1; }
docker info >/dev/null 2>&1 || { echo "✗ Docker daemon not running"; exit 1; }
gh repo view --json nameWithOwner --jq .nameWithOwner >/dev/null || { echo "✗ gh repo unresolved"; exit 1; }
docker image inspect sandcastle-max >/dev/null 2>&1 || { echo "✗ sandcastle-max image not built — run 'bun run sandcastle:build'"; exit 1; }

# Auto-recover OAuth token: if missing, attempt to source the helper.
if [[ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
  if [[ -f scripts/claude-oauth-env.sh ]]; then
    set +e
    source scripts/claude-oauth-env.sh 2>&1 | tail -5
    set -e
  fi
  [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]] || {
    echo "✗ CLAUDE_CODE_OAUTH_TOKEN missing and auto-source failed."
    echo "  Try manually: source scripts/claude-oauth-env.sh"
    exit 1
  }
fi

# Auto-recover GH token: if missing, attempt to read from gh CLI.
if [[ -z "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ]]; then
  if gh auth status >/dev/null 2>&1; then
    export GH_TOKEN=$(gh auth token)
  fi
  [[ -n "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ]] || {
    echo "✗ No GH_TOKEN/GITHUB_TOKEN and gh CLI not authenticated."
    exit 1
  }
fi

echo "✓ pre-flight passed (oauth=present gh_token=present docker=ok image=ok)"

# Detect base branch (HEAD donde estamos parados). El merge-wave debe
# correr desde la misma branch desde la cual se lanzó el dispatch.
export SANDCASTLE_BASE_BRANCH=$(git rev-parse --abbrev-ref HEAD)
export SANDCASTLE_BASE_BRANCH_SLUG=$(echo "$SANDCASTLE_BASE_BRANCH" | tr '/' '-' | tr '[:upper:]' '[:lower:]')
echo "✓ base branch detected: $SANDCASTLE_BASE_BRANCH"
```

**Importante para Claude (el AI ejecutando este comando):** todos los steps a continuación deben heredar las env vars recuperadas. Encadenar pre-flight + Step 1 + Step 2 + Step 3 en un único `bash -c` o en pocas invocaciones de Bash. NO llamar Bash una vez por step — las env vars se resetean entre llamadas.

## Step 1 — Discover PRs to review

Listar los PRs abiertos con label `afk-agent-pr` que estén **listos para review** (`afk-checks-passed`, sin label `agent-approved` aún):

```bash
gh pr list \
  --state open \
  --label afk-agent-pr \
  --label afk-checks-passed \
  --json number,title,headRefName,baseRefName,labels,files,additions,deletions,mergeable \
  --jq '[.[] | select(.labels | map(.name) | contains(["agent-approved"]) | not)]'
```

Para cada PR encontrado:
1. Extraer su issue número del título (patrón `feat(#N):`, `fix(#N):`) o del cuerpo (`Closes #N`).
2. Verificar que el PR `baseRefName` matchee con `$SANDCASTLE_BASE_BRANCH` — si no, es un PR de otra rama, SKIP con warning.
3. Verificar `mergeable == "MERGEABLE"` o `"UNKNOWN"`; si `"CONFLICTING"` ya, anotalo para el coordinator.
4. Verificar que el PR no tenga label `agent-rejected` reciente (escape hatch del round previo).

Si no hay PRs elegibles: abort con "no hay PRs para revisar. Lanzá `/sandcastle-dispatch-wave` primero o esperá a que afk-checks pase."

## Step 2 — Preview to user

```
Merge wave detectada (N PRs listos para review):

  PR #45  (#5  F2 — Primitives library)       agent/feature-x/issue-5    [+450/-12, 8 files]
  PR #46  (#7  VS3 — Order endpoint)          agent/feature-x/issue-7    [+220/-3, 4 files]
  PR #47  (#9  VS4 — Order list UI)           agent/feature-x/issue-9    [+340/-8, 6 files]

PRs descartados (no listos):
  PR #48  (#2)  → afk-checks-failed
  PR #49  (#4)  → agent-rejected (round previo: scope creep)

Image: sandcastle-max  ·  Model: claude-opus-4-7  ·  Reviewers paralelos: N

Lanzar review wave? [y/N/select <PR numbers comma-separated>]:
```

## Step 3 — User confirmation

Wait for input. Same semantics como `/sandcastle-dispatch-wave`:
- `y` / `Y` → review todos los PRs elegibles.
- `N` / vacío → abortar.
- `select 45,46` → subset.
- `--no-confirm` arg → skipear esta puerta.

## Step 4 — Per-PR preparation

Para cada PR en el review set, BEFORE launching reviewers:

1. **Extract the original brief.** El reviewer necesita el contrato exacto contra el cual evaluar:
   ```bash
   ISSUE_N=$(extraer del título o body del PR)
   ORIGINAL_BRIEF=$(gh api repos/$REPO/issues/$ISSUE_N/comments \
     --jq '[.[] | select(.body | contains("## Agent Brief"))] | last | .body')
   ```
   Si no hay brief: SKIP con warning. El PR no se puede evaluar sin contrato.

2. **Snapshot del PR.** Capturar el diff y la metadata que el reviewer va a leer:
   ```bash
   mkdir -p .sandcastle/review-inputs
   gh pr diff $PR_NUMBER > ".sandcastle/review-inputs/pr-${PR_NUMBER}.diff"
   gh pr view $PR_NUMBER --json files,title,body,headRefName,baseRefName,additions,deletions \
     > ".sandcastle/review-inputs/pr-${PR_NUMBER}.meta.json"
   ```

3. **Compose review prompt** para este PR. Escribir a `.sandcastle/review-prompts/pr-${PR_NUMBER}.md` usando el template de "Review prompt" abajo.

## Step 5 — Launch review containers (paralelo)

Cada reviewer corre en un container Sandcastle separado, branchStrategy=head (read-only), modelo Opus 4.7:

```bash
mkdir -p .sandcastle/review-logs
for PR_N in $REVIEW_SET; do
  REVIEW_PROMPT=".sandcastle/review-prompts/pr-${PR_N}.md"
  LOG=".sandcastle/review-logs/pr-${PR_N}-$(date +%Y%m%d-%H%M%S).log"
  (
    SANDCASTLE_MODEL="claude-opus-4-7" \
    SANDCASTLE_ROLE="reviewer" \
    SANDCASTLE_PR_NUMBER="$PR_N" \
    SANDCASTLE_PROMPT_FILE="$REVIEW_PROMPT" \
      bunx tsx .sandcastle/main.mts > "$LOG" 2>&1 &
    echo $! > ".sandcastle/review-logs/pr-${PR_N}.pid"
  )
done
```

Monitor mode (cada 30s):
- Check `docker info` (wave-fatal si falla).
- List PIDs vivos.
- Para PIDs muertos, parsear el log:
  - `<verdict>APPROVE</verdict>` → label `agent-approved` ya aplicado por el agente. Continuar al Step 6.
  - `<verdict>HOLD</verdict>` → label `needs-changes` ya aplicado. NO entra al merge bucket esta ola.
  - `<verdict>BLOCK</verdict>` + `<block-reason>IMPLEMENTATION</block-reason>` → registrar para fixer-container (Step 7b).
  - `<verdict>BLOCK</verdict>` + `<block-reason>BRIEF_AMBIGUOUS</block-reason>` → registrar para re-brief (Step 7b).
  - Sin verdict → log error y label `reviewer-crashed`. Escalate a Leo.

### Per-PR `review-prompts/pr-N.md` template

```markdown
You are an AFK Claude Code reviewer agent. Your job is to judge whether an open PR honors the original brief from the issue tracker. You DO NOT modify any code. You DO NOT merge. You emit a verdict + a comment on the PR and exit.

## Context

- **Repo:** {{REPO}}
- **PR:** #{{PR_NUMBER}} — {{PR_TITLE}}
- **Branch:** {{HEAD_REF}} → {{BASE_REF}}
- **Files touched:** {{FILE_COUNT}} ({{ADDITIONS}}+/{{DELETIONS}}-)
- **Origin issue:** #{{ISSUE_N}}

## The contract (original Agent Brief)

This block is the ONLY contract you evaluate against. Discussion in the issue, the PR body, commit messages — context only. The brief is the contract.

---

{{ORIGINAL_BRIEF}}

---

## What you must do

### 1. Read inputs

- `.sandcastle/review-inputs/pr-{{PR_NUMBER}}.diff` — the full diff
- `.sandcastle/review-inputs/pr-{{PR_NUMBER}}.meta.json` — files list, additions/deletions
- The brief above
- Explore the codebase as needed to understand context (e.g. `CONTEXT.md` for vocabulary, `CLAUDE.md` for repo conventions — but Standards-axis review is NOT your job; focus on Spec)

### 2. Judge the implementation vs. the contract (Spec axis only)

Report:
- **(a) Missing or partial acceptance criteria** — what the brief asked for that isn't in the diff (or is half-done). Cite the brief literally for each finding.
- **(b) Scope creep** — behavior in the diff that wasn't asked for. Cite the diff hunk and explain why it's out of scope.
- **(c) Wrong implementation** — criteria that look addressed but are implemented incorrectly. Cite the brief literally + the diff hunk.

Under 600 words total. Be specific. No vague language.

### 3. Emit a verdict

Choose ONE:

- `<verdict>APPROVE</verdict>` — the diff honors the contract. No critical findings (minor style notes are OK but not blockers).
- `<verdict>HOLD</verdict>` — the diff is close but has findings that the implementer should address. NOT a critical block; just needs another pass.
- `<verdict>BLOCK</verdict>` — the diff has critical issues. Include subtype:
  - `<block-reason>IMPLEMENTATION</block-reason>` — implementation is incorrect or incomplete but the brief was clear. Fixer-container will attempt to repair in-place.
  - `<block-reason>BRIEF_AMBIGUOUS</block-reason>` — you cannot judge because the brief is unclear/contradictory. You must additionally:
    1. Write `## Agent Brief - Round 2` as a NEW comment on issue #{{ISSUE_N}} with clarifications based on what you observed.
    2. Apply label `agent-blocked-rebrief` to the issue.
    The next `/sandcastle-dispatch-wave` will pick up the updated brief.

### 4. Post your review

Write a comment on the PR with this exact structure:

```markdown
## Spec Review (single-axis, /sandcastle-merge-wave)

**Verdict:** APPROVE | HOLD | BLOCK

### Findings

#### Missing / partial criteria
- ...

#### Scope creep
- ...

#### Wrong implementation
- ...

### Verdict rationale
(1-2 sentences explaining the verdict)

— Reviewed by Opus 4.7 against issue #{{ISSUE_N}} brief.
```

Use:
```bash
gh pr comment {{PR_NUMBER}} --body-file <comment-file>
```

### 5. Apply labels

- If APPROVE → `gh pr edit {{PR_NUMBER}} --add-label agent-approved`
- If HOLD → `gh pr edit {{PR_NUMBER}} --add-label needs-changes`
- If BLOCK → `gh pr edit {{PR_NUMBER}} --add-label agent-rejected`

### 6. Emit the verdict token

End your run with EXACTLY the verdict block, e.g.:

```
<verdict>APPROVE</verdict>
```

or

```
<verdict>BLOCK</verdict>
<block-reason>IMPLEMENTATION</block-reason>
```

## Anti-patterns (do not do these)

- Do NOT modify code. Read-only review.
- Do NOT execute `gh pr merge`. Merging is the orchestrator's job after your verdict.
- Do NOT evaluate Standards (CLAUDE.md, CONTEXT.md compliance) — that's Fase 6, not in scope for single-axis.
- Do NOT approve when you can't find the brief — emit BLOCK + BRIEF_AMBIGUOUS instead.
- Do NOT be vague. Cite brief lines, cite diff hunks.
```

When generating this file, substitute:
- `{{REPO}}` → `gh repo view --json nameWithOwner --jq .nameWithOwner`
- `{{PR_NUMBER}}` → the PR number
- `{{PR_TITLE}}` → from `gh pr view --json title`
- `{{HEAD_REF}}` / `{{BASE_REF}}` → from PR meta
- `{{FILE_COUNT}}` / `{{ADDITIONS}}` / `{{DELETIONS}}` → from PR meta
- `{{ISSUE_N}}` → extracted from PR title or body
- `{{ORIGINAL_BRIEF}}` → contents of the latest `## Agent Brief` comment on the issue

## Step 6 — Aggregate verdicts and confirm

When all review PIDs have exited, present:

```
Review wave summary (3 reviewed):

  PR #45 (#5 F2)   ✓ APPROVE      label agent-approved
  PR #46 (#7 VS3)  ⚠ HOLD         label needs-changes — see comment
  PR #47 (#9 VS4)  ✗ BLOCK        label agent-rejected — IMPLEMENTATION

Approved bucket: PR #45

Logs: .sandcastle/review-logs/*

Proceder con merge del bucket APPROVE? [y/N/select <PR numbers>]:
```

Wait for confirmation. Same semantics que Step 3.

## Step 7 — Coordinator topológico (1 invocación Opus, no paralela)

Para los PRs aprobados, computar orden de merge. Lanzar UN container Opus coordinator:

```bash
mkdir -p .sandcastle/coordinator-inputs
# Snapshot todos los diffs aprobados
for PR in $APPROVED_SET; do
  gh pr diff $PR > ".sandcastle/coordinator-inputs/pr-${PR}.diff"
  gh pr view $PR --json files,title,body > ".sandcastle/coordinator-inputs/pr-${PR}.meta.json"
done
# Escribir el prompt del coordinator
# (template abajo)
SANDCASTLE_MODEL="claude-opus-4-7" \
SANDCASTLE_ROLE="coordinator" \
SANDCASTLE_PROMPT_FILE=".sandcastle/coordinator-prompt.md" \
  bunx tsx .sandcastle/main.mts > .sandcastle/coordinator-logs/$(date +%Y%m%d-%H%M%S).log 2>&1
```

### Coordinator prompt template

```markdown
You are the merge-wave coordinator. Your job is to decide the order in which N approved PRs should be merged into `{{BASE_BRANCH}}` to minimize conflicts and respect implicit dependencies.

## Input

Each PR is described by:
- `.sandcastle/coordinator-inputs/pr-{N}.diff`
- `.sandcastle/coordinator-inputs/pr-{N}.meta.json` (files + brief reference)
- The latest `## Agent Brief` of its origin issue (citado en el meta.json)

## What you must do

### 1. Detect file overlaps
Use `jq` o lectura directa para extraer la lista de `files` por PR. Si dos PRs tocan archivos en común, ese par tiene **overlap físico** (futuro conflict potencial).

### 2. Detect logical dependencies
Lee cada brief y busca `## Blocked by` o referencias `#N` cross-issue. Si PR-X depende lógicamente de PR-Y, debe mergearse después.

### 3. Detect semantic-risk pairs
Lee los diffs de pares con overlap físico. Marcá como "semantic-risk" los pares donde:
- Ambos modifican el mismo símbolo (función, tipo, constante)
- Uno introduce algo que el otro consume (acoplamiento implícito)
- Los briefs sugieren intents potencialmente contradictorios

### 4. Emit topological order

Output EXACTAMENTE este formato:

```
<merge-order>
PR_N
PR_M
PR_K
</merge-order>

<semantic-risk-pairs>
PR_N ↔ PR_M (razón: ambos modifican createUser())
</semantic-risk-pairs>

<rationale>
(1-2 párrafos explicando el ordenamiento)
</rationale>
```

Si no hay overlap ni deps lógicas, cualquier orden vale — emitir el orden por número de PR.

## Anti-patterns

- NO modifiques código.
- NO emitas verdicts (eso ya pasó en Step 5).
- NO leas archivos fuera de `.sandcastle/coordinator-inputs/`.
```

El comando orquestador parsea el output (`<merge-order>` block, `<semantic-risk-pairs>` block) y arma:
- `MERGE_ORDER=(PR_N PR_M PR_K)` — array secuencial
- `SEMANTIC_RISK_PAIRS` — map PR → list of "watch out for" PRs

## Step 8 — Loop secuencial de merge

```bash
for PR in "${MERGE_ORDER[@]}"; do
  echo "=== Merging PR #$PR ==="

  # 1. Auto-rebase contra la base actualizada
  if ! gh pr update-branch $PR 2>/dev/null; then
    # Conflict detectado — lanzar conflict-resolver agent (ver Step 8a)
    resolve_conflict $PR
    RESOLVE_RESULT=$?
    if [[ $RESOLVE_RESULT -ne 0 ]]; then
      echo "  ✗ INCOMPATIBLE — skipping merge, escalating to Leo"
      gh pr edit $PR --add-label intent-conflict
      continue
    fi
  fi

  # 2. Validar con sandcastle-validate local (Fase 3)
  if ! scripts/sandcastle-validate.sh $PR; then
    echo "  ✗ afk-checks failed post-rebase — skipping merge"
    continue
  fi

  # 3. Merge
  gh pr merge $PR --squash --delete-branch --subject "$(gh pr view $PR --json title --jq .title)"
  echo "  ✓ merged"
done
```

### Step 8a — Conflict-resolver agent (intent-aware)

Se invoca cuando `gh pr update-branch` falla. NO es el mismo agente que el reviewer — branchStrategy distinta (sí commitea, sí push --force).

```bash
resolve_conflict() {
  local PR=$1
  local BRANCH=$(gh pr view $PR --json headRefName --jq .headRefName)
  local PREV_MERGED=("${ALREADY_MERGED[@]}")  # PRs ya mergeados en esta ola

  # Snapshot de inputs para el resolver
  mkdir -p .sandcastle/resolver-inputs
  gh pr diff $PR > ".sandcastle/resolver-inputs/pr-${PR}.diff"
  for prev in "${PREV_MERGED[@]}"; do
    gh pr diff $prev > ".sandcastle/resolver-inputs/prev-pr-${prev}.diff"
    gh api repos/$REPO/issues/$(extract_issue $prev)/comments \
      --jq '[.[] | select(.body | contains("## Agent Brief"))] | last | .body' \
      > ".sandcastle/resolver-inputs/prev-pr-${prev}.brief.md"
  done

  # Render del prompt + launch
  SANDCASTLE_MODEL="claude-opus-4-7" \
  SANDCASTLE_ROLE="resolver" \
  SANDCASTLE_ISSUE_NUMBER="$(extract_issue $PR)" \
  SANDCASTLE_BRANCH="$BRANCH" \
  SANDCASTLE_BASE_BRANCH="$SANDCASTLE_BASE_BRANCH" \
  SANDCASTLE_PROMPT_FILE=".sandcastle/resolver-prompts/pr-${PR}.md" \
    bunx tsx .sandcastle/main.mts > ".sandcastle/resolver-logs/pr-${PR}.log" 2>&1

  # Parsear output
  if grep -q "<resolution>RESOLVED</resolution>" ".sandcastle/resolver-logs/pr-${PR}.log"; then
    return 0
  else
    return 1  # INCOMPATIBLE o error
  fi
}
```

### Conflict-resolver prompt template

```markdown
You are an intent-aware merge conflict resolver. Your job is to resolve git conflicts in PR #{{PR_NUMBER}} against the updated base `{{BASE_BRANCH}}` — WHILE PRESERVING THE INTENT of every brief involved. You are NOT a syntactic merger.

## Context

This PR was approved by a reviewer but couldn't be rebased cleanly because previous PRs in this wave already modified overlapping code.

## Inputs you must read

1. **Your contract (this PR's brief):**
   `.sandcastle/resolver-inputs/pr-{{PR_NUMBER}}.brief.md`

2. **Your original diff (pre-rebase):**
   `.sandcastle/resolver-inputs/pr-{{PR_NUMBER}}.diff`

3. **Briefs and diffs of the PRs already merged in this wave (intent of the new base):**
   `.sandcastle/resolver-inputs/prev-pr-*.brief.md`
   `.sandcastle/resolver-inputs/prev-pr-*.diff`

4. **Current state of the base** (after the previous merges):
   - `git log --oneline {{BASE_BRANCH}}..HEAD` if you need to see commits.
   - Read files in the working directory; the conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) show where git couldn't decide.

## What you must do

### 1. Understand both intents
For each conflict marker block, read:
- What your brief asked for (your intent)
- What the previous merged brief(s) asked for (the new-base intent)

### 2. Resolve preserving BOTH intents
Edit the file so that the resolved code:
- Implements **your** contract's behavior fully.
- Preserves the behavior introduced by the previous merge(s).
- Is syntactically and semantically correct.

### 3. Verify no regression (criterios de no-regresión)

Your resolution MUST NOT:
1. Eliminate behavior explicitly required by ANY of the briefs in conflict.
2. Silence, skip, or `it.skip` tests to make compilation pass.
3. "Simplify" code that appears duplicated if the briefs justify it as separate (e.g. two validators that happen to look similar but serve different purposes).
4. Introduce behavior that isn't asked for in ANY brief.
5. Change public contracts (function signatures, exported types) without justification in some brief.

If satisfying your contract REQUIRES violating one of 1-5 — that's an **INCOMPATIBLE** outcome, not a RESOLVED one. The intents are mutually exclusive by design and human judgment is needed.

### 4. Run tests + typecheck before pushing

Inside the container:
- `bun run typecheck:ui` (if applicable)
- `tsc --noEmit`
- `bun test`

If anything fails post-resolution, you must fix it — or escalate as INCOMPATIBLE.

### 5. Commit and force-push

```bash
git add -A
git commit -m "resolve: rebase {{BRANCH}} on {{BASE_BRANCH}} after wave merges"
git push --force-with-lease origin {{BRANCH}}
```

### 6. Emit the resolution token

End with EXACTLY one of:

- `<resolution>RESOLVED</resolution>` — you produced a clean diff that preserves both intents, tests pass.
- `<resolution>INCOMPATIBLE</resolution>` — the intents are mutually exclusive. **Before printing this**:
  1. Comment on PR #{{PR_NUMBER}} with `## Intent Conflict` explaining what couldn't coexist and which brief lines collide.
  2. Apply label `intent-conflict` to the PR.
  Then output `<resolution>INCOMPATIBLE</resolution>`.

## Anti-patterns

- Do NOT delete code from previous merges to "simplify". That's regression.
- Do NOT pick one intent and discard the other "for now". That's regression too.
- Do NOT push without running tests.
- Do NOT use `--no-verify` to bypass hooks.
```

### Step 8b — Fixer-container (for BLOCK + IMPLEMENTATION from Step 5)

Si en Step 5 algún PR salió como `BLOCK + IMPLEMENTATION`, lanzar un fixer-container que recibe el feedback del reviewer y arregla in-place. NO se ejecuta en serie con el merge loop; corre en paralelo después de Step 5 (antes o durante Step 8).

```bash
for PR in $BLOCK_IMPLEMENTATION_SET; do
  SANDCASTLE_MODEL="claude-opus-4-7" \
  SANDCASTLE_ROLE="fixer" \
  SANDCASTLE_PR_NUMBER="$PR" \
  SANDCASTLE_BRANCH=$(gh pr view $PR --json headRefName --jq .headRefName) \
  SANDCASTLE_BASE_BRANCH="$SANDCASTLE_BASE_BRANCH" \
  SANDCASTLE_PROMPT_FILE=".sandcastle/fixer-prompts/pr-${PR}.md" \
    bunx tsx .sandcastle/main.mts > ".sandcastle/fixer-logs/pr-${PR}.log" 2>&1 &
done
```

El fixer recibe en el prompt: brief original + diff actual + comentario del reviewer (feedback específico). Lee, edita, commitea, push (no --force, append). Re-corre el ciclo de review (próxima ola).

**Cap: 2 rounds máximo por PR**. Track con label `fixer-round-1`, `fixer-round-2`. Después → label `manual-intervention` y escalate a Leo.

## Step 9 — Final report

```
Merge wave summary (5/7 success):

  PR #45 (#5 F2)   ✓ merged                       (squash, branch deleted)
  PR #46 (#7 VS3)  ⚠ HOLD                          needs-changes — not merged
  PR #47 (#9 VS4)  ✓ merged                       (after auto-rebase clean)
  PR #48 (#2)      ✓ merged                       (after conflict-resolver: RESOLVED)
  PR #49 (#4)      ✗ INCOMPATIBLE                 intent-conflict — Leo decide
  PR #50 (#6)      ⌛ fixer-round-1 spawned        rerun /sandcastle-merge-wave después
  PR #51 (#8)      ⌛ rebrief escrito              rerun /sandcastle-dispatch-wave para round 2

Issues mergeados: #5, #9, #2
Próxima ola: re-run /sandcastle-pipeline (o /sandcastle-dispatch-wave manualmente)
                cuando fixer + rebrief estén listos.

Logs:
  .sandcastle/review-logs/*
  .sandcastle/resolver-logs/*
  .sandcastle/fixer-logs/*

Wave report: .sandcastle/wave-reports/<timestamp>.json
```

Save wave report como JSON estructurado en `.sandcastle/wave-reports/<timestamp>.json`:

```json
{
  "wave_id": "merge-2026-05-13-1830",
  "base_branch": "feature/x",
  "reviewed": [...],
  "approved_and_merged": [...],
  "hold": [...],
  "blocked_implementation": [...],
  "blocked_rebrief": [...],
  "incompatible": [...],
  "ci_failed_post_rebase": [...]
}
```

## Cleanup

- Borrar `.sandcastle/review-logs/*.pid`, `.sandcastle/resolver-logs/*.pid`, `.sandcastle/fixer-logs/*.pid` (PIDs ya no válidos).
- Mantener `.log`, `review-prompts/`, `resolver-prompts/`, `fixer-prompts/`, `review-inputs/`, `resolver-inputs/` para debugging postmortem.

## Arguments

- `--prs <list>` — explicit review set, skipping discovery (ej. `--prs 45,46,47`).
- `--max-parallel <N>` — cap concurrency. Default: launch all eligible.
- `--dry-run` — todo menos lanzar containers. Imprime los prompts, env vars, comandos. Útil para verificar extracción de briefs y composición del review prompt.
- `--no-confirm` — skipea las puertas y/N (Step 3 + Step 6). Solo úsalo en scripts.
- `--skip-coordinator` — usar orden por número de PR ascendente en lugar del Opus coordinator (fallback más barato si la quota Max está apretada).

## Notes for future maintainers

- **`/review` de Matt Pocock está in-progress** al momento de escribir (2026-05-13). Cuando gradúe a `skills/engineering/` stable, agregar Fase 6: dos-axis review (Standards + Spec) en el reviewer. Implica disparar 2 sub-agentes general-purpose dentro de cada container reviewer, aggregator sin merge/rerank, output bajo `## Standards Review` y `## Spec Review`.
- **El conflict-resolver es intent-aware**, no syntax-aware. Si en práctica vemos resolvers que mergean "simplificando" (regresión silenciosa), reforzar los criterios de no-regresión en el prompt y considerar añadir checks programáticos (diff contra brief expected outputs).
- **El fixer-container puede entrar en loop infinito**. El cap de 2 rounds (`fixer-round-1`, `fixer-round-2`) es la guardia. Si Leo ve `manual-intervention` con frecuencia, el brief estaba mal-escrito desde el origen — actualizar `/agent-brief` skill upstream.
- **Sin GH Actions**: `sandcastle-validate` corre local (Fase 3 — `scripts/sandcastle-validate.sh`). Si por alguna razón hace falta validar en GH (cloud build, secrets remotos), agregar un step opcional en Step 8 — pero por default todo es local.
- **Quota Max y Opus**: una ola de N reviewers + 1 coordinator + posibles resolver/fixer containers consume rápido la ventana de 5h. Limitar `--max-parallel` a 3-4 con Opus. Si quota se agota mid-wave, abortar y aplicar label `quota-exhausted` (manejo formal en Fase 5 con `/sandcastle-pipeline`).
