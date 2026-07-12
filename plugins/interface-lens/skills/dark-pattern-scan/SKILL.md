---
name: dark-pattern-scan
description: Escaneo adversarial de dark patterns en código o diseño antes de shippear — rastrea flujos completos (suscripción, checkout, consentimiento, cancelación), mide asimetría de fricción entrada/salida y devuelve reporte pasa/falla con evidencia por archivo:línea. Usar SOLO cuando el usuario pide explícitamente escanear/buscar dark patterns o manipulación — "dark-pattern-scan", "buscá dark patterns", "escaneá patrones oscuros", "scan for dark patterns", "revisá que no haya manipulación antes de shippear". NO invocar espontáneamente durante code review no relacionado.
---

# /dark-pattern-scan — caza adversarial de patrones oscuros

Modo adversarial: asumí que el código/diseño **puede estar manipulando** y tratá de
demostrarlo con evidencia. No sos un linter de estilo — sos el auditor que el usuario
final no puede contratar. Esto importa incluso sin mala intención del equipo: los
patrones se cuelan por defaults de librerías, copy heredado y código generado por IA
(que los reproduce en más de la mitad de los casos).

## Paso 0 — Cargar la base de conocimiento

1. `${CLAUDE_PLUGIN_ROOT}/references/dark-patterns.md` — la taxonomía operativa con señales de código por patrón. Es TU checklist; el reporte final responde por cada patrón.
2. `${CLAUDE_PLUGIN_ROOT}/CONTEXT.md` — asimetría de fricción, prueba del arrepentimiento, escalas.

## Paso 1 — Delimitar la superficie de escaneo

Si el usuario no especificó qué escanear, identificá en el repo (o pedí que señale)
las **superficies de riesgo** — los patrones viven en flujos, no en pantallas sueltas:

| Superficie | Qué buscar ahí |
|---|---|
| Alta/baja de suscripción, trials | roach motel, forced continuity, sludge |
| Checkout, pricing, carrito | drip pricing, preselección dañina, urgencia/escasez falsas |
| Consentimiento, privacidad, permisos | privacy zuckering, preselección, asimetría aceptar/rechazar |
| Modales, prompts, notificaciones | nagging, bait-and-switch, confirmshaming |
| Copy de botones y opciones negativas | confirmshaming, bait-and-switch |
| Feeds, listados, contenido patrocinado | disguised ads, autoplay/scroll sin puntos de parada |

Un diff acotado (integración con `/code-review`) limita la superficie al código
tocado + los flujos que ese código afecta.

## Paso 2 — Rastrear flujos, no pantallas

Para cada superficie:

1. **Trazá la ruta de entrada** al compromiso (suscribirse, aceptar, comprar): contá pasos, clics, campos.
2. **Trazá la ruta de salida** (cancelar, rechazar, darse de baja, borrar cuenta): ¿existe en el código? ¿mismo canal? ¿cuántos pasos?
3. **Aplicá el test de asimetría**: entrada fácil + salida costosa = hallazgo estructural, aunque ningún elemento individual sea oscuro.
4. Recorré el checklist de `dark-patterns.md` usando las **señales de flujo/código** de cada patrón. Priorizá las comprobables mecánicamente: countdowns hardcodeados, stock/viewers aleatorios en el cliente, `checked={true}` en opciones con costo, negativas que no se persisten, handlers que hacen más de lo que su label dice, fees que solo existen en el paso final.

## Paso 3 — Calificar cada hallazgo

- **Evidencia obligatoria:** `archivo:línea` (código) o elemento/texto citado (diseño). Sin evidencia no hay hallazgo.
- **Patrón** de la taxonomía + severidad y confianza (escalas de CONTEXT.md).
- **Prueba del arrepentimiento** aplicada.
- **Bandera regulatoria** cuando aplique (click-to-cancel FTC, DSA de la UE — ver sección regulatoria de `dark-patterns.md`): un dark pattern confirmado puede ser pasivo legal, no solo deuda de UX.
- **Fix concreto** por hallazgo.

Distinguí siempre **dark pattern** (falla la prueba del arrepentimiento + está en la
taxonomía) de **hallazgo de usabilidad** (mal diseño sin manipulación) — lo segundo
va a `/ui-judge`, no acá. No inflar el reporte con usabilidad genérica.

## Paso 4 — Reporte pasa/falla

Estructura de salida (en el chat; NADA de artifacts salvo pedido explícito):

```
## Veredicto: PASA / FALLA
FALLA si hay ≥1 hallazgo con severidad bloqueante o alta con confianza alta.

## Hallazgos (rankeados por severidad)
1. <patrón> — severidad · confianza · [bandera regulatoria si aplica]
   Evidencia: archivo:línea / elemento citado
   Prueba del arrepentimiento: …
   Fix: …

## Checklist de la taxonomía
Un renglón por patrón: ✅ limpio / 🔴 hallazgo / ⚪ no evaluable en esta superficie
(el ⚪ es obligatorio declararlo — lo no escaneado no está aprobado).

## Asimetría de fricción
Tabla entrada vs. salida por compromiso detectado (pasos/canal).
```

## Integración con otros flujos

- **Con `/code-review`:** corré este scan después de un review sobre diffs que tocan UI/checkout/consentimiento, cuando el usuario lo pida. El scan NO reemplaza el review: busca manipulación, no bugs.
- **Con `/ui-judge`:** si el juez marcó "sospechas a verificar" en flujos, este scan las confirma o descarta leyendo el código.
- Reportes visuales (dataviz/artifact-design) solo si el usuario pide explícitamente un artifact.
