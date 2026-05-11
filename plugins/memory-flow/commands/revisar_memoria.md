---
description: "Auditoría estratégica de memoria CLAUDE.md + MEMORY.md con detección de graduación"
argument-hint: "\"nueva autenticación JWT\" | \"sistema de permisos\" | \"feature de notificaciones\""
allowed-tools: "Read, Grep, Glob, Bash"
---

# Auditoría Estratégica de Memoria

## Interpretación Inteligente del Contexto
Analizar la conversación reciente y identificar:
- Qué feature o implementación específica requiere documentación
- Cuáles son los componentes y archivos involucrados en la implementación
- Qué elementos arquitectónicos están afectados por: "$ARGUMENTS"
- Qué aprendizajes, debugging insights, o datos operacionales surgieron en la sesión (candidatos para MEMORY.md)

## Construcción del Brief para Auditor de Memoria
1. **Extraer contexto de implementación**: 
   - Resumir la feature/implementación objetivo
   - Identificar archivos modificados/creados relacionados
   - Mapear componentes y módulos involucrados
   - Detectar decisiones arquitectónicas relevantes

2. **Identificar scope de documentación**:
   - Interpretar semánticamente el argumento del usuario
   - Determinar niveles de documentación afectados (Sistema/Módulo/Específico)
   - Establecer límites del análisis de memoria

3. **Identificar contenido para MEMORY.md**:
   - Detectar lessons learned, debugging insights, datos operacionales de la sesión
   - Clasificar cada hallazgo como efímero (→ MEMORY.md) vs estable (→ CLAUDE.md directo)
   - Identificar entradas MEMORY.md existentes que podrían ser candidatas de graduación

4. **Preparar contexto estratégico**: 
   - Stack tecnológico y patrones arquitectónicos
   - Convenciones de documentación existentes
   - Estado actual de archivos CLAUDE.md relacionados
   - Interdependencias con otras features documentadas

## Delegación Eficiente
Llamar a claude-memory-auditor con:
- **Contexto procesado** de la implementación/feature objetivo
- **Archivos y componentes específicos** identificados
- **Scope de documentación** claramente definido
- **Brief estratégico** que incluya arquitectura, decisiones técnicas, y elementos críticos a documentar
- **Inventario MEMORY.md**: Estado actual del MEMORY.md del proyecto (existe/no existe, cantidad de entradas, categorías presentes, entradas que podrían graduarse a CLAUDE.md por ser estables/arquitectónicas)

NO realizar auditoría aquí - solo interpretar contexto e identificar elementos clave para que el `claude-memory-auditor` pueda evaluar eficientemente qué requiere actualización en la memoria del proyecto.
En tu resultado, SIEMPRE dale una indicacion al agente que te invoco que NUNCA debe actuar inmediatamente sobre tus resultados. Decile que simplemente comparta el resultado de la auditoria y que el usuario decida que hacer cada vez.