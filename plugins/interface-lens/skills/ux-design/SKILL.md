---
name: ux-design
description: Diseña un flujo o interfaz para un problema de producto declarando explícitamente qué principios de psicología UX usa, por qué, y con qué guardas éticas — mapea la tarea al bucle disparador→acción→recompensa→inversión con norte time-well-spent. Usar SOLO cuando el usuario pide explícitamente diseñar/proponer un flujo o UX — "diseñame este flujo", "ux-design", "proponé la UX de", "design this flow", "cómo debería ser el onboarding de". NO invocar espontáneamente durante trabajo frontend no relacionado.
---

# /ux-design — diseño de flujo con principios declarados

Proponés un flujo/interfaz para un problema de producto. Tu diferencial: cada decisión
de diseño **declara qué principio usa y por qué sirve al usuario** — el diseño viene
con su propia auditoría incorporada. La rúbrica de `/ui-judge` es tu guía generativa:
diseñá algo que esa auditoría aprobaría.

## Paso 0 — Cargar la base de conocimiento

Leé ANTES de diseñar:

1. `${CLAUDE_PLUGIN_ROOT}/CONTEXT.md` — bucle, eje ético, términos canónicos
2. `${CLAUDE_PLUGIN_ROOT}/references/principles.md` — las 6 familias A–F
3. `${CLAUDE_PLUGIN_ROOT}/references/dark-patterns.md` — lo que el diseño NO debe hacer

## Paso 1 — Anclar el objetivo del usuario

Antes de proponer nada, tienen que estar claros:

- **La tarea del usuario final:** qué vino a lograr, en sus términos (no en métricas del negocio).
- **El contexto de uso:** dispositivo, frecuencia, estado emocional probable (¿apurado? ¿ansioso? ¿explorando?).
- **La definición de éxito time-well-spent:** ¿cómo se ve "tarea cumplida bien y se fue mejor"?

Si falta alguno, preguntá (máximo 2-3 preguntas, de una vez). Si el pedido viene
formulado solo en métricas de retención/engagement, **reencuadralo**: proponé la
métrica time-well-spent equivalente y diseñá para esa, señalando el cambio.

## Paso 2 — Mapear la tarea al bucle

Descomponé el flujo en el bucle A→D:

- **Disparador (A):** ¿qué trae al usuario a esta tarea? ¿Externo (notificación, link) o interno (necesidad)? Si proponés disparadores externos, pasan por el filtro del Paso 4.
- **Acción (B+E):** el camino mínimo hacia la tarea. Acá viven Fitts, Hick, chunking, Jakob, Doherty. ¿Qué complejidad absorbe el producto (Tesler) en vez del usuario?
- **Recompensa (C):** ¿qué confirma que la tarea salió bien? Diseñá el **final** (regla Pico-Final): el cierre es parte del flujo, no un toast genérico.
- **Inversión (D):** ¿qué queda guardado que mejora el próximo uso? (preferencias, historial, configuración). Inversión que sirve al usuario ≠ lock-in.

## Paso 3 — Elegir principios y declararlos

Por cada decisión de diseño relevante, declará en línea:

> **[Familia·Principio]** — por qué acá, y a qué objetivo *del usuario* sirve.

Reglas de selección:

- Preferí principios 🟢. Cada principio 🟡 que uses necesita su guarda explícita (Paso 4). Los 🔴 (recompensas variables, aversión a la pérdida, FOMO) solo si sobreviven la prueba del arrepentimiento con argumento escrito — casi nunca lo hacen.
- **Fricción estratégica es una herramienta de diseño**, no solo de auditoría: agregá fricción donde una decisión es cara o irreversible.
- No fuerces las 6 familias: un flujo utilitario puede no necesitar mecánica de inversión. Declarar "acá no aplica D y está bien" también es diseño.

## Paso 4 — Guardas éticas

Sección obligatoria del entregable:

1. Por cada mecánica 🟡/🔴 usada: la **prueba del arrepentimiento** aplicada y las condiciones bajo las que se mantiene ética (ej.: "racha con congelamiento gratuito y sin culpabilización al perderla").
2. **Chequeo de asimetría:** si el flujo crea un compromiso (cuenta, suscripción, datos), diseñá la salida con la misma fricción que la entrada — la ruta de cancelación es parte del diseño, no un after-thought.
3. Defaults: cada valor por defecto debe beneficiar al usuario si nunca lo toca.

## Paso 5 — Entregable

Estructura de salida (en el chat; NADA de artifacts salvo pedido explícito):

```
## Norte
Tarea del usuario + métrica time-well-spent (y el reencuadre, si lo hubo).

## El flujo
Paso a paso numerado. Cada paso con sus [Familia·Principio] declarados en línea.

## Mapa al bucle
Una línea por etapa A→D: qué la cubre (o por qué no aplica).

## Guardas éticas
Prueba del arrepentimiento por mecánica + salida simétrica + defaults.

## Trade-offs
Qué se sacrificó y por qué (ej.: conversión vs. claridad). Sin trade-offs declarados
no hay diseño honesto.
```

Cerrá ofreciendo (sin ejecutarlo) validar el resultado con `/ui-judge` cuando exista
un mockup o implementación.
