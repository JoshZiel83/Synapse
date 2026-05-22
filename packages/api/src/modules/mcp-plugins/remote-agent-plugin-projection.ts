import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import {
  MCP_TOOL_NAMESPACE_SEPARATOR,
  type ToolDefinition,
} from "@synapse/shared"
import { z, type ZodRawShape } from "zod"
import { executeSql } from "../../infrastructure/database/kysely.js"
import { resolveInstallationConfig } from "./config-resolver.js"
import { getOrCreateInstance } from "./instance-manager.js"

type ConversationPluginRow = {
  installation_id: string
  owner_workspace_id: string
  item_slug: string
  publisher_slug: string
  transport: "builtin" | "stdio" | "http" | "relay"
  entry_point: string | null
  tool_manifest: unknown
}

function parseToolManifest(value: unknown): ToolDefinition[] {
  if (Array.isArray(value)) return value as ToolDefinition[]
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? (parsed as ToolDefinition[]) : []
    } catch {
      return []
    }
  }
  return []
}

function jsonSchemaPropertyToZod(prop: unknown): z.ZodTypeAny {
  if (!prop || typeof prop !== "object") return z.any()
  const p = prop as { type?: string | string[]; enum?: unknown[] }
  if (Array.isArray(p.enum) && p.enum.every((v) => typeof v === "string")) {
    return z.enum(p.enum as [string, ...string[]])
  }
  const t = Array.isArray(p.type) ? p.type[0] : p.type
  switch (t) {
    case "string":
      return z.string()
    case "number":
    case "integer":
      return z.number()
    case "boolean":
      return z.boolean()
    case "array":
      return z.array(z.any())
    case "object":
      return z.record(z.any())
    default:
      return z.any()
  }
}

function toolDefinitionToZodShape(def: ToolDefinition): ZodRawShape {
  const shape: ZodRawShape = {}
  const required = new Set(def.parameters?.required ?? [])
  const props = def.parameters?.properties ?? {}
  for (const [key, prop] of Object.entries(props)) {
    const base = jsonSchemaPropertyToZod(prop)
    shape[key] = required.has(key) ? base : base.optional()
  }
  return shape
}

async function loadConversationVisiblePluginInstallations(params: {
  workspaceId: string
  conversationId: string
}): Promise<ConversationPluginRow[]> {
  const result = await executeSql<ConversationPluginRow>(
    `
      SELECT DISTINCT
        installation.id AS installation_id,
        installation.workspace_id AS owner_workspace_id,
        item.slug AS item_slug,
        publisher.slug AS publisher_slug,
        spec.transport,
        spec.entry_point,
        spec.tool_manifest
      FROM plugin_installations installation
      INNER JOIN catalog_items item ON item.id = installation.catalog_item_id
      INNER JOIN publishers publisher ON publisher.id = item.publisher_id
      INNER JOIN plugin_package_version_specs spec
        ON spec.catalog_version_id = installation.catalog_version_id
      INNER JOIN resource_access_bindings binding ON (
        binding.resource_type = 'plugin_installation'
        AND binding.plugin_installation_id = installation.id
        AND binding.status = 'active'
        AND (
          (binding.target_type = 'workspace' AND binding.subject_workspace_id = $1)
          OR (binding.target_type = 'conversation' AND binding.subject_conversation_id = $2)
        )
      )
      WHERE installation.workspace_id = $1
        AND installation.status = 'active'
      ORDER BY installation.updated_at DESC
    `,
    [params.workspaceId, params.conversationId]
  )
  return result.rows
}

/**
 * Project the (workspace OR conversation)-granted plugin tools onto the given per-conversation
 * MCP server. Tool names are namespaced `<publisher>__<plugin>__<tool>` to mirror the in-process
 * actor surface, so a remote agent sees the same shape native actors would.
 *
 * Returns the namespaced tool names that were registered (for diagnostics / tests).
 */
export async function registerConversationPluginsOnMcpServer(params: {
  server: McpServer
  workspaceId: string
  conversationId: string
}): Promise<string[]> {
  const rows = await loadConversationVisiblePluginInstallations({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
  })
  const registered: string[] = []
  for (const row of rows) {
    const resolved = await resolveInstallationConfig(row.installation_id).catch(
      () => null
    )
    if (!resolved) continue
    let instance
    try {
      instance = await getOrCreateInstance({
        pluginId: resolved.pluginId,
        installationId: resolved.installationId,
        pluginSlug: row.item_slug,
        orgSlug: row.publisher_slug,
        transport: row.transport,
        entryPoint: row.entry_point || "",
        scope: "conversation",
        scopeId: `conversation:${params.conversationId}`,
        config: resolved.config,
        workspaceId: row.owner_workspace_id,
      })
    } catch {
      continue
    }
    for (const def of instance.tools as ToolDefinition[]) {
      const namespaced = [row.publisher_slug, row.item_slug, def.name].join(
        MCP_TOOL_NAMESPACE_SEPARATOR
      )
      try {
        params.server.registerTool(
          namespaced,
          {
            description: def.description,
            inputSchema: toolDefinitionToZodShape(def),
          },
          async (input: Record<string, unknown>) => {
            const output = await instance.execute(def.name, input ?? {})
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    typeof output === "string"
                      ? output
                      : JSON.stringify(output, null, 2),
                },
              ],
            }
          }
        )
        registered.push(namespaced)
      } catch {
        // Tool registration can fail if a duplicate name shows up; skip and continue.
      }
    }
  }
  return registered
}

/** Test-only: re-export the visibility query so the test suite can poke at it. */
export const __loadConversationVisiblePluginInstallationsForTest =
  loadConversationVisiblePluginInstallations
