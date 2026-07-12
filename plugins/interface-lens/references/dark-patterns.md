# Dark patterns — guía operativa de detección

Detalle operativo de la fila "Taxonomía de dark patterns" del catálogo
(`principles.md`, familia F). Cada patrón lista **señales estáticas** (visibles en un
screenshot o copy) y **señales de flujo/código** (solo detectables recorriendo la
interacción o leyendo la implementación). La investigación es clara: analizar una
pantalla suelta pierde los patrones que emergen en la interacción — por eso
`/dark-pattern-scan` rastrea flujos, no pantallas.

## El test maestro: asimetría de fricción

Medí los pasos/clics/campos para **entrar** en un compromiso (suscribirse, aceptar,
comprar) versus los pasos para **salir** de él (cancelar, rechazar, darse de baja).

> **Entrada en 1 clic + salida en N pasos = bandera roja estructural.**
> La asimetría es medible y objetiva; no depende de interpretar intenciones.

## Catálogo de patrones

### Sludge
Fricción deliberada para estorbar una acción que conviene al usuario.
- **Señales estáticas:** el botón de la acción pro-usuario es gris/pequeño/escondido; el pro-negocio es prominente.
- **Señales de flujo/código:** pasos extra, confirmaciones redundantes o esperas solo en rutas de salida; formularios que piden "motivo" obligatorio para cancelar.
- **Test:** asimetría de fricción entrada/salida.

### Roach motel
Fácil entrar, difícil salir.
- **Señales estáticas:** "Suscribite" visible en todas partes; "Cancelar suscripción" ausente del UI.
- **Señales de flujo/código:** la cancelación exige canal distinto al de alta (llamar por teléfono, enviar mail) cuando el alta fue online; ruta de cancelación inexistente en el código.
- **Test:** ¿existe en el código una ruta de salida del mismo canal y costo que la de entrada?

### Confirmshaming
Culpar o avergonzar al usuario por rechazar.
- **Señales estáticas:** el texto del botón de rechazo carga juicio ("No, prefiero pagar de más", "No me importa mi salud").
- **Señales de flujo/código:** strings de opciones negativas con carga emocional; A/B tests sobre copy de rechazo.
- **Test:** ¿el "no" está redactado neutro ("No, gracias") o castiga?

### Precios ocultos / drip pricing
Costos que aparecen recién al final del embudo.
- **Señales estáticas:** precio grande sin impuestos/fees; asteriscos y letra chica.
- **Señales de flujo/código:** cargos (service fee, envío, impuestos) que se suman en el paso de checkout y no existían en la vista de producto/listado.
- **Test:** ¿el total del checkout coincide con el precio que motivó el clic?

### Bait-and-switch
La acción produce un resultado distinto al esperado.
- **Señales estáticas:** CTAs ambiguos cerca de zonas de toque frecuente; X de cierre que acepta en vez de cerrar.
- **Señales de flujo/código:** handlers que hacen más de lo que el label promete (aceptar términos + suscribir a newsletter en un solo botón).
- **Test:** ¿el efecto del handler coincide 1:1 con el texto del control?

### Forced continuity
Prueba gratis que cobra sin aviso claro.
- **Señales estáticas:** "gratis" prominente, fecha y monto del primer cobro ausentes o en letra chica.
- **Señales de flujo/código:** no hay notificación programada antes del primer cargo; el trial pide tarjeta sin necesitarla para la funcionalidad.
- **Test:** ¿el usuario sabe exactamente cuándo y cuánto se le va a cobrar, antes de dar la tarjeta?

### Privacy zuckering
Engañar para compartir más datos de los que el usuario quiere.
- **Señales estáticas:** "Aceptar todo" prominente vs. "Configurar" escondido; lenguaje que confunde ("mejorar tu experiencia").
- **Señales de flujo/código:** defaults de consentimiento en `true`; scopes de permisos mayores a lo que la feature necesita; rechazar cuesta más clics que aceptar.
- **Test:** rechazar todo debe costar los mismos clics que aceptar todo.

### Nagging
Interrupciones repetidas hasta que el usuario cede.
- **Señales estáticas:** el mismo modal/prompt reaparece sin opción "no volver a preguntar".
- **Señales de flujo/código:** re-prompts sin persistir la negativa, o con cooldowns diseñados para reintentarlo; la negativa no se guarda, el sí se guarda para siempre.
- **Test:** ¿el "no" se persiste con el mismo peso que el "sí"?

### Disguised ads
Anuncios que se hacen pasar por contenido o controles.
- **Señales estáticas:** ads con el mismo estilo visual que el contenido, sin etiqueta clara; falsos botones de descarga.
- **Señales de flujo/código:** contenido patrocinado renderizado con el mismo componente que el orgánico sin marcado diferencial.
- **Test:** ¿un usuario apurado distingue anuncio de contenido en <1 segundo?

### Urgencia/escasez falsas *(extensión del índice — FOMO corrupto, familia C/D)*
Contadores y stock inventados para forzar decisión.
- **Señales estáticas:** "quedan 2", "oferta termina en 10:00", "37 personas viendo esto".
- **Señales de flujo/código:** **countdown hardcodeado o que se resetea al recargar; número de stock/viewers generado aleatoriamente en el cliente.** Este es de los pocos patrones 100% comprobables leyendo código.
- **Test:** ¿el dato de urgencia sale de datos reales del backend o está fabricado?

### Preselección dañina *(extensión del índice)*
Defaults que benefician al negocio a costa del usuario.
- **Señales estáticas:** checkboxes pre-tildados de add-ons, seguros, newsletters, donaciones.
- **Señales de flujo/código:** `checked`/`defaultValue` en `true` para opciones con costo o cesión de datos.
- **Test:** ¿cada default beneficia al usuario si no lo toca nunca?

## Exposición regulatoria (contexto, no asesoría legal)

Varios de estos patrones ya no son solo mala praxis: la regla *click-to-cancel* de la
FTC (EE.UU.) exige que cancelar sea tan fácil como suscribirse (roach motel/sludge), y
el Digital Services Act de la UE prohíbe explícitamente los dark patterns en
plataformas. Un hallazgo confirmado puede ser pasivo legal, no solo deuda de UX —
señalarlo así cuando aplique.

## Nota sobre código generado por IA

Auditorías de componentes ecommerce generados por LLMs encontraron patrones engañosos
en más de la mitad de los outputs, sin que nadie los pidiera. Escanear código generado
antes de shippear no es paranoia: los modelos reproducen los dark patterns de sus
datos de entrenamiento.
