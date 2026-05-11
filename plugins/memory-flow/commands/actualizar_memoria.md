---
description: "Implementa actualizaciones de memoria CLAUDE.md + MEMORY.md con ejecución de graduaciones"
argument-hint: "\"implementar recomendaciones auditoría\" | \"aplicar plan JWT\" | \"actualizar según análisis\""
---

# Implementación de Actualización de Memoria

## Análisis de Recomendaciones de Auditoría
Procesar las recomendaciones de auditoría proporcionadas por el usuario e identificar:
- Qué archivos CLAUDE.md específicos deben actualizarse
- Qué contenido debe agregarse/modificarse en cada nivel jerárquico
- Cuáles son las prioridades de implementación según: "$ARGUMENTS"

## **PRINCIPIO CRÍTICO: ESTADO ACTUAL ÚNICAMENTE + MÁXIMA SÍNTESIS + PRESERVACIÓN CONSERVADORA**
**La memoria CLAUDE.md debe ser EXTREMADAMENTE SINTÉTICA y reflejar SOLO el estado presente:**
- **NO incluir**: Comparaciones "antes vs después"
- **NO incluir**: Beneficios, ventajas, o justificaciones de decisiones
- **NO incluir**: Tracking de progreso, histórico de cambios, o roadmaps
- **NO incluir**: Referencias a versiones anteriores o futuras
- **NO incluir**: Explicaciones largas, ejemplos extensos, o contexto innecesario
- **SOLO incluir**: Información mínima esencial sobre cómo funciona actualmente la codebase

**Criterio de síntesis**: Si se puede decir en menos palabras, hacerlo. Cada línea debe aportar valor directo para interpretar el código.

**PRESERVACIÓN CONSERVADORA**: NO eliminar contenido existente a menos que se tenga certeza absoluta de que está obsoleto o incorrectamente ubicado. Ante la duda, conservar la información existente y solo agregar/modificar lo específicamente auditado.

## PARA MEMORY.md: REGISTRO CONTEXTUALIZADO
Reglas invertidas a CLAUDE.md — MEMORY.md es memoria de sesión:
- **SÍ incluir**: Fechas, lessons learned, debugging insights, datos operacionales, contexto de descubrimiento
- **NO incluir**: Arquitectura estable, convenciones de código, comandos build/test (eso va en CLAUDE.md)
- **Formato**: Entradas con `- **Tema** (YYYY-MM-DD): Descripción`, agrupadas por categoría
- **Límite**: 200 líneas máximo. Si crece, crear topic files vinculados en `memory/`
- **Graduación**: Las entradas estables/arquitectónicas se sintetizan hacia CLAUDE.md y se eliminan de MEMORY.md

## Compartimentación Jerárquica
Aplicar estrictamente los siguientes niveles:
- **Nivel Raíz**: Contenido sintético de existencia únicamente (1-2 líneas máximo)
- **Nivel Módulo**: Relaciones, dependencias, reglas de uso/cuándo aplicar
- **Nivel Específico**: Detalles técnicos, implementación, ejemplos prácticos
- **Progresión**: Mención → Contexto → Detalles

## Proceso de Implementación

### 1. Inventario de Estado Actual
- Leer archivos CLAUDE.md existentes relacionados con las recomendaciones
- Leer MEMORY.md del proyecto (`~/.claude/projects/<path>/memory/MEMORY.md`)
- Mapear contenido actual por nivel jerárquico
- Identificar qué debe agregarse/modificarse según la auditoría

### 2. Ejecución de Graduaciones
Para cada entrada marcada como `GRADUATE` o `SPLIT` en la auditoría:
- Sintetizar el contenido: eliminar fechas, contexto de sesión, convertir a formato CLAUDE.md (estado actual, sin historia)
- Insertar contenido sintetizado en la sección apropiada del CLAUDE.md target
- Eliminar la entrada graduada de MEMORY.md (o solo la parte graduada en caso de SPLIT)
- Para entradas `ARCHIVE`: eliminar de MEMORY.md directamente
- Verificar que la graduación no genera duplicación con contenido CLAUDE.md existente

### 3. Aplicación de Actualizaciones CLAUDE.md
- Implementar modificaciones específicas por archivo CLAUDE.md
- Respetar compartimentación jerárquica en cada actualización
- Mantener máxima síntesis en todo el contenido
- Preservar información existente no relacionada con la auditoría

### 4. Aplicación de Actualizaciones MEMORY.md
- Agregar nuevas entradas con fecha y categoría según la auditoría
- Consolidar entradas relacionadas si se han acumulado
- Verificar que el total no exceda 200 líneas; si excede, mover contenido a topic files vinculados
- NO agregar a MEMORY.md contenido que pertenece a CLAUDE.md (arquitectura estable, convenciones)

### 5. Validación de Coherencia
- Verificar consistencia entre niveles jerárquicos de CLAUDE.md
- Asegurar progresión lógica de información
- Confirmar que no hay duplicación entre CLAUDE.md y MEMORY.md
- Verificar que las graduaciones se ejecutaron completamente (nada quedó en ambos sistemas)

**Propósito único**: Ayudar a interpretar y entender la arquitectura y funcionamiento actual del código de la forma más concisa posible.

**EJECUTAR**: Implementar directamente las modificaciones de memoria CLAUDE.md siguiendo estrictamente la compartimentación jerárquica, el principio de estado actual únicamente, máxima síntesis, y preservación conservadora basándose en las recomendaciones de auditoría proporcionadas.