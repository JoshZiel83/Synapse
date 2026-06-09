import type {
  AvailableSkillSummary,
  CapabilitySurface,
  RuntimeActorContext,
  SkillSurfaceItem,
  ToolSurfaceItem,
} from "@synapse/shared/types"
import type { ProjectedToolDefinition, ToolSourceKind } from "@synapse/shared"
import { type ResolvedMcpTools } from "../mcp-plugins/tool-resolver.js"
import { projectToolsForPrincipal } from "../capability-projection/service.js"
import { listVisibleSkills } from "../skills/service.js"
import { db } from "../../infrastructure/database/kysely.js"
import { createLogger } from "../../infrastructure/logger/index.js"

const log = createLogger("capabilities")

const EMPTY_MCP_TOOLS: ResolvedMcpTools = {
  tools: [],
  executor: async () => ({
    content: [],
    origin: { kind: "system", registryKey: "empty_mcp_tools" },
  }),
  mcpVersion: 0,
  refresh: async () => ({ tools: [], mcpVersion: 0 }),
  setTurnId: () => {},
  shutdown: async () => {},
}

// Maps the structured ToolRef source kind to the dashboard surface label.
// Routed tools are system/plugin/device; the prior `device__`-prefix sniff is
// gone — provenance is read from `ref.source.kind`.
function surfaceSourceFor(kind: ToolSourceKind): ToolSurfaceItem["source"] {
  switch (kind) {
    case "device":
      return "device_capability"
    case "plugin":
      return "plugin_installation"
    case "system":
      return "builtin"
  }
}

function mapToolSurfaceItem(tool: ProjectedToolDefinition): ToolSurfaceItem {
  return {
    id: tool.ref.toolId,
    name: tool.name,
    source: surfaceSourceFor(tool.ref.source.kind),
  }
}

function mapSkillSurfaceItem(skill: AvailableSkillSummary): SkillSurfaceItem {
  return {
    id: skill.instanceId,
    name: skill.name,
    source: "installed",
  }
}

export async function resolveActorCapabilitySurface(
  runtimeContext: RuntimeActorContext & { conversationId: string }
): Promise<{
  runtimeContext: RuntimeActorContext
  surface: CapabilitySurface
  availableSkills: AvailableSkillSummary[]
  mcpTools: ResolvedMcpTools
}> {
  // Resolve the calling user's workspace_member so member-scoped grants
  // (approval bindings, controller-issued member grants) become visible to the
  // tool resolver and skills surface. Without this, an approved member would
  // be granted a binding but the runtime wouldn't see it.
  const resolved: RuntimeActorContext & { conversationId: string } = {
    ...runtimeContext,
  }
  if (!resolved.workspaceMemberId && resolved.userId) {
    const member = await db
      .selectFrom("workspace_members")
      .select("id")
      .where("workspace_id", "=", resolved.workspaceId)
      .where("user_id", "=", resolved.userId)
      .limit(1)
      .executeTakeFirst()
    if (member) {
      resolved.workspaceMemberId = member.id
    }
  }

  let mcpTools = EMPTY_MCP_TOOLS
  try {
    if (!resolved.actorId) {
      // Pure-conversation surface: no device tools projected. The legacy
      // resolver supported this; the new projection requires an actorId.
      mcpTools = EMPTY_MCP_TOOLS
    } else {
      mcpTools = await projectToolsForPrincipal({
        ...resolved,
        principal: {
          kind: "actor",
          actorId: resolved.actorId,
          conversationId: resolved.conversationId,
        },
        consumer: "chat_runtime",
      })
    }
  } catch (error: any) {
    log.error({ err: error }, "[capabilities] Failed to resolve MCP tools")
  }

  const availableSkills = await listVisibleSkills({
    workspaceId: resolved.workspaceId,
    workspaceMemberId: resolved.workspaceMemberId,
    actorId: resolved.actorId,
    sessionId: resolved.sessionId,
    conversationId: resolved.conversationId,
    conversationKind: resolved.conversationKind,
    isImConversation: resolved.isImConversation,
  })

  return {
    runtimeContext: resolved,
    surface: {
      tools: mcpTools.tools.map((tool) => mapToolSurfaceItem(tool)),
      skills: availableSkills.map(mapSkillSurfaceItem),
      version: mcpTools.mcpVersion,
    },
    availableSkills,
    mcpTools,
  }
}
