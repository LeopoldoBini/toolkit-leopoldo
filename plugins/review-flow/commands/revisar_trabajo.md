---
description: "Revisión crítica rápida de lo que venimos trabajando"
argument-hint: "\"lo que acabamos de hacer\" | \"sistema actual\" | \"esta feature\""
allowed-tools: "Read, Grep, Bash"
---

# Revisión Crítica Contextual

## Interpretación Inteligente del Contexto
Analizar la conversación reciente y identificar:
- Qué se esta implementando o modificando en la sesion de trabajo
- Cuáles son los archivos y componentes relevantes  
- Qué scope específico revisar basado en: "$ARGUMENTS"

## Construcción del Brief para Subagente
1. **Extraer contexto de la conversación**: Qué se implementó, qué archivos se mencionaron, qué archivos se escribieron/modificaron, qué problemas se resolvieron
2. **Identificar scope específico**: Interpretar semánticamente el argumento del usuario
3. **Preparar brief completo**: Pasar al subagente `revisor_de_trabajo` contexto procesado (objetivo, implementaciones) + archivos específicos + instrucciones para ubicar la implementacion.

## Delegación Eficiente
Llamar a revisor_de_trabajo con:
- **Contexto procesado** de lo que se hizo recientemente
- **Archivos específicos** identificados del scope
- **Enfoque particular** basado en la implementacion / trabajo que mensiono el usuario, orientado a dar todos lo que necesitara el `revisor_de_trabajo` para poder auditar efectivamente la implementacion.

NO hacer análisis completo aquí - solo interpretar contexto y delegar inteligentemente.
