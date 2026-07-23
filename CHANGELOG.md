# Changelog

**English** · [简体中文](./CHANGELOG_CN.md) · [Español](./CHANGELOG_ES.md)

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> [!WARNING]
> Synapse is still in an early design and implementation phase (pre-1.0, currently
> `0.1.0`). Under SemVer's 0.x rules any release may include breaking changes, and
> backwards compatibility for old data is not guaranteed. Breaking changes are reconciled
> by rebuilding the database (`npm run db:rebuild`) and redeploying, not by migrations —
> see [`deploy.md`](./deploy.md).

## [Unreleased]

Distributed-tracing round-2 correctness fixes (commits `defdece3`, `f6c456b5`, `cd615060`,
`79ddc845`). They change wire, queue, and telemetry contracts and require a **coordinated
redeploy** — the exact procedure (hard build order, `--force-recreate`, and a
post-recreate verification checklist) is the rollout runbook in
[`docs/logging-refactor/04-operations.md`](./docs/logging-refactor/04-operations.md) §7. No
database schema changed, so this release needs no `db:rebuild`.

### Breaking

- **Chat outbox queue-state version bump (mobile).** The offline chat outbox's stored
  queue state was bumped to a new version as a clean break. Any messages left
  queued-but-unsent by a previous build are dropped on upgrade; the mobile app
  re-bootstraps its outbox on first load. No already-sent message and no server-side data
  is affected.
- **Remote-agent daemon wire protocol.** The `fail-deliveries` frame body was reshaped and
  a new `agent:deliveries:completed` frame was added (both now carry the signed
  `wireTraceContextFields`, not bare strings). A daemon built before this change receives
  `400` for those frames until it is rebuilt and republished (`deploy.md` §5b); affected
  deliveries stay pending and re-notify, so no data is lost. `AgentSession.setMcpServers`
  was removed from the driver interface.
- **`@fastify/otel` per-hook spans removed; egress propagator fails closed; OTel
  service-name precedence corrected (api).** `@fastify/otel` was upgraded to 0.20.1 with
  `instrumentHooks:false`, so each request now produces a single SERVER span and the 8
  per-request lifecycle-hook spans are gone — any dashboard or alert querying
  `fastify.type=hook` loses that data. The first-party egress propagator now fails closed
  unconditionally: it no longer emits an unsampled flags-`00` `traceparent` (nor an
  inherited vendor `tracestate`) to third parties. `OTEL_SERVICE_NAME` and
  `OTEL_RESOURCE_ATTRIBUTES` now correctly override the built-in service name (the previous
  precedence was inverted) — a deployment that relied on the old behavior will see its
  reported service name change. (Sentry defaulting to errors-only drops span volume but is
  not itself breaking.)
- **Inbound `tracestate` cap and grammar tightened.** `MAX_TRACESTATE_LENGTH` was
  reconciled down from 1024 to 512 (the value `@opentelemetry/core` 2.8.0 actually
  enforces) and the `tracestate` key grammar was widened to the W3C trace-context Level-2
  superset. An inbound `tracestate` longer than 512 characters or with more than 32 members
  is now dropped as a whole rather than silently partial-salvaged.

### Added

- **Public-edge rate limiting and Ring-0 ingress marker.** Generous rate limiting on the
  two public nginx templates — `limit_req` on `/api/` and `limit_conn` on `/ws` (`429` not
  `503`; a normal ~30-request page load never trips it), IPv6 keyed per `/64` on the TLS
  edge (njs) or per-address on the http profile. Also the unspoofable
  `x-synapse-trace-ingress` Ring-0 marker, an optional `SYNAPSE_TRACE_SAMPLING_SALT` for
  the keyed ratio sampler, and explicit Tempo `overrides.defaults` bounds. Thresholds and
  knobs are documented in
  [`docs/logging-refactor/04-operations.md`](./docs/logging-refactor/04-operations.md) §6
  (rate limits) and §1 (environment variables). Not a breaking change.
