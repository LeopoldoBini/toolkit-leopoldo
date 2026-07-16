# SPEC — host-orchestrator v4: motor Workflow-nativo

**Estado:** GRILLADA — decisiones cerradas con Leo (grilling 2026-07-16); lista para implementar tras Piloto 1
**Autor:** Claude + Leo
**Reemplaza:** motor v3.0.0 (playbooks markdown interpretados por turno + `/goal` + verificador Haiku + `cc-afk` con env vars)

---

## 1. Motivación

El motor v3 funciona, pero sus reglas viven en prosa que el modelo *interpreta* cada turno. Dolores reales de la corrida PRD-0017 (jul-2026, devbox):

1. **Gate en prosa ≠ gate como regla.** El bloque bash de validación del comando es texto; el modelo lo aplicó "con criterio" (inventó un ratchet de no-regresión en vez de exigir verde absoluto). Salió bien, pero fue juicio del modelo, no regla ejecutada.
2. **Modelo del host sin pinnear.** La corrida terminó con el host en Sonnet 5 (default de devbox) mientras los implementers sí estaban en Opus. Nada en el motor v3 garantiza el modelo de cada rol.
3. **Andamiaje frágil.** `/goal` + 50 turnos máx + auto-compact + 10 env vars en `cc-afk`. Cada pieza es un punto de falla que el Workflow tool trae resuelto de fábrica: resume (`resumeFromRunId` + journal), presupuesto de tokens (`budget`), fases visibles (`/workflows`), pinneo de modelo por `agent()`.

**Principio v4:** las *reglas* son código JS determinístico (loops, condiciones, comparaciones numéricas); los *agentes* solo implementan, validan-reportando-números y resuelven conflictos. El modelo nunca decide si un gate pasa: lo decide un `if`.

## 2. Decisiones ya tomadas (constraints — no re-litigar)

1. **Política de rama por milestone, siempre:** el pipeline crea `prd/<milestone>` al arrancar; los PRs de las issues apuntan a esa rama; al final queda UN PR `prd/X → master` para el botón verde de Leo. Master siempre deployable. Refresh por tanda (antes de cada wave, traer lo nuevo de master). PRDs en paralelo solo si Leo decide que no se pisan.
2. **Las issues de GitHub se quedan** como backlog durable e input (`milestone:X`): briefs `## Agent Brief`, deps `Blocked by`, trazabilidad issue→PR. Cambia el motor, no el contrato.
3. **Motor genérico en el plugin + contrato fino por repo** (hook de validación, base branch, runtime). Ambición: publicable.
4. **Roadmap:** PRD-0017 cierra con motor v3 → Piloto 1 = ratchet TS (App.SaltaCompra) → construir v4 → Piloto 2 = PRD-0016 supervisado.
5. **Invocación explícita SIEMPRE:** la entrada es un slash command tipeado por Leo. El Workflow tool además exige opt-in explícito — doble candado, compatible con la regla del marketplace.

## 3. Arquitectura

```
Leo tipea:  /prd-pipeline milestone:PRD-0016          (slash command, host-orchestrator v4)
   │
   ▼
Comando (markdown, delgado):
   lee .host-orchestrator/config.json → valida preconds → compone args
   └─ Workflow({ scriptPath: <plugin>/workflows/prd-pipeline.js, args })
   │
   ▼
Script JS (determinístico, corre en background):
   Fase 0  Setup        agente serializador: crea/actualiza rama prd/X, baseline
   Loop    Waves        while (hay issues accionables && budget.remaining()):
     0.    Scout        agente Haiku: estado issues/PRs → buckets (JSON schema)
     1.    Refresh      serializador: merge master→prd/X; conflicto → merge-resolver
     2.    Merge wave   por PR MERGE_READY: validar → merge-resolver → merge (serial)
     3.    Impl wave    fan-out implementers Opus en worktrees (paralelo)
     4.    Gate         CÓDIGO JS: compara métricas del validador vs baseline → if
     5.    Publish      serializador: push + gh pr create por resultado verde (serial)
   Fase N  Review       review fleet sobre el diff integrado prd/X vs master
   Fase Z  Cierre       serializador: PR draft prd/X → master + reporte final
```

### 3.1 Los cuatro roles de agente (tiering pinneado SIEMPRE)

| Rol | Modelo (`opts.model`) | Effort | Hace | NO hace |
|---|---|---|---|---|
| **scout** | `haiku` | low | `gh issue/pr list --json` → buckets estructurados | juicio, mutación |
| **implementer** | `opus` | (sesión) | TDD + vertical slice en su worktree (disciplina actual de `parallel-implementer.md`) | push, `gh pr *`, salir del worktree |
| **validator** | `haiku` o `sonnet` | low | ejecuta `wave-validate.sh --json` (o autodetect) y reporta NÚMEROS via schema | decidir si pasa — eso es del script |
| **serializer** (git-officer) | `sonnet` | medium | TODA mutación remota: push, `gh pr create/merge`, branch ops. Idempotente (check-then-act) | implementar, juzgar código |
| **merge-resolver** | `opus` | high | resolver conflictos con intent packet; 5 criterios de no-regresión (sin cambios vs v3) | mergear él mismo (reporta; el serializer ejecuta) |

**Regla dura:** ningún `agent()` sin `model:` explícito. La lección del host-en-Sonnet muere acá: el "host" ahora es código, no tiene modelo.

**Quién elige el tier (decisión de Leo, grilling 2026-07-16):** la tabla de arriba es el default, no dogma. El orquestador que diseña/lanza la corrida (sesión en **Fable 5**) ajusta el modelo de cada nodo en tiempo de diseño bajo el principio de **modelo mínimo suficiente** — el tier más barato que cumple la vara de correctitud del nodo; escalar solo donde el error es caro o irreversible. Doble objetivo explícito: máxima correctitud Y eficiencia de tokens (junto con el tope de presupuesto de §6.5). La elección queda pinneada en el script; en runtime nadie re-decide.

### 3.2 Doctrina "host owns all mutations" → etapa serializadora

El script no tiene FS/git. La doctrina se re-expresa: **toda mutación remota corre en agentes `serializer` despachados secuencialmente por el script** (`await` uno por uno — el orden lo garantiza el código, no la disciplina del modelo). Los implementers siguen sin poder pushear (constraint triple-declarado en su prompt, como hoy).

Cada mutación es **check-then-act** (idempotente): antes de `gh pr create`, verificar si ya existe PR para esa branch; antes de merge, verificar si ya está mergeado. Esto hace el replay del resume seguro (§3.5).

**Dos PRDs en paralelo no se pisan por diseño:** cada workflow solo muta su rama `prd/X` y las branches de sus issues; master solo se *lee* (fetch en el refresh); el único write a master es el botón verde manual de Leo. Punto de contacto restante: labels de issues — disjuntos por milestone.

### 3.3 El gate como código: ratchet de no-regresión formalizado

Semántica exacta (formaliza `lesson_gate_wave_es_ratchet_no_regresion`):

```
PASA ⇔  tests_propios == verde                      (los tests del slice, todos)
     ∧  ts_errors_nuevos == 0                        (errores TS ≤ baseline, sin nuevos)
     ∧  tests_rotos ⊆ baseline.tests_rotos           (ningún test antes-verde ahora rojo)
```

- **Tests propios (DECIDIDO en grilling 2026-07-16, opción B):** `tests_propios` = tests en archivos de test tocados por el diff del PR, derivado mecánicamente de `git diff --name-only` + `test_globs` del config (default por runtime). El gate exige además que el diff agregue ≥ 1 test nuevo (anti "slice sin tests"). El auto-reporte del implementer va al audit log pero NUNCA participa del `if`. Ajuste para slices que solo modifican tests existentes: el requisito "≥ 1 test nuevo" se relaja a "≥ 1 test agregado O modificado".
- **Baseline:** se captura UNA vez por wave, sobre `prd/X` recién refrescada (Fase 1), corriendo el mismo validador. `{ts_errors: N, failing_tests: [nombres]}`.
- **Contrato del hook:** `scripts/wave-validate.sh --json` emite `{"ts_errors": N, "tests": {"failed": M, "failed_names": [...]}}`. Sin hook → el validator autodetecta (PM + typecheck + test) y reporta los mismos campos en su schema de salida.
- **La comparación es un `if` en JS.** El validator reporta números; jamás opina. Rojo → no PR, worktree conservado, label + comment en la issue (via serializer), igual que hoy.

### 3.4 Estado: GitHub única fuente de verdad + journal para resume

- **Se elimina `state.json`** como fuente de verdad. El scout deriva el estado real de GitHub al inicio de cada wave (barato: Haiku + `gh --json`).
- **El journal del Workflow** (`journal.jsonl`) es el mecanismo de resume — no es estado de dominio, es cache de ejecución.
- **`PROGRESS.md` se elimina** (existía para sobrevivir compacts; el script no compacta). La narrativa humana ahora es `log()` + la ventana `/workflows` + el reporte final.
- **El audit log `.host-orchestrator/waves/<TS>.log` SE CONSERVA** (append-only, lo escribe el serializer en cada mutación). Es el post-mortem en disco, independiente del journal de la sesión.

### 3.5 Crash / resume

Crash a mitad de corrida → `Workflow({scriptPath, resumeFromRunId})`. El replay re-ejecuta el script: los `agent()` completados devuelven su resultado cacheado (mismo prompt+opts), el primero incompleto corre live. Como TODA mutación es check-then-act, re-correr un serializer que había mutado a medias es seguro: constata lo hecho y completa lo que falta. Crash a mitad de merge = caso cubierto: el serializer del replay ve el PR ya mergeado (o no) en GitHub y actúa en consecuencia.

Restricción heredada: sin `Date.now()` en el script → timestamps entran por `args` (el comando los inyecta al lanzar) y el audit log los estampa el serializer (él sí tiene shell).

**Regla de reanudación (DECIDIDA en grilling 2026-07-16):** `resumeFromRunId` SOLO si nada cambió a mano desde el crash (ni merges manuales, ni issues cerradas, ni pushes). Ante cualquier duda → corrida fresca, que siempre es segura: el scout deriva el estado real de GitHub y no repite lo ya hecho (solo re-hace el trabajo in-flight perdido). El replay del resume usa scouts cacheados (foto vieja) — es correcto únicamente bajo esa regla; no se agrega cache-busting. La regla queda escrita en el comando `/prd-pipeline`.

### 3.6 Refresh de la rama milestone

- **Merge, no rebase** — `prd/X` es compartida (PRs de issues le apuntan); rebase reescribiría historia bajo PRs abiertos.
- Antes de cada wave: serializer hace `git fetch && git merge origin/master` en `prd/X`.
- **Conflicto** → despachar `merge-resolver` (Opus, intent packet = qué trae master vs qué lleva la rama). Si resuelve → serializer commitea y pushea. Si `INCOMPATIBLE` → el workflow **frena esa corrida** con estado BLOCKED + reporte claro (no intenta heroísmos: conflictos de a cucharadas era el objetivo del refresh frecuente; uno incompatible es señal de que Leo debe mirar).

### 3.7 Review fleet final

**DECIDIDO (grilling 2026-07-16, opción A):** fase nativa del workflow — reviewers (fan-out por superficie) → judge → appliers, con los prompts de review-fleet PORTADOS a host-orchestrator, sobre el diff integrado `prd/X..master`. Los fixes aprobados van en UN commit/PR `review/<slug>` → `prd/X` que pasa por el mismo gate. Motor autocontenido y publicable; la revisión hereda pinneo de modelos, orden y presupuesto.

Contexto de la decisión: la v4 tiene vocación de **reemplazar el flujo de implementación paralela autónoma completo** — la duplicación de prompts con engineering-workflow es transitoria, no deuda permanente. La versión interactiva de review-fleet sigue existiendo para uso manual.

### 3.8 Entrada, `cc-afk` y permisos

- **Comando nuevo `/prd-pipeline`** (v4) — markdown delgado: gate de invocación explícita → precondiciones → leer config → `Workflow({scriptPath, args})`. `/afk-pipeline` v3 queda deprecado.
- **`cc-afk` se reduce a**: abrir `claude` con el comando tipeado. Mueren `CLAUDE_CODE_MAX_TURNS`, `AUTO_COMPACT_WINDOW`, `DISABLE_THINKING` (el loop ya no es de turnos). Sobreviven los timeouts de Bash/API (los agentes siguen corriendo comandos largos).
- **`--dangerously-skip-permissions` sigue siendo necesario para AFK real** (los agentes del workflow heredan el permission mode de la sesión; en background nadie contesta prompts). Piloto 2 (supervisado) corre en sesión interactiva normal: Leo contesta los prompts o pre-permite.

### 3.9 Monitoreo

- **`/workflows`** en la sesión = vista live (fases, agentes, tokens).
- **Convención `log()`** (contrato del script): inicio/fin de fase con conteos; por issue: `dispatched #N` / `gate PASS|FAIL #N (ts:+0, tests:verde)` / `PR #M opened` / `PR #M merged`; toda mutación remota; todo bloqueo. La ventana espejo de tmux/cmux cuenta la historia con solo estas líneas.
- **Audit log en disco** (§3.4) para post-mortem sin la sesión.

### 3.10 Contrato por repo (mínimo publicable)

```
.host-orchestrator/config.json      (nuevo, opcional con defaults)
{
  "base_branch": "master",              // default: default branch del remoto
  "validate_hook": "scripts/wave-validate.sh",
  "max_parallel": 6,
  "runtime": "node|bun|...",            // hint para el validator autodetect
  "model_overrides": {}                 // p.ej. {"implementer": "sonnet"} para repos triviales
}
scripts/wave-validate.sh            (existente; NUEVO modo --json, ver §3.3)
```

Issues: mismo contrato de hoy (label `ready-for-agent`, `## Agent Brief`, `Blocked by`).

### 3.11 Decisiones técnicas menores (CTO, cerradas en el grilling)

- **Base de los worktrees:** el worktree de `isolation: 'worktree'` nace del HEAD de la sesión, que no está garantizado. Por eso el PRIMER paso obligatorio de cada implementer es `git fetch && git checkout -B issue-<N> origin/prd/<X>` — la base correcta se toma del remoto, independiente de dónde esté parada la sesión.
- **Gate rojo → reintento:** 1 reintento por issue dentro de la corrida, re-despachando el implementer con el output del gate como feedback (worktree conservado). Segundo rojo → label `agent-blocked` + comment con el log (via serializer), la wave sigue con el resto. Sin heroísmos.
- **Permisos:** AFK real = `--dangerously-skip-permissions` (como hoy; nadie contesta prompts en background). Piloto 2 supervisado = sesión interactiva normal.
- **Roles de agente:** los `agent()` referencian los `agents/*.md` del plugin via `agentType` (una sola fuente de disciplina, compartida con los comandos standalone).

## 4. Migración v3 → v4

| Pieza v3 | Destino v4 |
|---|---|
| `/afk-pipeline` | **Borrado directo en v4.0.0** — reemplazado por `/prd-pipeline` (breaking; decidido en grilling) |
| `/parallel-implement-wave`, `/merge-orchestrate` | **Se quedan** como herramientas manuales standalone (uso interactivo puntual) |
| `agents/parallel-implementer.md`, `merge-resolver.md` | **Se quedan** — los `agent()` del workflow los referencian via `agentType` (o prompts portados) |
| `cc-afk` | Simplificado (§3.8) |
| `.host-orchestrator/pipelines/*.state.json`, `PROGRESS.md` | **Eliminados** (GitHub + journal + audit log los cubren) |
| `.host-orchestrator/waves/*.log` | **Se conserva** (mismo formato/path) |
| `/goal` + verificador Haiku | **Innecesarios** — el loop es el `while` del script |

## 5. Plan de pilotos

1. **Piloto 1 — ratchet TS (App.SaltaCompra), riesgo bajo:** workflow ad-hoc reducido (sin política de rama milestone, PRs de solo-tipos directo a master) que valida los patrones núcleo: validator con salida JSON + gate como `if` + serializer idempotente + tiering pinneado + resume tras kill manual. Criterio de éxito: 0 decisiones de gate tomadas por un modelo.
2. **Piloto 2 — PRD-0016 con `/prd-pipeline` completo, SUPERVISADO** (Leo mirando, sesión interactiva, no AFK): política de rama + refresh + waves + review fleet + PR final draft. Criterio de éxito: el PR `prd/0016 → master` queda listo para botón verde sin intervención manual intermedia (más allá de permisos).

Aprendizajes del piloto 1 se incorporan a la spec ANTES de construir el motor completo.

## 6. Preguntas abiertas (para el grilling)

1. ~~Review fleet~~ ✅ RESUELTO: opción A — fase nativa con prompts portados (ver §3.7). La v4 aspira a reemplazar el flujo autónomo completo.
2. ~~Frescura del scout en replay~~ ✅ RESUELTO: resume solo si nada cambió a mano; si no, corrida fresca (ver §3.5). Sin cache-busting.
3. ~~`agentType` vs prompts inline~~ ✅ RESUELTO (decisión CTO): `agentType` referenciando los `agents/*.md` del plugin — una sola fuente de verdad para la disciplina, compartida con los comandos standalone; el plugin se publica entero (agents/ + workflows/), así que no rompe la autocontención.
4. ~~Semántica de "tests propios"~~ ✅ RESUELTO: opción B — derivado del diff (ver §3.3).
5. ~~Presupuesto~~ ✅ RESUELTO: tope SIEMPRE, proporcional al tamaño del milestone (monto por issue = decisión técnica, se calibra en los pilotos). Al agotarse: cortar limpio al final de la wave en curso + reporte de pendientes (retomable con corrida fresca). El script chequea `budget.remaining()` en cada boundary de wave.
6. ~~Scopes~~ ✅ RESUELTO: los cuatro alcances de hoy (`milestone:` / `label:` / `parent:#N` / lista explícita). La rama integradora se nombra por alcance: `prd/<milestone>` o `batch/<slug>`. Mismo motor, misma política de rama.
7. ~~Deprecación~~ ✅ RESUELTO: borrar `/afk-pipeline` directo en v4.0.0 (breaking, precedente v3/Docker). Único usuario = Leo; dos motores en paralelo es la confusión que queremos evitar. `cc-afk` avisa si se invoca con sintaxis vieja.

---

*Post-grilling: este DRAFT se convierte en ADR definitivo + actualización de CONTEXT.md si aparece vocabulario nuevo (scout, serializer, ratchet, baseline).*
