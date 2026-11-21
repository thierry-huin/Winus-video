# Winus Video — Design System

Sistema de diseño compartido por las dos apps web del producto:

- **QC Editorial** (`qc.html` + `qc.js`) — control de calidad editorial para broadcast deportivo.
- **Coms** (`index.html` + `viewer.js`) — visor/admin/publisher de las señales en vivo.

Generado y validado con la skill `ui-ux-pro-max` (`.agents/skills/ui-ux-pro-max`), pero **no es una copia literal de su output** — ver "Por qué se desvía del generador" más abajo. Metodología de aplicación: skill `frontend-design` (`.agents/skills/frontend-design`).

## A quién sirve y qué debe transmitir

Técnicos de control de calidad y operadores de señal en una sala de control de broadcast deportivo, mirando esta interfaz durante turnos de varias horas, con múltiples feeds de video y mucha información simultánea en pantalla (incidencias, niveles de audio, estado de sesiones, PGM/Talkback). La interfaz debe transmitir **precisión, calma y confianza**: nunca ansiedad visual, nunca ambigüedad sobre qué está pasando ahora mismo.

## Por qué se desvía del generador automático

`ui-ux-pro-max --design-system "broadcast monitoring control room dashboard" --density 8 --variance 3 --motion 2` devolvió una base sólida (paleta dark-tech + verde de estado, estilo "Minimalism & Swiss Style", densidad de espaciado correcta) pero con dos problemas verificados antes de persistir, tal como indica la propia skill ("Verify... before applying it"):

1. El **patrón de página** que devolvió fue "Real-Time / Operations Landing" (lenguaje de landing page de marketing: hero, CTA, "Start trial") — no aplica a una herramienta interna que los técnicos ya usan a diario. Se reemplazó por los principios de **Status Page / Incident Management** (encontrado en una búsqueda separada de `--domain product`), mucho más afín: monitoreo denso en tiempo real, indicadores de severidad, nunca ocultar estados de error.
2. La **tipografía** sugerida (Fira Code/Fira Sans) requiere un `@import` de Google Fonts — una dependencia de red innecesaria para una herramienta que corre muchas horas en una red de instalación de broadcast, que puede estar restringida o sin salida a internet confiable. Se optó por **system font stacks** (cero latencia, cero dependencia externa, siempre disponibles).

Además, en vez de adoptar la paleta de color generada desde cero, se **evolucionó la paleta que las dos apps ya comparten hoy** (mismo navy `#1a1a2e`/`#16213e`, mismo rojo/verde/ámbar reutilizados consistentemente en ambas — ver inventario de colores hecho antes de tocar nada). Esa paleta ya tenía buenos huesos; lo que faltaba era token-izarla, resolver inconsistencias puntuales (3 variantes de ámbar distintas, cada app con su propio "color primario") y sumar las escalas que no existían (tipografía, radios, sombras, movimiento).

## Tokens

Los valores reales viven en [`shared/design-tokens.css`](shared/design-tokens.css) (custom properties, sin selectores de elementos — enlazarlo nunca cambia layout por sí solo). Este documento explica el *porqué*; ese archivo es la fuente de verdad para los *valores*.

### Mapa de color semántico

Seis roles, cada uno con un solo significado — nunca se reutiliza un color para dos cosas distintas:

- **`--color-brand`** (púrpura `#7b2ff7`) — identidad del producto, acciones primarias no relacionadas con severidad. Antes QC usaba ámbar como "color primario" y Coms usaba púrpura; se unifica en púrpura (ya era la marca más establecida) para que ambas apps se sientan una sola familia.
- **`--color-select`** (azul `#2979ff`) — "este control está presionado/activo ahora". Es una convención explícita ya existente en el producto (botón presionado = azul) — se preserva intacta, nunca se reutiliza para otra cosa.
- **`--color-info`** (cian `#00c9db`) — foco de teclado, links, acentos informativos. Ya existía en ambas apps de forma dispersa; se formaliza.
- **`--color-success`** (verde `#00e676`) — on-air, activo, saludable, resuelto.
- **`--color-warning`** (ámbar `#f59e0b`) — P2, advertencias, atención pronto. Consolida las 3 variantes de ámbar que circulaban sueltas (`#f59e0b`/`#ffab40`/`#ff9800`) en una sola.
- **`--color-danger`** (rojo `#ff5252`) — P1, error, destructivo, tally PGM.

### Tipografía

`--font-sans` (system stack) para todo texto humano (labels, botones, descripciones). `--font-mono` (system monospace) reservado **solo** para datos medidos: timecodes, IDs, contadores, logs — nunca para títulos ni cuerpo de texto. Esto separa visualmente "esto lo escribió una persona" de "esto es un valor medido por la máquina", relevante en una herramienta técnica.

### Densidad vs. legibilidad

El tamaño base de texto (`--text-base: 13px`) queda deliberadamente por debajo del "16px mínimo" genérico: esto es una consola de monitoreo multi-feed densa, no una página de lectura — forzar 16px rompería cualquier grilla/tabla y sacaría información real de la pantalla. La legibilidad se protege con contraste alto (mínimo 4.5:1, verificar con `web-design-guidelines`), `line-height` generoso (`--leading-normal: 1.5`) en texto largo, y jerarquía de peso tipográfico — no con tamaño de fuente bruto. Texto largo real (descripción de incidencias, informes) sube explícitamente a `--text-md`/`--leading-normal`, nunca se sube el base global.

### Movimiento

Dial de movimiento 2/10 (sutil) a propósito: esto se mira fijo durante un turno completo, el movimiento debe confirmar un cambio de estado, nunca decorar. Duraciones cortas (120–280ms), nada de scroll-reveals ni animaciones de "aterrizaje" tipo landing page. `prefers-reduced-motion` se respeta de forma global (ver el bloque `@media` en `design-tokens.css`) además de en cada animación puntual (ej. el pulso de alerta P1 en QC ya lo hacía; ahora es la norma del proyecto, no la excepción).

## Patrón de layout (de "Status Page / Incident Management")

- Nunca ocultar un estado de error/alerta activo detrás de una interacción adicional — debe ser visible de un vistazo.
- Indicadores de severidad siempre con color + texto/ícono (nunca solo color, por accesibilidad para daltonismo).
- Grillas de monitoreo densas pero escaneables: usar `--space-sm`/`--space-md` entre celdas, `--color-surface` para despegar cada panel del fondo, bordes sutiles (`--color-border`) en vez de sombras pesadas para separar paneles (una sombra fuerte por cada tarjeta, repetida 20 veces en una grilla, es ruido visual, no jerarquía).
- Un solo acento "memorable" por pantalla (principio de `frontend-design`: "spend your boldness in one place") — el resto, disciplinado. En QC eso es la barra de alerta P1; en Coms, el tally border del feed en vivo.

## Anti-patrones (no usar)

- Tarjetas-SaaS idénticas con el mismo `border-radius` y la misma sombra gris sin importar la jerarquía del contenido.
- Emojis como íconos (usar SVG).
- Cualquier elemento clickeable sin `cursor: pointer`.
- Textos en mayúscula sostenida como única jerarquía (`text-transform: uppercase` en vez de peso/tamaño).
- Animación de scroll-reveal o "fade-and-slide-up" en cada sección — es el default genérico de una landing page, no aplica acá.
- Ocultar un estado de error o un feed caído detrás de una interacción extra.
- Reutilizar un color semántico (rojo/verde/ámbar/azul) para algo que no sea su significado asignado.

## Regla dura para quien implemente (ambos agentes de rediseño)

Antes de tocar HTML: generar el "contrato JS" de la app (grep de `getElementById`, `querySelector(All)`, `classList`, `closest`, `nextElementSibling`, `dataset`) y verificar al final que ningún ID/clase/relación padre-hijo que el JS lee cambió. Se pueden agregar wrappers/clases nuevas libremente; nunca renombrar o quitar algo que el JS ya usa. El diseño es 100% CSS + estructura visual — cero cambios de lógica, datos o protocolo.

## Checklist antes de dar por terminada una pantalla

- [ ] Contraste de texto ≥ 4.5:1 sobre su fondo real (verificar, no asumir).
- [ ] Foco de teclado visible (`--color-info` como anillo de foco) en todo control interactivo.
- [ ] `prefers-reduced-motion` respetado.
- [ ] Ningún color hardcodeado nuevo — todo sale de `shared/design-tokens.css`.
- [ ] Ningún ID/selector que el JS usa fue renombrado (contrato JS verificado).
- [ ] Responsive sin scroll horizontal ni recorte de contenido a 390px y 1440px (ver Fase E).
- [ ] Un solo acento memorable por pantalla; el resto, disciplinado.
