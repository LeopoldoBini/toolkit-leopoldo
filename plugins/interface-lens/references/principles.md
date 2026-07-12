# Catálogo de principios — base de conocimiento de interface-lens

28 principios en 6 familias funcionales. Organizados por su **rol en el sistema de
atención**, no alfabéticamente: la familia dice *para qué sirve* el principio.

Este catálogo es el lenguaje compartido de las tres skills (`/ui-judge`, `/ux-design`,
`/dark-pattern-scan`). El modelo mental que las conecta (bucle + eje ético) está en
`CONTEXT.md` del plugin.

## Cómo leer cada entrada

- **Peso** (1–5): cuánto mueve la conducta. 5 = fundacional, 1 = detalle fino.
- **Fn** (funciones): `J` juzgar/auditar · `D` diseñar/proponer · `B` construir/implementar.
- **Ética**: 🟢 alinea con el usuario · 🟡 persuasivo, vigilar · 🔴 se corrompe en dark pattern.

---

## A · Disparadores — arrancan el bucle (`trigger`)

| Principio | Peso | Fn | Ética | Definición |
|---|:--:|:--:|:--:|---|
| **Fogg Behavior Model · B=MAP** | 5 | J D | 🟡 | La conducta ocurre cuando Motivación, Habilidad y un Prompt coinciden a la vez. Marco raíz. |
| **Disparador externo → interno** | 4 | J D | 🟡 | Notificaciones e íconos ceden lugar a señales internas (aburrimiento, ansiedad) que ya no necesitan prompt. |
| **Push notifications · hot triggers** | 4 | J B | 🔴 | El motivo nº1 de retorno. Poderoso y el primero que se corrompe (interrupción manipulativa). |
| **Efecto Zeigarnik · bucles abiertos** | 3 | D B | 🟡 | Las tareas incompletas se recuerdan mejor. Barras de progreso, borradores, "1 paso restante". |
| **Efecto Von Restorff · aislamiento** | 3 | J D | 🟢 | Lo distinto entre iguales se recuerda. Base de jerarquía visual y del CTA único. |

## B · Acción y fricción — allanan la conducta buscada (`ability`)

| Principio | Peso | Fn | Ética | Definición |
|---|:--:|:--:|:--:|---|
| **Ley de Fitts** | 4 | J B | 🟢 | Tiempo de alcanzar un target = f(distancia, tamaño). Objetivos grandes y cercanos; thumb zone. |
| **Ley de Hick · sobrecarga de opciones** | 4 | J D | 🟢 | El tiempo de decisión crece con el número de opciones. Menos, mejor jerarquizadas. |
| **Carga cognitiva · Miller · Chunking** | 4 | J D | 🟢 | La memoria de trabajo sostiene ~7±2 ítems. Agrupar en trozos con sentido baja el esfuerzo. |
| **Umbral de Doherty · <400ms** | 3 | J B | 🟢 | La productividad se dispara si el sistema responde por debajo de 400ms. Latencia = fricción invisible. |
| **Ley de Jakob · convención** | 4 | J D | 🟢 | El usuario pasa la mayor parte del tiempo en OTROS sitios; espera que el tuyo funcione igual. |
| **Ley de Tesler · complejidad irreducible** | 3 | D B | 🟡 | Todo sistema tiene complejidad que no desaparece: ¿la absorbe el usuario o el producto? |
| **Thumb zone · navegación sin fricción** | 3 | J B | 🟡 | 90% diestros: controles clave abajo-derecha. Swipe que avanza sin decidir (arma de doble filo). |
| **Fricción estratégica · sludge inverso** | 3 | D J | 🟢 | Añadir fricción curada donde importa (confirmar, revisar) sube satisfacción y valor percibido. |

## C · Recompensa — el motor de dopamina (`reward`)

| Principio | Peso | Fn | Ética | Definición |
|---|:--:|:--:|:--:|---|
| **Recompensas variables** | 5 | J D | 🔴 | Lo impredecible engancha más que lo predecible: dopamina en la anticipación. |
| **Validación social · likes** | 4 | J | 🔴 | Cada like = pico de dopamina y aceptación. Refuerzo potente que puede volverse tóxico. |
| **Autoplay · scroll infinito** | 4 | J | 🔴 | Quita puntos naturales de parada. Máxima retención, mínima agencia del usuario. |
| **Regla Pico-Final** | 4 | D J | 🟢 | Se juzga una experiencia por su pico emocional y su final. Diseñá cierres memorables, no solo entradas. |
| **Conexión emocional · tono** | 3 | D | 🟢 | Las apps que hacen *sentir* algo, no solo *hacer* algo, son más pegajosas — y más queribles. |

## D · Inversión y retorno — por qué vuelven (`investment`)

| Principio | Peso | Fn | Ética | Definición |
|---|:--:|:--:|:--:|---|
| **Inversión · almacenar valor** | 4 | D J | 🟡 | Tiempo, datos, seguidores, configuración: cada aporte mejora el próximo ciclo y ata al usuario. |
| **Aversión a la pérdida · rachas** | 5 | J D | 🔴 | Perder duele ~2× lo que agrada ganar. Rachas de Duolingo, "no rompas tu progreso". |
| **Efecto Goal-Gradient** | 3 | D B | 🟡 | La motivación crece al acercarse a la meta. Barras casi llenas, "te faltan 2 sellos". |
| **Refuerzo de identidad** | 3 | D | 🟡 | El producto se vuelve parte de quién sos ("soy runner", "soy políglota"). Adhesión profunda. |
| **FOMO · prueba social · escasez** | 4 | J | 🔴 | Tendencias, "otros lo están viendo", tiempo limitado. Cialdini aplicado — y muy corruptible. |

## E · Cognición y legibilidad — el eje "superior" (`clarity`)

| Principio | Peso | Fn | Ética | Definición |
|---|:--:|:--:|:--:|---|
| **Efecto Estética-Usabilidad** | 4 | J D | 🟢 | Lo bello se percibe como más usable y perdona errores menores. La estética es funcional. |
| **Gestalt · Proximidad + Región común** | 4 | J B | 🟢 | Lo cercano o con borde compartido se lee como grupo. Base del layout y el espaciado. |
| **Ley de Prägnanz · simplicidad** | 3 | J D | 🟢 | El ojo interpreta lo complejo en su forma más simple posible. Reducir es respetar al usuario. |
| **Posición serial · primacía y recencia** | 3 | D | 🟢 | Se recuerda mejor lo primero y lo último de una serie. Ubicá lo crítico en los extremos. |
| **Atención selectiva · ceguera al banner** | 3 | J | 🟢 | Filtramos estímulos; ignoramos lo que "parece" anuncio. No disfraces lo importante de ruido. |
| **Modelo mental · Flow** | 4 | J D | 🟢 | Coincidir con el modelo que el usuario ya trae permite inmersión sin fricción cognitiva. |

## F · Filtro ético — la capa de juicio (`ethics`)

| Principio | Peso | Fn | Ética | Definición |
|---|:--:|:--:|:--:|---|
| **Taxonomía de dark patterns** | 5 | J | 🔴 | Sludge, roach motel, confirmshaming, precios ocultos, bait-and-switch. Detalle operativo en `dark-patterns.md`. |
| **Prueba del arrepentimiento** | 5 | J D | 🟢 | ¿El usuario agradecería este empujón si supiera cómo funciona? Si no, es manipulación (Eyal). |
| **Nudge vs. Sludge** | 3 | J D | 🟢 | Nudge facilita la decisión que le conviene al usuario; sludge estorba la salida. Misma técnica, intención opuesta. |
| **Time-well-spent · diseño humano** | 4 | J D | 🟢 | Norte alternativo al "tiempo en app": ¿el usuario logró su objetivo y se fue mejor? Métrica superior. |

---

## Regla de oro del catálogo

Casi todos los principios de peso alto (recompensas variables, aversión a la pérdida,
push) viven del lado corruptible del eje ético. **La técnica es neutral; el juicio lo
aporta la prueba del arrepentimiento.** Ese filtro es lo que ninguna "lista de leyes
UX" incluye — y es la ventaja de este plugin.

## Fuentes

- [Laws of UX](https://lawsofux.com/) — Jon Yablonski
- [The Hooked Model](https://www.nirandfar.com/how-to-manufacture-desire/) — Nir Eyal
- BJ Fogg — Behavior Model (B=MAP), Stanford Behavior Design Lab
- Robert Cialdini — *Influence*, principios de persuasión
