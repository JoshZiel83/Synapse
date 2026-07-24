# Changelog

**English** · [简体中文](./CHANGELOG_CN.md) · [Español](./CHANGELOG_ES.md)

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> [!WARNING]
> Synapse is still in an early design and implementation phase (pre-1.0). Under SemVer's
> 0.x rules, any release may include breaking changes, and backward compatibility for
> existing data is not guaranteed — breaking changes are handled by rebuilding the database
> (`npm run db:rebuild`) and redeploying, not by migrations (see [`deploy.md`](./deploy.md)).
> Within `0.x`, a **minor** bump (`0.Y.0`) signals a consumer-facing break (REST/WebSocket
> routes and DTOs, the device-protocol wire contract, `@synapse/shared` exports,
> authentication, or a removed capability), while a **patch** (`0.y.Z`) is backward
> compatible. The tagged versions below, through `0.27.0`, retroactively reconstruct the
> history of the `dev` line, during which the package manifests stayed at `0.1.0`; `0.28.0`
> is the first release published to the package registry, and from it onward the manifests
> carry the released version.

## [Unreleased]

## [0.28.0] - 2026-07-24

Distributed-tracing round-3 correctness fix (commits `c068aef3`, `9b5a30c8`, `92645a74`): turn-scoped trace correlation for reverse-MCP tool calls across interleaved conversation wakes (F-r3-2). It changes the remote-agent daemon wire contract and requires a **coordinated redeploy** — the strict image build order and post-recreate checks are covered by the rollout runbook in [`docs/logging-refactor/04-operations.md`](./docs/logging-refactor/04-operations.md) §7, with the R3 daemon-first cutover order in §7.4. No database schema changed, so this release needs no `db:rebuild`.

This is also the first release in which the package manifests leave `0.1.0`: the coordinated set — `@synapse/device-protocol`, `@synapse/shared`, `@synapse/device-runtime`, `@synapse/device-sdk`, `@synapse/api`, and `@synapse/remote-agent-daemon` — is bumped in lockstep to `0.28.0`, and the four runtime packages are published to the private package registry. The platform runtime bundles stay decoupled at their own version.

### Changed

- **Breaking:** the remote-agent daemon wire gains an optional `turn_epoch` on both `agent:deliver` (api→daemon) and `agent:status` (daemon→api). Both frames validate as `z.strictObject`, so a peer built before this change strict-rejects the whole frame instead of ignoring the new field. Publishing to the registry stays dependency-ordered — `@synapse/device-protocol` → `shared` → `device-runtime` → `remote-agent-daemon` last (`deploy.md` §5b) — but the running deployment is rolled out **daemon first**: because the strict field lands on `agent:deliver`, upgrading the daemon ahead of the api keeps the delivery path clean (an old api simply omits the field), leaving only the daemon's `agent:status` frame dropped by a not-yet-upgraded api (turn correlation degraded, never a lost delivery). The reverse order would strict-reject every `agent:deliver` carrying the field and churn deliveries instead (still at-least-once — nothing is lost). The R3 cutover order is [`docs/logging-refactor/04-operations.md`](./docs/logging-refactor/04-operations.md) §7.4.
- The publishable @synapse packages are now a coordinated-redeploy set pinned to a single exact version; a new `guard:versions` gate (run in `verify:boundary`) enforces the lockstep version, the intra-set exact pins, the decoupled platform bundles, and package-lock sync.

### Fixed

- Interleaved conversation wakes no longer cross traces (F-r3-2): a late reverse-MCP `tools/call` from one turn is attributed to that turn's own delivery origins, never a concurrently-woken successor's. The daemon now holds an authoritative per-turn epoch behind a turn gate (one turn per conversation at a time; racing wakes queue in dispatch order and fire one at a time), the api keys its reverse-MCP span links on the daemon-confirmed running epoch, and turn completion drains exactly that epoch's pending set. A stale-machine-connection reaper finalizes a socket the OS never closed, and each driver emits at most one terminal signal per turn so the gate can never double-advance.

## [0.27.0] - 2026-07-23

Distributed-tracing round-2 correctness fixes (commits `defdece3`, `f6c456b5`, `cd615060`, `79ddc845`) plus public-edge hardening. For operators, the headline is a **coordinated redeploy**: this release changes wire, queue, and telemetry contracts, and the exact procedure — a strict image build order, `--force-recreate`, and a post-recreate verification checklist — is the rollout runbook in [`docs/logging-refactor/04-operations.md`](./docs/logging-refactor/04-operations.md) §7. No database schema changed, so this release needs no `db:rebuild`.

### Changed

- **Breaking:** chat messages left queued-but-unsent by a previous build are dropped on upgrade. The offline chat outbox's stored queue state was version-bumped as a clean break on **both web and mobile** (mobile snapshot v2→v3; shared `StoredChatQueueState` v4→v5, including the service worker); clients rebuild the outbox on first load. Already-sent messages and server-side data are unaffected.
- Remote-agent daemons should be rebuilt and republished (`deploy.md` §5b): a new `agent:deliveries:completed` frame (api→daemon) reclaims the daemon's pending-delivery set, and daemon-frame trace fields are gated behind `wireTraceContextFields` (schema-validated; malformed values degrade to absent). A daemon built before this change silently ignores the new frame until it is republished — affected deliveries stay pending and re-notify, so nothing is lost. `AgentSession.setMcpServers` was removed from the driver interface, and a CI guard now enforces api↔daemon frame parity. (The `fail-deliveries` body reshape shipped in v0.26.0.)
- Dashboards or alerts querying `fastify.type=hook` spans lose that data: with `@fastify/otel` 0.20.1 and `instrumentHooks:false`, each request now produces a single SERVER span, and the per-request lifecycle-hook spans are gone. The first-party egress propagator now fails closed unconditionally (no flags-`00` `traceparent` nor inherited vendor `tracestate` to third parties), and `OTEL_SERVICE_NAME`/`OTEL_RESOURCE_ATTRIBUTES` now correctly override the built-in service name (the previous precedence was inverted).
- Inbound `tracestate` handling tightened: `MAX_TRACESTATE_LENGTH` reconciled down from 1024 to 512 (the value `@opentelemetry/core` 2.8.0 enforces), with the key grammar widened to the W3C Level-2 superset. A header longer than 512 characters, with more than 32 members, duplicate keys, over-long values, or malformed members is now dropped as a whole rather than partially salvaged.
- Dependency patching moved from `patch-package` to a first-party `scripts/apply-patches.mjs` applier (postinstall and the api/web/mobile-web Dockerfiles). A device runtime installed from npm ships without the Go/Rust helper binaries and now degrades gracefully with a startup warning.

### Added

- Public-edge rate limiting on the two public nginx templates — `limit_req` on `/api/` and `/ws` plus `limit_conn` on `/ws` (returning `429`, not `503`; a normal page load never trips it), IPv6 keyed per `/64` at the TLS edge (njs). Also the unspoofable `x-synapse-trace-ingress` Ring-0 marker, an optional `SYNAPSE_TRACE_SAMPLING_SALT` for the keyed ratio sampler, explicit Tempo `overrides.defaults` bounds, and a startup warning when `SYNAPSE_SERVER_TIMING_TRACE=on` coexists with a ratio sampler. Thresholds and knobs: [`docs/logging-refactor/04-operations.md`](./docs/logging-refactor/04-operations.md) §6 and §1.
- Client and native-sidecar trace coverage: on web and mobile, trace carriers now come from real SDK spans (fabricated span ids eliminated), with short client spans around WebSocket auth/subscribe frames; the Go cua-helper and the Rust fs-helper emit per-RPC SERVER spans with JSON-RPC semconv attributes.
- Turn-scoped trace-carrier lifetimes on both the api (`TurnCarrierCache`) and the daemon (turn-epoch), fixing reverse-MCP span attribution; a new `OTEL_TRACES_EXPORTER` tri-state switch (unset/`otlp`/`none`) and case-insensitive `OTEL_TRACES_SAMPLER` normalization; and new `@synapse/shared` tracestate helpers (`sanitizeTracestateHeader`, `isValidTracestateHeader`, grammar constants) — all additive.
- This retroactive trilingual changelog (English, 简体中文, Español), reconstructing the release history v0.1.0–v0.26.2 with 50 annotated tags.
- CI: cross-language tests are gated for the first time (`go test` for the cua sidecar, `cargo test` for fs-helper), and the trace-propagation guard gained frame-parity and turn-scope rules.

### Fixed

- Daemon fan-in carrier cache: at the 20-entry cap, dedupe now evicts the oldest carrier instead of dropping the newest — previously the current turn's origin carrier could be the one discarded.

## [0.26.2] - 2026-07-17

### Fixed

- Remote-agent daemon: fan-in fail-delivery reports no longer inherit an ambient delivery trace; the API mints a fresh root span that links all origins, fixing mixed-origin correlation.

## [0.26.1] - 2026-07-17

### Added

- End-to-end trace propagation across the edge and frontend: at the trust boundary nginx strips inbound vendor trace-state headers (`tracestate`, `baggage`, `sentry-trace`) while forwarding W3C `traceparent` (which the API validates at extract, treating its flags as advisory), and the web and mobile clients bridge browser spans over that `traceparent`.

## [0.26.0] - 2026-07-17

### Added

- Trace consumers: daemon fan-in links, dispatch carrier, BullMQ producer spans, and OpenTelemetry across the Python sidecars. `resolution_traceparent` is persisted so a replayed resolution frame keeps the resolver's trace.

### Changed

- **Breaking:** the `POST /api/v1/internal/remote-agents/:remoteAgentId/fail-deliveries` request body was reshaped.

## [0.25.5] - 2026-07-17

### Added

- Device-protocol envelope trace-carrier schemas and per-message WebSocket tracing. Trace fields are tolerant — a malformed or oversized value degrades to absent rather than rejecting the message.

## [0.25.4] - 2026-07-16

### Changed

- OpenTelemetry now owns sampling and export; Sentry is demoted to a consumer. `SENTRY_TRACES_SAMPLE_RATE` is repurposed as a Sentry forward-rate.

## [0.25.3] - 2026-07-15

### Added

- Shared tracing foundation: a first-party trace-carrier contract, propagator, and a `@fastify/otel` patch.

## [0.25.2] - 2026-07-15

### Removed

- The reserved-but-inert `pty` capability machinery: the `pty` builtin-kind enum member, its policy, and the grant-creation reject path. Creating a pty grant had always failed with HTTP 400 (`pty_not_supported`); it was never a routable capability.

### Fixed

- The API Docker image builds again, ending a 14-day breakage caused by an unguarded `cp -r` of an assets path the icon refactor had deleted.
- Two off-box sandbox symlink escapes: an arbitrary host write through a base-snapshot symlink, and read-side host-file exfiltration through `envd`'s stat-follows-symlink behavior.
- A data-free convergence livelock in the off-box teardown path.

## [0.25.1] - 2026-07-13

### Added

- `cubesandbox:bare` off-box sandbox provider (E2B-compatible wire) with lexical path confinement — the first remote runtime adapter.

## [0.25.0] - 2026-07-12

### Added

- `runtimes` supertype: devices and sandboxes become detail tables on a single polymorphic `runtime_id`.
- Sandbox runtime-generalization: a `${provider}:${mode}` adapter registry with on-box `local:bare` and `docker:bare` bare adapters and a new `SANDBOX_MODE` (`resident`|`bare`|`auto`) operator setting — the substrate the off-box provider in 0.25.1 builds on.

### Changed

- **Breaking:** `device_*` renamed to `runtime_*` across the schema, the device-protocol wire contract (`DEVICE_*` → `RUNTIME_*` enums, `DeviceHelloParams` → `RuntimeHelloParams`, `pendingDeviceId` → `pendingRuntimeId`), and `OperationEnvelope` fields.

### Removed

- The `device_sync_sources` table and its `DEVICE_SYNC_SOURCE_KINDS`/`DEVICE_SYNC_MODES`/`DEVICE_SYNC_STATUSES` exports (dropped outright — no `runtime_*` replacement). The other 14 `device_*` tables and their `Device*` exports from `@synapse/device-protocol` were renamed rather than removed (see Changed).

## [0.24.1] - 2026-07-03

### Added

- Env-selected document extraction (`DOCUMENT_EXTRACTION_PROVIDER`) with an Apache Tika sidecar (PDF, DOCX, Markdown), enabled by default on the production profile, plus opt-in cloud providers (TextIn xParse, and an async LlamaParse path with a reconciliation sweeper). This completes the provider-abstraction work: the API image now bundles no inference engines.

### Removed

- The bundled `pdf-parse` dependency.

## [0.24.0] - 2026-07-03

### Removed

- **Breaking:** the `audit_logs` compliance feature, end to end — the `GET /api/v1/workspaces/:workspaceId/audit-logs` route, the `AuditLog*` exports, and the `auditor` platform role. (This is distinct from `/api/v1/logs` and `/api/v1/reports`, which remain.)

## [0.23.1] - 2026-07-03

### Added

- Env-selected embedding (`EMBEDDING_PROVIDER`) with a self-hosted bge-m3 sidecar plus a generic OpenAI-compatible adapter for cloud/self-hosted embedding vendors.

### Changed

- Memory vectors change from `VECTOR(384)` to `VECTOR(1024)` (e5-small → bge-m3); existing embeddings must be regenerated.

### Removed

- The bundled `@huggingface/transformers` dependency.

## [0.23.0] - 2026-07-02

### Added

- A self-hosted `sherpa-stream` realtime-ASR sidecar and a provider session-factory.

### Changed

- **Breaking:** `ASR_PROVIDER` now defaults to `none`. Existing realtime-ASR deployments must set `ASR_PROVIDER=volcengine`, or the `/ws/asr` dictation gateway goes silent.

## [0.22.2] - 2026-07-02

### Added

- Env-selected batch transcription with sherpa-onnx and faster-whisper sidecars (the `asr` Compose profile), restoring batch audio transcription as an out-of-process capability.

## [0.22.1] - 2026-07-02

### Added

- Env-selected OCR (`OCR_PROVIDER`) with tesseract and PP-OCRv6 sidecars, defaulting to tesseract on the production profile.

### Removed

- The bundled `tesseract.js` dependency.

## [0.22.0] - 2026-07-01

### Added

- A backend-free `web-next-design` UI sandbox (typed fake `ApiClient`) for design iteration.

### Changed

- **Breaking:** brand icons for IM and MCP plugins are now React components; the `iconUrl`, `pluginIconUrl`, and `iconAssetPath` response fields were removed.

### Removed

- `PLATFORM_ASSET_FILE_ORIGIN_SYSTEMS` exports and the MCP icon-seed pipeline.

## [0.21.2] - 2026-07-01

### Added

- Compile-time contract-parity assertions across all shared type/schema pairs, plus new `@synapse/shared` exports (persisted content-block schema, transport-account schemas, and others).

### Fixed

- Drift between hand-written types and their Zod schemas.

## [0.21.1] - 2026-06-22

### Added

- Firecrawl (hosted remote MCP) plus Notion, Xiaohongshu (小红书), and Bilibili MCP sidecars — all env-gated; the three sidecars share a new `_mcp_base` Python framework onto which the existing Mijia plugin was also migrated.

## [0.21.0] - 2026-06-21

### Added

- Telegram (Bot API), WhatsApp (Cloud API), and WhatsApp-unofficial (Baileys QR) connectors, plus an ffmpeg voice transcoder.
- Edge compression: a custom nginx build with Brotli, Zstandard, and RFC 9842 (`.dcb`/`.dcz`) delta-dictionary compression.
- Browser telemetry ingest: `POST /api/v1/reports` (NEL / Reporting API) and a `Server-Timing`/`traceresponse` header exposing the request trace id on every response.

### Changed

- **Breaking:** grant DTO field `memberId` → `workspaceMemberId` and `grantedByWorkspaceMemberId` → `createdByWorkspaceMemberId`; `SubjectRef.memberId` → `workspaceMemberId`.

### Removed

- `MCP_TOOL_NAMESPACE_SEPARATOR` and `PublicToolOrigin` exports.

## [0.20.1] - 2026-06-21

### Added

- HKUDS/CLI-Anything is internalized as a `cli-catalog` device-runtime builtin (66 CLIs), with a server-side gate on grant issuance.

## [0.20.0] - 2026-06-19

### Added

- A multi-backend content store: per-blob backend selection, a local CAS cache, an S3 remote backend (`@aws-sdk/client-s3`) with presigned PUT/GET, and sandbox CAS hydration.

### Changed

- **Breaking:** `resource_access_bindings` merged into `workspace_resource_grants`; wire shape `{app}` → `{resource}`, `appId` → `resourceId`; per-type access sub-resources collapse into `GET|PUT .../workspace-resources/:resourceId/grants`; a new `automation_admin` workspace access key was added.

### Removed

- The `resource_access_bindings` model and its exports (`ResourceAccessBindingResourceType`, `ACCESS_BINDABLE_*`).

## [0.19.0] - 2026-06-18

### Changed

- **Breaking:** the create-invite request DTO drops absolute `expiresAt` for relative `expiresInHours`; a client still sending `expiresAt` has it silently ignored.
- The canonical `IsoInstantString` primitive and its conversion helpers now live in `@synapse/device-protocol/instant` and are re-exported from `@synapse/shared`.
- `workspace_app_grants.created_at` tightened to `NOT NULL` (removing 1970-epoch fallbacks); duration columns (`retention_ttl_ms`, `poll_interval_ms`, `ttl_ms`) widened to `BIGINT` with a `>= 0` CHECK.

## [0.18.2] - 2026-06-18

### Added

- Unified logging and distributed tracing: a single pino logger with a domain taxonomy, OpenTelemetry with Tempo, Loki, and Alloy, a self-hosted, DSN-gated Sentry error/performance consumer, BullMQ trace propagation, and a `/api/v1/logs` client-log ingest endpoint authenticated by a user session or a short-lived HMAC device token.
- IM inbound and outbound media completed on the content-addressed pipeline: DingTalk media (inbound + outbound), QQ inbound media into the CAS, WeChat inbound media (plus an aes_key encoding fix), and an empty-blob guard before outbound upload.

## [0.18.1] - 2026-06-17

### Changed

- The transport `CanonicalFileRef` is collapsed to a single content-addressed (sha256) shape; outbound sends now read bytes from the CAS for Feishu, QQ, and WeChat, and inbound media is persisted to the CAS for Feishu.

### Fixed

- Connector fixes: Feishu webhook verification, `@all` mention normalization, and inbound video; QQ official OpenAPI v2; DingTalk mention/rich-text/audio handling; WeChat (ilink personal-WeChat) connector realigned to the upstream protocol (session guard, QR login, media CDN).

## [0.18.0] - 2026-06-17

### Changed

- **Breaking:** application REST responses with a body are now wrapped in a `{ data }` envelope (~173 routes); no-body writes stay `204`, and wire/machine-surface endpoints (device handshake, `/api/v1/internal/*`, `/auth/device/*`, `/im/webhooks/*`, `/automation-webhooks/*`, `/install.{sh,ps1}`) deliberately keep bare payloads. Postgres stays snake_case while the TypeScript surface is fully camelCase (via a Kysely `CamelCasePlugin`). The error contract (`{ error, code }`) is deliberately unchanged.
- Repo-exit JSON decoding now fails closed on malformed stored payloads (previously silently coerced to `{}`) across most modules.

## [0.17.0] - 2026-06-10

### Added

- A unified, MCP-style Task model (`tool_call_task_*` tables) with an orthogonal lifecycle: `lifecycle_status` × `outcome`.
- The canonical `IsoInstantString` datetime primitive, `datetime/instant.ts` adapters, and the `guard-datetime-boundaries` CI check.

### Changed

- **Breaking:** `POST .../interactions/:id/respond` → `POST .../tasks/:taskId/respond`; the WebSocket feed event `interaction_requested` → `task_requested` and its payload `{interaction}` → `{task}`. Workspace-app root metadata was consolidated.

### Removed

- The `interaction_*` tables, `InteractionRequestSummary` and related exports, and legacy workspace-app write routes.

## [0.16.0] - 2026-06-07

### Added

- A server-computed tool-call presentation layer: display blocks, captured MCP `_meta`, and auto-attached descriptors for the built-in tools.
- New `@synapse/shared` exports (`resolvePresentation`, `PresentationString`) and presentation fields on `ServerToolCall`, `ToolPlugin`, and the turn-preview/activity DTOs.

## [0.15.0] - 2026-06-07

### Changed

- **Breaking:** the canonical `ToolResultOrigin` union (and `TOOL_RESULT_ORIGIN_KINDS`) was consolidated into the routed vocabulary — `mcp_remote|mcp_device|callable_plugin|builtin` → `system|plugin|device|provider_native` — with new per-kind field shapes, and `origin` became a required field on `CanonicalToolResult`/`NormalizedMcpToolResult`.
- **Breaking:** the `ActorRuntimeToolKind` enum values were remapped (`callable|mcp_plugin|mcp_device|provider_builtin` → `system|plugin|device`); WebSocket and turn-preview DTO values changed accordingly.

### Removed

- The `ExecutableModelToolKind` and `execKindForSource` exports.
- The `device`-derived catalog/marketplace enum members (`device_derived`, `device_derivation`, `device_projection`, catalog source `device`), the `device` plugin transport, the `actor_in_conversation`/`remote_agent_in_conversation` access-target labels, and `conversationActorContextId`.

## [0.14.1] - 2026-06-07

### Added

- nginx HTTP/3 (QUIC) support.

## [0.14.0] - 2026-06-06

### Added

- Tool provenance and routing (`ToolRef` + `NameRegistry`): a deterministic `toolId`, a wire-name ↔ toolId registry, and an immutable `tool_calls.source_snapshot`.

### Changed

- **Breaking:** tool provenance & routing — routing no longer parses tool names (projection mints deterministic `ToolRef`s + a per-turn `NameRegistry`); `ToolDefinition.source`/`sourceType` were removed from `@synapse/shared` (source now lives on the internal `ProjectedToolDefinition`).

### Removed

- The legacy `tool_calls.plugin_id`/`device_id` columns and the `tool_execution_attempts.plugin_id`/`device_id`/`instance_key` columns (provenance now derives from the parent `tool_calls.source_snapshot`).

## [0.13.0] - 2026-06-06

### Changed

- **Breaking:** the built-in tool execution-kind model was reshaped — the `ToolPlugin.kind` (`action`|`callable`) field was removed and `ToolPlugin.execute` made required; the `ActorRuntimeToolKind` union dropped its `builtin` and `action` members (both `@synapse/shared`).

## [0.12.0] - 2026-06-06

### Added

- A Vercel AI SDK v6 provider layer and a `deepseek` vendor.

### Changed

- **Breaking:** the model data model collapses to `model_bindings` + `model_binding_versions` (replacing `model_profiles`, `model_profile_revisions`, and `model_group_profiles`); `provider_steps` re-keyed to `model_binding_id`/`model_binding_version_id`.
- **Breaking:** `ResolvedModelConfig` was reshaped (`bindingId`, `providerKind`, `maxOutputTokens`); the shared export `MODEL_PROVIDER_CATALOG` → `MODEL_VENDOR_CATALOG` (`ModelProviderDefinition` → `ModelVendorDefinition`), with a new `ProviderKind` export.

### Removed

- Four hand-rolled LLM adapters, the `ModelProviderAdapter*`/`EngineBranch*` exports, and provider-native branch-state resume.

## [0.11.3] - 2026-06-06

### Fixed

- Multi-client chat broadcast could skip events because per-member `member_seq` was not gap-free under concurrent appends (the client cursor pages by `member_seq > cursor`). `member_seq` is now assigned as `MAX+1` under a per-member advisory transaction lock (`pg_advisory_xact_lock`), guaranteeing a contiguous, commit-ordered sequence.

## [0.11.2] - 2026-06-06

### Added

- A one-click, cross-platform Node installer served at `GET /api/v1/install.sh` and `install.ps1` (sha256-verified, with China/international mirror auto-detection).

## [0.11.1] - 2026-06-05

### Added

- Soft-delete tombstoning with `_live` read views, an offline purge CLI (`db:purge:*`), and an FK-policy CI gate backed by a table-classification manifest.
- Popup-first OAuth sign-in with cross-platform (web/mobile) error routing, completing the Feishu social-login flow.

### Changed

- Deletion is now tombstoning: `ON DELETE CASCADE` became `RESTRICT` repo-wide. Operator SQL that relied on cascading deletes now raises foreign-key violations, and schema bootstrap requires the `CREATEROLE` privilege.

### Fixed

- OpenAI requests to `gpt-5*` and o-series (o1/o3/o4) reasoning models now send `max_completion_tokens` instead of the rejected legacy `max_tokens`.

## [0.11.0] - 2026-06-04

### Added

- Feishu (Lark) social sign-in, plus a login/register UX overhaul (single-column layout, password-visibility toggle, email autosuggest, caps-lock warning, and specific login-error messages).
- The server-side actor sandbox is now deployable in both Docker and local modes via new deploy scripts (`deploy-sandbox-docker.sh` / `deploy-sandbox-local.sh`), a `docker-compose.sandbox-local.yml`, and an frps tunnel-edge image built from the official frp release.

### Changed

- **Breaking:** model configuration moved from environment variables to a declarative `config/model-groups.yaml`.

### Removed

- `AI_PROVIDER`, `AI_ENGINE_KIND`, `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL`, and `AI_MAX_TOKENS`. Chat requires an explicit model-group configuration; a fresh install starts with no model configured.

## [0.10.0] - 2026-06-04

### Added

- Better Auth 1.6.13 for identity (`account`/`session`/`verification` tables) and RFC 8628 device authorization.

### Changed

- **Breaking:** authentication endpoints were reshaped (`/register` → `/sign-up/email`, `/login` → `/sign-in/email`, and others); a new `BETTER_AUTH_SECRET` is required (falling back to `AUTH_SECRET` / `APP_SECRET`).

### Removed

- `users.password_hash`, `auth_sessions`, the six `/qr-login/*` routes, and the config-email super-admin auto-grant.

### Security

- All passwords and sessions are invalidated on upgrade (there is no migration path). The hardcoded session-cookie name was removed.

## [0.9.1] - 2026-06-04

### Added

- Gitleaks secret scanning wired into a pre-commit hook and CI (`secret-scan` workflow), backed by a `.gitleaks.toml` config and a baseline of known allowed matches.

### Changed

- Authorization hardening: exhaustive permission switches and fail-closed handling of unknown permissions.

### Fixed

- The workspace permission evaluator rejected the `manage_relays` key before the admin check, silently collapsing device management to self-ownership for owners, admins, and device-admin key holders.

## [0.9.0] - 2026-06-03

### Added

- Official remote MCP endpoints (AMiner, AMap, Figma) over HTTP and SSE, on the official SDK transports.

### Changed

- **Breaking:** the Mijia (Xiaomi smart-home) plugin moved from an always-on in-process builtin to an env-gated sidecar (`MIJIA_MCP_URL`) behind the `mijia` Compose profile — it is now off by default on the production profile.

### Removed

- The hand-rolled `McpHttpClient`.

## [0.8.1] - 2026-06-03

### Added

- The actor sandbox gains an E2B-SDK-shaped `SandboxBackend` lifecycle abstraction (`create`/`connect`/`kill`/`getHost`) with a local backend and an opt-in Docker-outside-of-Docker backend, a fast-path endpoint, and an fs-helper `fs.hello` freshness handshake.

## [0.8.0] - 2026-06-02

### Added

- A content-addressed file service (`content_blobs`, `file_assets`, `file_spaces`, `file_snapshots`, `file_mounts`) keyed by sha256.
- A server-side actor sandbox module: per-session lifecycle, a local host provider that spawns device-runtime child processes, working-set materialization over the new file service (`file_snapshots`, `file_mounts` tables), plus sandbox grants, GC, and conflict-notice handling.

### Changed

- **Breaking:** the encryption envelope moved from `enc:` to `enc:v2:` (scrypt KDF) with no re-encryption path; the bare-pg query escape hatch was removed as the data layer was unified on Kysely.

### Removed

- The in-process sherpa-onnx-node batch-ASR engine.

### Security

- Fail-fast Zod validation of environment configuration, SSRF hardening (including bracketed IPv6), and a new fail-closed `redactSecrets` secret redactor. A new required `SYNAPSE_REGISTRY_DOMAIN` is added.

## [0.7.1] - 2026-06-01

### Added

- A self-hosted Verdaccio private npm registry for distributing the device runtime and remote-agent daemon; `publishConfig` on ten packages.

## [0.7.0] - 2026-05-31

### Changed

- **Breaking:** all workspaces migrated to Zod 4 (pinned `4.3.6`); whether a conversation is an IM conversation is now derived from its transport binding, reshaping the chat-create and add-participant DTOs.

### Removed

- The legacy A2A design (`A2AApp`, `A2AAgentCard`, and related exports), `CONVERSATION_BOUNDARY`/`CONVERSATION_BOUNDARIES`, and `systemRef`.

## [0.6.1] - 2026-05-29

### Added

- A per-agent computer-use (CUA) session-focus subsystem.

## [0.6.0] - 2026-05-29

### Added

- A browser capability via chrome-devtools-mcp, with an operation-aware projection and manual grants.

### Changed

- The device-protocol `RuntimeBrowserPolicySchema` gains an additive operation-level `operations` allowlist (the matcher fails closed on a missing entry).
- **Breaking:** the device-protocol `DeviceCapabilitySummarySchema` adds a required `exposure_stable_key` field (plus an additive optional `metadata`).

## [0.5.0] - 2026-05-29

### Added

- Terminal capability v2 (`exec_file`, `powershell`) with a bundled toolchain, and six `device-runtime-bundles-*` platform packages distributed over Git LFS.

### Changed

- **Breaking:** the device-protocol `CommandlinePolicy` wire schema was reshaped. Building the project now requires Git LFS.

## [0.4.0] - 2026-05-29

### Added

- The `@synapse/device-runtime` npm CLI (`synapse-device`), a device filesystem capability (13 tools) backed by a new Rust fs-helper sidecar, and QQ (official OpenAPI v2) and DingTalk (Stream) connectors.

### Changed

- **Breaking:** the device control plane moved to a `GET /api/v1/devices/control-plane` WebSocket endpoint (JSON-RPC 2.0 framing); device identity now uses two keypairs; pairing moved to `POST /api/v1/devices/pairing-sessions/consume`. Building the project now requires a Rust toolchain (for the fs-helper sidecar).

### Removed

- The entire Go `relay/` subsystem (−66,599 lines): the relay CLI, the desktop GUI, the agent, and the FUSE mount; `/ws/relay`; thirteen `relay_*` tables; the relay auto-update manifest; and TLS public-key pinning.

### Security

- A new required `SYNAPSE_DEVICE_TRUSTED_SERVER_KEYS` (unset means every tool call is refused), and a mandatory frp tunnel for tool dispatch.

## [0.3.0] - 2026-05-27

### Added

- A scope dimension on the subject model (`ScopedSubjectTarget`, `scope_subject_id`) and `memory_access_grants` REST endpoints.

### Changed

- **Breaking:** `AccessTarget` and `CapabilityAccessTarget` were reshaped onto `ScopedSubjectTarget`.
- **Breaking:** memory DTOs reshaped onto the subject model: `MemoryEntry` replaces `spaceType`/`ownerScope`/owner-id fields with `owner`/`scope` (`SubjectRef`) + `namespaceKey`; the `memory_saved`/`memory_updated` feed events swap `memorySpaceType` for `memoryOwner`/`memoryNamespaceKey`; and `RelayAuthorizationGrantSummary.scope` (enum) becomes `subject` + optional `scope` `SubjectRef`s.

### Removed

- Legacy access-target types, `MEMORY_SCOPES`/`MEMORY_SPACE_TYPES`, and `relay_authorization_grants.scope`.
- The `conversation_actor_context` subject variant — `SUBJECT_KIND.CONVERSATION_ACTOR_CONTEXT`, `ACCESS_RESOURCE_TYPE.CONVERSATION_ACTOR_CONTEXT`, and the `conversationActorContextRef` / `isConversationActorContextSubject` exports (the actor-in-conversation case is now `actor` + `scope=conversation`).

## [0.2.0] - 2026-05-25

### Added

- An `access_subjects` registry that unifies the previously polymorphic subject model onto a single `subject_id`.
- An IM `TransportConnector` abstraction with a connector registry, plus functional Feishu (Lark), Weixin (personal WeChat), and WeCom connectors (Feishu/Weixin were previously 9-line capability stubs), a per-conversation reverse-MCP endpoint, an `AgentDriver` abstraction for the remote-agent daemon, and Docker Compose production deployment (`tls`/`http`/`certbot` profiles).

### Changed

- **Breaking:** conversation and interaction routes moved under `/chat/*` (legacy URLs return 404); WebSocket event names moved to dotted form (`auth_error` → `auth.error`, `server_shutdown` → `server.shutdown`); Docker Compose now hard-fails on eleven additional required environment variables (`APP_BASE_URL`, `SYNAPSE_PUBLIC_DOMAIN`, and others), bringing the required set to fifteen.

### Removed

- The host systemd deployment (units and start scripts); the `@synapse/shared` exports `Message`, `MessageType`, `ConversationSummary`, `SESSION_CHANNELS`, and `ChannelType`; the bare `/files/*` mount; and `sessions.channel_type`.

## [0.1.0] - 2026-05-20

The first release. Synapse is a self-hosted, conversation-centric runtime for digital teammates: AI actors and bridged coding agents join your workspaces and collaborate with you inside conversations, reachable from the IM apps you already use. The conversation itself is the collaboration boundary — it governs participants, transcript visibility, actor execution, wakeups, and memory handoff.

### Added

- **Conversation model** — all collaboration happens in a channel-agnostic conversation graph: `conversations` (kinds group/private/virtual, an internal/external boundary), polymorphic `conversation_participants` (workspace_member, actor, remote_agent, external, system) with per-participant read watermarks, and a typed `conversation_items` log (message/event/summary/control; user/assistant/system/tool roles) carrying shared/private scope, visible/internal surface, event fan-out policies, a monotonic per-conversation sequence, reply/cause threading, multi-part bodies (text/file_ref/json), and to/cc/visible targeting with mentions.
- **IM connectors** — chat with your teammates from the IM apps you already use: a Feishu (飞书) bot (webhook + long-connection, direct + group) and Weixin (personal WeChat) via QR pairing (long-connection, direct-only), fronted by a generic five-table transport abstraction (accounts, endpoints, per-conversation bindings, addresses, per-item delivery links).
- **Platform-native actors** — workspace-scoped, cloud-run AI teammates with typed roles (secretary/manager/specialist/reviewer/archivist/receptionist/assistant), an actor hierarchy, `can_represent_user`, and fully versioned history (`actor_versions`) whose provenance attributes each edit to a member, actor, system, or sync source.
- **Bridged remote agents** — bring your own coding agents: external agentic runtimes (Claude Code, Codex) running on a user's own machine join workspaces as participants via the `remote-agent-daemon`, a local Node driver that connects outbound over WebSocket, probes installed CLIs, spawns them per turn, and bridges chat through an injected stdio MCP server — with machine pairing/trust, plan-approval collaboration, and group-interaction grants.
- **Device tools via the Go relay** — give agents controlled access to a physical machine: a standalone on-device agent (`synapse-relay` CLI, a Wails desktop GUI, a FUSE mount) pairs the machine and exposes it to the cloud as authorized MCP tools over a versioned WebSocket dispatch protocol, hosting built-in computer-use (CUA), scoped-filesystem, bundled Chrome DevTools, and command-line servers.
- **Workspace governance & permissions** — two-tier RBAC: platform-level `platform_access_bindings` (super_admin/workspace_admin/model_admin/support/auditor) with env-config super-admin bootstrap, and workspace-level `workspace_members` (admin/member/guest) with eight fine-grained admin capability keys, token-based invites, and a polymorphic `resource_access_bindings` ACL that grants resources to workspace/conversation/actor subjects.
- **Authentication** — a hand-rolled identity stack: bcrypt password login, opaque sha256 bearer sessions (cookie or Authorization header) with client/transport metadata and lifecycle, and a full dual-token QR cross-device login state machine.
- **Shareable teammates & contacts** — a per-workspace, WeChat-style relationship graph over members, actors, and remote agents: shareable identity profiles with searchable IDs and QR tokens, friend requests with auto/manual approval, and accepted contact-list entries.
- **Catalog & marketplace** — install and share packaged capabilities: a publisher → item → version spine over three package kinds (actor_template, skill_package, plugin_package) with categories, version files, and per-kind specs; skill ingestion from GitHub/ClawHub mirror sources into parsed snapshots; and workspace-tenant installed-skill and plugin-installation runtime tables with OAuth-style plugin auth sessions and per-owner connections.
- **Model groups & LLM providers** — four hand-rolled provider adapters (Anthropic Messages, OpenAI Chat Completions, OpenAI Responses, BigModel/Zhipu GLM) behind a static provider catalog, plus DB-backed routing: versioned model profiles, `model_groups` with weighted-random/round-robin/priority-failover strategies and attempt policies, scoped grants, and actor→group assignments; the runtime provider/model is selected via environment.
- **MCP tools & plugins** — a four-transport MCP plugin host (builtin, stdio, http, relay) over a seven-kind tool taxonomy, shipping seven builtin plugins (feishu, aminer, amap, github, gitlab, mijia, and the Zhipu z-ai toolkit spanning search, reading, OCR/vision, audio/speech, media generation, and moderation), with runtime-permission approval and mount/reuse scoping.
- **Memory** — teammates remember: in-process hybrid semantic memory partitioned into five scopes (workspace_shared, conversation_shared, actor_private, participant_private, user_private) across seven item categories, combining lexical (FTS + trigram) and vector recall via a bundled transformers.js `multilingual-e5-small` model (VECTOR(384), HNSW cosine) that embeds locally with no external sidecar, plus recorded recall runs.
- **Self-hosted deployment** — runs on a single Ubuntu host: an nginx public entrypoint, systemd for the API and desktop web (`packages/web-next`), Dockerized PostgreSQL (pgvector/pg16) and Redis 7, a tsx-run API image, and a `production` Compose profile for the full containerized stack. Ships an Expo mobile app and README/CHANGELOG locales in English, 简体中文, and Español.

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
