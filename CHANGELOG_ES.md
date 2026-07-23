# Registro de cambios

[English](./CHANGELOG.md) · [简体中文](./CHANGELOG_CN.md) · **Español**

Este archivo documenta todos los cambios relevantes del proyecto.

El formato se basa en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el
proyecto procura seguir el [Versionado Semántico](https://semver.org/lang/es/spec/v2.0.0.html).

> [!WARNING]
> Synapse sigue en una fase temprana de diseño e implementación (pre-1.0, actualmente
> `0.1.0`). Según las reglas 0.x de SemVer, cualquier versión puede incluir cambios que
> rompen la compatibilidad, y por ahora no se garantiza la compatibilidad con datos
> antiguos. Los cambios incompatibles se reconcilian reconstruyendo la base de datos
> (`npm run db:rebuild`) y redistribuyendo, no mediante migraciones — véase
> [`deploy.md`](./deploy.md).

## [Unreleased]

Correcciones de la ronda 2 sobre la exactitud del trazado distribuido (commits `defdece3`,
`f6c456b5`, `cd615060`, `79ddc845`). Cambian contratos de wire, de cola y de telemetría, y
requieren un **redespliegue coordinado**: el procedimiento exacto (orden de compilación
obligatorio, `--force-recreate` y una lista de verificación posterior al recreate) es el
runbook de despliegue en
[`docs/logging-refactor/04-operations.md`](./docs/logging-refactor/04-operations.md) §7. No
cambió ningún esquema de base de datos, así que esta versión no necesita `db:rebuild`.

### Breaking (cambios incompatibles)

- **Aumento de versión del estado de la cola del outbox de chat (móvil).** El estado de la
  cola almacenada del outbox de chat sin conexión se subió a una nueva versión como ruptura
  limpia. Los mensajes que una compilación anterior dejó en cola pero sin enviar se
  descartan al actualizar; la app móvil reconstruye su outbox en la primera carga. Ningún
  mensaje ya enviado ni ningún dato del servidor se ve afectado.
- **Protocolo wire del daemon de agentes remotos.** Se reestructuró el cuerpo de la trama
  `fail-deliveries` y se añadió una nueva trama `agent:deliveries:completed` (ambas llevan
  ahora los `wireTraceContextFields` firmados, no cadenas sueltas). Un daemon compilado
  antes de este cambio recibe `400` para esas tramas hasta que se recompile y republique
  (`deploy.md` §5b); las entregas afectadas quedan pendientes y vuelven a notificar, por lo
  que no se pierden datos. Se eliminó `AgentSession.setMcpServers` de la interfaz del
  driver.
- **Spans por hook de `@fastify/otel` eliminados; el propagador de salida falla cerrado; se
  corrige la precedencia del nombre de servicio de OTel (api).** `@fastify/otel` se
  actualizó a 0.20.1 con `instrumentHooks:false`, de modo que cada solicitud produce ahora
  un único span SERVER y desaparecen los 8 spans de hooks de ciclo de vida por solicitud —
  cualquier panel o alerta que consulte `fastify.type=hook` pierde esos datos. El
  propagador de salida de primera parte ahora falla cerrado incondicionalmente: ya no emite
  a terceros un `traceparent` no muestreado con flags `00` (ni un `tracestate` de proveedor
  heredado). `OTEL_SERVICE_NAME` y `OTEL_RESOURCE_ATTRIBUTES` ahora sí anulan el nombre de
  servicio interno (antes la precedencia estaba invertida) — un despliegue que dependía del
  comportamiento anterior verá cambiar el nombre de servicio reportado. (Que Sentry quede
  por defecto solo en errores reduce el volumen de spans, pero eso en sí no es un cambio
  incompatible.)
- **Límite y gramática de `tracestate` entrante endurecidos.** `MAX_TRACESTATE_LENGTH` se
  redujo de 1024 a 512 (el valor que `@opentelemetry/core` 2.8.0 realmente impone) y la
  gramática de claves de `tracestate` se amplió al superconjunto Nivel 2 de W3C
  trace-context. Un `tracestate` entrante de más de 512 caracteres o con más de 32 miembros
  ahora se descarta por completo, en lugar de recuperarse parcialmente en silencio.

### Added (añadido)

- **Limitación de tasa en el borde público y marcador de ingreso Ring-0.** Limitación
  generosa en las dos plantillas públicas de nginx — `limit_req` en `/api/` y `limit_conn`
  en `/ws` (`429`, no `503`; una carga de página normal de ~30 solicitudes nunca lo
  dispara), IPv6 con clave por `/64` en el borde TLS (njs) o por dirección en el perfil
  http. También el marcador Ring-0 infalsificable `x-synapse-trace-ingress`, un
  `SYNAPSE_TRACE_SAMPLING_SALT` opcional para el muestreador de proporción con clave, y
  límites explícitos de Tempo `overrides.defaults`. Los umbrales y perillas están
  documentados en
  [`docs/logging-refactor/04-operations.md`](./docs/logging-refactor/04-operations.md) §6
  (límites de tasa) y §1 (variables de entorno). No es un cambio incompatible.
