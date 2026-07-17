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

1. **Política de rama por milestone, siempre:** el pipeline crea `prd/<milestone>` al arrancar; los PRs de las issues apuntan a esa rama; al final queda UN PR `prd/X → base` para el botón verde de Leo. La base siempre deployable. Refresh por tanda (antes de cada wave, traer lo nuevo de la base). PRDs en paralelo solo si Leo decide que no se pisan. («base» = `base_branch` del config; en SaltaCompra, `master`.)
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
     0.    Scout        agente T3: estado issues/PRs → buckets (JSON schema)
     1.    Refresh      serializador: merge base→prd/X; conflicto → merge-resolver
     2.    Merge wave   por PR MERGE_READY: validar → merge-resolver → merge (serial)
     3.    Impl wave    fan-out implementers T1 en worktrees (paralelo)
     4.    Gate         CÓDIGO JS: compara métricas del validador vs baseline → if
     5.    Publish      serializador: push + gh pr create por resultado verde (serial)
   Fase N  Review       review fleet sobre el diff integrado prd/X vs base
   Fase Z  Cierre       serializador: PR draft prd/X → base + reporte final
```

### 3.1 Los cuatro roles de agente (tiering pinneado SIEMPRE)

**Vocabulario de tiers (agnóstico a la línea de modelos vigente — DECIDIDO 2026-07-16):** la spec y los scripts hablan en tiers de capacidad, nunca en nombres de modelos. El mapeo tier→modelo vive en UN solo lugar (`model_map` del config, §3.10, con defaults del plugin): cambia la línea de modelos → se edita el mapeo, no la spec ni los scripts.

- **T0 — frontera:** máxima capacidad disponible. Orquesta (diseña la corrida y asigna tiers) y también es delegable a nodos donde el juicio es el producto (razonar, juzgar).
- **T1 — razonador:** alta capacidad. Nodos donde el error es caro o irreversible.
- **T2 — operativo/económico:** equilibrio capacidad/costo. Trabajo delicado pero rutinario, y lo económico no-trivial.
- **T3 — súper-económico:** mínimo costo. Operaciones quirúrgicas bien definidas, mecánicas y verificables.

**Rangos por rol (brújula, NO asignación — decidido 2026-07-16):** la tabla da el rango razonable de cada rol; el orquestador T0 elige el tier exacto de cada nodo al diseñar la corrida ("con qué armas batallar cada batalla"), según dificultad real de la tanda, criticidad y presupuesto. Declara su asignación al arrancar (header del script + `log()`), y queda pinneada: en runtime nadie re-decide.

| Rol | Rango | Effort | Hace | NO hace |
|---|---|---|---|---|
| **scout** | T2–T3 | low | `gh issue/pr list --json` → buckets estructurados | juicio, mutación |
| **implementer** | T0–T1 | (sesión) | TDD + vertical slice en su worktree (disciplina actual de `parallel-implementer.md`) | push, `gh pr *`, salir del worktree |
| **fixer mecánico** | T2 | medium | remediación bien especificada y verificable por gate (tipos, lint, codemods) — NO features | ídem implementer |
| **validator** | T2–T3 | low | ejecuta `wave-validate.sh --json` (o autodetect) y reporta NÚMEROS via schema | decidir si pasa — eso es del script |
| **serializer** (git-officer) | T1–T2 | medium | TODA mutación remota: push, `gh pr create/merge`, branch ops. Idempotente (check-then-act) | implementar, juzgar código |
| **merge-resolver** | T0–T1 | high | resolver conflictos con intent packet; 5 criterios de no-regresión (sin cambios vs v3) | mergear él mismo (reporta; el serializer ejecuta) |
| **reviewers/judge** (§3.7) | T0–T1 | high | revisar el diff integrado / fallar cada hallazgo | aplicar (eso es de appliers T1–T2) |

**Regla dura:** ningún `agent()` sin modelo explícito (resuelto desde el tier via `model_map`). La lección del host-sin-pinnear muere acá: el "host" ahora es código, no tiene modelo.

**Evidencia del Piloto 1 (2026-07-17, 53 agentes):** fixers T2 (sonnet) 9/9 gates sin reintentos en remediación mecánica (~42k output/nodo); validator T3 (haiku) 25/25 mediciones (~2k out); serializer T2 14/14. El costo real de un fixer son sus **cache-reads** (~35M/nodo), no su output — el tier del modelo importa menos que la cantidad de nodos y re-lecturas. De ahí el rol "fixer mecánico" T2.

**Principio de elección (grilling 2026-07-16): modelo mínimo suficiente.** Dentro del rango del rol, el orquestador elige el tier más barato que cumple la vara de correctitud del nodo; escala solo donde el error es caro o irreversible. Doble objetivo explícito: máxima correctitud Y eficiencia de tokens (junto con el tope de presupuesto de §6.5).

### 3.2 Doctrina "host owns all mutations" → etapa serializadora

El script no tiene FS/git. La doctrina se re-expresa: **toda mutación remota corre en agentes `serializer` despachados secuencialmente por el script** (`await` uno por uno — el orden lo garantiza el código, no la disciplina del modelo). Los implementers siguen sin poder pushear (constraint triple-declarado en su prompt, como hoy).

Cada mutación es **check-then-act** (idempotente): antes de `gh pr create`, verificar si ya existe PR para esa branch; antes de merge, verificar si ya está mergeado. Esto hace el replay del resume seguro (§3.5).

**Refinamientos del Piloto 1 (2026-07-17):**
- **Idempotencia por identidad de TRABAJO, no de branch:** el check primario es "¿existe PR MERGEADO para este trabajo?" (`gh pr list --head <branch> --state merged`), no "¿existe la branch?" — las branches se borran al mergear; la identidad durable del trabajo es su PR/issue.
- **Prohibiciones explícitas en el prompt del serializer:** esperar checks de CI solo con loop foreground de Bash y SOLO los checks REQUERIDOS por nombre (los advisory tipo CodeRabbit quedan pending largo y bloquean para siempre); PROHIBIDO usar Monitor o terminar el turno "esperando" — el turno termina únicamente con el reporte estructurado emitido.
- El serializer estampa el audit log SOLO con las mutaciones que ejecutó (no las constatadas).

**Dos PRDs en paralelo no se pisan por diseño:** cada workflow solo muta su rama `prd/X` y las branches de sus issues; la base solo se *lee* (fetch en el refresh); el único write a la base es el botón verde manual de Leo. Punto de contacto restante: labels de issues — disjuntos por milestone.

### 3.3 El gate como código: ratchet de no-regresión formalizado

Semántica exacta (formaliza `lesson_gate_wave_es_ratchet_no_regresion`):

```
PASA ⇔  tests_propios == verde                      (los tests del slice, todos)
     ∧  ∀ métrica m: valor(m) ≤ baseline(m)          (ratchet genérico: ninguna métrica empeora)
     ∧  tests_rotos ⊆ baseline.tests_rotos           (ningún test antes-verde ahora rojo)
```

**Métricas ratchet (agnóstico al stack — 2026-07-16):** el hook del repo declara sus métricas numéricas con convención "menor es mejor" (en un repo TS la métrica canónica es `ts_errors`; en otro stack podría ser `lint_errors`, `mypy_errors`, etc.). El motor no conoce ningún stack: solo compara números contra el baseline.

- **Tests propios (DECIDIDO en grilling 2026-07-16, opción B):** `tests_propios` = tests en archivos de test tocados por el diff del PR, derivado mecánicamente de `git diff --name-only` + `test_globs` del config (default por runtime). El gate exige además que el diff agregue ≥ 1 test nuevo (anti "slice sin tests"). El auto-reporte del implementer va al audit log pero NUNCA participa del `if`. Ajuste para slices que solo modifican tests existentes: el requisito "≥ 1 test nuevo" se relaja a "≥ 1 test agregado O modificado".
- **Baseline:** se captura UNA vez por wave, sobre `prd/X` recién refrescada (Fase 1), corriendo el mismo validador. `{metrics: {<nombre>: N, ...}, failing_tests: [nombres]}`.
- **Contrato del hook:** `scripts/wave-validate.sh --json` emite `{"status": "ok" | "error", "metrics": {"ts_errors": N, ...}, "tests": {"failed": M, "failed_names": [...]}}` (contrato validado en el Piloto 1 con `check.mjs --json`). Sin hook → el validator autodetecta el stack (default JS: package manager + typecheck + test; `metrics.ts_errors`) y reporta el mismo contrato en su schema de salida.
- **Medición inválida ≠ éxito (aprendizaje Piloto 1, 2026-07-16):** el contrato DEBE distinguir "medí 0" de "no pude medir". Si la herramienta de medición muere (OOM, crash, output vacío/no parseable), el hook emite `status: "measurement_failed"` — y el gate lo trata como BLOCKED de la medición (reintento o freno), NUNCA como métricas en cero. Origen: en CI, `tsc` murió por OOM y el output vacío se leyó como "0 errores". Un gate-como-código no puede permitir que una medición rota parezca verde.
- **La comparación es un `if` en JS.** El validator reporta números; jamás opina. Rojo → no PR, worktree conservado, label + comment en la issue (via serializer), igual que hoy.

### 3.4 Estado: GitHub única fuente de verdad + journal para resume

- **Se elimina `state.json`** como fuente de verdad. El scout deriva el estado real de GitHub al inicio de cada wave (barato: T3 + `gh --json`).
- **El journal del Workflow** (`journal.jsonl`) es el mecanismo de resume — no es estado de dominio, es cache de ejecución.
- **`PROGRESS.md` se elimina** (existía para sobrevivir compacts; el script no compacta). La narrativa humana ahora es `log()` + la ventana `/workflows` + el reporte final.
- **El audit log `.host-orchestrator/waves/<TS>.log` SE CONSERVA** (append-only, lo escribe el serializer en cada mutación). Es el post-mortem en disco, independiente del journal de la sesión.

### 3.5 Crash / resume

Crash a mitad de corrida → `Workflow({scriptPath, resumeFromRunId})`. El replay re-ejecuta el script: los `agent()` completados devuelven su resultado cacheado (mismo prompt+opts), el primero incompleto corre live. Como TODA mutación es check-then-act, re-correr un serializer que había mutado a medias es seguro: constata lo hecho y completa lo que falta. Crash a mitad de merge = caso cubierto: el serializer del replay ve el PR ya mergeado (o no) en GitHub y actúa en consecuencia.

Restricción heredada: sin `Date.now()` en el script → timestamps entran por `args` (el comando los inyecta al lanzar) y el audit log los estampa el serializer (él sí tiene shell).

**Regla de reanudación (DECIDIDA en grilling 2026-07-16):** `resumeFromRunId` SOLO si nada cambió a mano desde el crash (ni merges manuales, ni issues cerradas, ni pushes). Ante cualquier duda → corrida fresca, que siempre es segura: el scout deriva el estado real de GitHub y no repite lo ya hecho (solo re-hace el trabajo in-flight perdido). El replay del resume usa scouts cacheados (foto vieja) — es correcto únicamente bajo esa regla; no se agrega cache-busting. La regla queda escrita en el comando `/prd-pipeline`.

### 3.6 Refresh de la rama milestone

- **Merge, no rebase** — `prd/X` es compartida (PRs de issues le apuntan); rebase reescribiría historia bajo PRs abiertos.
- Antes de cada wave: serializer hace `git fetch && git merge origin/<base>` en `prd/X`.
- **Conflicto** → despachar `merge-resolver` (T1, intent packet = qué trae la base vs qué lleva la rama). Si resuelve → serializer commitea y pushea. Si `INCOMPATIBLE` → el workflow **frena esa corrida** con estado BLOCKED + reporte claro (no intenta heroísmos: conflictos de a cucharadas era el objetivo del refresh frecuente; uno incompatible es señal de que Leo debe mirar).

### 3.7 Review fleet final

**DECIDIDO (grilling 2026-07-16, opción A):** fase nativa del workflow — reviewers (fan-out por superficie) → judge → appliers, con los prompts de review-fleet PORTADOS a host-orchestrator, sobre el diff integrado `prd/X..base`. Los fixes aprobados van en UN commit/PR `review/<slug>` → `prd/X` que pasa por el mismo gate. Motor autocontenido y publicable; la revisión hereda pinneo de modelos, orden y presupuesto.

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
  "test_globs": ["**/*.test.*", "**/*.spec.*"],  // qué es "archivo de test" para el gate (§3.3)
  "model_map": { "T0": "fable", "T1": "opus", "T2": "sonnet", "T3": "haiku" },  // ÚNICO lugar nominal a modelos
  "role_tiers": {},                     // override por rol, p.ej. {"implementer": "T2"} para repos triviales
  "labels": { "ready": "ready-for-agent", "agent_pr": "afk-agent-pr" },
  "deny_paths": []                      // rutas VEDADAS a los agentes: ratchets/guards ortogonales del repo
}
scripts/wave-validate.sh            (existente; NUEVO modo --json, ver §3.3)
```

Issues: mismo contrato de hoy (label `ready-for-agent`, `## Agent Brief`, `Blocked by`).

**Ratchets ortogonales como deny-lists (aprendizaje Piloto 1):** si el repo tiene otros guards/ratchets (ej. doctrine-guard, deuda declarada por ADR), sus dominios van en `deny_paths` y en el `excluye` de cada prompt — un agente que "mejora" código vedado por otro ratchet produce PRs que ese ratchet rechaza (pasó con routes-deuda ADR-0023: 2 PRs revertidos). Los ratchets del repo no se negocian entre sí: se excluyen por adelantado.

### 3.11 Decisiones técnicas menores (CTO, cerradas en el grilling)

- **Base de los worktrees:** el worktree de `isolation: 'worktree'` nace del HEAD de la sesión, que no está garantizado. Por eso el PRIMER paso obligatorio de cada implementer es `git fetch && git checkout -B issue-<N> origin/prd/<X>` — la base correcta se toma del remoto, independiente de dónde esté parada la sesión.
- **Gate rojo → reintento:** 1 reintento por issue dentro de la corrida, re-despachando el implementer con el output del gate como feedback (worktree conservado). Segundo rojo → label `agent-blocked` + comment con el log (via serializer), la wave sigue con el resto. Sin heroísmos.
- **Permisos:** AFK real = `--dangerously-skip-permissions` (como hoy; nadie contesta prompts en background). Piloto 2 supervisado = sesión interactiva normal.
- **Roles de agente:** los `agent()` referencian los `agents/*.md` del plugin via `agentType` (una sola fuente de disciplina, compartida con los comandos standalone).

### 3.12 Hardening del script (aprendizajes Piloto 1, 2026-07-17 — obligatorios en el motor)

Patrones de referencia en `App.SaltaCompra:.host-orchestrator/pilots/ratchet-ts.workflow.js` (commiteado, PR #352):

1. **Normalización de `args`:** puede llegar objeto O string JSON según cómo se invoque el tool → primera línea del script: `const A = typeof args === 'string' ? JSON.parse(args) : args`. (Un crash en frío del Piloto 1.)
2. **`llamar()` — `agent()` endurecido:** `agent()` puede tirar throw (ej. "subagent completed without calling StructuredOutput") o devolver null. Wrapper con 1 reintento donde el intento 1 es **byte-idéntico** (preserva el cache del resume) y el 2 cache-bustea el label + declara el reintento y exige verificar estado previo. TODO `agent()` del motor pasa por acá.
3. **Budget por `args` con log de fuente:** la directiva "+N" del turno demostró ser frágil (llegó null y el corte nunca gatilló) → fuente primaria `args.budgetTotal`, fallback `budget.total`, y `log()` de qué fuente quedó activa (o "sin tope").
4. **Mediciones inmunes al harness:** los prompts de validators fijan timeouts explícitos por comando (los defaults del harness matan un `tsc`/`test` largo) y semántica de error (`status:'error'` del hook → campo `error` + sentinelas −1; el gate lo trata como fallo de medición, nunca como datos).
5. **Los reintentos de gate re-usan el worktree** (el retry-fixer recibe el path y los motivos numéricos exactos del gate); worktrees de gates FAIL se conservan para autopsia.

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

1. ✅ **Piloto 1 — COMPLETADO (2026-07-17, 4 corridas supervisadas): 6/6 criterios validados.** 10 gates decididos por `if` puro (0 juicio de modelo), serializer idempotente (kill a mitad de mutación → resume → constata y completa), 3 resumes sin mutación duplicada, corte por budget en boundary validado, `log()` contó la historia sola. Resultado colateral: deuda TS 1.066→51 (−95%) en 10 PRs, 0 regresiones. Los 9 aprendizajes quedaron incorporados: §3.1 (fixer mecánico T2 + evidencia de tokens), §3.2 (identidad de trabajo, prohibiciones del serializer), §3.3 (status ok|error), §3.10 (deny_paths), §3.12 (hardening completo).
2. ✅ **Piloto 2 — COMPLETADO (2026-07-17, milestone wave-bugs-piloto, 9 issues, supervisado):** el motor corrió de punta a punta — 8/8 bugs mergeados a la rama integradora, review fleet nativa (6 unidades, 5 hallazgos → 3 aplicados vía PR propio, 1 rechazado con criterio, 2 a HUMANO), PR final draft listo para botón verde. ~322k de 500k de budget, 31 agentes. Corrida cross-máquina real: arrancó en devbox, corte de luz, terminó en Mac con corrida fresca sin re-implementar nada (validó §3.5 + el fix DONE-por-PR-mergeado de 4.0.3). **Aprendizajes incorporados (4.0.4):** (a) el comando REUSA la rama integradora existente del scope en vez de computar una variante (una rama redundante forkeada bloqueó el primer run); (b) PRs IN_REVIEW (rojos) NO son accionables por el motor → se reportan en `para_leo`; (c) drift de baseline en la integradora (un PR mergea deuda sin pagarla en el ratchet del repo) rompe los checks de todos los PRs siguientes vía merge-ref — la reconciliación es humana/del repo (ADR del repo), el motor solo lo surfacea.
3. **Siguiente corrida real: PRD-0016** (12 issues) con el motor estabilizado; candidata a primera corrida AFK vía `cc-afk` cuando Leo lo decida.

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
