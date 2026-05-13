---
name: sandcastle-pipeline
description: Meta-comando que loopa /sandcastle-dispatch-wave → sandcastle-validate (polling local) → /sandcastle-merge-wave hasta que no queden issues `ready-for-agent` con dependencias resueltas. Default `--max-parallel 4` cuando el modelo es Opus. Soporta checkpoints (.sandcastle/checkpoints/) para reanudar tras interrupciones, y manejo de quota Max exhausted (label `quota-exhausted` + abort). Triggers cuando el user dice "corré el pipeline AFK", "pipeline completo", "lanzá el loop AFK", "automatizá el ciclo".
---

# /sandcastle-pipeline

Meta-comando integrador. Encadena `/sandcastle-dispatch-wave` + `sandcastle-validate` + `/sandcastle-merge-wave` en un loop, una iteración por ola, hasta que no haya más issues elegibles.

**Cuándo usarlo:** cuando tenés un set de issues `ready-for-agent` con dependencias entre ellos y querés que Claude maneje el ciclo completo sin que vos tengas que invocar cada subcomando. **Cuándo NO usarlo:** primera ola sobre un proyecto nuevo (corré los subcomandos a mano para calibrar primero — ver Fase 4 del plan).

## Arquitectura

```
loop:
  ┌─────────────────────────────────────────────────────────────────┐
  │ Iteration N                                                      │
  ├─────────────────────────────────────────────────────────────────┤
  │                                                                  │
  │  1. Checkpoint check                                             │
  │       ¿hay .sandcastle/checkpoints/*.json pendiente?              │
  │         → ofrecer reanudar (Y/N)                                 │
  │                                                                  │
  │  2. /sandcastle-dispatch-wave [--no-confirm si no es primera]   │
  │       lanza N containers Opus en paralelo                        │
  │       wait all PIDs                                              │
  │                                                                  │
  │  3. Polling local cada 30s sobre PRs lanzados:                   │
  │       scripts/sandcastle-validate.sh $PR  (Fase 3)               │
  │       timeout: 30 min default                                    │
  │       PRs que excedan timeout → label `slow-ci`, no entran a    │
  │         merge-wave esta iteración                                │
  │                                                                  │
  │  4. /sandcastle-merge-wave [--no-confirm si no es primera]      │
  │       review paralelo → coordinator topológico → merge serial   │
  │                                                                  │
  │  5. Check: ¿quedan issues con label `ready-for-agent` y deps    │
  │     mergeadas?                                                   │
  │       sí → continuar al siguiente iteration                     │
  │       no → break, fin del pipeline                              │
  │                                                                  │
  └─────────────────────────────────────────────────────────────────┘
```

## Pre-conditions

Mismo pre-flight que dispatch-wave y merge-wave. Run via un SINGLE bash invocation:

```bash
set -e

git rev-parse --show-toplevel >/dev/null || { echo "✗ not a git repo"; exit 1; }
[[ -f .sandcastle/main.mts ]] || { echo "✗ .sandcastle/ not scaffolded"; exit 1; }
docker info >/dev/null 2>&1 || { echo "✗ Docker daemon not running"; exit 1; }
gh repo view --json nameWithOwner --jq .nameWithOwner >/dev/null || { echo "✗ gh repo unresolved"; exit 1; }
docker image inspect sandcastle-max >/dev/null 2>&1 || { echo "✗ sandcastle-max image not built"; exit 1; }

# OAuth + GH token auto-recovery (igual que dispatch-wave)
[[ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]] && {
  [[ -f scripts/claude-oauth-env.sh ]] && { set +e; source scripts/claude-oauth-env.sh 2>&1 | tail -3; set -e; }
  [[ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]] && { echo "✗ CLAUDE_CODE_OAUTH_TOKEN missing"; exit 1; }
}
[[ -z "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ]] && {
  gh auth status >/dev/null 2>&1 && export GH_TOKEN=$(gh auth token)
  [[ -z "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ]] && { echo "✗ No GH_TOKEN"; exit 1; }
}

# Base branch detection
export SANDCASTLE_BASE_BRANCH=$(git rev-parse --abbrev-ref HEAD)
export SANDCASTLE_BASE_BRANCH_SLUG=$(echo "$SANDCASTLE_BASE_BRANCH" | tr '/' '-' | tr '[:upper:]' '[:lower:]')

# Default max-parallel para Opus
export SANDCASTLE_MAX_PARALLEL="${SANDCASTLE_MAX_PARALLEL:-4}"
export SANDCASTLE_MODEL="${SANDCASTLE_MODEL:-claude-opus-4-7}"

# Pipeline directories
mkdir -p .sandcastle/checkpoints .sandcastle/pipeline-logs

echo "✓ pre-flight passed"
echo "  base_branch: $SANDCASTLE_BASE_BRANCH"
echo "  model: $SANDCASTLE_MODEL"
echo "  max_parallel: $SANDCASTLE_MAX_PARALLEL"
```

## Step 0 — Checkpoint recovery

Antes de arrancar una iteración nueva, verificar si hay checkpoint pendiente:

```bash
LATEST_CHECKPOINT=$(ls -t .sandcastle/checkpoints/*.json 2>/dev/null | head -1)
if [[ -n "$LATEST_CHECKPOINT" ]]; then
  STATUS=$(jq -r '.status' "$LATEST_CHECKPOINT")
  if [[ "$STATUS" != "completed" ]]; then
    echo "Checkpoint pendiente: $LATEST_CHECKPOINT (status=$STATUS)"
    echo "Resumen:"
    jq '{wave_id, base_branch, started_at, last_step, dispatched, validated, reviewed, merged}' "$LATEST_CHECKPOINT"
    echo ""
    read -p "Reanudar desde acá? [Y/n]: " RESUME
    if [[ "$RESUME" != "n" && "$RESUME" != "N" ]]; then
      export PIPELINE_RESUME_FROM="$LATEST_CHECKPOINT"
    fi
  fi
fi
```

Si hay `PIPELINE_RESUME_FROM` seteado, saltear las etapas ya completadas según el checkpoint.

### Formato del checkpoint JSON

```json
{
  "wave_id": "pipeline-2026-05-13-1800",
  "base_branch": "feature/x",
  "started_at": "2026-05-13T18:00:00-03:00",
  "iteration": 2,
  "status": "in_progress",
  "last_step": "merge_wave",
  "dispatched": [5, 7, 9],
  "validated": [5, 7, 9],
  "reviewed": [5, 7],
  "merged": [5],
  "pending_merge": [7],
  "hold": [],
  "blocked": [],
  "quota_used_estimate": "2h 15m",
  "next_step": "merge_wave_continue"
}
```

El comando actualiza este archivo después de cada step grande (post-dispatch, post-validate, post-review, post-merge).

## Step 1 — Iteration loop

```bash
ITERATION=0
WAVE_ID="pipeline-$(date +%Y-%m-%d-%H%M%S)"
CHECKPOINT=".sandcastle/checkpoints/${WAVE_ID}.json"

# Inicializar checkpoint
cat > "$CHECKPOINT" <<EOF
{
  "wave_id": "$WAVE_ID",
  "base_branch": "$SANDCASTLE_BASE_BRANCH",
  "started_at": "$(date -Iseconds)",
  "iteration": $ITERATION,
  "status": "in_progress"
}
EOF

while true; do
  ITERATION=$((ITERATION + 1))
  echo ""
  echo "========================================="
  echo "  Iteration $ITERATION (wave_id=$WAVE_ID)"
  echo "========================================="
  echo ""

  # Step 1.1 — ¿Hay issues elegibles?
  ELIGIBLE_ISSUES=$(gh issue list \
    --state open \
    --search 'label:"ready-for-agent","state/ready-for-agent"' \
    --json number,labels \
    --limit 100 \
    --jq '[.[] | select(.labels | map(.name) | contains(["agent-blocked"]) | not)] | length')

  if [[ "$ELIGIBLE_ISSUES" -eq 0 ]]; then
    echo "No quedan issues elegibles. Pipeline terminado."
    break
  fi

  # Step 1.2 — Dispatch wave
  echo "→ /sandcastle-dispatch-wave (iteration $ITERATION)"
  CONFIRM_FLAG=""
  [[ "$ITERATION" -gt 1 ]] && CONFIRM_FLAG="--no-confirm"

  # Invocar dispatch-wave inline (el orquestador maneja el flujo).
  # En la práctica esto significa: ejecutar los Steps 1-5 del comando
  # /sandcastle-dispatch-wave. La AI debe leer el archivo del comando y
  # ejecutar sus pasos en orden, no spawnear un proceso aparte.
  # ...
  # update_checkpoint last_step=dispatch_wave dispatched=[...]

  # Step 1.3 — Polling local con sandcastle-validate
  echo "→ Polling sandcastle-validate sobre PRs lanzados"
  pipeline_poll_validate
  # update_checkpoint last_step=validate validated=[...] failed_validate=[...]

  # Step 1.4 — Merge wave
  echo "→ /sandcastle-merge-wave (iteration $ITERATION)"
  # ejecutar Steps 1-9 de /sandcastle-merge-wave
  # update_checkpoint last_step=merge_wave reviewed=[...] merged=[...] hold=[...] blocked=[...]

  # Step 1.5 — Quota check
  if pipeline_quota_exhausted; then
    echo "⚠ Quota Max exhausted detected. Aborting pipeline."
    for ISSUE in $IN_FLIGHT_ISSUES; do
      gh issue edit $ISSUE --add-label quota-exhausted
    done
    update_checkpoint status=aborted reason=quota_exhausted
    exit 3
  fi

  # Step 1.6 — Continuación: ¿hubo merges? Si no, evitar loop infinito.
  if [[ "$MERGED_COUNT" -eq 0 && "$HOLD_COUNT" -eq 0 && "$BLOCKED_COUNT" -gt 0 ]]; then
    echo "⚠ Iteration $ITERATION no produjo merges (todo BLOCKED). Aborting para evitar loop."
    update_checkpoint status=stuck reason=no_progress
    break
  fi
done

# Final
update_checkpoint status=completed completed_at=$(date -Iseconds)
echo ""
echo "Pipeline completado. Wave report: $CHECKPOINT"
```

## Funciones auxiliares

### `pipeline_poll_validate`

Polling local que invoca `sandcastle-validate.sh` por cada PR lanzado, con timeout y deduplicación:

```bash
pipeline_poll_validate() {
  local SET=("$@")  # PRs a validar
  local TIMEOUT_MIN=30
  local POLL_EVERY_SEC=30
  local START=$(date +%s)

  local PENDING=("${SET[@]}")
  local DONE=()
  local FAILED=()

  while [[ ${#PENDING[@]} -gt 0 ]]; do
    local NOW=$(date +%s)
    local ELAPSED=$(( (NOW - START) / 60 ))
    if [[ $ELAPSED -gt $TIMEOUT_MIN ]]; then
      # Timeout — label los pending como slow-ci
      for PR in "${PENDING[@]}"; do
        gh pr edit $PR --add-label slow-ci
        echo "  ⌛ PR #$PR timed out polling, label slow-ci applied"
      done
      break
    fi

    local NEXT_PENDING=()
    for PR in "${PENDING[@]}"; do
      if scripts/sandcastle-validate.sh "$PR" >/dev/null 2>&1; then
        DONE+=("$PR")
        echo "  ✓ PR #$PR validate passed"
      elif [[ $? -ge 2 ]]; then
        # Setup error (no docker, no gh) — wave-fatal
        echo "  ✗ pipeline_poll_validate: setup error" >&2
        return 2
      else
        # Falló o no estaba listo aún. ¿Es un fallo dueño del PR o todavía
        # está implementando? Heurística: si el PR tiene label
        # afk-checks-failed, ya pasó por el validador y falló de verdad.
        if gh pr view "$PR" --json labels --jq '.labels[].name' | grep -q afk-checks-failed; then
          FAILED+=("$PR")
          echo "  ✗ PR #$PR validate failed (label afk-checks-failed applied)"
        else
          NEXT_PENDING+=("$PR")
        fi
      fi
    done

    PENDING=("${NEXT_PENDING[@]}")
    if [[ ${#PENDING[@]} -gt 0 ]]; then
      sleep $POLL_EVERY_SEC
    fi
  done

  # Export results to caller
  echo "DONE=${DONE[*]}"
  echo "FAILED=${FAILED[*]}"
  echo "PENDING_AT_TIMEOUT=${PENDING[*]}"
}
```

### `pipeline_quota_exhausted`

Detecta si la quota Max del usuario está exhausted parseando los logs de containers recientes en busca de errores típicos de quota:

```bash
pipeline_quota_exhausted() {
  # Busca patrones de error de quota en los logs más recientes
  local PATTERNS="usage policy|rate limit exceeded|quota|context window|429|too many requests"
  for LOG in $(find .sandcastle -name "*.log" -mmin -10 2>/dev/null); do
    if grep -qiE "$PATTERNS" "$LOG"; then
      echo "  Quota signal detected in: $LOG"
      return 0  # exhausted
    fi
  done
  return 1  # OK
}
```

### `update_checkpoint`

Actualiza el JSON del checkpoint con key=value pairs:

```bash
update_checkpoint() {
  local TMP=$(mktemp)
  jq ". + {$(for arg in "$@"; do echo -n "\"${arg%%=*}\":\"${arg#*=}\","; done | sed 's/,$//')}" \
    "$CHECKPOINT" > "$TMP"
  mv "$TMP" "$CHECKPOINT"
}
```

## Step 2 — Final report

Cuando el loop termina, imprimir y persistir el report:

```
Pipeline summary (wave_id=pipeline-2026-05-13-1800):

  Iteration 1: dispatched 4 → validated 4 → reviewed 4 → merged 3, hold 1, blocked 0
  Iteration 2: dispatched 3 → validated 3 → reviewed 3 → merged 2, hold 0, blocked 1
  Iteration 3: dispatched 2 → validated 1 → reviewed 1 → merged 1, hold 0, blocked 0
                                ↳ 1 timed out (slow-ci)

Total: 6 issues mergeados, 1 en hold, 1 blocked, 1 con CI lento.

Estado final del checkpoint: .sandcastle/checkpoints/pipeline-2026-05-13-1800.json
Wave reports: .sandcastle/wave-reports/*.json
Logs: .sandcastle/{review,resolver,fixer,validate}-logs/

Próximos pasos manuales (si aplica):
  - PRs en hold: review manual de los comentarios del reviewer agent
  - Issues blocked: revisar label agent-blocked-{rebrief,codebase,unknown}
  - CI lento: investigar el PR con label slow-ci
```

## Arguments

- `--max-parallel <N>` — cap concurrency. Default: `$SANDCASTLE_MAX_PARALLEL` o 4 si Opus.
- `--max-iterations <N>` — cap iteraciones del loop. Default: ilimitado (sale cuando no hay más eligible).
- `--from-iteration <N>` — reanudar desde una iteración específica del checkpoint pendiente.
- `--dry-run` — todo menos lanzar containers. Útil para auditar el flujo.
- `--no-confirm` — skipear las puertas de confirmación de dispatch-wave y merge-wave en TODAS las iteraciones (no recomendado para primer uso).
- `--abort-on-block` — si una iteración produce algún BLOCK, abortar el pipeline en lugar de continuar.

## Notes for future maintainers

- **Por qué polling cada 30s en lugar de webhooks**: `sandcastle-validate` es local y rápido (segundos por PR), así que el costo del polling es trivial. Webhooks requerirían infra externa o GH Actions, que es exactamente lo que el plan elimina. Si en algún momento `sandcastle-validate` se vuelve lento (proyecto con miles de tests, image gigante), considerar event-driven en lugar de polling.

- **Manejo de quota Max**: la detección es heurística (grep en logs). Si vemos falsos positivos (abortar pipelines que en realidad no quedaron sin quota), refinar el pattern. Si vemos falsos negativos (no detectar y seguir lanzando containers que crashean), instrumentar la respuesta de Sandcastle/Claude Code directamente.

- **Checkpoints**: el formato JSON es flexible — agregar campos según necesidad. Mantenerlos chicos (KB, no MB) para que el reanudado sea instantáneo.

- **Fase 6 — Two-axis review**: cuando se incorpore (Fase 6 del plan), los reviewers van a producir 2 sub-reportes por PR. El pipeline no cambia — sigue invocando `/sandcastle-merge-wave` sin saber del detalle interno del review. Solo cambia el costo Opus por iteración (~3x el review).

- **Integración con engineering-workflow**: el pipeline asume que upstream (`/grill-with-docs` + `/to-prd` + `/to-issues`) genera issues con label `ready-for-agent` directo. Si en algún proyecto se usa `needs-triage` por flujo viejo, ejecutar `/triage` manual antes del primer `/sandcastle-pipeline`.

- **Cuándo NO usar este pipeline**:
  - Primera ola sobre un proyecto nuevo (calibrar primero — ver Fase 4 del plan).
  - Cuando hay PRs con merge conflicts ya conocidos contra `main` desde otro flujo paralelo.
  - Cuando la quota Max del día está casi agotada (el pipeline va a abortar de todos modos, mejor esperar).
