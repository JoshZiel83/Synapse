# MCP Relay V2

## Goals

- Make relay binding safe, explicit, and client-agnostic.
- Decouple local MCP sync sources from server runtime routing.
- Give every device, exposure, tool lineage, and operation a stable internal identifier.
- Fail closed when tool definitions change after planning.
- Keep internal relay identifiers hidden from models.

## Design Boundaries

### Client responsibilities

- Device key generation and local secure storage
- Pairing UX
- Local MCP discovery, import, watch, merge, and write-back
- Exposure supervision and health isolation
- Tool catalog tracking and list-changed handling
- Operation execution dedupe by `operation_id`

### Server responsibilities

- Device trust and pairing sessions
- Session lifecycle and operation dispatch
- Exposure and tool catalog metadata
- Authorization, audit, and routing
- Detecting stale tool definitions before execution

### What the server must not do

- Parse third-party MCP config formats directly
- Watch local client files
- Infer tool identity from user-facing names

## Identity Model

### Device

- `device_id`: stable random identifier for a relay client installation
- `public_key_fingerprint`: stable fingerprint of the device key

### Exposure

- `exposure_id`: stable identifier for one MCP exposed by one device
- `stable_key`: client-generated stable key for matching the same MCP across restarts and sync refreshes

### Tooling

- `catalog_revision_id`: one full `tools/list` snapshot for one exposure
- `tool_id`: relay-internal stable identifier for one tool lineage inside one exposure
- `tool_revision_id`: one concrete definition revision for a tool lineage
- `tool_name`: MCP-native name used only when calling `tools/call`

## Runtime Guarantees

### Isolation

- One failing exposure must not take down the full relay client.
- Exposure health is tracked independently: `starting`, `healthy`, `degraded`, `failed`, `quarantined`, `offline`.

### Dedupe

- Business dedupe key: `operation_id`
- Transport retry key: `delivery_id`
- Connection key: `session_id`
- Never dedupe by upstream tool call id.
- Never dedupe by `tool_name + arguments`.

### Tool definition safety

- Models never see relay internal identifiers.
- Models only see visible tool definitions: `name`, `description`, `inputSchema`.
- Relay runtime stores a hidden binding from visible tool choice to:
  - `exposure_id`
  - `tool_id`
  - `tool_revision_id`
  - `catalog_revision_id`
- If the active tool revision changes after planning, execution must fail closed with `tool_definition_changed`.
- The orchestrator must then re-read the current tool view and replan.

## Sync Source Policy

The server keeps source metadata only.

- `source_kind`: `manual`, `claude_code`, `claude_desktop`, `codex`, `gemini`, `opencode`, `custom`
- `sync_mode`: `import_only`, `observe`, `mirror`, `managed`, `detached`
- `status`: `unknown`, `idle`, `syncing`, `error`, `disabled`

The server does not read or write source config files itself.

## Pairing Model

All binding flows reduce to one pairing session.

- Desktop starts pairing and shows QR code or short code.
- Web can confirm the pairing.
- Web can also probe localhost and deliver a one-time pairing reference.
- Deep links only carry one-time pairing references, never long-lived auth tokens.

## Protocol Notes

### Hidden relay fields

These fields are runtime-only and must not be exposed to models:

- `device_id`
- `session_id`
- `exposure_id`
- `catalog_revision_id`
- `tool_id`
- `tool_revision_id`
- `operation_id`
- `delivery_id`

### Model-visible surface

The model sees only the resolved tool list:

- `name`
- `description`
- `inputSchema`

### Execution validation

Before dispatch:

1. Resolve visible tool choice to the hidden relay binding.
2. Verify the exposure is still online.
3. Verify the tool lineage still exists.
4. Verify the `tool_revision_id` still matches the planned revision.
5. Reject with `tool_definition_changed` if any revision drift is detected.

## Database Shape

Relay V2 introduces these primary tables:

- `relay_devices`
- `relay_pairing_sessions`
- `relay_device_sessions`
- `relay_sync_sources`
- `relay_exposures`
- `relay_catalog_revisions`
- `relay_tools`
- `relay_tool_revisions`
- `relay_operations`
- `relay_operation_deliveries`
- `relay_operation_results`

## Migration Strategy

No compatibility layer is required.

- Old relay tables are removed.
- Old relay tokens are removed.
- Existing relay clients are invalidated.
- Database is recreated from the new schema.
