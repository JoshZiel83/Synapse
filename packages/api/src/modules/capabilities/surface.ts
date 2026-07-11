import type {
  AvailableSkillSummary,
  CapabilitySurface,
  RuntimeActorContext,
  SkillSurfaceItem,
  ToolSurfaceItem,
} from "@synapse/shared/types"
import type { ProjectedToolDefinition } from "@synapse/shared"
import { type ResolvedMcpTools } from "../mcp-plugins/tool-resolver.js"
import { projectToolsForPrincipal } from "../capability-projection/service.js"
import { listVisibleSkills } from "../skills/service.js"
import { selectWorkspaceMemberId } from "./repo.js"
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

// The dashboard surface label IS the routed source kind (system/plugin/device).
// The prior `device__`-prefix sniff and the builtin/plugin_installation/
// runtime_capability relabel shim are gone — provenance is `ref.source.kind`.
function mapToolSurfaceItem(tool: ProjectedToolDefinition): ToolSurfaceItem {
  return {
    id: tool.ref.toolId,
    name: tool.name,
    source: tool.ref.source.kind,
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
    const memberId = await selectWorkspaceMemberId(
      resolved.workspaceId,
      resolved.userId
    )
    if (memberId) {
      resolved.workspaceMemberId = memberId
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
