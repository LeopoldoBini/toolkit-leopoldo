# CONTEXT.md — lenguaje compartido de interface-lens

Glosario canónico del dominio. Las tres skills razonan con este modelo mental; los
términos de acá son los únicos nombres válidos para estos conceptos.

## El bucle (estructura temporal)

Los 28 principios del catálogo **no son una lista: son un bucle** que se recarga solo.
Ordena *cuándo* actúa cada principio.

```
        ┌──────────────────── ↺ recarga ────────────────────┐
        │                                                    │
   DISPARADOR ──→ ACCIÓN ──→ RECOMPENSA ──→ INVERSIÓN ───────┘
   (A)           (B·E)       (C)            (D)
   Fogg          Fitts       recompensa     rachas
   Zeigarnik     Hick        variable       goal-gradient
   push          Doherty     dopamina       identidad

   Familia E (claridad/legibilidad) sostiene TODO el bucle.
   Familia F (ética) decide su DIRECCIÓN.
```

## El eje ético (dirección)

Ordena *hacia dónde* apunta cada mecánica. El mismo motor puede **servir** al usuario
o **capturarlo**.

```
   ético ────────────── persuasivo ────────────── oscuro
   (alinea con           (empuja al                (captura contra
    el usuario)           producto)                 la voluntad)
      🟢                     🟡                        🔴
```

## Términos canónicos

| Término | Definición | No confundir con |
|---|---|---|
| **Bucle** | disparador→acción→recompensa→inversión (Fogg/Eyal). La unidad de análisis de un flujo. | "funnel" (embudo de conversión, mide al negocio; el bucle mide al hábito) |
| **Familia A–F** | Las 6 familias del catálogo: A disparadores, B acción/fricción, C recompensa, D inversión, E claridad, F ética. | — |
| **Eje ético** | ético → persuasivo → oscuro. Atributo de cada *uso* de un principio, no del principio en sí. | "bueno/malo": la técnica es neutral, el uso no |
| **Prueba del arrepentimiento** | ¿El usuario agradecería este empujón si supiera exactamente cómo funciona? (Eyal). El filtro que decide los casos 🟡/🔴. | consentimiento formal (aceptar TOS no aprueba la prueba) |
| **Nudge** | Facilita la decisión que le conviene al usuario. | **Sludge**: fricción que estorba la salida o la decisión pro-usuario |
| **Fricción estratégica** | Fricción añadida a propósito donde protege al usuario (confirmar antes de borrar, revisar antes de pagar). | sludge (la dirección lo distingue: ¿a quién protege la fricción?) |
| **Time-well-spent** | Norte de diseño: tarea cumplida bien + usuario se va mejor. | "engagement"/"tiempo en app" como métrica de éxito |
| **Asimetría de fricción** | Pasos para entrar vs. pasos para salir de un compromiso. Test maestro de `dark-patterns.md`. | — |
| **Dark pattern** | Mecánica que falla la prueba del arrepentimiento Y está en la taxonomía de `dark-patterns.md`. | mal diseño sin intención (eso es un hallazgo de usabilidad, no un dark pattern) |

## Escalas compartidas (usadas por las 3 skills)

- **Severidad de hallazgo:** `bloqueante` (dark pattern confirmado o tarea imposible) · `alta` (fricción/confusión que hace fallar la tarea a una parte de los usuarios) · `media` (fricción notable, tarea completable) · `baja` (pulido).
- **Confianza:** `alta` (evidencia directa en el input) · `media` (inferencia razonable) · `baja` (hipótesis, requiere verificar con el input completo o con usuarios).
- **Veredicto ético por mecánica:** 🟢 pasa la prueba del arrepentimiento · 🟡 pasa con condiciones (declararlas) · 🔴 falla.
