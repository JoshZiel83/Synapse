# mcp-plugins/relay-\* — Deprecation Notice (Device Runtime v3)

These files implement the **v2 relay protocol** server side. They are still
live in v3.0 because the cutover to the device runtime dispatch path is
incremental:

- `relay-access.ts`, `relay-controller.ts`, `relay-manager.ts`,
  `relay-invoke-options.ts`, `relay-policy.ts`, `relay-special-mcp.ts`

The v3 refactor replaced the relay → device subsystem in **schema + module
layout + protocol**, but the actual **dispatch hot path** (chat runtime →
`callRelayTool` / `enqueueRelayToolTask`) still goes through these files for
existing devices that haven't been re-paired through the new
`@synapse/device-runtime` SDK.

## Replacement map

| Legacy module                   | Device-runtime replacement                                     |
| ------------------------------- | -------------------------------------------------------------- |
| `relay-manager.ts` dispatch     | `modules/devices/dispatch.ts` (`dispatchSyncTool`)             |
| `relay-manager.ts` catalog sync | `modules/devices/control-plane.ts` + device runtime side       |
| `relay-controller.ts` REST      | `modules/devices/controller.ts`                                |
| `relay-access.ts` projection    | `modules/capability-projection/device-capabilities.ts`         |
| `relay-invoke-options.ts`       | `@synapse/device-protocol` RUNTIME_AUTHORIZATION_REQUEST_MODES |
| `relay-policy.ts`               | inlined into capability-projection grant resolution            |
| `relay-special-mcp.ts`          | (no v3 equivalent — special-case fixups move out)              |

## Removal plan

Removal happens incrementally as each consumer migrates:

1. Migrate `packages/api/src/modules/session/runtime.ts` to dispatch through
   the devices module for runtimes that originated from a v3-paired device.
2. Migrate `packages/api/src/infrastructure/websocket/index.ts` device-side
   pairing claims to the new control-plane.ts handler.
3. Migrate `packages/api/src/modules/ai/session-tools.ts` to consume the
   capability-projection module's tool list directly.
4. Migrate `packages/api/src/modules/runtime-authorizations/requests.ts`
   off `relay-invoke-options.ts` once the new authorization runtime is wired.
5. Delete the relay-\*.ts files (this PR's eventual landing).
6. PR #18 drops the legacy `relay_*` tables once nothing reads them.

Until step 5 lands, **do not add new code that imports from
`relay-*.ts`**. New work goes through `modules/devices/` +
`modules/capability-projection/` + `@synapse/device-runtime`.

## Why not delete now

The dispatch hot path is the most heavily exercised code in the system.
Deleting 8.5k LOC of dispatch logic before its replacement is wired through
every caller would regress chat tool calls for every existing relay user. The
v3 PR sequence intentionally landed the new substrate (PRs #1–#16) first; the
dispatch cutover is the next major workstream.

See `docs/device-runtime-v3.md` §13 PR #17 / PR #18 for the full migration
schedule.
