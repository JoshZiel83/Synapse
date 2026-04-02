import type {
  AvailableSkillSummary,
  CapabilitySurface,
  RuntimeActorContext,
  SkillSurfaceItem,
  ToolSurfaceItem,
} from "@synapse/shared/types";
import {
  resolveMcpToolsForActor,
  type ResolvedMcpTools,
} from "../mcp-plugins/tool-resolver.js";
import { listVisibleSkills } from "../skills/service.js";

const EMPTY_MCP_TOOLS: ResolvedMcpTools = {
  tools: [],
  executor: async () => ({ content: [] }),
  mcpVersion: 0,
  refresh: async () => ({ tools: [], mcpVersion: 0 }),
  setTurnId: () => {},
  shutdown: async () => {},
};

function mapToolSurfaceItem(toolName: string): ToolSurfaceItem {
  return {
    id: toolName,
    name: toolName,
    source: toolName.startsWith("relay__")
      ? "relay_exposure"
      : "plugin_installation",
  };
}

function mapSkillSurfaceItem(skill: AvailableSkillSummary): SkillSurfaceItem {
  return {
    id: skill.instanceId,
    slug: skill.slug,
    source: skill.sourceKind === "relay_auto_loaded"
      ? "auto_activated"
      : "installed",
  };
}

export async function resolveActorCapabilitySurface(
  runtimeContext: RuntimeActorContext & { conversationId: string },
): Promise<{
  runtimeContext: RuntimeActorContext;
  surface: CapabilitySurface;
  availableSkills: AvailableSkillSummary[];
  mcpTools: ResolvedMcpTools;
}> {
  let mcpTools = EMPTY_MCP_TOOLS;
  try {
    mcpTools = await resolveMcpToolsForActor(runtimeContext);
  } catch (error: any) {
    console.error(
      "[capabilities] Failed to resolve MCP tools:",
      error?.message || String(error),
    );
  }

  const availableSkills = await listVisibleSkills({
    workspaceId: runtimeContext.workspaceId,
    actorId: runtimeContext.actorId,
    sessionId: runtimeContext.sessionId,
    conversationId: runtimeContext.conversationId,
  });

  return {
    runtimeContext,
    surface: {
      tools: mcpTools.tools.map((tool) => mapToolSurfaceItem(tool.name)),
      skills: availableSkills.map(mapSkillSurfaceItem),
      version: mcpTools.mcpVersion,
    },
    availableSkills,
    mcpTools,
  };
}
