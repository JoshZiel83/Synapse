# Registro de cambios

[English](./CHANGELOG.md) · [简体中文](./CHANGELOG_CN.md) · **Español**

Este archivo documenta todos los cambios relevantes del proyecto.

El formato se basa en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el
proyecto procura seguir el [Versionado Semántico](https://semver.org/lang/es/spec/v2.0.0.html).

> [!WARNING]
> Synapse sigue en una fase temprana de diseño e implementación (pre-1.0). Según las reglas
> 0.x de SemVer, cualquier versión puede incluir cambios incompatibles, y no se garantiza la
> compatibilidad con los datos existentes: los cambios incompatibles se resuelven
> reconstruyendo la base de datos (`npm run db:rebuild`) y redesplegando, no mediante
> migraciones (véase [`deploy.md`](./deploy.md)). Dentro de `0.x`, un incremento **minor**
> (`0.Y.0`) señala una ruptura de cara al consumidor (rutas REST/WebSocket y DTOs, el
> contrato del protocolo de dispositivos, las exportaciones de `@synapse/shared`, la
> autenticación, o una capacidad eliminada), mientras que un **patch** (`0.y.Z`) es
> retrocompatible. Las versiones etiquetadas a continuación, hasta `0.27.0`, reconstruyen
> retroactivamente el historial de la rama `dev`, durante el cual los manifiestos de los
> paquetes se mantuvieron en `0.1.0`; `0.28.0` es la primera versión publicada en el registro
> de paquetes, y a partir de ella los manifiestos llevan la versión publicada.

## [Unreleased]

## [0.28.0] - 2026-07-24

Corrección de exactitud de la ronda 3 del trazado distribuido (commits `c068aef3`, `9b5a30c8`, `92645a74`): correlación de trazas acotada al turno para las llamadas a herramientas de reverse-MCP a través de despertares de conversación intercalados (F-r3-2). Cambia el contrato del protocolo del daemon de agentes remotos y requiere un **redespliegue coordinado**: el orden estricto de compilación de imágenes y las comprobaciones posteriores a la recreación se recogen en el manual de operaciones de despliegue en [`docs/logging-refactor/04-operations.md`](./docs/logging-refactor/04-operations.md) §7, con el orden de conmutación de R3 — con el daemon primero — en §7.4. No cambió ningún esquema de base de datos, así que esta versión no necesita `db:rebuild`.

Es también la primera versión en la que los manifiestos de los paquetes dejan atrás `0.1.0`: el conjunto coordinado — `@synapse/device-protocol`, `@synapse/shared`, `@synapse/device-runtime`, `@synapse/device-sdk`, `@synapse/api` y `@synapse/remote-agent-daemon` — sube en bloque a `0.28.0`, y los cuatro paquetes de runtime se publican en el registro de paquetes privado. Los bundles de runtime de plataforma se mantienen desacoplados, con su propia versión.

### Cambiado

- **Cambio incompatible:** el protocolo del daemon de agentes remotos gana un `turn_epoch` opcional tanto en `agent:deliver` (api→daemon) como en `agent:status` (daemon→api). Ambas tramas se validan como `z.strictObject`, de modo que un par compilado antes de este cambio rechaza estrictamente la trama entera en lugar de ignorar el campo nuevo. La publicación en el registro sigue el orden de dependencias — `@synapse/device-protocol` → `shared` → `device-runtime` → `remote-agent-daemon` al final (`deploy.md` §5b) —, pero el despliegue en ejecución se actualiza **con el daemon primero**: como el campo estricto recae en `agent:deliver`, actualizar el daemon antes que la api mantiene limpia la ruta de entrega (una api antigua simplemente omite el campo), y solo queda la trama `agent:status` del daemon descartada por una api aún sin actualizar (correlación de turnos degradada, nunca una entrega perdida). El orden inverso rechazaría estrictamente cada `agent:deliver` que llevara el campo y provocaría reentregas repetidas (la entrega sigue siendo al menos una vez; no se pierde nada). El orden de conmutación de R3 está en [`docs/logging-refactor/04-operations.md`](./docs/logging-refactor/04-operations.md) §7.4.
- Los paquetes @synapse publicables forman ahora un conjunto de redespliegue coordinado fijado a una única versión exacta; una nueva verificación `guard:versions` (ejecutada en `verify:boundary`) exige la versión en bloque, las versiones fijadas exactas dentro del conjunto, los bundles de plataforma desacoplados y la sincronización del package-lock.

### Corregido

- Los despertares de conversación intercalados ya no cruzan trazas (F-r3-2): una llamada `tools/call` de reverse-MCP tardía de un turno se atribuye a los orígenes de entrega de ese mismo turno, nunca a los de un sucesor despertado de forma concurrente. El daemon mantiene ahora una época por turno autoritativa tras un control de turnos (un turno por conversación a la vez; los despertares que compiten se encolan en orden de despacho y se disparan de uno en uno), la api fija los enlaces de span de reverse-MCP en la época en ejecución confirmada por el daemon, y al completarse un turno se vacía exactamente el conjunto pendiente de esa época. Un recolector de conexiones de máquina obsoletas finaliza un socket que el sistema operativo nunca cerró, y cada driver emite como mucho una señal terminal por turno para que el control de turnos nunca pueda avanzar dos veces.

## [0.27.0] - 2026-07-23

Correcciones de exactitud de la ronda 2 del trazado distribuido (commits `defdece3`, `f6c456b5`, `cd615060`, `79ddc845`), además de un endurecimiento del borde público. Para los operadores, lo esencial es un **redespliegue coordinado**: esta versión cambia contratos del protocolo, de cola y de telemetría, y el procedimiento exacto — un orden estricto de compilación de imágenes, `--force-recreate` y una lista de verificación posterior a la recreación — es el manual de operaciones de despliegue en [`docs/logging-refactor/04-operations.md`](./docs/logging-refactor/04-operations.md) §7. No cambió ningún esquema de base de datos, así que esta versión no necesita `db:rebuild`.

### Cambiado

- **Cambio incompatible:** los mensajes de chat que una compilación anterior dejó en cola pero sin enviar se descartan al actualizar. El estado de cola almacenado del buzón de salida de chat sin conexión se subió de versión como ruptura limpia **tanto en web como en móvil** (instantánea móvil v2→v3; `StoredChatQueueState` compartido v4→v5, incluido el service worker); los clientes reconstruyen el buzón de salida en la primera carga. Los mensajes ya enviados y los datos del lado del servidor no se ven afectados.
- Los daemons de agentes remotos deberían recompilarse y republicarse (`deploy.md` §5b): una nueva trama `agent:deliveries:completed` (api→daemon) libera el conjunto de entregas pendientes del daemon, y los campos de traza de las tramas del daemon pasan por el control `wireTraceContextFields` (validados por esquema; un valor malformado se degrada a ausente). Un daemon compilado antes de este cambio ignora en silencio la trama nueva hasta que se republique — las entregas afectadas quedan pendientes y vuelven a notificar, así que no se pierde nada. Se eliminó `AgentSession.setMcpServers` de la interfaz del driver, y una verificación de CI exige ahora la paridad de tramas entre api y daemon. (La reestructuración del cuerpo de `fail-deliveries` se publicó en la v0.26.0.)
- Los paneles o alertas que consulten spans `fastify.type=hook` pierden esos datos: con `@fastify/otel` 0.20.1 e `instrumentHooks:false`, cada petición produce ahora un único span SERVER, y desaparecen los spans de hooks de ciclo de vida por petición. El propagador de salida propio ahora falla en modo cerrado incondicionalmente (no envía a terceros ni un `traceparent` con flags `00` ni un `tracestate` de proveedor heredado), y `OTEL_SERVICE_NAME`/`OTEL_RESOURCE_ATTRIBUTES` ahora sí anulan el nombre de servicio integrado (la precedencia anterior estaba invertida).
- Se endureció el manejo del `tracestate` entrante: `MAX_TRACESTATE_LENGTH` se rebajó de 1024 a 512 (el valor que `@opentelemetry/core` 2.8.0 impone), con la gramática de claves ampliada al superconjunto del Nivel 2 del W3C. Un encabezado de más de 512 caracteres, con más de 32 miembros, claves duplicadas, valores demasiado largos o miembros malformados se descarta ahora por completo en lugar de recuperarse parcialmente.
- El parcheo de dependencias pasó de `patch-package` a un aplicador propio, `scripts/apply-patches.mjs` (postinstall y los Dockerfiles de api/web/mobile-web). Un device runtime instalado desde npm no incluye los binarios auxiliares de Go/Rust y ahora se degrada de forma controlada con una advertencia al arrancar.

### Añadido

- Limitación de tasa en el borde público en las dos plantillas públicas de nginx — `limit_req` en `/api/` y `/ws` más `limit_conn` en `/ws` (devuelven `429`, no `503`; una carga de página normal nunca la dispara), con clave IPv6 por `/64` en el borde TLS (njs). También el marcador Ring-0 infalsificable `x-synapse-trace-ingress`, un `SYNAPSE_TRACE_SAMPLING_SALT` opcional para el muestreador de proporción con clave, límites explícitos en `overrides.defaults` de Tempo, y una advertencia al arrancar cuando `SYNAPSE_SERVER_TIMING_TRACE=on` coexiste con un muestreador de proporción. Umbrales y parámetros: [`docs/logging-refactor/04-operations.md`](./docs/logging-refactor/04-operations.md) §6 y §1.
- Cobertura de trazas en el cliente y en los sidecars nativos: en web y móvil, los portadores de trazas provienen ahora de spans reales del SDK (se eliminaron los ids de span fabricados), con spans de cliente breves alrededor de las tramas de auth/subscribe de WebSocket; el cua-helper de Go y el fs-helper de Rust emiten spans SERVER por RPC con atributos semconv de JSON-RPC.
- Vida útil de los portadores de trazas acotada al turno tanto en la api (`TurnCarrierCache`) como en el daemon (turn-epoch), lo que corrige la atribución de spans de reverse-MCP; un nuevo conmutador triestado `OTEL_TRACES_EXPORTER` (sin definir/`otlp`/`none`) y la normalización de `OTEL_TRACES_SAMPLER` sin distinguir mayúsculas de minúsculas; y nuevas funciones auxiliares de tracestate en `@synapse/shared` (`sanitizeTracestateHeader`, `isValidTracestateHeader`, constantes de gramática) — todo ello aditivo.
- Este registro de cambios retroactivo y trilingüe (English, 简体中文, Español), que reconstruye el historial de versiones v0.1.0–v0.26.2 con 50 tags anotados.
- CI: por primera vez hay un control para las pruebas en otros lenguajes (`go test` para el sidecar cua, `cargo test` para el fs-helper), y la verificación de propagación de trazas incorpora reglas de paridad de tramas y de alcance por turno.

### Corregido

- Caché de portadores del fan-in del daemon: al alcanzar el tope de 20 entradas, la deduplicación ahora expulsa el portador más antiguo en lugar de descartar el más nuevo — antes, el portador de origen del turno actual podía ser justamente el descartado.

## [0.26.2] - 2026-07-17

### Corregido

- Daemon de agentes remotos: los informes de fail-delivery con fan-in ya no heredan una traza de entrega del contexto ambiente; la API emite un span raíz nuevo que enlaza todos los orígenes, lo que corrige la correlación de orígenes mixtos.

## [0.26.1] - 2026-07-17

### Añadido

- Propagación de trazas de extremo a extremo a través del borde y el frontend: en la frontera de confianza, nginx elimina los encabezados de trace-state entrantes de proveedores (`tracestate`, `baggage`, `sentry-trace`) mientras reenvía el `traceparent` de W3C (que la API valida al extraerlo, tratando sus flags como orientativos), y los clientes web y móvil tienden un puente entre los spans del navegador y ese `traceparent`.

## [0.26.0] - 2026-07-17

### Añadido

- Consumidores de trazas: enlaces de fan-in del daemon, portador de despacho, spans de productor de BullMQ y OpenTelemetry en los sidecars de Python. `resolution_traceparent` se persiste para que una trama de resolución reproducida conserve la traza del resolutor.

### Cambiado

- **Cambio incompatible:** se reestructuró el cuerpo de la petición `POST /api/v1/internal/remote-agents/:remoteAgentId/fail-deliveries`.

## [0.25.5] - 2026-07-17

### Añadido

- Esquemas de portador de trazas en el envelope del protocolo de dispositivos y trazado de WebSocket por mensaje. Los campos de traza son tolerantes: un valor malformado o de tamaño excesivo se degrada a ausente en lugar de rechazar el mensaje.

## [0.25.4] - 2026-07-16

### Cambiado

- OpenTelemetry asume ahora el muestreo y la exportación; Sentry queda relegado a consumidor. `SENTRY_TRACES_SAMPLE_RATE` se reutiliza como tasa de reenvío hacia Sentry.

## [0.25.3] - 2026-07-15

### Añadido

- Base de trazado compartida: un contrato de portador de trazas propio, un propagador y un parche para `@fastify/otel`.

## [0.25.2] - 2026-07-15

### Eliminado

- La maquinaria de la capacidad `pty`, reservada pero inerte: el miembro `pty` del enum de builtin-kind, su política y la ruta de rechazo de creación de grants. Crear un grant de pty siempre había fallado con HTTP 400 (`pty_not_supported`); nunca fue una capacidad enrutable.

### Corregido

- La imagen Docker de la API vuelve a compilarse, lo que pone fin a una rotura de 14 días causada por un `cp -r` sin comprobación previa sobre una ruta de assets que la refactorización de iconos había eliminado.
- Dos escapes por enlace simbólico en el sandbox off-box: una escritura arbitraria en el host mediante un enlace simbólico en la instantánea base, y una exfiltración de archivos del host en el lado de lectura a través del comportamiento de `envd` de seguir enlaces simbólicos en `stat`.
- Un livelock de convergencia sin datos de por medio en la ruta de desmantelamiento off-box.

## [0.25.1] - 2026-07-13

### Añadido

- Proveedor de sandbox off-box `cubesandbox:bare` (contrato de red compatible con E2B) con confinamiento léxico de rutas: el primer adaptador de runtime remoto.

## [0.25.0] - 2026-07-12

### Añadido

- Supertipo `runtimes`: los dispositivos y los sandboxes pasan a ser tablas de detalle sobre un único `runtime_id` polimórfico.
- Generalización del runtime de sandbox: un registro de adaptadores `${provider}:${mode}` con los adaptadores bare on-box `local:bare` y `docker:bare` y un nuevo parámetro de operador `SANDBOX_MODE` (`resident`|`bare`|`auto`): el sustrato sobre el que se construye el proveedor off-box de 0.25.1.

### Cambiado

- **Cambio incompatible:** `device_*` se renombró a `runtime_*` en todo el esquema, en el contrato del protocolo de dispositivos (enums `DEVICE_*` → `RUNTIME_*`, `DeviceHelloParams` → `RuntimeHelloParams`, `pendingDeviceId` → `pendingRuntimeId`) y en los campos de `OperationEnvelope`.

### Eliminado

- La tabla `device_sync_sources` y sus exportaciones `DEVICE_SYNC_SOURCE_KINDS`/`DEVICE_SYNC_MODES`/`DEVICE_SYNC_STATUSES` (eliminadas por completo, sin reemplazo `runtime_*`). Las otras 14 tablas `device_*` y sus exportaciones `Device*` de `@synapse/device-protocol` se renombraron en lugar de eliminarse (véase «Cambiado»).

## [0.24.1] - 2026-07-03

### Añadido

- Extracción de documentos seleccionada mediante variable de entorno (`DOCUMENT_EXTRACTION_PROVIDER`) con un sidecar de Apache Tika (PDF, DOCX, Markdown), habilitado por defecto en el perfil de producción, además de proveedores en la nube de activación explícita (TextIn xParse, y una ruta asíncrona de LlamaParse con un proceso de barrido de reconciliación). Esto completa el trabajo de abstracción de proveedores: la imagen de la API ya no empaqueta ningún motor de inferencia.

### Eliminado

- La dependencia empaquetada `pdf-parse`.

## [0.24.0] - 2026-07-03

### Eliminado

- **Cambio incompatible:** la funcionalidad de cumplimiento `audit_logs`, de principio a fin: la ruta `GET /api/v1/workspaces/:workspaceId/audit-logs`, las exportaciones `AuditLog*` y el rol de plataforma `auditor`. (Esto es distinto de `/api/v1/logs` y `/api/v1/reports`, que se mantienen.)

## [0.23.1] - 2026-07-03

### Añadido

- Embeddings seleccionados mediante variable de entorno (`EMBEDDING_PROVIDER`), con un sidecar bge-m3 autoalojado y un adaptador genérico compatible con OpenAI para proveedores de embeddings en la nube o autoalojados.

### Cambiado

- Los vectores de memoria pasan de `VECTOR(384)` a `VECTOR(1024)` (e5-small → bge-m3); es necesario regenerar los embeddings existentes.

### Eliminado

- La dependencia empaquetada `@huggingface/transformers`.

## [0.23.0] - 2026-07-02

### Añadido

- Un sidecar autoalojado de ASR en tiempo real, `sherpa-stream`, y una fábrica de sesiones por proveedor.

### Cambiado

- **Cambio incompatible:** `ASR_PROVIDER` ahora es `none` por defecto. Los despliegues existentes con ASR en tiempo real deben establecer `ASR_PROVIDER=volcengine`; de lo contrario, la pasarela de dictado `/ws/asr` enmudece.

## [0.22.2] - 2026-07-02

### Añadido

- Transcripción por lotes seleccionada mediante variable de entorno, con sidecars sherpa-onnx y faster-whisper (el perfil de Compose `asr`), lo que restablece la transcripción de audio por lotes como capacidad fuera de proceso.

## [0.22.1] - 2026-07-02

### Añadido

- OCR seleccionado mediante variable de entorno (`OCR_PROVIDER`), con sidecars tesseract y PP-OCRv6; en el perfil de producción el valor por defecto es tesseract.

### Eliminado

- La dependencia empaquetada `tesseract.js`.

## [0.22.0] - 2026-07-01

### Añadido

- Un sandbox de UI sin backend, `web-next-design` (con un `ApiClient` falso tipado), para iterar sobre el diseño.

### Cambiado

- **Cambio incompatible:** los iconos de marca de los plugins de IM y MCP son ahora componentes de React; se eliminaron los campos de respuesta `iconUrl`, `pluginIconUrl` e `iconAssetPath`.

### Eliminado

- Las exportaciones `PLATFORM_ASSET_FILE_ORIGIN_SYSTEMS` y el pipeline de icon-seed de MCP.

## [0.21.2] - 2026-07-01

### Añadido

- Aserciones de paridad de contrato en tiempo de compilación para todos los pares tipo/esquema compartidos, además de nuevas exportaciones de `@synapse/shared` (el esquema de content-block persistido, los esquemas de transport-account y otros).

### Corregido

- La divergencia entre los tipos escritos a mano y sus esquemas de Zod.

## [0.21.1] - 2026-06-22

### Añadido

- Firecrawl (MCP remoto alojado) junto con sidecars MCP de Notion, Xiaohongshu (小红书) y Bilibili, todos controlados por variable de entorno; los tres sidecars comparten un nuevo framework de Python, `_mcp_base`, al que también se migró el plugin existente de Mijia.

## [0.21.0] - 2026-06-21

### Añadido

- Conectores de Telegram (Bot API), WhatsApp (Cloud API) y WhatsApp no oficial (QR de Baileys), además de un transcodificador de voz basado en ffmpeg.
- Compresión en el borde: una compilación personalizada de nginx con Brotli, Zstandard y compresión con diccionarios delta según RFC 9842 (`.dcb`/`.dcz`).
- Ingesta de telemetría del navegador: `POST /api/v1/reports` (NEL / Reporting API) y un encabezado `Server-Timing`/`traceresponse` que expone el id de traza de la petición en cada respuesta.

### Cambiado

- **Cambio incompatible:** en el DTO de grant, `memberId` → `workspaceMemberId` y `grantedByWorkspaceMemberId` → `createdByWorkspaceMemberId`; `SubjectRef.memberId` → `workspaceMemberId`.

### Eliminado

- Las exportaciones `MCP_TOOL_NAMESPACE_SEPARATOR` y `PublicToolOrigin`.

## [0.20.1] - 2026-06-21

### Añadido

- HKUDS/CLI-Anything se internaliza como el `cli-catalog` integrado del device-runtime (66 CLIs), con un control de emisión en el servidor.

## [0.20.0] - 2026-06-19

### Añadido

- Un almacén de contenido multi-backend: selección de backend por blob, una caché CAS local, un backend remoto de S3 (`@aws-sdk/client-s3`) con PUT/GET prefirmados, e hidratación del sandbox desde el CAS.

### Cambiado

- **Cambio incompatible:** `resource_access_bindings` se fusiona en `workspace_resource_grants`; la forma del protocolo `{app}` → `{resource}`, `appId` → `resourceId`; los sub-recursos de acceso por tipo se consolidan en `GET|PUT .../workspace-resources/:resourceId/grants`; se añadió una nueva clave de acceso de workspace, `automation_admin`.

### Eliminado

- El modelo `resource_access_bindings` y sus exportaciones (`ResourceAccessBindingResourceType`, `ACCESS_BINDABLE_*`).

## [0.19.0] - 2026-06-18

### Cambiado

- **Cambio incompatible:** el DTO de la petición de create-invite abandona el `expiresAt` absoluto en favor del `expiresInHours` relativo; si un cliente sigue enviando `expiresAt`, este se ignora silenciosamente.
- El primitivo canónico `IsoInstantString` y sus funciones auxiliares de conversión residen ahora en `@synapse/device-protocol/instant` y se reexportan desde `@synapse/shared`.
- `workspace_app_grants.created_at` se endurece a `NOT NULL` (se eliminaron los valores de respaldo a la época 1970); las columnas de duración (`retention_ttl_ms`, `poll_interval_ms`, `ttl_ms`) se ampliaron a `BIGINT` con un CHECK `>= 0`.

## [0.18.2] - 2026-06-18

### Añadido

- Logging unificado y trazado distribuido: un único logger pino con una taxonomía de dominio, OpenTelemetry con Tempo, Loki y Alloy, un consumidor de errores/rendimiento de Sentry autoalojado y con control por DSN, propagación de trazas en BullMQ, y un endpoint de ingesta de logs de cliente `/api/v1/logs` autenticado mediante una sesión de usuario o un token HMAC de dispositivo de corta duración.
- Se completaron los medios entrantes y salientes de IM sobre el pipeline direccionado por contenido: medios de DingTalk (entrantes + salientes), medios entrantes de QQ hacia el CAS, medios entrantes de WeChat (además de una corrección de la codificación de aes_key) y una comprobación de blob vacío antes de la subida saliente.

## [0.18.1] - 2026-06-17

### Cambiado

- El `CanonicalFileRef` de transporte se reduce a una única forma direccionada por contenido (sha256); los envíos salientes ahora leen los bytes desde el CAS para Feishu, QQ y WeChat, y los medios entrantes se persisten en el CAS para Feishu.

### Corregido

- Correcciones en los conectores: verificación del webhook de Feishu, normalización de menciones `@all` y vídeo entrante; la OpenAPI oficial v2 de QQ; manejo de menciones, texto enriquecido y audio en DingTalk; el conector de WeChat (WeChat personal por ilink) se realineó con el protocolo upstream (session guard, inicio de sesión por QR, CDN de medios).

## [0.18.0] - 2026-06-17

### Cambiado

- **Cambio incompatible:** las respuestas REST de la aplicación con cuerpo se envuelven ahora en un envelope `{ data }` (~173 rutas); las escrituras sin cuerpo siguen devolviendo `204`, y los endpoints de superficie de protocolo/máquina (handshake de dispositivo, `/api/v1/internal/*`, `/auth/device/*`, `/im/webhooks/*`, `/automation-webhooks/*`, `/install.{sh,ps1}`) conservan deliberadamente payloads sin envolver. Postgres se mantiene en snake_case mientras que la superficie de TypeScript es íntegramente camelCase (mediante un `CamelCasePlugin` de Kysely). El contrato de error (`{ error, code }`) queda deliberadamente sin cambios.
- La decodificación de JSON a la salida del repositorio ahora falla en modo cerrado ante payloads almacenados malformados (antes se convertían silenciosamente en `{}`) en la mayoría de los módulos.

## [0.17.0] - 2026-06-10

### Añadido

- Un modelo de Task unificado al estilo de MCP (tablas `tool_call_task_*`) con un ciclo de vida ortogonal: `lifecycle_status` × `outcome`.
- El primitivo canónico de fecha y hora `IsoInstantString`, los adaptadores `datetime/instant.ts` y la verificación de CI `guard-datetime-boundaries`.

### Cambiado

- **Cambio incompatible:** `POST .../interactions/:id/respond` → `POST .../tasks/:taskId/respond`; el evento del feed WebSocket `interaction_requested` pasa a ser `task_requested` y su payload `{interaction}` a `{task}`. Se consolidaron los metadatos raíz de workspace-app.

### Eliminado

- Las tablas `interaction_*`, `InteractionRequestSummary` y las exportaciones relacionadas, y las rutas de escritura heredadas de workspace-app.

## [0.16.0] - 2026-06-07

### Añadido

- Una capa de presentación de llamadas a herramientas calculada en el servidor: bloques de visualización, el `_meta` de MCP capturado y descriptores adjuntados automáticamente para las herramientas integradas.
- Nuevas exportaciones de `@synapse/shared` (`resolvePresentation`, `PresentationString`) y campos de presentación en `ServerToolCall`, `ToolPlugin` y los DTOs de turn-preview/activity.

## [0.15.0] - 2026-06-07

### Cambiado

- **Cambio incompatible:** la unión canónica `ToolResultOrigin` (junto con `TOOL_RESULT_ORIGIN_KINDS`) se consolidó en el vocabulario enrutado — `mcp_remote|mcp_device|callable_plugin|builtin` → `system|plugin|device|provider_native` — con nuevas formas de campos por kind, y `origin` pasó a ser un campo obligatorio en `CanonicalToolResult`/`NormalizedMcpToolResult`.
- **Cambio incompatible:** los valores del enum `ActorRuntimeToolKind` se reasignaron (`callable|mcp_plugin|mcp_device|provider_builtin` → `system|plugin|device`); los valores de los DTOs de WebSocket y de turn-preview cambiaron en consecuencia.

### Eliminado

- Las exportaciones `ExecutableModelToolKind` y `execKindForSource`.
- Los miembros de enum de catálogo/marketplace derivados de `device` (`device_derived`, `device_derivation`, `device_projection`, la fuente de catálogo `device`), el transporte de plugin `device`, las etiquetas de access-target `actor_in_conversation`/`remote_agent_in_conversation` y `conversationActorContextId`.

## [0.14.1] - 2026-06-07

### Añadido

- Soporte de HTTP/3 (QUIC) en nginx.

## [0.14.0] - 2026-06-06

### Añadido

- Procedencia y enrutamiento de herramientas (`ToolRef` + `NameRegistry`): un `toolId` determinista, un registro que asocia el nombre en el protocolo con el `toolId` y un `tool_calls.source_snapshot` inmutable.

### Cambiado

- **Cambio incompatible:** procedencia y enrutamiento de herramientas — el enrutamiento ya no analiza los nombres de las herramientas (la proyección emite `ToolRef`s deterministas más un `NameRegistry` por turno); `ToolDefinition.source`/`sourceType` se eliminaron de `@synapse/shared` (el `source` reside ahora en el `ProjectedToolDefinition` interno).

### Eliminado

- Las columnas heredadas `tool_calls.plugin_id`/`device_id` y las columnas `tool_execution_attempts.plugin_id`/`device_id`/`instance_key` (la procedencia se deriva ahora del `tool_calls.source_snapshot` padre).

## [0.13.0] - 2026-06-06

### Cambiado

- **Cambio incompatible:** se rediseñó el modelo de execution-kind de las herramientas integradas — se eliminó el campo `ToolPlugin.kind` (`action`|`callable`) y `ToolPlugin.execute` pasó a ser obligatorio; la unión `ActorRuntimeToolKind` perdió sus miembros `builtin` y `action` (ambos en `@synapse/shared`).

## [0.12.0] - 2026-06-06

### Añadido

- Una capa de proveedores del Vercel AI SDK v6 y un vendor `deepseek`.

### Cambiado

- **Cambio incompatible:** el modelo de datos de los modelos se consolida en `model_bindings` + `model_binding_versions` (en sustitución de `model_profiles`, `model_profile_revisions` y `model_group_profiles`); `provider_steps` cambió sus claves a `model_binding_id`/`model_binding_version_id`.
- **Cambio incompatible:** se rediseñó `ResolvedModelConfig` (`bindingId`, `providerKind`, `maxOutputTokens`); la exportación compartida `MODEL_PROVIDER_CATALOG` pasó a ser `MODEL_VENDOR_CATALOG` (`ModelProviderDefinition` → `ModelVendorDefinition`), con una nueva exportación `ProviderKind`.

### Eliminado

- Cuatro adaptadores de LLM implementados a mano, las exportaciones `ModelProviderAdapter*`/`EngineBranch*` y la reanudación de estado de rama nativa del proveedor.

## [0.11.3] - 2026-06-06

### Corregido

- La difusión de chat multicliente podía omitir eventos porque la asignación por miembro de `member_seq` no garantizaba una secuencia sin huecos ante inserciones concurrentes (el cursor del cliente pagina por `member_seq > cursor`). Ahora `member_seq` se asigna como `MAX+1` bajo un bloqueo consultivo de transacción por miembro (`pg_advisory_xact_lock`), lo que garantiza una secuencia contigua y ordenada por commit.

## [0.11.2] - 2026-06-06

### Añadido

- Un instalador de Node multiplataforma de un solo clic, servido en `GET /api/v1/install.sh` e `install.ps1` (verificado con sha256 y con autodetección de espejo China/internacional).

## [0.11.1] - 2026-06-05

### Añadido

- Borrado lógico con marcas de borrado (tombstoning) y vistas de lectura `_live`, una CLI de purga sin conexión (`db:purge:*`) y un control de CI de política de FK respaldado por un manifiesto de clasificación de tablas.
- Inicio de sesión OAuth con ventana emergente como vía principal y enrutamiento de errores multiplataforma (web/móvil), que completa el flujo de inicio de sesión social de Feishu.

### Cambiado

- El borrado ahora deja marcas de borrado (tombstoning): `ON DELETE CASCADE` pasó a `RESTRICT` en todo el repositorio. El SQL de operador que dependía de borrados en cascada ahora provoca violaciones de clave foránea, y la inicialización del esquema requiere el privilegio `CREATEROLE`.

### Corregido

- Las peticiones de OpenAI a los modelos de razonamiento `gpt-5*` y de la serie o (o1/o3/o4) ahora envían `max_completion_tokens` en lugar del `max_tokens` heredado, que era rechazado.

## [0.11.0] - 2026-06-04

### Añadido

- Inicio de sesión social con Feishu (Lark), más una renovación de la UX de inicio de sesión y registro (disposición de una sola columna, conmutador de visibilidad de contraseña, autosugerencia de correo electrónico, aviso de bloqueo de mayúsculas y mensajes de error de inicio de sesión específicos).
- El sandbox de actor del lado del servidor ahora puede desplegarse tanto en modo Docker como en modo local mediante nuevos scripts de despliegue (`deploy-sandbox-docker.sh` / `deploy-sandbox-local.sh`), un `docker-compose.sandbox-local.yml` y una imagen de tunnel-edge frps construida a partir de la versión oficial publicada de frp.

### Cambiado

- **Cambio incompatible:** la configuración de modelos se movió de variables de entorno a un `config/model-groups.yaml` declarativo.

### Eliminado

- `AI_PROVIDER`, `AI_ENGINE_KIND`, `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL` y `AI_MAX_TOKENS`. El chat requiere una configuración explícita de model-group; una instalación nueva arranca sin ningún modelo configurado.

## [0.10.0] - 2026-06-04

### Añadido

- Better Auth 1.6.13 para la identidad (tablas `account`/`session`/`verification`) y la autorización de dispositivos según RFC 8628.

### Cambiado

- **Cambio incompatible:** se rediseñaron los endpoints de autenticación (`/register` → `/sign-up/email`, `/login` → `/sign-in/email`, entre otros); se requiere un nuevo `BETTER_AUTH_SECRET` (con `AUTH_SECRET` / `APP_SECRET` como respaldo).

### Eliminado

- `users.password_hash`, `auth_sessions`, las seis rutas `/qr-login/*` y la concesión automática de super-admin al correo definido en la configuración.

### Seguridad

- Todas las contraseñas y sesiones quedan invalidadas al actualizar (no hay ruta de migración). Se eliminó el nombre de la cookie de sesión que estaba incrustado en el código.

## [0.9.1] - 2026-06-04

### Añadido

- Escaneo de secretos con Gitleaks integrado en un hook de pre-commit y en CI (workflow `secret-scan`), respaldado por una configuración `.gitleaks.toml` y una línea base de coincidencias conocidas y permitidas.

### Cambiado

- Endurecimiento de la autorización: sentencias switch de permisos exhaustivas y un manejo de los permisos desconocidos que falla en modo cerrado.

### Corregido

- El evaluador de permisos de workspace rechazaba la clave `manage_relays` antes de la comprobación de admin, lo que reducía silenciosamente la gestión de dispositivos a los dispositivos propios para propietarios, administradores y titulares de la clave device-admin.

## [0.9.0] - 2026-06-03

### Añadido

- Endpoints MCP remotos oficiales (AMiner, AMap, Figma) sobre HTTP y SSE, con los transportes del SDK oficial.

### Cambiado

- **Cambio incompatible:** el plugin de Mijia (domótica de Xiaomi) dejó de ser un plugin integrado dentro del proceso y siempre activo para convertirse en un sidecar controlado por variable de entorno (`MIJIA_MCP_URL`) detrás del perfil de Compose `mijia` — ahora viene desactivado por defecto en el perfil de producción.

### Eliminado

- El `McpHttpClient` implementado a mano.

## [0.8.1] - 2026-06-03

### Añadido

- El sandbox de actor incorpora una abstracción de ciclo de vida `SandboxBackend` con la forma del SDK de E2B (`create`/`connect`/`kill`/`getHost`), con un backend local y un backend Docker-outside-of-Docker de activación explícita, un endpoint de ruta rápida y un handshake de frescura `fs.hello` del fs-helper.

## [0.8.0] - 2026-06-02

### Añadido

- Un servicio de archivos direccionado por contenido (`content_blobs`, `file_assets`, `file_spaces`, `file_snapshots`, `file_mounts`) indexado por sha256.
- Un módulo de sandbox de actor del lado del servidor: ciclo de vida por sesión, un proveedor de host local que lanza procesos hijos del device-runtime, materialización del conjunto de trabajo sobre el nuevo servicio de archivos (tablas `file_snapshots`, `file_mounts`), además de grants de sandbox, GC y gestión de avisos de conflicto.

### Cambiado

- **Cambio incompatible:** el envelope de cifrado pasó de `enc:` a `enc:v2:` (KDF scrypt) sin ruta de recifrado; se eliminó la vía de escape para consultas bare-pg al unificarse la capa de datos en Kysely.

### Eliminado

- El motor de ASR por lotes sherpa-onnx-node que se ejecutaba dentro del proceso.

### Seguridad

- Validación Zod de la configuración de entorno que falla de inmediato, endurecimiento contra SSRF (incluidas las direcciones IPv6 entre corchetes) y un nuevo redactor de secretos que falla en modo cerrado, `redactSecrets`. Se añade una nueva variable obligatoria, `SYNAPSE_REGISTRY_DOMAIN`.

## [0.7.1] - 2026-06-01

### Añadido

- Un registro npm privado Verdaccio autoalojado para distribuir el device-runtime y el daemon de agentes remotos; `publishConfig` en diez paquetes.

## [0.7.0] - 2026-05-31

### Cambiado

- **Cambio incompatible:** todos los workspaces migraron a Zod 4 (fijado en `4.3.6`); que una conversación sea o no una conversación de IM ahora se deriva de su binding de transporte, lo que rediseña los DTOs de chat-create y add-participant.

### Eliminado

- El diseño A2A heredado (`A2AApp`, `A2AAgentCard` y las exportaciones relacionadas), `CONVERSATION_BOUNDARY`/`CONVERSATION_BOUNDARIES` y `systemRef`.

## [0.6.1] - 2026-05-29

### Añadido

- Un subsistema por agente de foco de sesión de computer-use (CUA).

## [0.6.0] - 2026-05-29

### Añadido

- Una capacidad de navegador vía chrome-devtools-mcp, con una proyección consciente de las operaciones y grants manuales.

### Cambiado

- El `RuntimeBrowserPolicySchema` del protocolo de dispositivos incorpora una lista de permitidos `operations` aditiva a nivel de operación (el comparador falla en modo cerrado ante una entrada ausente).
- **Cambio incompatible:** el `DeviceCapabilitySummarySchema` del protocolo de dispositivos añade un campo obligatorio `exposure_stable_key` (además de un `metadata` opcional aditivo).

## [0.5.0] - 2026-05-29

### Añadido

- La capacidad de terminal v2 (`exec_file`, `powershell`) con una cadena de herramientas empaquetada, y seis paquetes de plataforma `device-runtime-bundles-*` distribuidos mediante Git LFS.

### Cambiado

- **Cambio incompatible:** se rediseñó el esquema `CommandlinePolicy` del protocolo de dispositivos. Compilar el proyecto ahora requiere Git LFS.

## [0.4.0] - 2026-05-29

### Añadido

- La CLI npm de `@synapse/device-runtime` (`synapse-device`), una capacidad de sistema de archivos de dispositivo (13 herramientas) respaldada por un nuevo sidecar fs-helper en Rust, y conectores de QQ (OpenAPI oficial v2) y DingTalk (Stream).

### Cambiado

- **Cambio incompatible:** el plano de control de dispositivos se movió a un endpoint WebSocket `GET /api/v1/devices/control-plane` (tramas JSON-RPC 2.0); la identidad del dispositivo ahora usa dos pares de claves; el emparejamiento se movió a `POST /api/v1/devices/pairing-sessions/consume`. Compilar el proyecto ahora requiere una cadena de herramientas de Rust (para el sidecar fs-helper).

### Eliminado

- Todo el subsistema Go `relay/` (−66 599 líneas): la CLI del relay, la GUI de escritorio, el agente y el montaje FUSE; `/ws/relay`; trece tablas `relay_*`; el manifiesto de autoactualización del relay; y la fijación de clave pública TLS.

### Seguridad

- Una nueva variable obligatoria, `SYNAPSE_DEVICE_TRUSTED_SERVER_KEYS` (si no está definida, se rechaza toda llamada a herramienta), y un túnel frp obligatorio para el despacho de herramientas.

## [0.3.0] - 2026-05-27

### Añadido

- Una dimensión de ámbito en el modelo de sujetos (`ScopedSubjectTarget`, `scope_subject_id`) y endpoints REST para `memory_access_grants`.

### Cambiado

- **Cambio incompatible:** `AccessTarget` y `CapabilityAccessTarget` se rediseñaron sobre `ScopedSubjectTarget`.
- **Cambio incompatible:** los DTOs de memoria se rediseñaron sobre el modelo de sujetos: `MemoryEntry` sustituye los campos `spaceType`/`ownerScope` y el id de propietario por `owner`/`scope` (`SubjectRef`) más `namespaceKey`; los eventos de feed `memory_saved`/`memory_updated` cambian `memorySpaceType` por `memoryOwner`/`memoryNamespaceKey`; y `RelayAuthorizationGrantSummary.scope` (enum) pasa a ser `subject` más un `scope` opcional (ambos `SubjectRef`).

### Eliminado

- Los tipos heredados de access-target, `MEMORY_SCOPES`/`MEMORY_SPACE_TYPES` y `relay_authorization_grants.scope`.
- La variante de sujeto `conversation_actor_context` — `SUBJECT_KIND.CONVERSATION_ACTOR_CONTEXT`, `ACCESS_RESOURCE_TYPE.CONVERSATION_ACTOR_CONTEXT` y las exportaciones `conversationActorContextRef` / `isConversationActorContextSubject` (el caso de actor-en-conversación ahora es `actor` + `scope=conversation`).

## [0.2.0] - 2026-05-25

### Añadido

- Un registro `access_subjects` que unifica el modelo de sujetos, antes polimórfico, sobre un único `subject_id`.
- Una abstracción de IM `TransportConnector` con un registro de conectores, más conectores funcionales de Feishu (Lark), Weixin (WeChat personal) y WeCom (Feishu y Weixin eran hasta ahora stubs de capacidad de 9 líneas), un endpoint de reverse-MCP por conversación, una abstracción `AgentDriver` para el daemon de agentes remotos, y el despliegue de producción con Docker Compose (perfiles `tls`/`http`/`certbot`).

### Cambiado

- **Cambio incompatible:** las rutas de conversación e interacción se movieron bajo `/chat/*` (las URLs heredadas devuelven 404); los nombres de eventos de WebSocket pasaron a la forma con puntos (`auth_error` → `auth.error`, `server_shutdown` → `server.shutdown`); Docker Compose ahora falla de inmediato si falta alguna de las once variables de entorno obligatorias adicionales (`APP_BASE_URL`, `SYNAPSE_PUBLIC_DOMAIN`, entre otras), lo que eleva el conjunto obligatorio a quince.

### Eliminado

- El despliegue con systemd en el host (unidades de systemd y scripts de arranque); las exportaciones `Message`, `MessageType`, `ConversationSummary`, `SESSION_CHANNELS` y `ChannelType` de `@synapse/shared`; el montaje bare `/files/*`; y `sessions.channel_type`.

## [0.1.0] - 2026-05-20

La primera versión. Synapse es un runtime autoalojado y centrado en la conversación para compañeros de equipo digitales: actores de IA y agentes de programación puenteados se incorporan a tus workspaces y colaboran contigo dentro de las conversaciones, accesibles desde las aplicaciones de mensajería (IM) que ya usas. La propia conversación es la frontera de colaboración: gobierna los participantes, la visibilidad del historial, la ejecución de actores, los despertares y el traspaso de memoria.

### Añadido

- **Modelo de conversación** — toda la colaboración ocurre en un grafo de conversación agnóstico al canal: `conversations` (kinds group/private/virtual, una frontera internal/external), `conversation_participants` polimórfico (workspace_member, actor, remote_agent, external, system) con marcas de lectura por participante, y un registro tipado `conversation_items` (message/event/summary/control; roles user/assistant/system/tool) que lleva ámbito shared/private, superficie visible/internal, políticas de fan-out de eventos, una secuencia monótona por conversación, encadenamiento de reply/cause, cuerpos multiparte (text/file_ref/json) y direccionamiento to/cc/visible con menciones.
- **Conectores de IM** — chatea con tus compañeros de equipo desde las aplicaciones de mensajería que ya usas: un bot de Feishu (飞书) (webhook + long-connection, directo + grupo) y Weixin (WeChat personal) mediante emparejamiento por QR (long-connection, solo directo), al frente de los cuales opera una abstracción de transporte genérica de cinco tablas (accounts, endpoints, bindings por conversación, addresses, enlaces de entrega por item).
- **Actores nativos de la plataforma** — compañeros de equipo de IA con ámbito de workspace que se ejecutan en la nube, con roles tipados (secretary/manager/specialist/reviewer/archivist/receptionist/assistant), una jerarquía de actores, `can_represent_user` y un historial completamente versionado (`actor_versions`) cuya procedencia atribuye cada edición a un miembro, un actor, el sistema o una fuente de sincronización.
- **Agentes remotos puenteados** — trae tus propios agentes de programación: runtimes agénticos externos (Claude Code, Codex) que se ejecutan en la propia máquina del usuario se incorporan a los workspaces como participantes a través del `remote-agent-daemon`, un driver local de Node que abre una conexión saliente por WebSocket, sondea las CLIs instaladas, las lanza en cada turno y puentea el chat mediante un servidor MCP stdio inyectado — con emparejamiento/confianza de máquina, colaboración con aprobación de planes y grants de interacción en grupo.
- **Herramientas de dispositivo vía el relay de Go** — da a los agentes acceso controlado a una máquina física: un agente independiente en el dispositivo (la CLI `synapse-relay`, una GUI de escritorio Wails, un montaje FUSE) empareja la máquina y la expone a la nube como herramientas MCP autorizadas sobre un protocolo de despacho WebSocket versionado, y hospeda servidores integrados de computer-use (CUA), de sistema de archivos con ámbito acotado, de Chrome DevTools empaquetado y de línea de comandos.
- **Gobernanza y permisos del workspace** — RBAC de dos niveles: `platform_access_bindings` a nivel de plataforma (super_admin/workspace_admin/model_admin/support/auditor) con bootstrap del super-admin por configuración de entorno, y `workspace_members` a nivel de workspace (admin/member/guest) con ocho claves de capacidad de administración de grano fino, invitaciones basadas en token y una ACL polimórfica `resource_access_bindings` que concede recursos a sujetos workspace/conversation/actor.
- **Autenticación** — una pila de identidad implementada a mano: inicio de sesión por contraseña con bcrypt, sesiones bearer opacas sha256 (cookie o encabezado Authorization) con metadatos de cliente/transporte y ciclo de vida, y una máquina de estados completa, de doble token, para el inicio de sesión por QR entre dispositivos.
- **Compañeros de equipo y contactos compartibles** — un grafo de relaciones al estilo de WeChat, por workspace, sobre miembros, actores y agentes remotos: perfiles de identidad compartibles con IDs buscables y tokens QR, solicitudes de amistad con aprobación automática o manual y entradas aceptadas en la lista de contactos.
- **Catálogo y marketplace** — instala y comparte capacidades empaquetadas: un eje publisher → item → version sobre tres kinds de paquete (actor_template, skill_package, plugin_package) con categorías, archivos de versión y especificaciones por kind; ingesta de skills desde fuentes espejo de GitHub/ClawHub hacia instantáneas analizadas; y tablas de runtime, por tenant del workspace, de skills instaladas y de instalaciones de plugins, con sesiones de autenticación de plugin al estilo OAuth y conexiones por propietario.
- **Grupos de modelos y proveedores de LLM** — cuatro adaptadores de proveedor implementados a mano (Anthropic Messages, OpenAI Chat Completions, OpenAI Responses, BigModel/Zhipu GLM) tras un catálogo estático de proveedores, más enrutamiento respaldado por la base de datos: perfiles de modelo versionados, `model_groups` con estrategias weighted-random/round-robin/priority-failover y políticas de intentos, grants con ámbito y asignaciones actor→group; el proveedor y el modelo del runtime se seleccionan por variable de entorno.
- **Herramientas y plugins MCP** — un host de plugins MCP de cuatro transportes (builtin, stdio, http, relay) sobre una taxonomía de herramientas de siete kinds, que incluye siete plugins integrados (feishu, aminer, amap, github, gitlab, mijia y el toolkit z-ai de Zhipu, que abarca búsqueda, lectura, OCR/visión, audio/voz, generación de medios y moderación), con aprobación de permisos en runtime y ámbito de montaje/reutilización.
- **Memoria** — los compañeros de equipo recuerdan: memoria semántica híbrida dentro del proceso, particionada en cinco ámbitos (workspace_shared, conversation_shared, actor_private, participant_private, user_private) y siete categorías de item, que combina recuperación léxica (FTS + trigram) y vectorial mediante un modelo `multilingual-e5-small` de transformers.js empaquetado (VECTOR(384), HNSW cosine) que genera los embeddings localmente sin ningún sidecar externo, más ejecuciones de recuperación registradas.
- **Despliegue autoalojado** — funciona en un único host Ubuntu: nginx como punto de entrada público, systemd para la API y la web de escritorio (`packages/web-next`), PostgreSQL dockerizado (pgvector/pg16) y Redis 7, una imagen de la API ejecutada con tsx, y un perfil de Compose `production` para la pila completa en contenedores. Incluye una app móvil de Expo, así como el README y el CHANGELOG en inglés, 简体中文 y Español.

[Unreleased]: https://github.com/zai-org/Synapse/compare/v0.28.0...HEAD
[0.28.0]: https://github.com/zai-org/Synapse/compare/v0.27.0...v0.28.0
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
