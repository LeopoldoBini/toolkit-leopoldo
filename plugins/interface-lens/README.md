# interface-lens

Juzgar, diseñar y construir interfaces con psicología UX **más la brújula que las
listas de heurísticas no traen**: un eje ético (ético → persuasivo → oscuro) y la
prueba del arrepentimiento de Nir Eyal.

## La idea en una línea

La psicología del enganche (bucle disparador→acción→recompensa→inversión, dopamina,
recompensas variables) es un **motor** que sirve para dos fines opuestos: capturar al
usuario o servirlo. Este plugin encapsula el motor como conocimiento de referencia y
pone el juicio de dirección en el centro de las tres skills.

## Skills (tres verbos, invocación explícita)

| Skill | Verbo | Qué hace |
|---|---|---|
| `/ui-judge` | **Juzgar** | Audita screenshot/URL/código contra 28 principios en 6 familias (A–F). Hallazgos con evidencia concreta, score por familia, banderas de dark patterns, fixes priorizados. |
| `/ux-design` | **Diseñar** | Propone flujos mapeados al bucle, declarando qué principio usa cada decisión y por qué sirve al usuario. Guardas éticas y trade-offs obligatorios. |
| `/dark-pattern-scan` | **Construir** | Escaneo adversarial pre-ship: rastrea flujos (suscripción, checkout, consentimiento), mide asimetría de fricción entrada/salida, reporte pasa/falla con evidencia por línea. |

## Estructura

```
interface-lens/
  CONTEXT.md                 ← lenguaje compartido: bucle, eje ético, escalas
  references/
    principles.md            ← catálogo de 28 principios (familias A–F)
    dark-patterns.md         ← taxonomía operativa con señales de código por patrón
  skills/
    ui-judge/  ux-design/  dark-pattern-scan/
```

## Principios de diseño del plugin

- **Evidencia o nada:** ningún hallazgo sin elemento concreto, cita o `archivo:línea`. El prompting genérico contra heurísticas ronda 50–75% de precisión; el anclaje a evidencia es lo que lo sube.
- **Flujos, no pantallas:** los dark patterns más graves (roach motel, forced continuity) solo emergen en la interacción — por eso el scan rastrea rutas de entrada/salida en el código.
- **Honestidad sobre límites:** cada auditoría declara qué NO pudo evaluarse desde el input recibido.
- **Norte time-well-spent:** tarea cumplida bien, no tiempo en app.

## Vecinos

Complementa (no solapa) a `ui-ux-pro-max` (design intelligence visual: estilos,
paletas, layout): ese cubre *cómo se ve*; interface-lens cubre *cómo se comporta y
su ética*.

## Origen

Destilado del video *"The UX Psychology Behind Apps People Can't Stop Using"*
(`2TlIg3VokY8`), cruzado con BJ Fogg (B=MAP), Nir Eyal (*Hooked*),
[Laws of UX](https://lawsofux.com/) (Jon Yablonski) y Cialdini, más la capa ética
(taxonomía de dark patterns, prueba del arrepentimiento, time-well-spent).
