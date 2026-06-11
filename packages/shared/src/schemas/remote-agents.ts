import { z } from "zod"

/**
 * App-facing contracts for the remote-agents module's APP routes (master plan
 * §5.3). Every workspace-scoped + authenticated route here returns its value
 * through `appRoute` → `sendData` → `{ data: ... }`. These schemas describe the
 * value each handler returns (the helper wraps it).
 *
 * The route handlers map DB rows → presented views via this module's presenter
 * (`presentRemoteAgent`, `presentMachineListItem`, …) before returning. Those
 * presented views are genuinely-open presentation shapes the presenter already
 * owns, so collection entries / nested view objects are modeled as `z.unknown()`
 * — the boundary only needs to round-trip them unchanged, not re-validate their
 * interior. Top-level envelope keys (the discriminating structure consumers read
 * on) are modeled explicitly.
 */

/** GET remote-agents — `{ remoteAgents: RemoteAgentView[] }`. */
export const RemoteAgentListResponseSchema = z.object({
  remoteAgents: z.array(z.unknown()),
})
export type RemoteAgentListResponseSchemaType = z.infer<
  typeof RemoteAgentListResponseSchema
>

/** GET remote-agent/:id and POST .../bind — `{ remoteAgent: RemoteAgentView }`. */
export const RemoteAgentResponseSchema = z.object({
  remoteAgent: z.unknown(),
})
export type RemoteAgentResponseSchemaType = z.infer<
  typeof RemoteAgentResponseSchema
>

/** GET/PUT group-task-grants — `{ grants: RemoteAgentGroupTaskGrantView[] }`. */
export const RemoteAgentGroupTaskGrantsResponseSchema = z.object({
  grants: z.array(z.unknown()),
})
export type RemoteAgentGroupTaskGrantsResponseSchemaType = z.infer<
  typeof RemoteAgentGroupTaskGrantsResponseSchema
>

/**
 * POST pairing-sessions (201) — the pairing-session ticket. Top-level fields are
 * fixed; `machine` is the presented machine view (open) and `oneClickCommands`
 * is the installer block (null when the private registry is unset).
 */
export const RemoteAgentMachinePairingSessionResponseSchema = z.object({
  machine: z.unknown(),
  apiKey: z.string(),
  daemonCommand: z.string(),
  oneClickCommands: z
    .object({ unix: z.string(), windows: z.string() })
    .nullable(),
})
export type RemoteAgentMachinePairingSessionResponseSchemaType = z.infer<
  typeof RemoteAgentMachinePairingSessionResponseSchema
>

/** GET remote-agent-machines — `{ machines: RemoteAgentMachineView[] }`. */
export const RemoteAgentMachineListResponseSchema = z.object({
  machines: z.array(z.unknown()),
})
export type RemoteAgentMachineListResponseSchemaType = z.infer<
  typeof RemoteAgentMachineListResponseSchema
>

/**
 * GET remote-agent-machines/:id — machine detail. The three top-level keys are
 * the structure consumers read on; their entries are open presented views.
 */
export const RemoteAgentMachineDetailResponseSchema = z.object({
  machine: z.unknown(),
  runtimeCatalog: z.array(z.unknown()),
  bindings: z.array(z.unknown()),
})
export type RemoteAgentMachineDetailResponseSchemaType = z.infer<
  typeof RemoteAgentMachineDetailResponseSchema
>
