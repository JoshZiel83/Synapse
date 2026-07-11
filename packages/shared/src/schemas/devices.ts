import { z } from "zod"
import {
  DEVICE_BUILTIN_KINDS,
  DEVICE_EXPOSURE_RUNTIME_STATUSES,
  DEVICE_EXPOSURE_TRANSPORTS,
  DEVICE_PAIRING_MODES,
  DEVICE_PAIRING_STATUSES,
  DEVICE_SERVICE_KINDS,
  DEVICE_SERVICE_STATUSES,
  DEVICE_TRUST_STATUSES,
  DEVICE_TYPES,
} from "@synapse/device-protocol/enums"
import {
  RUNTIME_CAPABILITY_ACCESS_SCOPE_KIND,
  RUNTIME_CAPABILITY_ACCESS_SCOPE_KINDS,
  RUNTIME_CAPABILITY_ACCESS_SUBJECT_KIND,
  RUNTIME_CAPABILITY_ACCESS_SUBJECT_KINDS,
} from "../constants/enums.js"
import { IsoInstantStringSchema } from "./datetime.js"

/**
 * App-facing camelCase contract for the device-management dashboard
 * (list / detail / capabilities). Source of truth for what web-next and the
 * consumer-side device-sdk read. The signed machine/wire shapes (pairing,
 * bootstrap, control-plane) stay snake_case in @synapse/device-protocol — only
 * these *read views* are app-facing per master plan §2.3-6.
 */

export const DeviceViewSchema = z.strictObject({
  id: z.uuid(),
  workspaceId: z.uuid(),
  title: z.string(),
  deviceType: z.enum(DEVICE_TYPES),
  platform: z.string().nullable(),
  trustStatus: z.enum(DEVICE_TRUST_STATUSES),
  lastSeenAt: IsoInstantStringSchema.nullable(),
  lastConnectedAt: IsoInstantStringSchema.nullable(),
})
export type DeviceView = z.infer<typeof DeviceViewSchema>

export const DeviceListViewSchema = z.array(DeviceViewSchema)
export type DeviceListView = z.infer<typeof DeviceListViewSchema>

export const DeviceServiceViewSchema = z.strictObject({
  id: z.uuid(),
  deviceId: z.uuid(),
  serviceKind: z.enum(DEVICE_SERVICE_KINDS),
  version: z.string().nullable(),
  status: z.enum(DEVICE_SERVICE_STATUSES),
  lastSeenAt: IsoInstantStringSchema.nullable(),
  remoteAgentMachineId: z.uuid().nullable(),
})
export type DeviceServiceView = z.infer<typeof DeviceServiceViewSchema>

export const DeviceCapabilityViewSchema = z.strictObject({
  id: z.uuid(),
  workspaceId: z.uuid(),
  exposureId: z.uuid(),
  exposureStableKey: z.string(),
  displayName: z.string(),
  transport: z.enum(DEVICE_EXPOSURE_TRANSPORTS),
  builtinKind: z.enum(DEVICE_BUILTIN_KINDS).nullable(),
  runtimeStatus: z.enum(DEVICE_EXPOSURE_RUNTIME_STATUSES),
  // exposure-level metadata pass-through (provider-defined; open shape).
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
})
export type DeviceCapabilityView = z.infer<typeof DeviceCapabilityViewSchema>

export const DeviceDetailViewSchema = DeviceViewSchema.extend({
  description: z.string().nullable(),
  ownerWorkspaceMemberId: z.uuid().nullable(),
  services: z.array(DeviceServiceViewSchema),
  capabilities: z.array(DeviceCapabilityViewSchema),
})
export type DeviceDetailView = z.infer<typeof DeviceDetailViewSchema>

/**
 * Pairing ticket presented to the dashboard after starting a pairing session.
 * Carries dashboard-only display fields (oneClickCommands, verificationUri*)
 * that the wire `PairingTicket` does not. `bootstrapToken` here is the
 * camelCase app copy handed to web (which injects it into the sandbox env);
 * the snake_case wire `bootstrap_token` stays in device-protocol for the
 * sandbox→/devices/bootstrap handshake.
 */
export const DevicePairingTicketViewSchema = z.strictObject({
  pairingSessionId: z.uuid(),
  mode: z.enum(DEVICE_PAIRING_MODES),
  pairingCode: z.string().nullable(),
  bootstrapToken: z.string().nullish(),
  expiresAt: IsoInstantStringSchema,
  verificationUri: z.string().nullable(),
  verificationUriComplete: z.string().nullable(),
  status: z.enum(DEVICE_PAIRING_STATUSES),
  oneClickCommands: z
    .strictObject({ unix: z.string(), windows: z.string() })
    .nullish(),
})
export type DevicePairingTicketView = z.infer<
  typeof DevicePairingTicketViewSchema
>

// ============================================================================
// App-facing WRITE-path input contracts (camelCase). Per master plan §5.1.1 /
// §8.3, the request bodies for the device MANAGEMENT methods (createCloudDevice
// / startPairing / claimRemoteAgentDaemon / setActiveRuntimeCapabilities) are
// app contracts too — defined here in camelCase, paired with their *View
// result. controller parses with these; web-next + consumer-side device-sdk
// send camelCase bodies. The true wire/handshake inputs (consume / bootstrap)
// stay snake_case in @synapse/device-protocol (device-runtime/sandbox callers).
// ============================================================================

export const CreateCloudDeviceInputSchema = z.strictObject({
  workspaceId: z.uuid(),
  // title is optional: the server applies a default ("Cloud Device") when
  // omitted, so the app contract must accept its absence too — otherwise the
  // SDK would reject requests the server happily serves.
  title: z.string().min(1).optional(),
  preset: z.string().optional(),
})
export type CreateCloudDeviceInput = z.infer<
  typeof CreateCloudDeviceInputSchema
>

/**
 * App-facing result of createCloudDevice (camelCase), returned to web which
 * injects `bootstrapToken` into the sandbox env. The snake_case wire copy
 * (device-protocol `CreateCloudDeviceResultSchema.bootstrap_token`) is the
 * separate handshake contract used by the sandbox→/devices/bootstrap exchange;
 * same logical value, two surfaces, two independent contracts (§13.1).
 */
export const CreateCloudDeviceResultViewSchema = z.strictObject({
  pendingRuntimeId: z.uuid(),
  bootstrapToken: z.string(),
  pairingSessionId: z.uuid(),
  expiresAt: IsoInstantStringSchema,
})
export type CreateCloudDeviceResultView = z.infer<
  typeof CreateCloudDeviceResultViewSchema
>

export const StartPairingInputSchema = z.strictObject({
  workspaceId: z.uuid(),
  mode: z.enum(DEVICE_PAIRING_MODES),
  title: z.string().optional(),
  description: z.string().max(2000).optional(),
  deviceType: z.enum(DEVICE_TYPES).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  requestedPubkeyFingerprint: z.string().optional(),
  selfChallenge: z.string().optional(),
})
export type StartPairingInput = z.infer<typeof StartPairingInputSchema>

export const ClaimDaemonServiceInputSchema = z.strictObject({
  serviceKind: z.literal("remote_agent_daemon"),
  remoteAgentMachineId: z.uuid(),
})
export type ClaimDaemonServiceInput = z.infer<
  typeof ClaimDaemonServiceInputSchema
>

const RuntimeCapabilitySubjectRefSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal(RUNTIME_CAPABILITY_ACCESS_SUBJECT_KIND.WORKSPACE),
    workspaceId: z.uuid(),
  }),
  z.strictObject({
    kind: z.literal(RUNTIME_CAPABILITY_ACCESS_SUBJECT_KIND.ACTOR),
    actorId: z.uuid(),
  }),
  z.strictObject({
    kind: z.literal(RUNTIME_CAPABILITY_ACCESS_SUBJECT_KIND.REMOTE_AGENT),
    remoteAgentId: z.uuid(),
  }),
  z.strictObject({
    kind: z.literal(RUNTIME_CAPABILITY_ACCESS_SUBJECT_KIND.CONVERSATION),
    conversationId: z.uuid(),
  }),
])

/**
 * App-facing active-capability target. It intentionally mirrors the current
 * device binding whitelist without importing the device-protocol wire schema:
 * unscoped workspace/actor/remote_agent/conversation, or actor/remote_agent
 * scoped to a conversation.
 */
export const RuntimeCapabilityAccessTargetInputSchema = z
  .strictObject({
    subject: RuntimeCapabilitySubjectRefSchema,
    scope: RuntimeCapabilitySubjectRefSchema.optional(),
  })
  .superRefine((target, ctx) => {
    if (!target.scope) {
      return
    }
    const allowed =
      (target.subject.kind === RUNTIME_CAPABILITY_ACCESS_SUBJECT_KIND.ACTOR ||
        target.subject.kind ===
          RUNTIME_CAPABILITY_ACCESS_SUBJECT_KIND.REMOTE_AGENT) &&
      target.scope.kind === RUNTIME_CAPABILITY_ACCESS_SCOPE_KIND.CONVERSATION
    if (!allowed) {
      ctx.addIssue({
        code: "custom",
        message: `scoped target (subject.kind=${target.subject.kind}, scope.kind=${target.scope.kind}) is not in whitelist (only actor+conversation, remote_agent+conversation)`,
        path: ["scope"],
      })
    }
  })
export type RuntimeCapabilityAccessTargetInput = z.infer<
  typeof RuntimeCapabilityAccessTargetInputSchema
>

/**
 * Active-capability binding write. This is an app-facing management contract:
 * camelCase body, shared-owned target schema, and no device-protocol wire schema
 * reuse.
 */
export const SetActiveRuntimeCapabilitiesInputSchema = z.strictObject({
  workspaceId: z.uuid(),
  target: RuntimeCapabilityAccessTargetInputSchema,
  runtimeCapabilityIds: z.array(z.uuid()),
  reason: z.string().max(2000).optional(),
})
export type SetActiveRuntimeCapabilitiesInput = z.infer<
  typeof SetActiveRuntimeCapabilitiesInputSchema
>

/**
 * GET active-capabilities list query for a target (app-facing). This is the
 * query-string equivalent of the shared target whitelist above; the API maps
 * the flattened query form back to the internal AccessTarget at the route
 * boundary.
 */
export const ActiveRuntimeCapabilitiesListQuerySchema = z
  .object({
    subjectKind: z.enum(RUNTIME_CAPABILITY_ACCESS_SUBJECT_KINDS),
    subjectWorkspaceId: z.uuid().optional(),
    subjectActorId: z.uuid().optional(),
    subjectConversationId: z.uuid().optional(),
    subjectRemoteAgentId: z.uuid().optional(),
    scopeKind: z.enum(RUNTIME_CAPABILITY_ACCESS_SCOPE_KINDS).optional(),
    scopeConversationId: z.uuid().optional(),
  })
  .superRefine((query, ctx) => {
    if (query.scopeKind !== RUNTIME_CAPABILITY_ACCESS_SCOPE_KIND.CONVERSATION)
      return
    if (!query.scopeConversationId) {
      ctx.addIssue({
        code: "custom",
        message: "scopeConversationId required when scopeKind=conversation",
        path: ["scopeConversationId"],
      })
    }
    if (
      query.subjectKind !== RUNTIME_CAPABILITY_ACCESS_SUBJECT_KIND.ACTOR &&
      query.subjectKind !== RUNTIME_CAPABILITY_ACCESS_SUBJECT_KIND.REMOTE_AGENT
    ) {
      ctx.addIssue({
        code: "custom",
        message: `scopeKind=conversation only allowed with subjectKind=actor|remote_agent (got ${query.subjectKind})`,
        path: ["scopeKind"],
      })
    }
  })
export type ActiveRuntimeCapabilitiesListQuery = z.infer<
  typeof ActiveRuntimeCapabilitiesListQuerySchema
>

/** GET active-capabilities list result for a target (app-facing). */
export const ActiveRuntimeCapabilitiesViewSchema = z.strictObject({
  runtimeCapabilityIds: z.array(z.uuid()),
})
export type ActiveRuntimeCapabilitiesView = z.infer<
  typeof ActiveRuntimeCapabilitiesViewSchema
>
