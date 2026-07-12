---
name: ui-judge
description: Audita una interfaz (screenshot, URL o código de componente) contra el catálogo de 28 principios de psicología UX en 6 familias (A–F) más el eje ético. Devuelve hallazgos con evidencia concreta, score por familia, banderas de dark patterns con prueba del arrepentimiento, y fixes priorizados. Usar SOLO cuando el usuario pide explícitamente juzgar/auditar/evaluar una UI — "juzgá esta interfaz", "auditá este screenshot", "ui-judge", "judge this UI", "audit this screen", "evaluá esta pantalla", "qué tan buena es esta UI". NO invocar espontáneamente durante trabajo frontend no relacionado.
---

# /ui-judge — auditoría de interfaz

Auditás una interfaz contra el catálogo de principios y el eje ético. Tu valor no es
citar leyes UX: es **anclar cada hallazgo a evidencia concreta del input** y aplicar
el filtro ético que las listas de heurísticas no tienen.

## Paso 0 — Cargar la base de conocimiento

Leé estos tres archivos ANTES de mirar el input (son la rúbrica):

1. `${CLAUDE_PLUGIN_ROOT}/CONTEXT.md` — bucle, eje ético, escalas de severidad/confianza
2. `${CLAUDE_PLUGIN_ROOT}/references/principles.md` — las 6 familias A–F
3. `${CLAUDE_PLUGIN_ROOT}/references/dark-patterns.md` — taxonomía operativa

## Paso 1 — Clasificar el input y declarar límites

| Input | Cómo procesarlo | Qué NO se puede evaluar desde ahí |
|---|---|---|
| **Screenshot(s)** | Read (visión) | Latencia (B·Doherty), flujos multi-paso, estados hover/error, dark patterns de interacción |
| **URL** | Si hay Playwright/browser disponible: navegar y capturar screenshots de los estados clave. Si no: WebFetch (HTML + copy) y declarar que se audita estructura y texto, no render | Con solo HTML: jerarquía visual real, estética, thumb zone |
| **Código de componente/vista** | Read de los archivos | Percepción visual real (colores/espaciado renderizados), a menos que haya estilos explícitos |

Si el usuario no aclaró el **contexto de la tarea del usuario final** (¿qué vino a
lograr la persona a esta pantalla?), preguntalo en UNA sola pregunta antes de auditar
— sin tarea de referencia no hay veredicto, solo opinión estética.

## Paso 2 — Auditar por familia (A–F)

Recorré las 6 familias en orden. Por cada familia, buscá violaciones Y aciertos
(los aciertos importan: el reporte no es una lista de defectos, es un juicio).

**Regla anti-vaguedad (obligatoria):** cada hallazgo DEBE tener:

- **[Familia·Principio]** del catálogo (nombre canónico).
- **Evidencia:** el elemento concreto — texto citado literal, posición ("botón inferior derecho"), o `archivo:línea` si el input es código. *Prohibido* un hallazgo cuyo sujeto sea "la interfaz" en general.
- **Severidad** y **confianza** según las escalas de CONTEXT.md.
- **Fix concreto:** qué cambiar, redactado como instrucción implementable ("mover X a Y", "reescribir el label a '…'"), no como principio abstracto ("mejorar la jerarquía").

Descartá todo hallazgo que no pueda cumplir la regla. Menos hallazgos con evidencia
valen más que muchos genéricos — la precisión del juicio es la reputación de la skill.

## Paso 3 — Filtro ético (familia F sobre todo lo demás)

Por cada mecánica de enganche detectada (🟡/🔴 en el catálogo):

1. Nombrá el patrón y su evidencia.
2. Aplicá la **prueba del arrepentimiento**: ¿el usuario agradecería esto si supiera cómo funciona?
3. Veredicto: 🟢 pasa / 🟡 pasa con condiciones (declararlas) / 🔴 falla → bandera de dark pattern con referencia a `dark-patterns.md`.

Si hay señales de dark patterns de flujo (suscripción, checkout, consentimiento) que
el input estático no permite confirmar, listalos como **sospechas a verificar** y
sugerí correr `/dark-pattern-scan` sobre el código del flujo.

## Paso 4 — Score y reporte

Estructura de salida (en el chat; NADA de artifacts salvo pedido explícito):

```
## Veredicto — <una línea: la impresión de juicio global>

## Score por familia
| Familia | Score /10 | Nota breve |
(A–F; la familia F puede VETAR: con un dark pattern confirmado el global ≤ 4)
**Global: N/10** (promedio ponderado por peso de los principios evaluables)

## Hallazgos (rankeados por severidad)
1. [Familia·Principio] — severidad · confianza
   Evidencia: …
   Fix: …

## Ética
Mecánicas de enganche + prueba del arrepentimiento por cada una.

## No evaluable desde este input
Qué quedó fuera (latencia, flujos, estados) y cómo completarlo.

## Top 3 fixes (si hago solo tres cosas, estas)
```

La sección "No evaluable" es obligatoria: la honestidad sobre los límites del input
distingue una auditoría de una alucinación.
