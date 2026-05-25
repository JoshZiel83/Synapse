import type {
  AvailableSkillSummary,
  CapabilitySurface,
  RuntimeActorContext,
  SkillSurfaceItem,
  ToolSurfaceItem,
} from "@synapse/shared/types"
import { type ResolvedMcpTools } from "../mcp-plugins/tool-resolver.js"
import { projectToolsForPrincipal } from "../capability-projection/service.js"
import { listVisibleSkills } from "../skills/service.js"
import { db } from "../../infrastructure/database/kysely.js"

const EMPTY_MCP_TOOLS: ResolvedMcpTools = {
  tools: [],
  executor: async () => ({ content: [] }),
  mcpVersion: 0,
  refresh: async () => ({ tools: [], mcpVersion: 0 }),
  setTurnId: () => {},
  shutdown: async () => {},
}

function mapToolSurfaceItem(toolName: string): ToolSurfaceItem {
  return {
    id: toolName,
    name: toolName,
    source: toolName.startsWith("device__")
      ? "device_capability"
      : "plugin_installation",
  }
}

function mapSkillSurfaceItem(skill: AvailableSkillSummary): SkillSurfaceItem {
  return {
    id: skill.instanceId,
    slug: skill.slug,
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
        principal: { kind: "actor", actorId: resolved.actorId, conversationId: resolved.conversationId },
        consumer: "chat_runtime",
      })
    }
  } catch (error: any) {
    console.error(
      "[capabilities] Failed to resolve MCP tools:",
      error?.message || String(error)
    )
  }

  const availableSkills = await listVisibleSkills({
    workspaceId: resolved.workspaceId,
    workspaceMemberId: resolved.workspaceMemberId,
    actorId: resolved.actorId,
    sessionId: resolved.sessionId,
    conversationId: resolved.conversationId,
    conversationKind: resolved.conversationKind,
    conversationBoundary: resolved.conversationBoundary,
  })

  return {
    runtimeContext: resolved,
    surface: {
      tools: mcpTools.tools.map((tool) => mapToolSurfaceItem(tool.name)),
      skills: availableSkills.map(mapSkillSurfaceItem),
      version: mcpTools.mcpVersion,
    },
    availableSkills,
    mcpTools,
  }
}
