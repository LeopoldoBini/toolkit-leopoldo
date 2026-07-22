---
name: prd-pipeline
description: Motor v4 Workflow-nativo del pipeline AFK — reemplaza a /afk-pipeline. Lanza el workflow determinístico (workflows/prd-pipeline.js) que implementa+mergea las issues de un scope sobre una rama integradora, con gate como código, review fleet nativa y PR final draft para el botón verde de Leo. Usage `/prd-pipeline milestone:<name> [+800k]` (también `label:`, `parent:#N`, lista `#42,#43`); sin `+Nk` la corrida va SIN tope (el `+Nk` es un hard cap deliberado). La sesión que lo lanza es el orquestador T0 y decide el tiering por nodo.
---

# /prd-pipeline

## ⛔ Invocation gate — check BEFORE doing anything

Proceed ONLY if the user explicitly typed `/prd-pipeline` themselves (or the session's initial prompt, e.g. via the `cc-afk` alias, instructs running it). If YOU decided that some plan, review result, or "apply everything" request should become a pipeline — **STOP NOW**: do not create branches, do not launch any Workflow. Tell Leo what you would run and let HIM invoke it. Rule of this marketplace: orchestration commands are never auto-invoked by the model.

**Spec de referencia (leela ante cualquier duda):** `docs/SPEC-v4-workflow-engine.md` en este plugin — el motor es la materialización 1:1 de esa spec.

## Qué hace

Compone `args` y lanza **`Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/prd-pipeline.js", args })`**. Todo el pipeline (waves de implement/merge, gates, review fleet, PR final) corre determinístico dentro del workflow, en background. Vos (la sesión) sos el **orquestador T0**: tu único trabajo de juicio es el tiering por nodo y la supervisión; las reglas las ejecuta el script.

## Argumentos

- **Scope** (requerido, posicional): `milestone:<name>` | `label:<label>` | `parent:#N` | `#42,#43,...`
- **`+<N>k` / `+<N>m`** (opcional): hard cap de tokens de la corrida — va al `args.budgetTotal` (fuente primaria; la directiva del turno es solo fallback, demostró ser frágil). **Sin `+Nk`, la corrida va SIN tope** (default desde v4.0.8) — pasalo solo cuando quieras limitarla deliberadamente.
- **`--max-waves=N`** (default 8), **`--max-parallel=N`** (default 6, techo 8), **`--dry-run`** (mostrar plan + args sin lanzar).

## Pasos (vos, la sesión T0)

### 1 — Pre-flight

```bash
git rev-parse --git-dir && gh auth status
git remote show origin | sed -n 's/.*HEAD branch: //p'   # default branch (fallback de base)
cat .host-orchestrator/config.json 2>/dev/null            # contrato del repo (§3.10, opcional)
ls scripts/wave-validate.sh 2>/dev/null
date -Iseconds                                            # ts para args (el script no puede llamar Date.now)
```

Fallos de precondición → reportar BLOCKED y frenar (no lanzar nada).

### 2 — Componer `args`

Defaults del config (todos opcionales): `base_branch` (default: default branch del remoto), `validate_hook`, `test_globs` (default `["**/*.test.*","**/*.spec.*"]`), `model_map` (default `{T0:'fable',T1:'opus',T2:'sonnet',T3:'haiku'}`), `role_tiers`, `labels` (default `{ready:'ready-for-agent', agentPr:'afk-agent-pr'}`), `deny_paths`, `required_checks`, `max_parallel`.

- **`rama`**: ANTES de computar nada: `git ls-remote origin 'refs/heads/prd/*' 'refs/heads/batch/*'` — si YA existe una rama integradora que corresponde a este scope (de una corrida anterior), **REUSALA con su nombre exacto**, no inventes una variante (aprendizaje Piloto 2: una rama redundante forkeada bloquea la corrida). Si no existe: `prd/<slug>` para milestone, `batch/<slug>` para label/parent/lista; slug = scope value en kebab-case.
- **`runLabel`**: `<rama sin prefijo>-<fecha corta>` (ej. `prd0016-0718`).
- **`tiers`** — TU decisión de diseño como T0, dentro de los rangos de la spec §3.1 (brújula: scout/validator T2–T3, implementer T0–T1 —o T2 si la tanda es remediación mecánica—, serializer T1–T2, resolver/reviewer/judge T0–T1, applier T1–T2). Principio: **modelo mínimo suficiente**. Aplicá `role_tiers` del config si existe. Declarale a Leo la asignación elegida y por qué (2 líneas) ANTES de lanzar.
- **`issueTiers`** (opcional): si conocés issues puntuales triviales/críticas, override por número.
- **`budgetTotal`**: del `+Nk` del comando si vino; **sin `+Nk` → `budgetTotal: null` (SIN tope)**. Decisión de Leo (22-jul, corrida PRD-0019: el tope +1000k cortó la corrida a 58 tokens del `minBudgetWave` dejando 2 slices y la review fleet afuera — un tope "razonable" corta donde no debe). NO le propongas un tope ni frenes esperando confirmación: lanzá sin cap e informale el costo estimado de referencia (`~150k × issues + 300k`, la regla vieja de 100k/issue quedó corta) para que sepa qué esperar. Con `+Nk` explícito el comportamiento no cambia: hard cap — es la forma deliberada de Leo de limitar una corrida.
- **`ts`**: el `date -Iseconds` del pre-flight.

### 3 — Confirmar y lanzar

Mostrale a Leo: scope resuelto (cuántas issues ve `gh issue list`), rama integradora, tiering elegido, budget. Con `--dry-run`: terminar acá.

Confirmado (o corrida AFK ya autorizada por el prompt inicial):

```
Workflow({
  scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/prd-pipeline.js",
  args: { ts, runLabel, repo: <pwd>, scope, base, rama, models, tiers, issueTiers,
          validateHook, testGlobs, denyPaths, requiredChecks, labels,
          maxParallel, maxWaves, budgetTotal, minBudgetWave: 300000 }
})
```

Corre en background: monitoreá con `/workflows`; los `log()` del script cuentan la historia. Al terminar, el reporte estructurado del workflow es tu materia prima para el resumen a Leo (status, PR final draft, bloqueadas, bugs anotados, `para_leo`).

### 4 — Regla de reanudación (§3.5)

Crash/kill → **`resumeFromRunId` SOLO si nada cambió a mano desde el corte** (ni merges manuales, ni issues cerradas, ni pushes). Ante cualquier duda → corrida fresca con los MISMOS args (el scout deriva el estado real de GitHub; los serializers son idempotentes: no se repite nada ya hecho). Si reanudás: mismo `scriptPath`, mismos `args`, `resumeFromRunId` del run cortado.

## Qué NO hace

- No crea issues ni briefs (eso es `/to-issues` de engineering-workflow).
- No mergea la rama integradora a la base: el PR final queda **draft** para el botón verde de Leo.
- No re-decide tiers en runtime: el tiering se pinnea al lanzar.

## Contrato por repo (opcional, `.host-orchestrator/config.json`)

Ver spec §3.10. Sin config → defaults. El hook `scripts/wave-validate.sh --json` debe emitir `{"status":"ok"|"error","metrics":{...},"tests":{...}}` — **medición inválida nunca es éxito** (§3.3).

## Entrada AFK (`cc-afk` v4)

```bash
cc-afk() {
  [ -z "$*" ] && { echo "usage: cc-afk <scope> [+800k]"; return 1; }
  API_TIMEOUT_MS=1200000 BASH_DEFAULT_TIMEOUT_MS=300000 BASH_MAX_TIMEOUT_MS=1200000 \
    claude --dangerously-skip-permissions "/prd-pipeline $*"
}
```

Muertos vs v3: `/goal`, `CLAUDE_CODE_MAX_TURNS`, `AUTO_COMPACT_WINDOW`, `DISABLE_THINKING` — el loop ya no es de turnos. Sobreviven solo los timeouts. Supervisado (recomendado para corridas nuevas): sesión interactiva normal, sin `--dangerously-skip-permissions`.
