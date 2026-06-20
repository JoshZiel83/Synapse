import { z } from "zod"
import {
  REMOTE_AGENT_BINDING_STATUSES,
  REMOTE_AGENT_MACHINE_LIFECYCLE_STATES,
  REMOTE_AGENT_MACHINE_TRUST_STATUSES,
  REMOTE_AGENT_RUNTIME_CATALOG_STATUSES,
  REMOTE_AGENT_RUNTIME_KINDS,
  REMOTE_AGENT_RUNTIME_STATES,
} from "../constants/enums.js"
import { IsoInstantStringSchema } from "./datetime.js"

/**
 * App-facing contracts for the remote-agents module's APP routes (master plan
 * §5.3). Every workspace-scoped + authenticated route here returns its value
 * through `appRoute` → `sendData` → `{ data: ... }`. These schemas describe the
 * value each handler returns (the helper wraps it).
 *
 * round-6 P1-4: the presented views (RemoteAgentView, machine views, runtime
 * catalog, group-task grants, bindings) are now modeled as real Zod, matching
 * the presenter output (remote-agents/presenter.ts present*). Instants are
 * IsoInstantStringSchema; open JSON (metadata / runtime capabilities) stays a
 * passthrough record. The machine RPC /internal/* bodies live in
 * @synapse/device-protocol (round-6 P1-5) — these are the human app views.
 */

const runtimeKindSchema = z.enum(REMOTE_AGENT_RUNTIME_KINDS)
const runtimeStateSchema = z.enum(REMOTE_AGENT_RUNTIME_STATES)
const runtimeCatalogStatusSchema = z.enum(REMOTE_AGENT_RUNTIME_CATALOG_STATUSES)
const bindingStatusSchema = z.enum(REMOTE_AGENT_BINDING_STATUSES)
const machineTrustStatusSchema = z.enum(REMOTE_AGENT_MACHINE_TRUST_STATUSES)
const machineLifecycleStateSchema = z.enum(
  REMOTE_AGENT_MACHINE_LIFECYCLE_STATES
)
const jsonRecordSchema = z.record(z.string(), z.unknown())

/** Per-runtime capability flags (presenter emits {} when unknown). */
export const RemoteAgentRuntimeCapabilityViewSchema = z.object({
  supportsRequestUserInput: z.boolean().optional(),
  supportsPlanMode: z.boolean().optional(),
  supportsPersistentSession: z.boolean().optional(),
  supportsCodexAppServer: z.boolean().optional(),
  supportsStructuredIo: z.boolean().optional(),
})

/** Runtime summary (presentRuntimeSummary). */
export const RemoteAgentRuntimeSummaryViewSchema = z.object({
  runtimeKind: runtimeKindSchema,
  state: runtimeStateSchema,
  statusText: z.string().optional(),
  sessionId: z.string().optional(),
  activeConversationId: z.string().optional(),
  activeTaskId: z.string().optional(),
  pendingConversationCount: z.number(),
  unreadDeliveryCount: z.number(),
  lastActivityAt: IsoInstantStringSchema.optional(),
  lastRunStartedAt: IsoInstantStringSchema.optional(),
  lastRunFinishedAt: IsoInstantStringSchema.optional(),
  lastError: z.string().optional(),
  capabilities: RemoteAgentRuntimeCapabilityViewSchema.optional(),
})

/** Binding block embedded in a RemoteAgentView (presentRemoteAgent). */
export const RemoteAgentBindingViewSchema = z.object({
  machineId: z.string(),
  machineTitle: z.string().optional(),
  status: bindingStatusSchema,
  runtimePath: z.string().optional(),
  localRootPath: z.string().optional(),
  machineLifecycleState: machineLifecycleStateSchema.optional(),
  runtimeSummary: RemoteAgentRuntimeSummaryViewSchema.optional(),
})

/** A single remote agent (presentRemoteAgent). */
export const RemoteAgentViewSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  displayName: z.string(),
  title: z.string(),
  description: z.string().optional(),
  runtimeKind: runtimeKindSchema,
  avatarFileId: z.string().optional(),
  avatarEmoji: z.string().optional(),
  requiresContactApproval: z.boolean(),
  isActive: z.boolean(),
  isPublicShared: z.boolean(),
  metadata: jsonRecordSchema,
  ownerWorkspaceMemberId: z.string().optional(),
  createdAt: IsoInstantStringSchema.optional(),
  updatedAt: IsoInstantStringSchema.optional(),
  runtimeSummary: RemoteAgentRuntimeSummaryViewSchema.optional(),
  binding: RemoteAgentBindingViewSchema.optional(),
})

/** A group-task-grant row (presentGroupTaskGrant). */
export const RemoteAgentGroupTaskGrantViewSchema = z.object({
  workspaceMemberId: z.string(),
  createdByWorkspaceMemberId: z.string().optional(),
  createdAt: IsoInstantStringSchema.optional(),
  updatedAt: IsoInstantStringSchema.optional(),
  userId: z.string(),
  name: z.string(),
  avatarUrl: z.string().optional(),
})

/** A machine list/detail row (presentMachineListItem / presentMachineFromCamelRow). */
export const RemoteAgentMachineViewSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  title: z.string(),
  description: z.string().optional(),
  trustStatus: machineTrustStatusSchema,
  lifecycleState: machineLifecycleStateSchema.optional(),
  bindingCount: z.number().optional(),
  lastSeenAt: IsoInstantStringSchema.optional(),
  createdAt: IsoInstantStringSchema.optional(),
  updatedAt: IsoInstantStringSchema.optional(),
})

/** A runtime-catalog entry (presentRuntimeCatalogEntry). */
export const RemoteAgentRuntimeCatalogEntryViewSchema = z.object({
  runtimeKind: runtimeKindSchema,
  executablePath: z.string().optional(),
  status: runtimeCatalogStatusSchema,
  version: z.string().optional(),
  metadata: jsonRecordSchema,
  lastError: z.string().optional(),
  lastSeenAt: IsoInstantStringSchema.optional(),
})

/** A machine-detail binding row (presentMachineBinding). */
export const RemoteAgentMachineBindingViewSchema = z.object({
  remoteAgentId: z.string(),
  displayName: z.string(),
  runtimeKind: runtimeKindSchema,
  runtimePath: z.string().optional(),
  localRootPath: z.string().optional(),
  status: bindingStatusSchema,
  runtimeSummary: RemoteAgentRuntimeSummaryViewSchema.optional(),
})

/** One-click installer command block. */
export const OneClickInstallCommandsSchema = z.object({
  unix: z.string(),
  windows: z.string(),
})

/** GET remote-agents — `{ remoteAgents: RemoteAgentView[] }`. */
export const RemoteAgentListResponseSchema = z.object({
  remoteAgents: z.array(RemoteAgentViewSchema),
})
export type RemoteAgentListResponseSchemaType = z.infer<
  typeof RemoteAgentListResponseSchema
>

/** GET remote-agent/:id and POST .../bind — `{ remoteAgent: RemoteAgentView }`. */
export const RemoteAgentResponseSchema = z.object({
  remoteAgent: RemoteAgentViewSchema,
})
export type RemoteAgentResponseSchemaType = z.infer<
  typeof RemoteAgentResponseSchema
>

/** GET/PUT group-task-grants — `{ grants: RemoteAgentGroupTaskGrantView[] }`. */
export const RemoteAgentGroupTaskGrantsResponseSchema = z.object({
  grants: z.array(RemoteAgentGroupTaskGrantViewSchema),
})
export type RemoteAgentGroupTaskGrantsResponseSchemaType = z.infer<
  typeof RemoteAgentGroupTaskGrantsResponseSchema
>

/**
 * POST pairing-sessions (201) — the pairing-session ticket. `machine` is the
 * presented machine view; `oneClickCommands` is the installer block (null when
 * the private registry is unset).
 */
export const RemoteAgentMachinePairingSessionResponseSchema = z.object({
  machine: RemoteAgentMachineViewSchema,
  apiKey: z.string(),
  daemonCommand: z.string(),
  oneClickCommands: OneClickInstallCommandsSchema.nullable(),
})
export type RemoteAgentMachinePairingSessionResponseSchemaType = z.infer<
  typeof RemoteAgentMachinePairingSessionResponseSchema
>

/** GET remote-agent-machines — `{ machines: RemoteAgentMachineView[] }`. */
export const RemoteAgentMachineListResponseSchema = z.object({
  machines: z.array(RemoteAgentMachineViewSchema),
})
export type RemoteAgentMachineListResponseSchemaType = z.infer<
  typeof RemoteAgentMachineListResponseSchema
>

/** GET remote-agent-machines/:id — machine detail. */
export const RemoteAgentMachineDetailResponseSchema = z.object({
  machine: RemoteAgentMachineViewSchema,
  runtimeCatalog: z.array(RemoteAgentRuntimeCatalogEntryViewSchema),
  bindings: z.array(RemoteAgentMachineBindingViewSchema),
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
