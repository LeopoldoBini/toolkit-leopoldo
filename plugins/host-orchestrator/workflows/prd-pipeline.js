export const meta = {
  name: 'prd-pipeline',
  description: 'Motor v4 host-orchestrator: waves implement+merge sobre rama integradora, gate como código, review fleet nativa, PR final draft',
  phases: [
    { title: 'Setup' },
    { title: 'Review' },
    { title: 'Cierre' },
  ],
}

// ============================================================================
// host-orchestrator v4 — motor genérico Workflow-nativo (spec: docs/SPEC-v4-workflow-engine.md)
//
// Principios (no negociables):
//  - Las REGLAS son código JS. El gate es un `if` sobre números de un validator.
//    CERO decisiones de gate tomadas por un modelo.
//  - Toda mutación remota corre en serializers secuenciales, check-then-act,
//    idempotentes por identidad de TRABAJO (PR/issue), no de branch (§3.2).
//  - Tiering pinneado: TODO agent() lleva model explícito resuelto de args (§3.1).
//  - Sin Date.now(): timestamps entran por args; el audit log lo estampa el serializer.
//
// args = {
//   ts: string ISO (inyectado por el comando al lanzar),
//   runLabel: string,
//   repo: path absoluto del repo de la sesión,
//   scope: { type: 'milestone'|'label'|'parent'|'list', value: string },
//   base: 'master',                       // base_branch del config
//   rama: 'prd/<slug>' | 'batch/<slug>',  // rama integradora (la computa el comando)
//   models: { T0, T1, T2, T3 },           // model_map del config
//   tiers: { scout, validator, implementer, serializer, resolver, reviewer, judge, applier },
//   issueTiers: { '<n>': 'T2', ... },     // override por issue (opcional)
//   validateHook: 'scripts/wave-validate.sh' | null,
//   testGlobs: ['**/*.test.*', ...],
//   denyPaths: [],                        // ratchets/guards ortogonales (§3.10)
//   requiredChecks: [],                   // checks de CI a esperar (vacío = no esperar)
//   labels: { ready: 'ready-for-agent', agentPr: 'afk-agent-pr' },
//   maxParallel: 6, maxWaves: 8,
//   budgetTotal: number|null, minBudgetWave: 300000,
//   testsRojosPreexistentes: []           // paths conocidos (opcional, informativo)
// }
// ============================================================================

// §3.12.1 — args puede llegar objeto o string JSON según cómo se invoque el tool.
// GUARDA: el orquestador T0 DEBE componer el objeto args (paso 2 de commands/prd-pipeline.md:
// scope, models, tiers, rama, base, budgetTotal, ...). Pasar el scope crudo ("milestone:X +800k")
// como string NO es válido — se rechaza acá con un mensaje claro en vez de un JSON.parse críptico.
function parseArgs(a) {
  if (a && typeof a === 'object') return a
  if (typeof a === 'string') {
    const s = a.trim()
    if (!s.startsWith('{')) {
      throw new Error(
        `prd-pipeline: args inválido. Recibí el scope crudo (${JSON.stringify(s.slice(0, 60))}) en vez del objeto args. ` +
          `El orquestador T0 debe COMPONER args (scope/models/tiers/rama/base/budgetTotal/...) siguiendo el paso 2 de commands/prd-pipeline.md, ` +
          `no pasar la directiva del comando literal.`
      )
    }
    return JSON.parse(s)
  }
  throw new Error(`prd-pipeline: args ausente o de tipo no soportado (${typeof a}). Componé el objeto args (ver commands/prd-pipeline.md).`)
}
const A = parseArgs(args)

const M = A.models
const T = A.tiers
const REPO = A.repo
const RAMA = A.rama
const BASE = A.base
const WT_INTEGRACION = `${REPO}/.host-orchestrator/wt/${RAMA.replace(/\//g, '-')}`
const AUDIT_LOG = `${REPO}/.host-orchestrator/waves/${A.runLabel}.log`

// §3.12.3 — budget por args (fuente primaria), fallback directiva, log de fuente
const BUDGET_TOTAL = A.budgetTotal ?? budget.total
const restante = () => (BUDGET_TOTAL ? Math.max(0, BUDGET_TOTAL - budget.spent()) : Infinity)

const scopeQuery = {
  milestone: `--milestone "${A.scope.value}"`,
  label: `--label "${A.scope.value}"`,
  parent: `--search "Part of #${String(A.scope.value).replace('#', '')} in:body"`,
  list: null, // lista explícita: el scout la recibe literal
}[A.scope.type]

// ---------------------------------------------------------------------------
// Schemas — los agentes reportan HECHOS y NÚMEROS; los veredictos son del script
// ---------------------------------------------------------------------------
const SCOUT_SCHEMA = {
  type: 'object',
  required: ['issues', 'all_done'],
  properties: {
    all_done: { type: 'boolean' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        required: ['number', 'title', 'bucket'],
        properties: {
          number: { type: 'integer' },
          title: { type: 'string' },
          bucket: {
            type: 'string',
            enum: ['DONE', 'MERGE_READY', 'IN_REVIEW', 'IMPLEMENTABLE', 'BLOCKED_BY_DEP', 'HUMAN_GATED'],
          },
          pr_number: { type: 'integer' },
          pr_branch: { type: 'string' },
          blocked_by: { type: 'array', items: { type: 'integer' } },
          detalle: { type: 'string' },
        },
      },
    },
    notas: { type: 'string' },
  },
}

const MEDICION_SCHEMA = {
  type: 'object',
  required: ['status', 'metrics', 'tests_failed', 'failing_test_files'],
  properties: {
    status: { type: 'string', enum: ['ok', 'error'] },
    error: { type: 'string' },
    metrics: { type: 'object', additionalProperties: { type: 'integer' } },
    tests_failed: { type: 'integer' },
    failing_test_files: { type: 'array', items: { type: 'string' } },
    // mecánica del diff contra la rama integradora (solo cuando se pide):
    diff_toca_tests: { type: 'boolean' },
    tests_del_diff_verdes: { type: 'boolean' },
  },
}

const IMPL_SCHEMA = {
  type: 'object',
  required: ['worktree', 'branch', 'resumen'],
  properties: {
    worktree: { type: 'string', description: 'pwd absoluto del worktree' },
    branch: { type: 'string' },
    resumen: { type: 'string' },
    bugs_reales: { type: 'array', items: { type: 'string' } },
    bloqueado: { type: 'string', description: 'solo si el brief es inimplementable: por qué' },
  },
}

const SERIALIZER_SCHEMA = {
  type: 'object',
  required: ['status', 'detalle'],
  properties: {
    status: { type: 'string', enum: ['ok', 'ya_estaba', 'blocked'] },
    pr_number: { type: 'integer' },
    detalle: { type: 'string' },
  },
}

const RESOLVER_SCHEMA = {
  type: 'object',
  required: ['action', 'resolution', 'resumen'],
  properties: {
    action: { type: 'string', enum: ['MERGE', 'HOLD', 'ABORT'] },
    resolution: { type: 'string', enum: ['RESOLVED', 'INCOMPATIBLE', 'NOT_NEEDED'] },
    resumen: { type: 'string' },
  },
}

const PARTICION_SCHEMA = {
  type: 'object',
  required: ['unidades', 'analisis'],
  properties: {
    analisis: { type: 'string', description: 'mapa integral del diff: módulos, seams, contratos' },
    unidades: {
      type: 'array',
      items: {
        type: 'object',
        required: ['nombre', 'paths'],
        properties: {
          nombre: { type: 'string' },
          paths: { type: 'array', items: { type: 'string' } },
          seams: { type: 'string' },
        },
      },
    },
  },
}

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['titulo', 'ubicacion', 'severidad', 'por_que', 'fix_propuesto'],
        properties: {
          titulo: { type: 'string' },
          ubicacion: { type: 'string', description: 'file:line' },
          severidad: { type: 'string', enum: ['alta', 'media', 'baja'] },
          por_que: { type: 'string' },
          fix_propuesto: { type: 'string' },
        },
      },
    },
  },
}

const JUICIO_SCHEMA = {
  type: 'object',
  required: ['aplicar', 'rechazadas', 'humano'],
  properties: {
    aplicar: {
      type: 'array',
      description: 'en orden de aplicación (independientes primero)',
      items: {
        type: 'object',
        required: ['titulo', 'ubicacion', 'fix', 'razon'],
        properties: {
          titulo: { type: 'string' },
          ubicacion: { type: 'string' },
          fix: { type: 'string' },
          razon: { type: 'string' },
        },
      },
    },
    rechazadas: { type: 'array', items: { type: 'object', properties: { titulo: { type: 'string' }, razon: { type: 'string' } } } },
    humano: { type: 'array', items: { type: 'object', properties: { titulo: { type: 'string' }, decision_necesaria: { type: 'string' } } } },
  },
}

const APPLIER_SCHEMA = {
  type: 'object',
  required: ['worktree', 'branch', 'aplicadas', 'falladas', 'resumen'],
  properties: {
    worktree: { type: 'string' },
    branch: { type: 'string' },
    aplicadas: { type: 'integer' },
    falladas: { type: 'array', items: { type: 'string' } },
    resumen: { type: 'string' },
  },
}

// ---------------------------------------------------------------------------
// §3.12.2 — llamar(): agent() endurecido. Intento 1 byte-idéntico (preserva el
// cache del resume); intento 2 cache-bustea el label y exige verificar estado.
// ---------------------------------------------------------------------------
async function llamar(makePrompt, opts, intentos = 2) {
  for (let i = 1; i <= intentos; i++) {
    const prompt =
      i === 1
        ? makePrompt('')
        : makePrompt(
            `\n\n(REINTENTO ${i}: el intento anterior terminó sin reportar su resultado estructurado. Parte del trabajo puede estar YA HECHO — verificá el estado real antes de cada acción. Tu ÚLTIMO acto es SIEMPRE el reporte estructurado.)`
          )
    const o = i === 1 ? opts : { ...opts, label: `${opts.label}~r${i}` }
    try {
      const r = await agent(prompt, o)
      if (r) return r
      log(`⚠ ${opts.label}: intento ${i} devolvió null`)
    } catch (e) {
      log(`⚠ ${opts.label}: intento ${i} falló: ${String(e).slice(0, 160)}`)
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// EL GATE (§3.3): función pura. Acá y solo acá se decide pasa/no-pasa.
// ---------------------------------------------------------------------------
function gate(med, base, { exigirTests = true } = {}) {
  const motivos = []
  if (!med) return { pass: false, motivos: ['validator murió'] }
  if (med.status !== 'ok') return { pass: false, motivos: [`medición inválida: ${med.error ?? 'sin detalle'}`] }
  // ratchet genérico: ninguna métrica empeora (convención "menor es mejor")
  for (const k of Object.keys(base.metrics ?? {})) {
    const b = base.metrics[k]
    const c = med.metrics?.[k]
    if (typeof c !== 'number') motivos.push(`métrica ${k} no reportada`)
    else if (c > b) motivos.push(`${k} empeoró (${b} → ${c})`)
  }
  if (!(med.tests_failed <= base.tests_failed))
    motivos.push(`tests rojos subieron (${base.tests_failed} → ${med.tests_failed})`)
  const nuevosRojos = (med.failing_test_files ?? []).filter(
    (f) => !(base.failing_test_files ?? []).includes(f)
  )
  if (nuevosRojos.length > 0) motivos.push(`tests antes-verdes ahora rojos: ${nuevosRojos.join(', ')}`)
  if (exigirTests) {
    if (med.diff_toca_tests !== true) motivos.push('el diff no agrega ni modifica ningún test (anti "slice sin tests")')
    if (med.tests_del_diff_verdes !== true) motivos.push('tests tocados por el diff no están todos verdes')
  }
  return { pass: motivos.length === 0, motivos }
}

// ---------------------------------------------------------------------------
// Validator (T económico, effort low): ejecuta y cuenta. Jamás opina. (§3.12.4)
// ---------------------------------------------------------------------------
function medir(donde, faseTag, etiqueta, { conDiff = false, pull = false } = {}) {
  const hook = A.validateHook
    ? `2. ${A.validateHook} --json   (timeout 420000)
   → status:'error' → reportá su campo error y status:'error'; NO sigas.
   → status:'ok' → copiá su objeto metrics tal cual.`
    : `2. Autodetectá el runtime (lockfile) y corré el typecheck del repo (timeout 420000).
   → reportá metrics = {"typecheck_errors": <conteo>}; si el comando crashea sin errores parseables: status:'error' (un output vacío JAMÁS es 0).`
  const diff = conDiff
    ? `4. Mecánica del diff contra origin/${RAMA} (timeout 120000):
   git fetch origin && git diff --name-only origin/${RAMA}...HEAD
   → diff_toca_tests = ¿algún archivo del diff matchea ${JSON.stringify(A.testGlobs)}?
   → corré SOLO los archivos de test del diff → tests_del_diff_verdes = ¿todos verdes? (sin tests en el diff → false)`
    : ''
  const pre = pull ? `0. git fetch origin && git pull --ff-only origin ${RAMA}\n` : ''
  return llamar(
    (suf) => `Sos un MEDIDOR. Ejecutá EXACTAMENTE estos comandos en orden y reportá NÚMEROS por schema. No opines, no arregles nada, no toques ningún archivo.

${pre}1. cd ${donde}
${hook}
3. Corré la suite de tests del repo (timeout 420000) → tests_failed = conteo de tests fallidos, failing_test_files = paths de archivos de test con fallas. Todo verde → 0 y lista vacía.
${diff}
Si un comando no puede correr: status:'error' con el mensaje en 'error'.${suf}`,
    { label: `validator:${etiqueta}`, phase: faseTag, model: M[T.validator], effort: 'low', schema: MEDICION_SCHEMA }
  ).then((r) => {
    // §3.3 — sin hook, el contrato de metrics es EXACTAMENTE {typecheck_errors}. Un
    // validator que sobre-reporta claves extra (p.ej. tests_passed en el baseline)
    // haría exigir al ratchet métricas que las mediciones siguientes nunca pidieron
    // (y tests_passed invierte "menor es mejor"). Normalizar acá, en código.
    if (r && !A.validateHook && r.metrics) r.metrics = { typecheck_errors: r.metrics.typecheck_errors }
    return r
  })
}

// ---------------------------------------------------------------------------
// Serializer (§3.2): ÚNICA vía de mutación remota. Check-then-act, secuencial.
// ---------------------------------------------------------------------------
const SERIALIZER_BASE = `Sos el SERIALIZADOR de mutaciones remotas (git-officer) del pipeline ${A.runLabel}. Sos IDEMPOTENTE: esta corrida puede ser una reanudación — antes de CADA acción verificás si ya está hecha (check-then-act); si ya está, constatás y seguís. La identidad del trabajo es su PR/issue, NO la branch (las branches se borran al mergear: chequeá PRs mergeados, no existencia de branch). Nunca implementás ni juzgás código.
PROHIBIDO: usar el tool Monitor, o terminar tu turno "esperando" algo — tu turno termina ÚNICAMENTE con el reporte estructurado emitido. Si esperás checks de CI: SOLO los requeridos por nombre (${JSON.stringify(A.requiredChecks)}; lista vacía = no esperes ninguno), con un loop foreground de Bash (timeout 600000); checks advisory se IGNORAN.
AUDIT LOG: por cada mutación que EJECUTES (no las constatadas) apendeá una línea a ${AUDIT_LOG}: "$(date -Iseconds) ${A.runLabel} <contexto> <accion> <resultado>" (mkdir -p si hace falta).\n\n`

function serializar(tarea, etiqueta, faseTag) {
  return llamar((suf) => SERIALIZER_BASE + tarea + `\n\nDevolvé por schema: status ('ok' | 'ya_estaba' | 'blocked'), pr_number si aplica, detalle (1-2 líneas).${suf}`, {
    label: `serializer:${etiqueta}`,
    phase: faseTag,
    model: M[T.serializer],
    effort: 'medium',
    schema: SERIALIZER_SCHEMA,
  })
}

// ---------------------------------------------------------------------------
// merge-resolver (agentType del plugin): recomienda; el serializer ejecuta.
// ---------------------------------------------------------------------------
function resolver(packet, etiqueta, faseTag) {
  return llamar(
    (suf) => `${packet}

IMPORTANTE: reportá tu recomendación por el output estructurado (schema), no por XML. Vos NO pusheás, NO mergeás, NO llamás gh con mutaciones — si resolvés conflictos, dejá los archivos resueltos y commiteados LOCALMENTE en el worktree indicado.${suf}`,
    {
      label: `resolver:${etiqueta}`,
      phase: faseTag,
      model: M[T.resolver],
      effort: 'high',
      agentType: 'host-orchestrator:merge-resolver',
      schema: RESOLVER_SCHEMA,
    }
  )
}

// ===========================================================================
// FASE: Setup — rama integradora + worktree local de integración
// ===========================================================================
phase('Setup')
log(
  `▶ ${A.runLabel} — scope ${A.scope.type}:${A.scope.value} — rama ${RAMA} sobre ${BASE} — ` +
    `budget ${BUDGET_TOTAL ? Math.round(BUDGET_TOTAL / 1000) + 'k' : 'SIN TOPE'}` +
    `${A.budgetTotal ? ' (por args)' : budget.total ? ' (por directiva)' : ''} — ts=${A.ts}`
)
log(`tiers: ${Object.entries(T).map(([r, t]) => `${r}=${t}→${M[t]}`).join(' ')}`)

const setup = await serializar(
  `Preparar la rama integradora del pipeline:
1. cd ${REPO} && git fetch origin
2. CHECK: ¿existe origin/${RAMA}? → si no: git branch ${RAMA} origin/${BASE} && git push -u origin ${RAMA} (contexto audit: setup)
3. CHECK: ¿existe el worktree local ${WT_INTEGRACION}? → si no: git worktree add ${WT_INTEGRACION} ${RAMA} (trackeando origin/${RAMA}); si existe: dentro de él git pull --ff-only.
4. Dentro del worktree: instalá dependencias si el repo lo necesita (lockfile presente y node_modules ausente).`,
  'setup-rama',
  'Setup'
)
if (!setup || setup.status === 'blocked') {
  log(`✖ setup falló: ${setup?.detalle ?? 'serializer murió'} — ABORT`)
  return { status: 'ABORT', fase: 'setup', detalle: setup?.detalle ?? 'serializer murió' }
}

// ===========================================================================
// LOOP DE WAVES
// ===========================================================================
const wavesReporte = []
const bugsReales = []
const bloqueadas = []
const pendientes = []
let inReviewUltimo = [] // PRs rojos/no-mergeables: NO accionables por el motor, van a para_leo
let allDone = false
let baseMetrics = null

for (let wave = 1; wave <= A.maxWaves; wave++) {
  if (BUDGET_TOTAL && restante() < A.minBudgetWave) {
    log(`■ CORTE por budget en boundary de wave ${wave}: quedan ${Math.round(restante() / 1000)}k < ${Math.round(A.minBudgetWave / 1000)}k mínimos`)
    pendientes.push(`waves restantes desde la ${wave}`)
    break
  }
  const FASE = `Wave ${wave}`
  phase(FASE)

  // --- Scout (frescura garantizada: el prompt varía por wave) ----------------
  const scout = await llamar(
    (suf) => `Sos un SCOUT de estado (wave ${wave}, corrida ${A.runLabel}). Solo LEÉS GitHub con gh; no mutás nada, no opinás sobre código.

1. cd ${REPO}
2. Issues del scope: ${
      A.scope.type === 'list'
        ? `gh issue view por cada una de: ${A.scope.value}`
        : `gh issue list ${scopeQuery} --state all --json number,title,state,labels,body --limit 200`
    }
3. Por cada issue, bucketeá con estas reglas EXACTAS (primera que matchee):
   - DONE: existe PR MERGEADO hacia ${RAMA} que referencia la issue. OJO: la issue puede seguir ABIERTA — las issues se cierran recién cuando el PR final llega a ${BASE}; el PR mergeado ES la identidad del trabajo hecho. (También DONE si la issue está cerrada con PR mergeado.)
   - HUMAN_GATED: label 'agent-blocked' (o variantes 'agent-blocked-*').
   - MERGE_READY: PR abierto hacia ${RAMA} con label '${A.labels.agentPr}', sin label 'merge-blocked'.
   - IN_REVIEW: PR abierto pero con checks fallidos, conflictos o 'merge-blocked'.
   - BLOCKED_BY_DEP: el body tiene 'Blocked by #X' con X no DONE (listá los números en blocked_by).
   - IMPLEMENTABLE: sin PR abierto ni mergeado, label '${A.labels.ready}' (o 'state/${A.labels.ready}'), deps cerradas.
   - NINGUNA regla matchea (ej. sin label ready, sin PR) → HUMAN_GATED con detalle 'sin regla aplicable: <por qué>'.
   Buscá PRs con: gh pr list --state all --search "<n> in:title" --json number,state,headRefName,labels,mergeable,statusCheckRollup (y validá que referencie la issue; incluí los MERGED).
4. all_done = ¿todas DONE o HUMAN_GATED sin nada accionable? → all_done=true SOLO si no queda NADA accionable (ni MERGE_READY ni IMPLEMENTABLE ni IN_REVIEW) y hay al menos una DONE.

Reportá por schema. En 'detalle' de cada issue: 1 línea con la evidencia del bucket.${suf}`,
    { label: `scout:w${wave}`, phase: FASE, model: M[T.scout], effort: 'low', schema: SCOUT_SCHEMA }
  )
  if (!scout) {
    log(`✖ scout de la wave ${wave} murió — ABORT`)
    return { status: 'ABORT', fase: FASE, detalle: 'scout murió', waves: wavesReporte }
  }
  const buckets = {}
  for (const i of scout.issues) (buckets[i.bucket] ??= []).push(i)
  log(
    `scout w${wave}: ${scout.issues.length} issues — ` +
      Object.entries(buckets).map(([b, l]) => `${b}:${l.length}`).join(' ')
  )
  for (const i of buckets.HUMAN_GATED ?? []) bloqueadas.push(`#${i.number} HUMAN_GATED: ${i.detalle ?? i.title}`)
  inReviewUltimo = (buckets.IN_REVIEW ?? []).map((i) => `#${i.number} IN_REVIEW (PR #${i.pr_number ?? '?'}): ${i.detalle ?? i.title} — requiere intervención humana antes de re-correr`)

  if (scout.all_done) {
    allDone = true
    log(`✔ scope completo en wave ${wave} — pasando a Review`)
    break
  }

  const accionables = (buckets.MERGE_READY ?? []).length + (buckets.IMPLEMENTABLE ?? []).length
  if (accionables === 0) {
    log(`■ BLOCKED: sin issues accionables (${(buckets.BLOCKED_BY_DEP ?? []).length} por deps, ${(buckets.HUMAN_GATED ?? []).length} humanas, ${(buckets.IN_REVIEW ?? []).length} in-review) — Leo tiene que intervenir`)
    break
  }

  // --- Refresh: base → rama integradora (§3.6, merge, nunca rebase) ---------
  const refresh = await serializar(
    `Refresh de la rama integradora (wave ${wave}):
1. cd ${WT_INTEGRACION} && git fetch origin && git pull --ff-only origin ${RAMA}
2. git merge origin/${BASE}
   - Sin conflicto (o ya al día): push si hubo merge nuevo (contexto audit: refresh-w${wave}) y status 'ok' (o 'ya_estaba').
   - CON CONFLICTO: NO resuelvas. git merge --abort y status 'blocked' con la lista de archivos en conflicto en detalle.`,
    `refresh-w${wave}`,
    FASE
  )
  if (refresh?.status === 'blocked') {
    log(`refresh w${wave} conflictúa (${refresh.detalle}) → merge-resolver`)
    const veredicto = await resolver(
      `## Workspace
Worktree: ${WT_INTEGRACION} (rama ${RAMA}, worktree local de integración). Tarea: mergear origin/${BASE} en ${RAMA}.
Corré vos: cd ${WT_INTEGRACION} && git merge origin/${BASE} — y resolvé los conflictos EN LOS ARCHIVOS.

## Intent packet
Rama integradora del pipeline ${A.runLabel} (scope ${A.scope.type}:${A.scope.value}): acumula los PRs de las issues del scope. ${BASE} trae trabajo externo al pipeline. Criterio: preservar AMBAS intenciones; ante incompatibilidad semántica real, ABORT + INCOMPATIBLE.

## Conflicto reportado
${refresh.detalle}`,
      `refresh-w${wave}`,
      FASE
    )
    if (veredicto?.action === 'MERGE' && veredicto.resolution !== 'INCOMPATIBLE') {
      const pushRefresh = await serializar(
        `El merge-resolver dejó resuelto y commiteado el merge de origin/${BASE} en ${WT_INTEGRACION}. Verificá que el merge esté cerrado (sin conflict markers, working tree limpio) y pusheá ${RAMA} (contexto audit: refresh-resolved-w${wave}). Si el árbol NO está limpio: status 'blocked'.`,
        `refresh-push-w${wave}`,
        FASE
      )
      if (pushRefresh?.status === 'blocked') {
        log(`■ BLOCKED en refresh w${wave}: ${pushRefresh.detalle}`)
        return { status: 'BLOCKED', fase: FASE, detalle: `refresh: ${pushRefresh.detalle}`, waves: wavesReporte, bloqueadas }
      }
    } else {
      log(`■ BLOCKED: refresh ${BASE}→${RAMA} INCOMPATIBLE (${veredicto?.resumen ?? 'resolver murió'}) — Leo tiene que mirar`)
      return { status: 'BLOCKED', fase: FASE, detalle: `refresh incompatible: ${veredicto?.resumen}`, waves: wavesReporte, bloqueadas }
    }
  }

  // --- Baseline de la wave (§3.3): sobre la rama integradora refrescada -----
  const baseMed = await medir(WT_INTEGRACION, FASE, `baseline-w${wave}`, { pull: true })
  if (!baseMed || baseMed.status !== 'ok') {
    log(`✖ baseline w${wave} inválido (${baseMed?.error ?? 'validator murió'}) — ABORT (medición inválida nunca es éxito)`)
    return { status: 'ABORT', fase: FASE, detalle: `baseline: ${baseMed?.error ?? 'validator murió'}`, waves: wavesReporte, bloqueadas }
  }
  baseMetrics = {
    metrics: baseMed.metrics,
    tests_failed: baseMed.tests_failed,
    failing_test_files: baseMed.failing_test_files,
  }
  log(`baseline w${wave}: ${Object.entries(baseMed.metrics).map(([k, v]) => `${k}=${v}`).join(' ')} testsRojos=${baseMed.tests_failed}`)

  const waveResumen = { wave, merges: [], impl: [] }

  // --- Merge wave: SERIAL por PR MERGE_READY (validar → resolver → merge) ---
  for (const iss of buckets.MERGE_READY ?? []) {
    const prNum = iss.pr_number
    const prep = await serializar(
      `Preparar el PR #${prNum} (issue #${iss.number}) para merge a ${RAMA}:
1. cd ${REPO} && git fetch origin
2. CHECK: gh pr view ${prNum} --json state,mergedAt → si ya está mergeado: 'ya_estaba' y TERMINÁ.
3. Worktree efímero en ${REPO}/.host-orchestrator/wt/pr-${prNum} — CONTRATO: el worktree DEBE quedar EXACTAMENTE en ese path (el validator mide ahí; otro path = medición inválida = merge bloqueado).
   a. Si ya existe: reusalo con git pull.
   b. Si la branch ${iss.pr_branch} está checkouteada en OTRO worktree (git worktree list — típico leftover de un implementer): si ese worktree está limpio (git status --porcelain vacío) y su HEAD está contenido en origin/${iss.pr_branch}, removelo (git worktree remove --force + git worktree prune) y seguí; si tiene commits sin pushear o cambios sin commitear, NO lo toques → status 'blocked' con el detalle.
   c. git worktree add ${REPO}/.host-orchestrator/wt/pr-${prNum} ${iss.pr_branch}
4. Dentro: git merge origin/${RAMA} — CON conflicto: NO resuelvas, abortá el merge y status 'blocked' con los archivos. Sin conflicto: si hubo merge nuevo, push de la branch del PR (contexto audit: pr-${prNum}-update). Instalá deps si hace falta.
En detalle reportá el path del worktree.`,
      `prep-pr${prNum}`,
      FASE
    )
    if (prep?.status === 'ya_estaba') {
      waveResumen.merges.push({ pr: prNum, resultado: 'ya_estaba' })
      continue
    }
    const wtPr = `${REPO}/.host-orchestrator/wt/pr-${prNum}`
    let conflicto = prep?.status === 'blocked'

    if (conflicto) {
      const v = await resolver(
        `## Workspace
Worktree: ${wtPr} (branch ${iss.pr_branch}). Tarea: mergear origin/${RAMA} en la branch del PR #${prNum} — corré el merge y resolvé conflictos EN LOS ARCHIVOS, commiteados localmente.

## Intent packet
Issue #${iss.number}: ${iss.title}. Leé el brief con: gh issue view ${iss.number} --comments (sección '## Agent Brief') y el PR con: gh pr view ${prNum}. Aplicá tus 5 criterios de no-regresión.

## Conflicto reportado
${prep?.detalle ?? 'sin detalle'}`,
        `pr${prNum}`,
        FASE
      )
      if (v?.action !== 'MERGE' || v.resolution === 'INCOMPATIBLE') {
        await serializar(
          `El merge del PR #${prNum} quedó bloqueado por el resolver (${v?.resolution ?? 'resolver murió'}: ${v?.resumen ?? ''}). Aplicá: gh pr edit ${prNum} --add-label merge-blocked && gh pr comment ${prNum} --body "merge-resolver: ${v?.resumen ?? 'sin veredicto'} (pipeline ${A.runLabel})" (contexto audit: pr-${prNum}-blocked). Limpiá el worktree ${wtPr} (git worktree remove --force).`,
          `block-pr${prNum}`,
          FASE
        )
        waveResumen.merges.push({ pr: prNum, resultado: 'merge-blocked', motivo: v?.resumen })
        continue
      }
      conflicto = false
    }

    const medPr = await medir(wtPr, FASE, `pr${prNum}`, {})
    const g = gate(medPr, baseMetrics, { exigirTests: false }) // el PR ya pasó su gate al publicarse; acá exigimos no-regresión post-merge-de-rama
    if (!g.pass) {
      await serializar(
        `El PR #${prNum} NO pasa el gate de no-regresión contra ${RAMA} (${g.motivos.join(' | ')}). Aplicá: gh pr edit ${prNum} --add-label merge-blocked && gh pr comment ${prNum} --body "gate: ${g.motivos.join('; ')} (pipeline ${A.runLabel})" (contexto audit: pr-${prNum}-gate-fail). Conservá el worktree ${wtPr} para autopsia.`,
        `gatefail-pr${prNum}`,
        FASE
      )
      waveResumen.merges.push({ pr: prNum, resultado: 'gate-fail', motivo: g.motivos })
      continue
    }
    const mrg = await serializar(
      `Mergear el PR #${prNum} a ${RAMA}:
1. Si la branch del PR avanzó localmente en ${wtPr} (merge de refresh o resolución), asegurate de que esté pusheada.
2. CHECK: ¿ya está mergeado? → si no: gh pr merge ${prNum} --squash --delete-branch (contexto audit: pr-${prNum}-merge)
3. Limpiá el worktree ${wtPr} (git worktree remove --force). En ${WT_INTEGRACION}: git pull --ff-only.`,
      `merge-pr${prNum}`,
      FASE
    )
    waveResumen.merges.push({ pr: prNum, resultado: mrg?.status ?? 'blocked', motivo: mrg?.detalle })
    log(`merge PR #${prNum}: ${mrg?.status ?? 'serializer murió'}`)
  }

  // --- Impl wave: fan-out implementers en worktrees (cap maxParallel) -------
  const implementables = (buckets.IMPLEMENTABLE ?? []).slice(0, A.maxParallel)
  if (implementables.length > 0) {
    log(`▶ impl w${wave}: ${implementables.map((i) => `#${i.number}`).join(' ')}`)
    const deny = A.denyPaths.length ? `\nPATHS VEDADOS (ratchets/guards ortogonales del repo — NO los toques ni "mejores" nada ahí): ${A.denyPaths.join(', ')}` : ''

    const implResultados = (
      await parallel(
        implementables.map((iss) => () => implementarConGate(iss, FASE, deny))
      )
    ).filter(Boolean)

    // Publish SERIAL: una mutación remota por vez, orden determinístico
    for (const r of implResultados) {
      waveResumen.impl.push({ issue: r.issue, gate: r.gate, motivos: r.motivos })
      bugsReales.push(...(r.impl?.bugs_reales ?? []).map((b) => `[#${r.issue}] ${b}`))
      if (r.gate !== 'PASS') {
        if (r.gate === 'FAIL') {
          await serializar(
            `La issue #${r.issue} falló su gate 2 veces (${(r.motivos ?? []).join(' | ')}). Aplicá: gh issue edit ${r.issue} --add-label agent-blocked && gh issue comment ${r.issue} --body "gate del pipeline ${A.runLabel}: ${(r.motivos ?? []).join('; ')}. Worktree conservado: ${r.impl?.worktree}" (contexto audit: issue-${r.issue}-blocked).`,
            `block-i${r.issue}`,
            FASE
          )
          bloqueadas.push(`#${r.issue} gate FAIL: ${(r.motivos ?? []).join('; ')}`)
        }
        continue
      }
      const pub = await serializar(
        `Publicar el trabajo de la issue #${r.issue} (worktree ${r.impl.worktree}, branch ${r.impl.branch}):
1. CHECK identidad de trabajo: ¿hay PR (abierto O mergeado) de la branch ${r.impl.branch}? → mergeado: 'ya_estaba'; abierto: constatá que esté al día y saltá a 3.
2. cd ${r.impl.worktree} && git push -u origin ${r.impl.branch}, después gh pr create --base ${RAMA} --label ${A.labels.agentPr} --title "${r.titulo ?? `issue #${r.issue}`}" --body con: "Closes #${r.issue}", el resumen del implementer, y "PR del pipeline ${A.runLabel}. 🤖 Generated with [Claude Code](https://claude.com/claude-code)" (contexto audit: issue-${r.issue}-pr-create)
3. Si el PR quedó abierto sin problemas: limpiá el worktree OBLIGATORIAMENTE (git worktree remove --force + git worktree prune) — un checkout residual de la branch bloquea el worktree canónico del merge posterior. Solo conservalo si el push o el PR fallaron.`,
        `publish-i${r.issue}`,
        FASE
      )
      log(`publish #${r.issue}: ${pub?.status ?? 'blocked'} ${pub?.pr_number ? `→ PR #${pub.pr_number}` : ''}`)
    }
  }

  wavesReporte.push(waveResumen)
  log(`✔ wave ${wave} cerrada: ${waveResumen.merges.length} merges procesados, ${waveResumen.impl.length} impls — spent ${Math.round(budget.spent() / 1000)}k`)
}

// --- implementer + gate por issue (cadena secuencial; corre en paralelo entre issues)
async function implementarConGate(iss, FASE, deny) {
  const tier = A.issueTiers?.[String(iss.number)] ?? T.implementer
  log(`dispatched implementer:#${iss.number} (${tier}→${M[tier]})`)
  const impl = await llamar(
    (suf) => `Implementá la issue #${iss.number} ("${iss.title}") del repo en tu worktree AISLADO (tu cwd). No salgas de él.

PASO 0 (obligatorio — la base se toma del REMOTO, §3.11):
  git fetch origin && git checkout -B issue-${iss.number} origin/${RAMA}
  Instalá dependencias si el repo lo necesita.
PASO 1: leé el brief: gh issue view ${iss.number} --comments → sección '## Agent Brief' (gh solo LECTURA: prohibida toda mutación remota).
PASO 2: implementá el slice vertical con tu disciplina TDD completa (roja→verde por criterio de aceptación).${deny}
PASO 3: verificate: typecheck + suite de tests del repo. Ningún test antes-verde puede quedar rojo.
PASO 4: git add -A && git commit (mensaje descriptivo). NO pushees, NO gh pr create — el pipeline publica por vos.
Si un error destapa un BUG REAL preexistente: NO lo arregles, anotalo en bugs_reales.
Si el brief es inimplementable/ambiguo: explicalo en 'bloqueado' y NO inventes.

Reportá por el output estructurado (schema; no XML): worktree = pwd absoluto, branch, resumen, bugs_reales, bloqueado.${suf}`,
    {
      label: `implementer:#${iss.number}`,
      phase: FASE,
      model: M[tier],
      effort: 'medium',
      isolation: 'worktree',
      agentType: 'host-orchestrator:parallel-implementer',
      schema: IMPL_SCHEMA,
    }
  )
  if (!impl) return { issue: iss.number, gate: 'ERROR', motivos: ['implementer murió'] }
  if (impl.bloqueado) return { issue: iss.number, gate: 'FAIL', motivos: [`brief: ${impl.bloqueado}`], impl }

  let med = await medir(impl.worktree, FASE, `i${iss.number}`, { conDiff: true })
  let g = gate(med, baseMetrics)
  if (!g.pass) {
    log(`gate FAIL #${iss.number} (${g.motivos.join(' | ')}) → reintento 1/1`)
    await llamar(
      (suf) => `Sos el implementer de la issue #${iss.number} en tu SEGUNDO y ÚLTIMO intento. Tu trabajo está en ${impl.worktree} (branch ${impl.branch}) — cd ahí primero.
El gate (comparación numérica contra el baseline de la wave) falló por:
${g.motivos.map((m) => `  - ${m}`).join('\n')}
Corregí ESO con las mismas reglas (solo tu slice, TDD, sin mutaciones remotas, commit local al final).${suf}`,
      { label: `retry:#${iss.number}`, phase: FASE, model: M[tier], effort: 'medium', schema: IMPL_SCHEMA }
    )
    med = await medir(impl.worktree, FASE, `i${iss.number}-retry`, { conDiff: true })
    g = gate(med, baseMetrics)
  }
  log(`gate ${g.pass ? 'PASS' : 'FAIL'} #${iss.number}${g.pass ? '' : ` (${g.motivos.join(' | ')})`}`)
  return { issue: iss.number, titulo: iss.title, gate: g.pass ? 'PASS' : 'FAIL', motivos: g.motivos, impl }
}

// ===========================================================================
// FASE: Review fleet nativa (§3.7) — solo si el scope quedó completo
// ===========================================================================
let reviewReporte = { corrida: false }
if (allDone) {
  phase('Review')
  const okBudget = !BUDGET_TOTAL || restante() >= A.minBudgetWave
  if (!okBudget) {
    log(`■ review salteada por budget (quedan ${Math.round(restante() / 1000)}k)`)
    pendientes.push('review fleet (budget)')
  } else {
    // 1. Análisis integral + partición en unidades de review (T razonador)
    const part = await llamar(
      (suf) => `Sos el PARTICIONADOR de un review fleet. SOLO LEÉS.
1. cd ${WT_INTEGRACION} && git fetch origin && git pull --ff-only
2. Estudiá el diff INTEGRADO completo: git diff origin/${BASE}...HEAD — como un todo, no PR por PR: mapa de módulos tocados, seams nuevos, contratos cambiados, estado compartido. Leé CONTEXT.md y docs/adr/ si existen.
3. Particioná en unidades de review = superficies cohesivas del estado FINAL (módulo + sus seams, ~≤1.5k líneas relevantes por unidad, máx 6). Las fronteras salen del dominio y la estructura del repo, NUNCA de cómo se despachó el trabajo (waves/issues son artefactos de scheduling).
Reportá por schema: analisis (el mapa) y unidades (nombre, paths, seams).${suf}`,
      { label: 'review:particion', phase: 'Review', model: M[T.reviewer], effort: 'high', schema: PARTICION_SCHEMA }
    )
    if (!part) {
      log('✖ particionador murió — review salteada')
      pendientes.push('review fleet (particionador murió)')
    } else {
      const unidades = part.unidades.slice(0, 6)
      log(`review: ${unidades.length} unidades — ${unidades.map((u) => u.nombre).join(', ')}`)

      // 2. Reviewers: 2 lentes por unidad + integración si hay 2+ (paralelo, read-only)
      const lentes = [
        { key: 'arch', desc: 'ARQUITECTURA (lente deep-modules): profundidad de módulos, seams, deletion test, interfaz-como-superficie-de-test. ¿La unidad es un módulo profundo o una fachada rota?' },
        { key: 'impl', desc: 'IMPLEMENTACIÓN CRÍTICA: bugs de correctitud, seguridad (OWASP), manejo de errores, consistencia con las convenciones del repo, code smells con consecuencia real.' },
      ]
      const trabajos = unidades.flatMap((u) =>
        lentes.map((l) => ({ etiqueta: `${l.key}:${u.nombre}`, prompt: `Unidad "${u.nombre}" (paths: ${u.paths.join(', ')}; seams: ${u.seams ?? 'n/a'}). Lente ${l.desc}` }))
      )
      if (unidades.length > 1)
        trabajos.push({
          etiqueta: 'integracion',
          prompt: `SOLO los SEAMS ENTRE unidades (contratos, flujo de datos, invariantes cruzadas) que surgen de este análisis integral: ${part.analisis}. Los reviewers por unidad no ven esto; acá es donde se rompen las implementaciones multi-wave.`,
        })

      const hallazgosCrudos = (
        await parallel(
          trabajos.map((t) => () =>
            llamar(
              (suf) => `Sos un REVIEWER read-only del diff integrado ${BASE}...${RAMA}.
1. cd ${WT_INTEGRACION} (NO modifiques NADA)
2. Base del review: git diff origin/${BASE}...HEAD restringido a tu alcance. Leé CONTEXT.md/ADRs si existen.
3. Tu alcance y lente: ${t.prompt}
Reportá findings ESTRUCTURADOS (título · file:line · severidad alta/media/baja · por qué importa · fix propuesto). Sin prosa. Lista vacía si no hay nada real — no inventes hallazgos para justificarte.${suf}`,
              { label: `review:${t.etiqueta}`, phase: 'Review', model: M[T.reviewer], effort: 'high', schema: FINDINGS_SCHEMA }
            )
          )
        )
      )
        .filter(Boolean)
        .flatMap((r, idx) => (r.findings ?? []).map((f) => ({ ...f, lente: trabajos[idx]?.etiqueta })))
      log(`review: ${hallazgosCrudos.length} findings crudos de ${trabajos.length} reviewers`)

      // 3. Judge (dedup + APLICAR/RECHAZAR/HUMANO + orden) — barrier necesario
      let juicio = { aplicar: [], rechazadas: [], humano: [] }
      if (hallazgosCrudos.length > 0) {
        juicio =
          (await llamar(
            (suf) => `Sos el JUEZ de un review fleet sobre el diff integrado ${BASE}...${RAMA} (repo en ${WT_INTEGRACION}, solo lectura). Scope: ${A.scope.type}:${A.scope.value}.

FINDINGS (${hallazgosCrudos.length}):
${JSON.stringify(hallazgosCrudos, null, 1)}

Tu deber:
- Deduplicá solapados entre lentes.
- Fallá cada uno: APLICAR / RECHAZAR / HUMANO (necesita decisión de Leo), razón de 1 línea.
- Pesá: ¿es real (no especulativo)? ¿está en scope? ¿el riesgo del fix supera su beneficio? ¿contradice un ADR o CONTEXT.md?
- Ordená la lista APLICAR: independientes primero, dependientes al final.
Vos NO editás código.${suf}`,
            { label: 'review:judge', phase: 'Review', model: M[T.judge], effort: 'high', schema: JUICIO_SCHEMA }
          )) ?? juicio
      }
      log(`judge: ${juicio.aplicar.length} APLICAR · ${juicio.rechazadas.length} rechazadas · ${juicio.humano.length} para Leo`)

      // 4. Applier (seriado en un solo worktree/branch review/*) + gate + publish
      let reviewPr = null
      if (juicio.aplicar.length > 0) {
        const apl = await llamar(
          (suf) => `Sos el APPLIER del review fleet. Trabajás en tu worktree AISLADO (tu cwd).
PASO 0: git fetch origin && git checkout -B review/${A.runLabel} origin/${RAMA}. Instalá deps si hace falta.
Aplicá EN ORDEN estos fixes aprobados por el juez (y SOLO estos):
${juicio.aplicar.map((f, i) => `${i + 1}. [${f.ubicacion}] ${f.titulo} → ${f.fix}`).join('\n')}
Por cada fix: aplicá, corré build/tests del área tocada; si rompe, REVERTILO (no "fixes forward") y anotalo en falladas.
Al final: git add -A && git commit. NO pushees, NO gh.
Reportá por schema: worktree (pwd absoluto), branch, aplicadas, falladas, resumen.${suf}`,
          { label: 'review:applier', phase: 'Review', model: M[T.applier], effort: 'medium', isolation: 'worktree', schema: APPLIER_SCHEMA }
        )
        if (apl && apl.aplicadas > 0) {
          const medRev = await medir(apl.worktree, 'Review', 'review-fixes', { conDiff: false })
          const gRev = gate(medRev, baseMetrics, { exigirTests: false })
          if (gRev.pass) {
            const pubRev = await serializar(
              `Publicar y mergear los fixes del review (worktree ${apl.worktree}, branch ${apl.branch}):
1. CHECK identidad de trabajo: ¿PR de ${apl.branch} ya mergeado? → 'ya_estaba'.
2. push -u origin ${apl.branch} && gh pr create --base ${RAMA} --label ${A.labels.agentPr} --label review-fix --title "review: fixes del fleet (${A.runLabel})" --body con el resumen del applier + "🤖 Generated with [Claude Code](https://claude.com/claude-code)" (contexto audit: review-pr-create)
3. gh pr merge --squash --delete-branch del PR creado (contexto audit: review-pr-merge). En ${WT_INTEGRACION}: git pull --ff-only.`,
              'review-publish',
              'Review'
            )
            reviewPr = pubRev?.pr_number ?? null
            log(`review: ${apl.aplicadas} fixes mergeados${reviewPr ? ` (PR #${reviewPr})` : ''}`)
          } else {
            log(`review: fixes NO pasan el gate (${gRev.motivos.join(' | ')}) — descartados, worktree conservado para autopsia`)
            juicio.humano.push({ titulo: 'fixes del review no pasaron el gate', decision_necesaria: `revisar ${apl.worktree}: ${gRev.motivos.join('; ')}` })
          }
        }
      }
      reviewReporte = { corrida: true, unidades: unidades.map((u) => u.nombre), findings: hallazgosCrudos.length, juicio, review_pr: reviewPr }
    }
  }
}

// ===========================================================================
// FASE: Cierre — PR draft rama → base + reporte
// ===========================================================================
phase('Cierre')
let prFinal = null
if (allDone) {
  const cierre = await serializar(
    `Cerrar el pipeline: PR draft de ${RAMA} hacia ${BASE}.
1. cd ${WT_INTEGRACION} && git pull --ff-only
2. CHECK identidad de trabajo: ¿ya existe PR (abierto o mergeado) ${RAMA} → ${BASE}? → reportá su número ('ya_estaba').
3. Si no: gh pr create --draft --base ${BASE} --head ${RAMA} --title "${A.scope.type}:${A.scope.value} — pipeline ${A.runLabel}" --body con: resumen del scope, lista de issues cerradas con sus PRs (sacala de gh), nota del review fleet, y "PR integrador para botón verde de Leo. 🤖 Generated with [Claude Code](https://claude.com/claude-code)" (contexto audit: pr-final-create)`,
    'pr-final',
    'Cierre'
  )
  prFinal = cierre?.pr_number ?? null
}

const reporte = {
  status: allDone ? 'DONE' : pendientes.length ? 'BUDGET_CUT' : 'BLOCKED',
  corrida: A.runLabel,
  ts_lanzamiento: A.ts,
  scope: A.scope,
  rama: RAMA,
  pr_final_draft: prFinal,
  waves: wavesReporte,
  review: reviewReporte,
  bloqueadas,
  pendientes,
  bugs_reales_para_issues: bugsReales,
  para_leo: [
    ...(reviewReporte.juicio?.humano ?? []).map((h) => `[review] ${h.titulo}: ${h.decision_necesaria}`),
    ...bloqueadas,
    ...inReviewUltimo,
  ],
  tokens_spent: budget.spent(),
}
log(
  `■ fin ${A.runLabel}: ${reporte.status} — waves=${wavesReporte.length}` +
    `${prFinal ? ` · PR final draft #${prFinal}` : ''} · bloqueadas=${bloqueadas.length} · bugs anotados=${bugsReales.length} · spent ${Math.round(budget.spent() / 1000)}k`
)
return reporte
