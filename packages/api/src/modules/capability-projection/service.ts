// @synapse/api/src/modules/capability-projection
// Unified tool projection per docs/device-runtime-v3.md §11.
//
// v3.0 skeleton: this module is the single canonical entry point used by chat
// runtime and reverse MCP. It delegates to mcp-plugins/tool-resolver.ts for
// plugin + legacy relay_capability projections AND now unions device_capability
// tools alongside, so the planner sees device-side bash / list_dir / etc.
// alongside MCP plugins. Device dispatch goes through DeviceTunnelRegistry +
// the synchronous tools/call client in devices/dispatch.ts.

import { randomUUID } from "node:crypto"
import type {
  ToolDefinition,
  NormalizedMcpToolResult,
  RuntimeActorContext,
  ConversationBoundary,
  CanonicalContentBlock,
} from "@synapse/shared/types"
import { SUBJECT_KIND, textBlock } from "@synapse/shared"
import type { McpExecutionContext } from "../mcp-plugins/instance-manager.js"
import {
  resolveMcpToolsForActor,
  resolveMcpToolsForRemoteAgent,
  type ResolvedMcpTools,
} from "../mcp-plugins/tool-resolver.js"
import { db } from "../../infrastructure/database/kysely.js"
import { upsertAccessSubject } from "../access/subject-registry.js"
import { ensureConversationActorContext } from "../session/service.js"
import { dispatchSyncTool } from "../devices/dispatch.js"
import {
  loadDeviceCapabilityToolsForSubjects,
  type DeviceCapabilityToolRow,
} from "./device-capabilities.js"

/**
 * Discriminated union of principals that capability projection evaluates
 * tools for. See docs/device-runtime-v3.md §10.3.
 *
 * - `actor` with optional conversationId — chat runtime acting on behalf of
 *   an actor. When conversationId is provided, projection ALSO reads
 *   conversation-scoped bindings (the 1:1 device-picker output).
 * - `actor_in_conversation` — group-chat actor, anchored to a specific
 *   conversation_actor_context.
 * - `conversation` — transcript-side jobs with no actor in play.
 * - `remote_agent` — reverse MCP caller bridged into a conversation.
 * - `workspace_member` — dashboard introspection; never used for executable
 *   dispatch.
 */
export type DevicePrincipal =
  | { kind: "actor"; actorId: string; conversationId?: string }
  | { kind: "conversation"; conversationId: string }
  | {
      kind: "actor_in_conversation"
      conversationActorContextId: string
      actorId: string
      conversationId: string
    }
  | { kind: "remote_agent"; remoteAgentId: string; conversationId: string }
  | {
      kind: "workspace_member"
      workspaceId: string
      workspaceMemberId: string
    }

/**
 * Consumer kind controls permission semantics. See docs/device-runtime-v3.md §11:
 *
 * - `chat_runtime` / `reverse_mcp` — only count explicit `use` grants from
 *   resource_access_bindings; manageable resources are NOT auto-included so
 *   the active-device picker actually narrows chat surface.
 * - `dashboard` — also counts `view` / `manage`-derived permissions.
 */
export type CapabilityProjectionConsumer =
  | "chat_runtime"
  | "reverse_mcp"
  | "dashboard"

export interface ProjectToolsInput extends Omit<
  RuntimeActorContext,
  "actorId"
> {
  workspaceId: string
  principal: DevicePrincipal
  conversationId?: string
  conversationKind?: "private" | "group" | "virtual"
  conversationBoundary?: ConversationBoundary
  consumer: CapabilityProjectionConsumer
}

/**
 * Projection output preserves the existing ResolvedMcpTools surface so callers
 * can swap in without touching their dispatch loop. PR #7 will additionally
 * surface device-attributed bindings via the binding/origin discriminator
 * documented in docs/device-runtime-v3.md §11 outputs section.
 */
export type ProjectedToolList = ResolvedMcpTools

/**
 * Single canonical entry point. Routes to the legacy actor / remote_agent
 * resolver in v3.0 skeleton; PR #7 extends it to union device_capability
 * exposures.
 */
export async function projectToolsForPrincipal(
  input: ProjectToolsInput
): Promise<ProjectedToolList> {
  const legacy = await projectLegacyTools(input)
  const device = await projectDeviceTools(input)
  if (device.tools.length === 0) return legacy
  return unionWithDevice(legacy, device)
}

async function projectLegacyTools(
  input: ProjectToolsInput
): Promise<ProjectedToolList> {
  const { principal } = input
  switch (principal.kind) {
    case "actor":
    case "actor_in_conversation":
    case "conversation": {
      // chat-runtime / dashboard delegate to the actor resolver. For
      // `conversation` (no actor in play) we pass an empty actor identity;
      // the legacy resolver tolerates this for workspace-scoped bindings.
      const actorId = principal.kind === "conversation" ? "" : principal.actorId
      const conversationId =
        principal.kind === "conversation"
          ? principal.conversationId
          : (principal.conversationId ?? input.conversationId ?? "")
      if (!conversationId) {
        throw new Error(
          "capability-projection: conversationId is required for chat-runtime principals"
        )
      }
      if (!actorId) {
        throw new Error(
          "capability-projection: actorId is required for non-conversation principals (workspace-only chat dispatch is not in v3.0 scope)"
        )
      }
      return resolveMcpToolsForActor({
        ...input,
        actorId,
        conversationId,
      })
    }
    case "remote_agent": {
      return resolveMcpToolsForRemoteAgent({
        ...input,
        conversationId: principal.conversationId,
        remoteAgentId: principal.remoteAgentId,
      })
    }
    case "workspace_member": {
      // Dashboard introspection is not yet exposed through this module — its
      // current callers use the access evaluator directly. v3 reserves this
      // branch for the future projection-backed dashboard rendering.
      throw new Error(
        "capability-projection: workspace_member principal is dashboard-only and not yet wired"
      )
    }
  }
}

interface DeviceToolBundle {
  tools: ToolDefinition[]
  handlers: Map<string, DeviceCapabilityToolRow>
}

// Tools we project from device_capabilities are namespaced so they cannot
// collide with MCP-plugin tools that happen to share a bare name.
const DEVICE_TOOL_PREFIX = "device__"

function namespaceDeviceToolName(row: DeviceCapabilityToolRow): string {
  return `${DEVICE_TOOL_PREFIX}${row.device_capability_id}__${row.visible_tool_name}`
}

async function principalSubjectIds(
  input: ProjectToolsInput
): Promise<string[]> {
  const ids: string[] = []
  // Every principal can see workspace-scoped bindings.
  ids.push(
    await upsertAccessSubject(db, {
      kind: SUBJECT_KIND.WORKSPACE,
      workspaceId: input.workspaceId,
    })
  )
  const principal = input.principal
  switch (principal.kind) {
    case "actor": {
      ids.push(
        await upsertAccessSubject(db, {
          kind: SUBJECT_KIND.ACTOR,
          actorId: principal.actorId,
        })
      )
      if (principal.conversationId) {
        ids.push(
          await upsertAccessSubject(db, {
            kind: SUBJECT_KIND.CONVERSATION,
            conversationId: principal.conversationId,
          })
        )
      }
      break
    }
    case "actor_in_conversation": {
      ids.push(
        await upsertAccessSubject(db, {
          kind: SUBJECT_KIND.ACTOR,
          actorId: principal.actorId,
        }),
        await upsertAccessSubject(db, {
          kind: SUBJECT_KIND.CONVERSATION,
          conversationId: principal.conversationId,
        })
      )
      try {
        const ctx = await ensureConversationActorContext({
          actorId: principal.actorId,
          conversationId: principal.conversationId,
        })
        ids.push(
          await upsertAccessSubject(db, {
            kind: SUBJECT_KIND.CONVERSATION_ACTOR_CONTEXT,
            contextId: ctx.conversationActorContextId,
          })
        )
      } catch {
        /* if the context can't be resolved we still surface workspace/actor
         * bindings — the planner just won't see actor_in_conversation grants */
      }
      break
    }
    case "conversation": {
      ids.push(
        await upsertAccessSubject(db, {
          kind: SUBJECT_KIND.CONVERSATION,
          conversationId: principal.conversationId,
        })
      )
      break
    }
    case "remote_agent": {
      ids.push(
        await upsertAccessSubject(db, {
          kind: SUBJECT_KIND.REMOTE_AGENT,
          remoteAgentId: principal.remoteAgentId,
        }),
        await upsertAccessSubject(db, {
          kind: SUBJECT_KIND.CONVERSATION,
          conversationId: principal.conversationId,
        })
      )
      break
    }
    case "workspace_member":
      // Already gated by the projectToolsForPrincipal switch above.
      break
  }
  return ids
}

async function projectDeviceTools(
  input: ProjectToolsInput
): Promise<DeviceToolBundle> {
  // workspace_member never reaches here (throws above) and the chat-runtime
  // consumer is the only one currently wired for device dispatch.
  if (input.principal.kind === "workspace_member") {
    return { tools: [], handlers: new Map() }
  }
  const subjectIds = await principalSubjectIds(input)
  const rows = await loadDeviceCapabilityToolsForSubjects({
    workspaceId: input.workspaceId,
    subjectIds,
  })
  const handlers = new Map<string, DeviceCapabilityToolRow>()
  const tools: ToolDefinition[] = []
  for (const row of rows) {
    const name = namespaceDeviceToolName(row)
    handlers.set(name, row)
    tools.push({
      name,
      description: row.visible_description || `Device tool: ${row.visible_tool_name} on ${row.device_name}`,
      parameters: normalizeInputSchema(row.input_schema),
    })
  }
  return { tools, handlers }
}

function normalizeInputSchema(raw: unknown): ToolDefinition["parameters"] {
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>
    const props =
      obj["properties"] && typeof obj["properties"] === "object"
        ? (obj["properties"] as ToolDefinition["parameters"]["properties"])
        : {}
    const required = Array.isArray(obj["required"])
      ? (obj["required"] as string[])
      : []
    return { type: "object", properties: props, required }
  }
  return { type: "object", properties: {}, required: [] }
}

function unionWithDevice(
  legacy: ProjectedToolList,
  device: DeviceToolBundle
): ProjectedToolList {
  const dispatchDeviceTool = async (
    toolName: string,
    input: Record<string, unknown>
  ): Promise<NormalizedMcpToolResult> => {
    const row = device.handlers.get(toolName)
    if (!row) {
      return mcpErrorBlock(
        `device tool ${toolName} not found in projection`
      )
    }
    // v3.0 skeleton dispatches without a signed OperationEnvelope; the dispatcher
    // currently treats the envelope as opaque metadata so this works for smoke
    // tests but PR #6 will require a real signed envelope (see §4.5). The
    // attempt_id is generated here so retries surface as distinct attempts in
    // device_operation_attempts.
    const envelopeStub = {
      operation_id: randomUUID(),
      attempt_id: randomUUID(),
      device_runtime_session_id: randomUUID(),
      device_capability_id: row.device_capability_id,
      device_exposure_id: row.device_exposure_id,
      device_tool_id: row.device_tool_id,
      device_tool_revision_id: row.device_tool_revision_id,
      input_hash: "",
      task_mode: "sync" as const,
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      signature_kid: "v3-skeleton-unsigned",
      signature: "v3-skeleton-unsigned",
    }
    // device_service_id is the runtime currently serving the capability; in
    // v3.0 skeleton we look it up from the exposure -> service join already
    // baked into the row's device_exposure_id metadata. For now we delegate
    // to dispatchSyncTool which calls DeviceTunnelRegistry.resolve(); we use
    // the exposure_id as the service-key surrogate. When PR #6 wires the
    // session table the lookup will resolve via the catalog_revision_id.
    const result = await dispatchSyncTool({
      deviceServiceId: row.device_exposure_id,
      envelope: envelopeStub,
      args: input,
      toolName: row.visible_tool_name,
    })
    if (!result.ok) {
      return mcpErrorBlock(
        `device dispatch failed (${result.error?.code}): ${result.error?.message}`
      )
    }
    const tool = result.result as
      | { content?: CanonicalContentBlock[]; isError?: boolean }
      | undefined
    return {
      content: tool?.content ?? [],
      isError: tool?.isError,
    }
  }

  const executor = async (
    toolName: string,
    input: Record<string, unknown>,
    executionContext?: McpExecutionContext
  ): Promise<NormalizedMcpToolResult> => {
    if (device.handlers.has(toolName)) {
      return dispatchDeviceTool(toolName, input)
    }
    return legacy.executor(toolName, input, executionContext)
  }

  const refresh = async () => {
    const refreshed = await legacy.refresh()
    return {
      tools: [...refreshed.tools, ...device.tools],
      mcpVersion: refreshed.mcpVersion,
    }
  }

  return {
    tools: [...legacy.tools, ...device.tools],
    executor,
    mcpVersion: legacy.mcpVersion,
    refresh,
    setTurnId: legacy.setTurnId,
    shutdown: legacy.shutdown,
  }
}

function mcpErrorBlock(message: string): NormalizedMcpToolResult {
  return {
    content: [textBlock(message) as CanonicalContentBlock],
    isError: true,
  }
}

/** Re-export shared executor/dispatch shapes so callers depend on this module only. */
export type {
  ToolDefinition,
  NormalizedMcpToolResult,
  McpExecutionContext,
  ResolvedMcpTools,
}
