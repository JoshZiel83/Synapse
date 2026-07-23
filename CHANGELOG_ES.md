# Registro de cambios

[English](./CHANGELOG.md) · [简体中文](./CHANGELOG_CN.md) · **Español**

Este archivo documenta todos los cambios relevantes del proyecto.

El formato se basa en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el
proyecto procura seguir el [Versionado Semántico](https://semver.org/lang/es/spec/v2.0.0.html).

> [!WARNING]
> Synapse sigue en una fase temprana de diseño e implementación (pre-1.0). Según las reglas
> 0.x de SemVer, cualquier versión puede incluir cambios incompatibles, y no se
> garantiza la compatibilidad con datos antiguos: los cambios incompatibles se resuelven
> reconstruyendo la base de datos (`npm run db:rebuild`) y redesplegando, no mediante
> migraciones (véase [`deploy.md`](./deploy.md)). En `0.x`, un incremento **minor** (`0.Y.0`)
> marca una ruptura en una superficie expuesta al consumidor (rutas REST/WebSocket y DTOs, el
> contrato wire del protocolo de dispositivos, los exports de `@synapse/shared`,
> la autenticación, o una capacidad eliminada), y un **patch** (`0.y.Z`) es retrocompatible.
> Las versiones etiquetadas a continuación hasta `0.27.0` reconstruyen retroactivamente el
> historial de la rama `dev`, período durante el cual los manifiestos de los paquetes se
> mantuvieron en `0.1.0`; `0.28.0` es la primera versión publicada en el registro de
> paquetes, y a partir de ella los manifiestos llevan la versión publicada.

## [Unreleased]

## [0.28.0] - 2026-07-24

Corrección de exactitud de la ronda 3 del trazado distribuido (commits `c068aef3`, `9b5a30c8`, `92645a74`): correlación de trazas acotada al turn para las llamadas a herramientas de reverse-MCP a través de despertares de conversación intercalados (F-r3-2). Cambia el contrato wire del daemon de agentes remotos y requiere un **redespliegue coordinado**: el orden de compilación obligatorio y las comprobaciones posteriores al recreate son el runbook de despliegue en [`docs/logging-refactor/04-operations.md`](./docs/logging-refactor/04-operations.md) §7, con el orden de cutover daemon-first de R3 en §7.4. No cambió ningún esquema de base de datos, así que esta versión no necesita `db:rebuild`.

Es también la primera versión en la que los manifiestos de los paquetes dejan `0.1.0`: el conjunto coordinado — `@synapse/device-protocol`, `@synapse/shared`, `@synapse/device-runtime`, `@synapse/device-sdk`, `@synapse/api` y `@synapse/remote-agent-daemon` — sube en bloque a `0.28.0`, y los cuatro paquetes de runtime se publican en el registro de paquetes privado. Los bundles de runtime de plataforma permanecen desacoplados en su propia versión.

### Cambiado

- **Cambio incompatible:** el wire del daemon de agentes remotos gana un `turn_epoch` opcional tanto en `agent:deliver` (api→daemon) como en `agent:status` (daemon→api). Ambos frames se validan como `z.strictObject`, así que un par compilado antes de este cambio rechaza el frame entero en lugar de ignorar el campo nuevo. La publicación en el registro sigue el orden de dependencias — `@synapse/device-protocol` → `shared` → `device-runtime` → `remote-agent-daemon` al final (`deploy.md` §5b) —, pero el despliegue en ejecución se actualiza **primero el daemon**: como el campo estricto cae en `agent:deliver`, actualizar el daemon antes que la api mantiene limpia la ruta de entrega (una api antigua simplemente omite el campo) y solo queda el frame `agent:status` del daemon descartado por una api aún sin actualizar (correlación de turns degradada, nunca una entrega perdida). El orden inverso rechazaría cada `agent:deliver` que lleve el campo y provocaría churn de entregas en su lugar (aun así at-least-once, no se pierde nada). El orden de cutover de R3 está en [`docs/logging-refactor/04-operations.md`](./docs/logging-refactor/04-operations.md) §7.4.
- Los paquetes @synapse publicables forman ahora un conjunto de redespliegue coordinado fijado a una única versión exacta; un nuevo guard `guard:versions` (ejecutado en `verify:boundary`) exige el incremento de versión en bloque, los pines exactos dentro del conjunto, los bundles de plataforma desacoplados y la sincronización del package-lock.

### Corregido

- Los despertares de conversación intercalados ya no cruzan trazas (F-r3-2): una llamada `tools/call` de reverse-MCP tardía de un turn se atribuye a los orígenes de entrega de ese mismo turn, nunca a los de un sucesor recién despertado. El daemon mantiene ahora un epoch por turn autoritativo tras una compuerta de turns (un turn por conversación a la vez; los despertares que compiten se encolan en orden de despacho y se liberan de uno en uno), la api fija las span links de reverse-MCP en el epoch en ejecución confirmado por el daemon, y al completarse un turn se vacía exactamente el conjunto pendiente de ese epoch. Un recolector de conexiones de máquina obsoletas finaliza un socket que el sistema operativo nunca cerró (FIN), y cada driver emite como mucho una señal terminal por turn para que la compuerta no pueda avanzar dos veces.

## [0.27.0] - 2026-07-23

Correcciones de exactitud de la ronda 2 del trazado distribuido (commits `defdece3`, `f6c456b5`, `cd615060`, `79ddc845`), además de un endurecimiento del borde público. Cambian contratos de wire, de cola y de telemetría, y requieren un **redespliegue coordinado**: el procedimiento exacto (orden de compilación obligatorio, `--force-recreate` y una lista de verificación posterior al recreate) es el runbook de despliegue en [`docs/logging-refactor/04-operations.md`](./docs/logging-refactor/04-operations.md) §7. No cambió ningún esquema de base de datos, así que esta versión no necesita `db:rebuild`.

### Cambiado

- **Cambio incompatible:** el estado de cola almacenado del outbox de chat sin conexión se subió de versión como ruptura limpia **tanto en web como en móvil** (snapshot móvil v2→v3; `StoredChatQueueState` compartido v4→v5, incluido el service worker). Los mensajes que una compilación anterior dejó en cola pero sin enviar se descartan al actualizar; los clientes reconstruyen el outbox en la primera carga. Los mensajes ya enviados y los datos del lado del servidor no se ven afectados.
- Wire del daemon de agentes remotos: un nuevo frame `agent:deliveries:completed` (api→daemon) libera el conjunto de entregas pendientes del daemon, y los campos de traza de los frames del daemon pasan ahora por el gate `wireTraceContextFields` (validados por schema; un valor malformado se trata como ausente). Un daemon compilado antes de este cambio ignora en silencio el frame nuevo hasta que se recompile y republique (`deploy.md` §5b): las entregas afectadas quedan pendientes y vuelven a notificar, así que no se pierde nada. Se eliminó `AgentSession.setMcpServers` de la interfaz del driver, y un guard de CI exige ahora la paridad de frames entre api y daemon. (La reestructuración del cuerpo de `fail-deliveries` se publicó en la v0.26.0.)
- `@fastify/otel` 0.20.1 con `instrumentHooks:false`: cada solicitud produce ahora un único span SERVER y desaparecen los spans de hooks de ciclo de vida por solicitud — cualquier panel o alerta que consulte `fastify.type=hook` pierde esos datos. El propagador de salida de primera parte ahora falla cerrado incondicionalmente (no emite a terceros ni un `traceparent` con flags `00` ni un `tracestate` de proveedor heredado), y `OTEL_SERVICE_NAME`/`OTEL_RESOURCE_ATTRIBUTES` ahora sí anulan el nombre de servicio interno (la precedencia anterior estaba invertida).
- Se endureció el manejo del `tracestate` entrante: `MAX_TRACESTATE_LENGTH` se redujo de 1024 a 512 (el valor que `@opentelemetry/core` 2.8.0 realmente impone), con la gramática de claves ampliada al superconjunto del Nivel 2 de W3C; un encabezado de más de 512 caracteres, con más de 32 miembros, claves duplicadas, valores demasiado largos o miembros malformados ahora se descarta por completo, en lugar de recuperarse parcialmente.
- El parcheo de dependencias pasó de `patch-package` a un aplicador de primera parte, `scripts/apply-patches.mjs` (postinstall y los Dockerfiles de api/web/mobile-web); un device runtime instalado vía npm no incluye los binarios auxiliares de Go/Rust y ahora se degrada de forma controlada con una advertencia al arrancar.

### Añadido

- Limitación de tasa en el borde público en las dos plantillas públicas de nginx — `limit_req` en `/api/` y `/ws` más `limit_conn` en `/ws` (`429`, no `503`; una carga de página normal nunca lo dispara), IPv6 con clave por `/64` en el borde TLS (njs). También el marcador Ring-0 infalsificable `x-synapse-trace-ingress`, un `SYNAPSE_TRACE_SAMPLING_SALT` opcional para el muestreador de proporción con clave, límites explícitos de Tempo `overrides.defaults`, y una advertencia al arrancar cuando `SYNAPSE_SERVER_TIMING_TRACE=on` coexiste con un muestreador de proporción. Umbrales y parámetros: [`docs/logging-refactor/04-operations.md`](./docs/logging-refactor/04-operations.md) §6 y §1.
- Correlación de trazas del lado del cliente en web y móvil: los carriers provienen ahora de spans reales del SDK (se eliminaron los ids de span fabricados), con spans de cliente breves alrededor de los frames de auth/subscribe de WebSocket.
- El cua-helper de Go y el fs-helper de Rust emiten spans SERVER por RPC con atributos semconv de JSON-RPC.
- Vida útil de los trace-carriers acotada al turn tanto en la api (`TurnCarrierCache`) como en el daemon (turn-epoch), lo que corrige la atribución de spans del reverse-MCP; un nuevo conmutador triestado `OTEL_TRACES_EXPORTER` (sin definir/`otlp`/`none`) y normalización de `OTEL_TRACES_SAMPLER` sin distinguir mayúsculas de minúsculas; nuevos helpers de tracestate en `@synapse/shared` (`sanitizeTracestateHeader`, `isValidTracestateHeader`, constantes de gramática) — todo ello aditivo.
- Este registro de cambios retroactivo y trilingüe (English, 简体中文, Español), que reconstruye el historial de versiones v0.1.0–v0.26.2 con 50 tags anotados.
- CI: por primera vez hay un gate para los tests en otros lenguajes (`go test` para el sidecar cua, `cargo test` para el fs-helper), y el guard de propagación de trazas incorpora reglas de paridad de frames y de alcance por turn.

### Corregido

- Caché de carriers del fan-in del daemon: al alcanzar el tope de 20 entradas, la deduplicación ahora expulsa el carrier más antiguo en lugar de descartar el más nuevo — antes, el carrier de origen del turn actual podía ser justamente el descartado.

## [0.26.2] - 2026-07-17

### Corregido

- Daemon de remote-agent: los informes de fail-delivery con fan-in ya no heredan la traza de entrega del contexto ambiente; la API genera un span raíz nuevo que enlaza todos los orígenes, lo que corrige la correlación de orígenes mixtos.

## [0.26.1] - 2026-07-17

### Añadido

- Propagación de trazas de extremo a extremo a través del edge y el frontend: en la frontera de confianza, nginx elimina los encabezados de trace-state entrantes de proveedores (`tracestate`, `baggage`, `sentry-trace`) mientras reenvía el `traceparent` W3C (que la API valida al extraer, tratando sus flags como orientativos), y los clientes web y móvil tienden un puente entre los spans del navegador y ese `traceparent`.

## [0.26.0] - 2026-07-17

### Añadido

- Consumidores de trazas: enlaces de fan-in del daemon, portador de dispatch, spans de productor de BullMQ y OpenTelemetry en los sidecars de Python. `resolution_traceparent` se persiste para que una trama de resolución reproducida conserve la traza del resolutor.

### Cambiado

- **Cambio incompatible:** se rediseñó el cuerpo de la petición `POST /api/v1/internal/remote-agents/:remoteAgentId/fail-deliveries`.

## [0.25.5] - 2026-07-17

### Añadido

- Esquemas de portador de trazas en el envelope del protocolo de dispositivos y tracing de WebSocket por mensaje. Los campos de traza son tolerantes: un valor malformado o de tamaño excesivo se trata como ausente en lugar de rechazar el mensaje.

## [0.25.4] - 2026-07-16

### Cambiado

- El muestreo y la exportación pasan a ser responsabilidad de OpenTelemetry; Sentry queda relegado a consumidor. `SENTRY_TRACES_SAMPLE_RATE` se reutiliza como tasa de reenvío hacia Sentry.

## [0.25.3] - 2026-07-15

### Añadido

- Base de tracing compartida: un contrato de portador de trazas propio, un propagador y un parche para `@fastify/otel`.

## [0.25.2] - 2026-07-15

### Eliminado

- Maquinaria de la capacidad `pty`, reservada pero inerte (el miembro del enum de builtin-kind `pty`, su política y la ruta de rechazo de creación de grants). Crear un grant de pty siempre fallaba con HTTP 400 (`pty_not_supported`); nunca fue una capacidad enrutable.

### Corregido

- La imagen Docker de la API vuelve a construirse; se resuelve así una rotura de 14 días causada por un `cp -r` sin comprobación previa sobre una ruta de assets que el refactor de iconos había eliminado.
- Dos escapes de symlink en el sandbox off-box: una escritura arbitraria en el host mediante un symlink en el base-snapshot, y una exfiltración de archivos del host en el lado de lectura a través del comportamiento de `envd` de seguir symlinks en stat.
- Un livelock de convergencia sin pérdida de datos en la ruta de teardown off-box.

## [0.25.1] - 2026-07-13

### Añadido

- Proveedor de sandbox off-box `cubesandbox:bare` (contrato wire compatible con E2B) con confinamiento léxico de rutas: el primer adaptador de runtime remoto.

## [0.25.0] - 2026-07-12

### Añadido

- Supertipo `runtimes`: los dispositivos y los sandboxes se convierten en tablas de detalle sobre un único `runtime_id` polimórfico.
- Generalización del runtime de sandbox: un registro de adaptadores `${provider}:${mode}` con adaptadores bare on-box `local:bare` y `docker:bare` y una nueva opción de operador `SANDBOX_MODE` (`resident`|`bare`|`auto`): el sustrato sobre el que se construye el proveedor off-box en 0.25.1.

### Cambiado

- **Cambio incompatible:** `device_*` renombrado a `runtime_*` en todo el esquema, el contrato wire del protocolo de dispositivos (enums `DEVICE_*` → `RUNTIME_*`, `DeviceHelloParams` → `RuntimeHelloParams`, `pendingDeviceId` → `pendingRuntimeId`) y los campos de `OperationEnvelope`.

### Eliminado

- La tabla `device_sync_sources` y sus exports `DEVICE_SYNC_SOURCE_KINDS`/`DEVICE_SYNC_MODES`/`DEVICE_SYNC_STATUSES` (eliminados por completo, sin reemplazo `runtime_*`). Las otras 14 tablas `device_*` y sus exports `Device*` de `@synapse/device-protocol` se renombraron en lugar de eliminarse (ver Cambiado).

## [0.24.1] - 2026-07-03

### Añadido

- Extracción de documentos seleccionada por entorno (`DOCUMENT_EXTRACTION_PROVIDER`) con un sidecar de Apache Tika (PDF, DOCX, Markdown), habilitado por defecto en el perfil de producción, además de proveedores opt-in en la nube (TextIn xParse, y una ruta asíncrona de LlamaParse con un sweeper de reconciliación). Esto completa el trabajo de abstracción de proveedor: la imagen de la API ya no incluye ningún motor de inferencia.

### Eliminado

- La dependencia incluida `pdf-parse`.

## [0.24.0] - 2026-07-03

### Eliminado

- **Cambio incompatible:** la funcionalidad de cumplimiento `audit_logs` en su totalidad: la ruta `GET /api/v1/workspaces/:workspaceId/audit-logs`, los exports `AuditLog*` y el rol de plataforma `auditor`. (Esto es distinto de `/api/v1/logs` y `/api/v1/reports`, que se mantienen.)

## [0.23.1] - 2026-07-03

### Añadido

- Embeddings seleccionados por entorno (`EMBEDDING_PROVIDER`) con un sidecar bge-m3 autoalojado junto con un adaptador genérico compatible con OpenAI para proveedores de embeddings en la nube o autoalojados.

### Cambiado

- Los vectores de memoria pasan de `VECTOR(384)` a `VECTOR(1024)` (e5-small → bge-m3); los embeddings existentes deben regenerarse.

### Eliminado

- La dependencia incluida `@huggingface/transformers`.

## [0.23.0] - 2026-07-02

### Añadido

- Un sidecar de ASR en tiempo real `sherpa-stream` autoalojado y una session-factory de proveedor.

### Cambiado

- **Cambio incompatible:** `ASR_PROVIDER` ahora usa `none` por defecto. Los despliegues existentes de ASR en tiempo real deben establecer `ASR_PROVIDER=volcengine`, o la pasarela de dictado `/ws/asr` enmudece.

## [0.22.2] - 2026-07-02

### Añadido

- Transcripción por lotes seleccionada por entorno con sidecars sherpa-onnx y faster-whisper (el perfil de Compose `asr`), con lo que la transcripción de audio por lotes vuelve a ofrecerse como capacidad fuera de proceso.

## [0.22.1] - 2026-07-02

### Añadido

- OCR seleccionado por entorno (`OCR_PROVIDER`) con sidecars tesseract y PP-OCRv6, con tesseract por defecto en el perfil de producción.

### Eliminado

- La dependencia incluida `tesseract.js`.

## [0.22.0] - 2026-07-01

### Añadido

- Un sandbox de UI `web-next-design` sin backend (`ApiClient` falso tipado) para iterar sobre el diseño.

### Cambiado

- **Cambio incompatible:** los iconos de marca de los plugins de IM y MCP pasan a ser componentes React; se eliminaron los campos de respuesta `iconUrl`, `pluginIconUrl` e `iconAssetPath`.

### Eliminado

- Los exports `PLATFORM_ASSET_FILE_ORIGIN_SYSTEMS` y el pipeline de icon-seed de MCP.

## [0.21.2] - 2026-07-01

### Añadido

- Aserciones de paridad de contrato en tiempo de compilación para todos los pares tipo/esquema compartidos, además de nuevos exports de `@synapse/shared` (esquema de content-block persistido, esquemas de transport-account y otros).

### Corregido

- Divergencia entre los tipos escritos a mano y sus esquemas Zod.

## [0.21.1] - 2026-06-22

### Añadido

- Firecrawl (MCP remoto hospedado) junto con sidecars MCP de Notion, Xiaohongshu (小红书) y Bilibili, todos con env-gate; los tres sidecars comparten un nuevo framework de Python `_mcp_base` al que también se migró el plugin existente de Mijia.

## [0.21.0] - 2026-06-21

### Añadido

- Conectores de Telegram (Bot API), WhatsApp (Cloud API) y WhatsApp no oficial (Baileys QR), junto con un transcodificador de voz basado en ffmpeg.
- Compresión en el edge: una compilación personalizada de nginx con Brotli, Zstandard y compresión con diccionario delta RFC 9842 (`.dcb`/`.dcz`).
- Ingesta de telemetría de navegador: `POST /api/v1/reports` (NEL / Reporting API) y un encabezado `Server-Timing`/`traceresponse` que expone el trace id de la petición en cada respuesta.

### Cambiado

- **Cambio incompatible:** en el DTO de grant, `memberId` → `workspaceMemberId` y `grantedByWorkspaceMemberId` → `createdByWorkspaceMemberId`; `SubjectRef.memberId` → `workspaceMemberId`.

### Eliminado

- Los exports `MCP_TOOL_NAMESPACE_SEPARATOR` y `PublicToolOrigin`.

## [0.20.1] - 2026-06-21

### Añadido

- HKUDS/CLI-Anything internalizado como builtin `cli-catalog` del device-runtime (66 CLIs), con un gate de minting en el servidor.

## [0.20.0] - 2026-06-19

### Añadido

- Un almacén de contenido multi-backend: selección de backend por blob, una caché CAS local, un backend remoto S3 (`@aws-sdk/client-s3`) con PUT/GET prefirmados, e hidratación CAS del sandbox.

### Cambiado

- **Cambio incompatible:** `resource_access_bindings` fusionado en `workspace_resource_grants`; forma wire `{app}` → `{resource}`, `appId` → `resourceId`; los sub-recursos de acceso por tipo se consolidan en `GET|PUT .../workspace-resources/:resourceId/grants`; se añadió una nueva clave de acceso de workspace `automation_admin`.

### Eliminado

- El modelo `resource_access_bindings` y sus exports (`ResourceAccessBindingResourceType`, `ACCESS_BINDABLE_*`).

## [0.19.0] - 2026-06-18

### Cambiado

- **Cambio incompatible:** el DTO de la petición de create-invite descarta el `expiresAt` absoluto en favor del `expiresInHours` relativo; si un cliente sigue enviando `expiresAt`, se ignora silenciosamente.
- El primitivo canónico `IsoInstantString` y sus helpers de conversión ahora residen en `@synapse/device-protocol/instant` y se reexportan desde `@synapse/shared`.
- `workspace_app_grants.created_at` pasa a ser `NOT NULL` (se eliminaron los fallbacks a la época 1970); las columnas de duración (`retention_ttl_ms`, `poll_interval_ms`, `ttl_ms`) se ampliaron a `BIGINT` con un CHECK `>= 0`.

## [0.18.2] - 2026-06-18

### Añadido

- Logging unificado (un único logger pino con una taxonomía de dominio) y tracing distribuido (OpenTelemetry, Tempo, Loki, Alloy) con un consumidor de errores/rendimiento de Sentry (autoalojado, con gate por DSN), propagación de trazas en BullMQ, y un endpoint de ingesta de logs de cliente `/api/v1/logs` autenticado mediante sesión de usuario o un token HMAC de dispositivo de corta duración.
- Se completaron los medios entrantes/salientes de IM sobre el pipeline direccionado por contenido: medios de DingTalk (entrantes + salientes), medios entrantes de QQ al CAS, medios entrantes de WeChat (junto con una corrección de codificación de aes_key) y una comprobación de blob vacío antes de la subida saliente.

## [0.18.1] - 2026-06-17

### Cambiado

- El `CanonicalFileRef` de transporte se reduce a una única forma direccionada por contenido (sha256); los envíos salientes ahora leen bytes del CAS para Feishu, QQ y WeChat, y los medios entrantes se persisten en el CAS para Feishu.

### Corregido

- Correcciones de conectores: verificación del webhook de Feishu, normalización de menciones `@all` y vídeo entrante; QQ OpenAPI oficial v2; manejo de menciones/rich-text/audio de DingTalk; conector de WeChat (ilink WeChat personal) realineado con el protocolo upstream (session guard, login por QR, CDN de medios).

## [0.18.0] - 2026-06-17

### Cambiado

- **Cambio incompatible:** las respuestas REST de la aplicación con cuerpo ahora se envuelven en un envelope `{ data }` (~173 rutas); las escrituras sin cuerpo se mantienen en `204`, y los endpoints de superficie wire/máquina (handshake de dispositivo, `/api/v1/internal/*`, `/auth/device/*`, `/im/webhooks/*`, `/automation-webhooks/*`, `/install.{sh,ps1}`) mantienen deliberadamente payloads sin envolver. Postgres permanece en snake_case mientras que la superficie de TypeScript es totalmente camelCase (vía un `CamelCasePlugin` de Kysely). El contrato de error (`{ error, code }`) queda deliberadamente sin cambios.
- La decodificación de JSON a la salida del repositorio ahora falla cerrado ante payloads almacenados malformados (antes se convertían silenciosamente a `{}`) en la mayoría de los módulos.

## [0.17.0] - 2026-06-10

### Añadido

- Un modelo de Task unificado al estilo MCP (tablas `tool_call_task_*`) con un ciclo de vida ortogonal: `lifecycle_status` × `outcome`.
- El primitivo de fecha-hora canónico `IsoInstantString`, los adaptadores `datetime/instant.ts` y el check de CI `guard-datetime-boundaries`.

### Cambiado

- **Cambio incompatible:** `POST .../interactions/:id/respond` → `POST .../tasks/:taskId/respond`; el evento del feed WebSocket `interaction_requested` → `task_requested` y su payload `{interaction}` → `{task}`. Se consolidaron los metadatos raíz de workspace-app.

### Eliminado

- Las tablas `interaction_*`, `InteractionRequestSummary` y exports relacionados, y las rutas de escritura heredadas de workspace-app.

## [0.16.0] - 2026-06-07

### Añadido

- Una capa de presentación de tool-call calculada en el servidor: bloques de display, `_meta` de MCP capturado, y descriptores adjuntados automáticamente para las herramientas integradas.
- Nuevos exports de `@synapse/shared` (`resolvePresentation`, `PresentationString`) y campos de presentación en `ServerToolCall`, `ToolPlugin` y los DTOs de turn-preview/activity.

## [0.15.0] - 2026-06-07

### Cambiado

- **Cambio incompatible:** la unión canónica `ToolResultOrigin` (y `TOOL_RESULT_ORIGIN_KINDS`) se unificó en el vocabulario enrutado — `mcp_remote|mcp_device|callable_plugin|builtin` → `system|plugin|device|provider_native` — con nuevas formas de campos por kind, y `origin` pasó a ser un campo obligatorio en `CanonicalToolResult`/`NormalizedMcpToolResult`.
- **Cambio incompatible:** el enum `ActorRuntimeToolKind` se recodificó (`callable|mcp_plugin|mcp_device|provider_builtin` → `system|plugin|device`); los valores de los DTOs de WebSocket y turn-preview cambiaron en consecuencia.

### Eliminado

- Los exports `ExecutableModelToolKind` y `execKindForSource`.
- Se descartaron los miembros de enum de catálogo/marketplace derivados de `device` (`device_derived`, `device_derivation`, `device_projection`, source de catálogo `device`), el transporte de plugin `device`, las etiquetas de access-target `actor_in_conversation`/`remote_agent_in_conversation`, y `conversationActorContextId`.

## [0.14.1] - 2026-06-07

### Añadido

- Soporte de HTTP/3 (QUIC) en nginx.

## [0.14.0] - 2026-06-06

### Añadido

- Procedencia y enrutamiento de herramientas (`ToolRef` + `NameRegistry`): un `toolId` determinista, un registro wire-name ↔ toolId, y un `tool_calls.source_snapshot` inmutable.

### Cambiado

- **Cambio incompatible:** procedencia y enrutamiento de herramientas — el enrutamiento ya no parsea nombres de herramientas (la proyección genera `ToolRef`s deterministas + un `NameRegistry` por turno); `ToolDefinition.source`/`sourceType` se eliminaron de `@synapse/shared` (source ahora reside en el `ProjectedToolDefinition` interno).

### Eliminado

- Las columnas heredadas `tool_calls.plugin_id`/`device_id` y las columnas `tool_execution_attempts.plugin_id`/`device_id`/`instance_key` (la procedencia ahora deriva del `tool_calls.source_snapshot` padre).

## [0.13.0] - 2026-06-06

### Cambiado

- **Cambio incompatible:** se rediseñó el modelo de execution-kind de las herramientas integradas — se eliminó el campo `ToolPlugin.kind` (`action`|`callable`) y `ToolPlugin.execute` pasó a ser obligatorio; la unión `ActorRuntimeToolKind` descartó sus miembros `builtin` y `action` (ambos en `@synapse/shared`).

## [0.12.0] - 2026-06-06

### Añadido

- Una capa de proveedor del Vercel AI SDK v6 y un vendor `deepseek`.

### Cambiado

- **Cambio incompatible:** el modelo de datos de modelos se consolida en `model_bindings` + `model_binding_versions` (en sustitución de `model_profiles`, `model_profile_revisions` y `model_group_profiles`); `provider_steps` ahora usa `model_binding_id`/`model_binding_version_id` como claves.
- **Cambio incompatible:** se rediseñó `ResolvedModelConfig` (`bindingId`, `providerKind`, `maxOutputTokens`); el export compartido `MODEL_PROVIDER_CATALOG` → `MODEL_VENDOR_CATALOG` (`ModelProviderDefinition` → `ModelVendorDefinition`), con un nuevo export `ProviderKind`.

### Eliminado

- Cuatro adaptadores LLM implementados a mano, los exports `ModelProviderAdapter*`/`EngineBranch*` y la reanudación de estado de branch nativo del proveedor.

## [0.11.3] - 2026-06-06

### Corregido

- El broadcast de chat multi-cliente podía omitir eventos porque la asignación del `member_seq` por miembro no garantizaba una secuencia sin huecos ante appends concurrentes (el cursor del cliente pagina por `member_seq > cursor`). Ahora `member_seq` se asigna como `MAX+1` bajo un lock advisory de transacción por miembro (`pg_advisory_xact_lock`), lo que garantiza una secuencia contigua y ordenada por commit.

## [0.11.2] - 2026-06-06

### Añadido

- Un instalador de Node multiplataforma de un solo clic, servido en `GET /api/v1/install.sh` e `install.ps1` (verificado con sha256, con autodetección de mirror China/internacional).

## [0.11.1] - 2026-06-05

### Añadido

- Borrado lógico (soft-delete) con vistas de lectura `_live`, una CLI de purga offline (`db:purge:*`) y un gate de CI de política de FK respaldado por un manifiesto de clasificación de tablas.
- Inicio de sesión OAuth popup-first, con enrutamiento de errores multiplataforma (web/móvil), que completa el flujo de login social de Feishu.

### Cambiado

- El borrado ahora es lógico (tombstoning): `ON DELETE CASCADE` pasó a `RESTRICT` en todo el repo. El SQL de operador que dependía de borrados en cascada ahora provoca violaciones de clave foránea, y el bootstrap del esquema requiere el privilegio `CREATEROLE`.

### Corregido

- Las peticiones de OpenAI a los modelos de razonamiento `gpt-5*` y de la serie o (o1/o3/o4) ahora envían `max_completion_tokens` en lugar del `max_tokens` heredado y rechazado.

## [0.11.0] - 2026-06-04

### Añadido

- Inicio de sesión social de Feishu (Lark), más una renovación de la UX de login/registro (layout de una sola columna, toggle de visibilidad de contraseña, autosugerencia de email, aviso de bloq-mayús y mensajes de error de login específicos).
- El sandbox de actor del lado del servidor ahora puede desplegarse tanto en modo Docker como en modo local mediante nuevos scripts de despliegue (`deploy-sandbox-docker.sh` / `deploy-sandbox-local.sh`), un `docker-compose.sandbox-local.yml` y una imagen de tunnel-edge frps construida a partir del release oficial de frp.

### Cambiado

- **Cambio incompatible:** la configuración de modelos se movió de variables de entorno a un `config/model-groups.yaml` declarativo.

### Eliminado

- `AI_PROVIDER`, `AI_ENGINE_KIND`, `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL` y `AI_MAX_TOKENS`. El chat requiere una configuración explícita de model-group; una instalación nueva arranca sin ningún modelo configurado.

## [0.10.0] - 2026-06-04

### Añadido

- Better Auth 1.6.13 para identidad (tablas `account`/`session`/`verification`) y autorización de dispositivos RFC 8628.

### Cambiado

- **Cambio incompatible:** se rediseñaron los endpoints de autenticación (`/register` → `/sign-up/email`, `/login` → `/sign-in/email`, entre otros); se requiere un nuevo `BETTER_AUTH_SECRET` (con fallback a `AUTH_SECRET` / `APP_SECRET`).

### Eliminado

- `users.password_hash`, `auth_sessions`, las seis rutas `/qr-login/*` y la concesión automática de super-admin al email de configuración.

### Seguridad

- Todas las contraseñas y sesiones se invalidan al actualizar (no hay ruta de migración). Se eliminó el nombre de cookie de sesión hardcodeado.

## [0.9.1] - 2026-06-04

### Añadido

- Escaneo de secretos con Gitleaks integrado en un hook de pre-commit y en CI (workflow `secret-scan`), respaldado por una configuración `.gitleaks.toml` y una baseline de coincidencias conocidas y permitidas.

### Cambiado

- Endurecimiento de autorización: switches de permisos exhaustivos y manejo fail-closed de permisos desconocidos.

### Corregido

- El evaluador de permisos de workspace rechazaba la clave `manage_relays` antes de la verificación de admin, con lo que la gestión de dispositivos quedaba silenciosamente reducida a los dispositivos propios para owners, admins y titulares de la clave device-admin.

## [0.9.0] - 2026-06-03

### Añadido

- Endpoints MCP remotos oficiales (AMiner, AMap, Figma) sobre HTTP y SSE, en los transportes del SDK oficial.

### Cambiado

- **Cambio incompatible:** el plugin de Mijia (domótica de Xiaomi) pasó de ser un builtin in-process siempre activo a un sidecar con env-gate (`MIJIA_MCP_URL`) detrás del perfil de Compose `mijia` — ahora está desactivado por defecto en el perfil de producción.

### Eliminado

- El `McpHttpClient` implementado a mano.

## [0.8.1] - 2026-06-03

### Añadido

- El sandbox de actor incorpora una abstracción de ciclo de vida `SandboxBackend` al estilo del SDK de E2B (`create`/`connect`/`kill`/`getHost`) con un backend local y un backend opt-in Docker-outside-of-Docker, un endpoint de fast-path, y un handshake de frescura `fs.hello` del fs-helper.

## [0.8.0] - 2026-06-02

### Añadido

- Un servicio de archivos direccionado por contenido (`content_blobs`, `file_assets`, `file_spaces`, `file_snapshots`, `file_mounts`) indexado por sha256.
- Un módulo de sandbox de actor del lado del servidor: ciclo de vida por sesión, un proveedor host local que lanza procesos hijos del device-runtime, materialización del working-set sobre el nuevo servicio de archivos (tablas `file_snapshots`, `file_mounts`), más grants de sandbox, GC y manejo de avisos de conflicto.

### Cambiado

- **Cambio incompatible:** el envelope de cifrado pasó de `enc:` a `enc:v2:` (KDF scrypt) sin ruta de re-cifrado; se eliminó el mecanismo para ejecutar consultas bare-pg directamente al converger la capa de datos en Kysely.

### Eliminado

- El motor de ASR por lotes in-process sherpa-onnx-node.

### Seguridad

- Validación Zod fail-fast de la configuración de entorno, endurecimiento contra SSRF (incluyendo IPv6 entre corchetes) y un nuevo redactor de secretos `redactSecrets` fail-closed. Se añade un nuevo `SYNAPSE_REGISTRY_DOMAIN` obligatorio.

## [0.7.1] - 2026-06-01

### Añadido

- Un registro npm privado Verdaccio autoalojado para distribuir el device-runtime y el daemon de remote-agent; `publishConfig` en diez paquetes.

## [0.7.0] - 2026-05-31

### Cambiado

- **Cambio incompatible:** se migraron todos los workspaces a Zod 4 (fijado en `4.3.6`); la naturaleza IM de una conversación ahora se deriva de su binding de transporte, lo que rediseña los DTOs de create y add-participant del chat.

### Eliminado

- El diseño A2A heredado (`A2AApp`, `A2AAgentCard` y exports relacionados), `CONVERSATION_BOUNDARY`/`CONVERSATION_BOUNDARIES` y `systemRef`.

## [0.6.1] - 2026-05-29

### Añadido

- Un subsistema de foco de sesión de computer-use (CUA) por agente.

## [0.6.0] - 2026-05-29

### Añadido

- Una capacidad de navegador vía chrome-devtools-mcp, con una proyección consciente de la operación y grants manuales.

### Cambiado

- El `RuntimeBrowserPolicySchema` del protocolo de dispositivos incorpora una allowlist aditiva de `operations` a nivel de operación (el matcher falla cerrado si falta la entrada).
- **Cambio incompatible:** el `DeviceCapabilitySummarySchema` del protocolo de dispositivos añade un campo obligatorio `exposure_stable_key` (más un `metadata` opcional aditivo).

## [0.5.0] - 2026-05-29

### Añadido

- Capacidad de terminal v2 (`exec_file`, `powershell`) con un toolchain incluido, y seis paquetes de plataforma `device-runtime-bundles-*` distribuidos mediante Git LFS.

### Cambiado

- **Cambio incompatible:** se rediseñó el esquema wire `CommandlinePolicy` del protocolo de dispositivos. Compilar el proyecto ahora requiere Git LFS.

## [0.4.0] - 2026-05-29

### Añadido

- La CLI npm `@synapse/device-runtime` (`synapse-device`), una capacidad de sistema de archivos de dispositivo (13 herramientas) respaldada por un nuevo sidecar Rust fs-helper, y conectores de QQ (OpenAPI oficial v2) y DingTalk (Stream).

### Cambiado

- **Cambio incompatible:** el plano de control de dispositivos se movió a un endpoint WebSocket `GET /api/v1/devices/control-plane` (framing JSON-RPC 2.0); la identidad del dispositivo ahora usa dos pares de claves; el emparejamiento se movió a `POST /api/v1/devices/pairing-sessions/consume`. Compilar el proyecto ahora requiere un toolchain de Rust (para el sidecar fs-helper).

### Eliminado

- Todo el subsistema Go `relay/` (−66 599 líneas): la CLI de relay, la GUI de escritorio, el agente y el montaje FUSE; `/ws/relay`; trece tablas `relay_*`; el manifiesto de auto-actualización del relay; y el pinning de clave pública TLS.

### Seguridad

- Un nuevo `SYNAPSE_DEVICE_TRUSTED_SERVER_KEYS` obligatorio (si no se define, se rechaza toda llamada a herramienta), y un túnel frp obligatorio para el dispatch de herramientas.

## [0.3.0] - 2026-05-27

### Añadido

- Una dimensión de scope en el modelo de subject (`ScopedSubjectTarget`, `scope_subject_id`) y los endpoints REST de `memory_access_grants`.

### Cambiado

- **Cambio incompatible:** `AccessTarget` y `CapabilityAccessTarget` se rediseñaron sobre `ScopedSubjectTarget`.
- **Cambio incompatible:** los DTOs de memoria se rediseñaron sobre el modelo de subject: `MemoryEntry` reemplaza los campos `spaceType`/`ownerScope`/owner-id por `owner`/`scope` (`SubjectRef`) + `namespaceKey`; los eventos de feed `memory_saved`/`memory_updated` cambian `memorySpaceType` por `memoryOwner`/`memoryNamespaceKey`; y `RelayAuthorizationGrantSummary.scope` (enum) pasa a ser `subject` + `scope` opcional (`SubjectRef`).

### Eliminado

- Los tipos heredados de access-target, `MEMORY_SCOPES`/`MEMORY_SPACE_TYPES` y `relay_authorization_grants.scope`.
- La variante de subject `conversation_actor_context` — `SUBJECT_KIND.CONVERSATION_ACTOR_CONTEXT`, `ACCESS_RESOURCE_TYPE.CONVERSATION_ACTOR_CONTEXT` y los exports `conversationActorContextRef` / `isConversationActorContextSubject` (el caso de actor-en-conversación ahora es `actor` + `scope=conversation`).

## [0.2.0] - 2026-05-25

### Añadido

- Un registro `access_subjects` que unifica el modelo de subject, antes polimórfico, sobre un único `subject_id`.
- Una abstracción de IM `TransportConnector` con un registro de conectores, más conectores funcionales de Feishu (Lark), Weixin (WeChat personal) y WeCom (Feishu/Weixin eran antes stubs de capacidad de 9 líneas), un endpoint de reverse-MCP por conversación, una abstracción `AgentDriver` para el daemon de remote-agent, y despliegue de producción con Docker Compose (perfiles `tls`/`http`/`certbot`).

### Cambiado

- **Cambio incompatible:** las rutas de conversación e interacción se movieron bajo `/chat/*` (las URLs heredadas devuelven 404); los nombres de eventos de WebSocket pasaron a forma con puntos (`auth_error` → `auth.error`, `server_shutdown` → `server.shutdown`); Docker Compose ahora falla de inmediato si falta alguna de las once variables de entorno obligatorias adicionales (`APP_BASE_URL`, `SYNAPSE_PUBLIC_DOMAIN` y otras), lo que eleva el conjunto obligatorio a quince.

### Eliminado

- El despliegue systemd en el host (units y scripts de arranque); los exports de `@synapse/shared` `Message`, `MessageType`, `ConversationSummary`, `SESSION_CHANNELS` y `ChannelType`; el montaje bare `/files/*`; y `sessions.channel_type`.

## [0.1.0] - 2026-05-20

Un runtime autoalojado y centrado en la conversación para compañeros de equipo digitales, donde la propia conversación es la frontera de colaboración que delimita participantes, visibilidad del historial, ejecución de actores, wakeups y traspaso de memoria.

### Añadido

- **Modelo de conversación** — un grafo de conversación agnóstico al canal: `conversations` (tipos group/private/virtual, límite internal/external), `conversation_participants` polimórfico (workspace_member, actor, remote_agent, external, system) con marcas de lectura por participante, y un registro tipado `conversation_items` (message/event/summary/control; roles user/assistant/system/tool) con ámbito shared/private, superficie visible/internal, políticas de fan-out de eventos, secuencia monótona por conversación, encadenamiento de reply/cause y cuerpos multiparte (text/file_ref/json), además de direccionamiento to/cc/visible y menciones.
- **Conectores de IM** — una abstracción de transporte genérica de cinco tablas (accounts, endpoints, bindings por conversación, addresses, enlaces de entrega por item) tras la que operan dos conectores: bot de Feishu (飞书) (webhook + long-connection, directo + grupo) y Weixin (WeChat personal) mediante emparejamiento por QR (long-connection, solo directo).
- **Actores nativos de la plataforma** — compañeros de equipo de IA con ámbito de workspace y ejecución en la nube, con roles tipados (secretary/manager/specialist/reviewer/archivist/receptionist/assistant), una jerarquía de actores, `can_represent_user` e historial versionado completo (`actor_versions`) con procedencia que atribuye cada edición a un member, actor, system o fuente de sync.
- **Agentes remotos puenteados** — runtimes agénticos externos (Claude Code, Codex) que se ejecutan en la propia máquina del usuario, incorporados como participantes del workspace a través del `remote-agent-daemon` (un driver local de Node que abre una conexión saliente por WebSocket, sondea las CLIs instaladas, las lanza en cada turno y sirve de puente para el chat mediante un servidor MCP stdio inyectado) con emparejamiento/confianza de máquina, colaboración con aprobación de planes y grants de interacción en grupo.
- **Herramientas de dispositivo vía el relay de Go** — un agente independiente en el dispositivo (CLI `synapse-relay`, GUI de escritorio Wails, montaje FUSE) que empareja una máquina física y la expone a la nube como herramientas MCP autorizadas sobre un protocolo de despacho WebSocket versionado, hospedando computer-use (CUA) integrado, sistema de archivos con ámbito acotado, Chrome DevTools empaquetado y servidores de línea de comandos.
- **Gobernanza y permisos del workspace** — un RBAC de dos niveles: `platform_access_bindings` a nivel de plataforma (super_admin/workspace_admin/model_admin/support/auditor) con bootstrap del super-admin por env-config, y `workspace_members` a nivel de workspace (admin/member/guest) con ocho claves de capacidad de admin de grano fino, invitaciones basadas en token y una ACL `resource_access_bindings` polimórfica que concede recursos a sujetos workspace/conversation/actor.
- **Autenticación** — una pila de identidad implementada a mano: login por contraseña con bcrypt, sesiones bearer opacas sha256 (cookie o cabecera Authorization) con metadatos de cliente/transporte y ciclo de vida, y una máquina de estados completa, con doble token, para el login por QR entre dispositivos.
- **Compañeros de equipo y contactos compartibles** — un grafo de relaciones estilo WeChat por workspace sobre members, actors y agentes remotos: perfiles de identidad compartibles con IDs buscables y tokens QR, solicitudes de amistad con aprobación automática/manual y entradas aceptadas en la lista de contactos.
- **Catálogo y marketplace** — un eje publisher → item → version sobre tres tipos de paquete (actor_template, skill_package, plugin_package) con categorías, archivos de versión y specs por tipo; ingesta de skills desde fuentes espejo de GitHub/ClawHub a snapshots parseados; y tablas de runtime de skills instaladas y de instalación de plugins por tenant del workspace, con sesiones de auth de plugin estilo OAuth y conexiones por propietario.
- **Grupos de modelos y proveedores de LLM** — cuatro adaptadores de proveedor implementados a mano (Anthropic Messages, OpenAI Chat Completions, OpenAI Responses, BigModel/Zhipu GLM) tras un catálogo estático de proveedores, más un subsistema de enrutamiento respaldado por BD: perfiles de modelo versionados, `model_groups` con estrategias weighted-random/round-robin/priority-failover y políticas de intentos, grants con ámbito y asignaciones actor→group; el proveedor/modelo de runtime se selecciona por entorno.
- **Herramientas y plugins MCP** — un host de plugins MCP de cuatro transportes (builtin, stdio, http, relay) sobre una taxonomía de herramientas de siete tipos, que incluye siete plugins builtin (feishu, aminer, amap, github, gitlab, mijia y el toolkit z-ai de Zhipu que abarca búsqueda, lectura, OCR/visión, audio/voz, generación de medios y moderación), con aprobación de permisos en runtime y ámbito de mount/reuse.
- **Memoria** — memoria semántica híbrida in-process, particionada en cinco ámbitos (workspace_shared, conversation_shared, actor_private, participant_private, user_private) y siete categorías de item, que combina recuperación léxica (FTS + trigram) y vectorial mediante un modelo `multilingual-e5-small` de transformers.js empaquetado (VECTOR(384), HNSW cosine) que genera embeddings localmente sin sidecar externo, más ejecuciones de recall registradas.
- **Despliegue autoalojado** — una disposición de host único en Ubuntu: nginx como punto de entrada público, systemd para la API y la web de escritorio (`packages/web-next`), PostgreSQL dockerizado (pgvector/pg16) y Redis 7, una imagen de API ejecutada con tsx, y un perfil de Compose `production` para la pila completa en contenedores; incluye una app móvil Expo, junto con README y CHANGELOG en inglés, 简体中文 y Español.

[Unreleased]: https://github.com/zai-org/Synapse/compare/v0.27.0...HEAD
[0.27.0]: https://github.com/zai-org/Synapse/compare/v0.26.2...v0.27.0
[0.26.2]: https://github.com/zai-org/Synapse/compare/v0.26.1...v0.26.2
[0.26.1]: https://github.com/zai-org/Synapse/compare/v0.26.0...v0.26.1
[0.26.0]: https://github.com/zai-org/Synapse/compare/v0.25.5...v0.26.0
[0.25.5]: https://github.com/zai-org/Synapse/compare/v0.25.4...v0.25.5
[0.25.4]: https://github.com/zai-org/Synapse/compare/v0.25.3...v0.25.4
[0.25.3]: https://github.com/zai-org/Synapse/compare/v0.25.2...v0.25.3
[0.25.2]: https://github.com/zai-org/Synapse/compare/v0.25.1...v0.25.2
[0.25.1]: https://github.com/zai-org/Synapse/compare/v0.25.0...v0.25.1
[0.25.0]: https://github.com/zai-org/Synapse/compare/v0.24.1...v0.25.0
[0.24.1]: https://github.com/zai-org/Synapse/compare/v0.24.0...v0.24.1
[0.24.0]: https://github.com/zai-org/Synapse/compare/v0.23.1...v0.24.0
[0.23.1]: https://github.com/zai-org/Synapse/compare/v0.23.0...v0.23.1
[0.23.0]: https://github.com/zai-org/Synapse/compare/v0.22.2...v0.23.0
[0.22.2]: https://github.com/zai-org/Synapse/compare/v0.22.1...v0.22.2
[0.22.1]: https://github.com/zai-org/Synapse/compare/v0.22.0...v0.22.1
[0.22.0]: https://github.com/zai-org/Synapse/compare/v0.21.2...v0.22.0
[0.21.2]: https://github.com/zai-org/Synapse/compare/v0.21.1...v0.21.2
[0.21.1]: https://github.com/zai-org/Synapse/compare/v0.21.0...v0.21.1
[0.21.0]: https://github.com/zai-org/Synapse/compare/v0.20.1...v0.21.0
[0.20.1]: https://github.com/zai-org/Synapse/compare/v0.20.0...v0.20.1
[0.20.0]: https://github.com/zai-org/Synapse/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/zai-org/Synapse/compare/v0.18.2...v0.19.0
[0.18.2]: https://github.com/zai-org/Synapse/compare/v0.18.1...v0.18.2
[0.18.1]: https://github.com/zai-org/Synapse/compare/v0.18.0...v0.18.1
[0.18.0]: https://github.com/zai-org/Synapse/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/zai-org/Synapse/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/zai-org/Synapse/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/zai-org/Synapse/compare/v0.14.1...v0.15.0
[0.14.1]: https://github.com/zai-org/Synapse/compare/v0.14.0...v0.14.1
[0.14.0]: https://github.com/zai-org/Synapse/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/zai-org/Synapse/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/zai-org/Synapse/compare/v0.11.3...v0.12.0
[0.11.3]: https://github.com/zai-org/Synapse/compare/v0.11.2...v0.11.3
[0.11.2]: https://github.com/zai-org/Synapse/compare/v0.11.1...v0.11.2
[0.11.1]: https://github.com/zai-org/Synapse/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/zai-org/Synapse/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/zai-org/Synapse/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/zai-org/Synapse/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/zai-org/Synapse/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/zai-org/Synapse/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/zai-org/Synapse/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/zai-org/Synapse/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/zai-org/Synapse/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/zai-org/Synapse/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/zai-org/Synapse/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/zai-org/Synapse/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/zai-org/Synapse/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/zai-org/Synapse/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/zai-org/Synapse/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/zai-org/Synapse/releases/tag/v0.1.0
