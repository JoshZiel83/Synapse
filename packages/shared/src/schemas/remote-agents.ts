import { z } from "zod"
import { REMOTE_AGENT_RUNTIME_KINDS } from "../constants/enums.js"

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

// ───────────────────────────── request DTOs (§5.1.1) ─────────────────────────
// App-facing request bodies for the remote-agents APP routes (the machine-RPC
// /internal/* bodies live in @synapse/device-protocol — see round-6 P1-5).
// Single-sourced here so the API parser and the web/mobile clients share one
// definition.

/** POST remote-agent-machines/pairing-sessions body. */
export const CreateRemoteAgentMachineInputSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  description: z.string().trim().max(2000).optional(),
})
export type CreateRemoteAgentMachineInput = z.infer<
  typeof CreateRemoteAgentMachineInputSchema
>

/** POST remote-agents/:id/bind body. */
export const BindRemoteAgentInputSchema = z.object({
  machineId: z.uuid(),
  runtimeKind: z.enum(REMOTE_AGENT_RUNTIME_KINDS),
  runtimePath: z.string().trim().min(1).optional(),
  localRootPath: z.string().trim().min(1).optional(),
})
export type BindRemoteAgentInput = z.infer<typeof BindRemoteAgentInputSchema>

/** PUT remote-agents/:id/group-task-grants body. */
export const UpdateRemoteAgentGroupTaskGrantsInputSchema = z.object({
  workspaceMemberIds: z.array(z.uuid()).max(200),
})
export type UpdateRemoteAgentGroupTaskGrantsInput = z.infer<
  typeof UpdateRemoteAgentGroupTaskGrantsInputSchema
>
