---
description: "Barrido batch de la memoria del proyecto: detecta memorias stale, obsoletas, duplicadas y graduables a CLAUDE.md/CONTEXT.md. Solo reporta — aplica únicamente con OK explícito del usuario."
argument-hint: "(sin args = barrido completo) | \"solo Proyecto\" | \"solo Feedback\""
allowed-tools: "Read, Grep, Glob, Bash"
---

# Barrido de Memoria (batch)

Complemento del comportamiento orgánico (graduar/corregir memorias al tocarlas durante el trabajo): este comando cubre las memorias que **nunca se vuelven a tocar** y se pudren en silencio. Correr periódicamente o tras cerrar una épica.

## Formato de memoria vigente (NO reintroducir el viejo)

La memoria del proyecto vive en `~/.claude/projects/<slug-del-path>/memory/`: **un archivo por hecho** con frontmatter (`name`, `description`, `metadata.type: user|feedback|project|reference`) + `MEMORY.md` como **índice de punteros de 1 línea** (nunca contenido). Enlaces entre memorias con `[[name]]`. NO existe más el MEMORY.md monolítico de entradas con fecha ni el límite de 200 líneas — no proponer volver a eso.

## Barrido — clasificar CADA memoria (o las de la categoría pedida en $ARGUMENTS)

Leer `MEMORY.md` y cada archivo apuntado. Verificar los claims contra la realidad (código actual, `git log`, `gh issue view` para estados de issues/PRs, existencia de paths/comandos citados). Clasificar:

1. **VIGENTE** — correcta y todavía útil. No tocar.
2. **STALE** — cita archivos/comandos/estados que ya no existen o cambiaron. Proponer la corrección concreta (o borrado si ya no aplica).
3. **GRADUABLE** — confirmada en varias sesiones y describe cómo **ES** el sistema (no qué pasó). Proponer destino exacto: sección de CLAUDE.md (repo o global) o CONTEXT.md si es vocabulario, y qué queda en la memoria (borrarla o reducirla a puntero).
4. **OBSOLETA** — cerrada/histórica sin valor futuro (proyectos ✅ con todos los pendientes saldados, incidentes resueltos sin lección vigente). Proponer borrado, o compresión a 1 línea si tiene valor de registro.
5. **FUSIONABLE** — solapa con otra memoria. Proponer el merge (cuál absorbe a cuál).

También detectar: punteros del índice sin archivo (o archivos sin puntero), `[[links]]` rotos, y pendientes "PENDIENTE LEO/Vale" que por fecha probablemente ya se resolvieron (marcarlos para confirmar, no asumir).

## Salida — reporte, NUNCA aplicar de inmediato

Presentar una tabla: memoria | clasificación | evidencia (1 línea) | acción propuesta. Cerrar con el resumen de impacto (cuántas se borran/graduan/corrigen).

**Regla dura:** este comando NO modifica nada por sí solo. El usuario revisa el reporte y decide; recién con su OK explícito se aplican las acciones (editar/borrar archivos de memoria, actualizar el índice, graduar contenido a CLAUDE.md/CONTEXT.md con commit si es archivo de repo).
