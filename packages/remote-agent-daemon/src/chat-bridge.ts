#!/usr/bin/env node

import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import process from "node:process"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { textBlock } from "@synapse/shared"
import { z } from "zod"

type BridgeConfig = {
  remoteAgentId: string
  serverUrl: string
  machineKey: string
  stateFile?: string
}

type ExposedDelivery = {
  deliveryId: string
  conversationId: string
  itemId: string
  sequence: number
}

type BridgeState = {
  lastConversationId?: string | null
  lastToolName?: string | null
  updatedAt?: string
  exposedDeliveries?: Record<string, ExposedDelivery[]>
}

function parseArgs(argv: string[]): BridgeConfig {
  const args = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]
    if (!current?.startsWith("--")) continue
    const next = argv[index + 1]
    if (!next || next.startsWith("--")) continue
    args.set(current.slice(2), next)
    index += 1
  }

  const remoteAgentId = args.get("remote-agent-id")?.trim() || ""
  const serverUrl = args.get("server-url")?.trim() || ""
  const machineKey = args.get("machine-key")?.trim() || ""
  const stateFile = args.get("state-file")?.trim() || undefined

  if (!remoteAgentId) {
    throw new Error("--remote-agent-id is required")
  }
  if (!serverUrl) {
    throw new Error("--server-url is required")
  }
  if (!machineKey) {
    throw new Error("--machine-key is required")
  }

  return {
    remoteAgentId,
    serverUrl,
    machineKey,
    stateFile,
  }
}

function buildUrl(
  serverUrl: string,
  pathname: string,
  query?: Record<string, string | number | undefined>
) {
  const url = new URL(pathname, serverUrl)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === "") continue
    url.searchParams.set(key, String(value))
  }
  return url
}

async function requestJson<T>(
  config: BridgeConfig,
  pathname: string,
  init?: RequestInit,
  query?: Record<string, string | number | undefined>
): Promise<T> {
  const url = buildUrl(config.serverUrl, pathname, query)
  const headers = new Headers(init?.headers)
  headers.set("authorization", `Bearer ${config.machineKey}`)
  if (init?.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }

  const response = await fetch(url, {
    ...init,
    headers,
  })

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "")
    throw new Error(
      `Bridge request failed (${response.status} ${response.statusText})${bodyText ? `: ${bodyText}` : ""}`
    )
  }

  return (await response.json()) as T
}

function jsonToolResult<T extends Record<string, unknown>>(
  structuredContent: T
) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(structuredContent, null, 2),
      },
    ],
    structuredContent,
  }
}

function loadBridgeState(config: BridgeConfig): BridgeState {
  if (!config.stateFile) {
    return {}
  }
  try {
    if (!existsSync(config.stateFile)) {
      return {}
    }
    const raw = readFileSync(config.stateFile, "utf8").trim()
    if (!raw) {
      return {}
    }
    const parsed = JSON.parse(raw) as BridgeState
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function writeBridgeState(config: BridgeConfig, state: BridgeState) {
  if (!config.stateFile) {
    return
  }
  writeFileSync(config.stateFile, JSON.stringify(state, null, 2), "utf8")
}

function updateBridgeState(config: BridgeConfig, patch: Partial<BridgeState>) {
  if (!config.stateFile) {
    return
  }
  try {
    const current = loadBridgeState(config)
    const next = {
      ...current,
      ...patch,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    }
    writeBridgeState(config, next)
  } catch {}
}

async function main() {
  const config = parseArgs(process.argv.slice(2))
  const server = new McpServer(
    {
      name: "synapse-chat-bridge",
      version: "0.1.0",
    },
    {
      capabilities: {
        logging: {},
      },
    }
  )

  server.registerTool(
    "list_conversations",
    {
      description:
        "List conversations this remote agent participates in, including unread counts.",
      inputSchema: {},
      outputSchema: {
        conversations: z.array(z.any()),
      },
    },
    async () => {
      updateBridgeState(config, {
        lastToolName: "list_conversations",
      })
      const result = await requestJson<{ conversations: unknown[] }>(
        config,
        `/api/v1/internal/remote-agents/${config.remoteAgentId}/conversations`
      )
      return jsonToolResult(result)
    }
  )

  server.registerTool(
    "check_messages",
    {
      description: "Return pending message deliveries for this remote agent.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).optional(),
      },
      outputSchema: {
        deliveries: z.array(z.any()),
      },
    },
    async ({ limit }) => {
      updateBridgeState(config, {
        lastToolName: "check_messages",
      })
      const result = await requestJson<{ deliveries: ExposedDelivery[] }>(
        config,
        `/api/v1/internal/remote-agents/${config.remoteAgentId}/check-messages`,
        undefined,
        { limit }
      )
      if (result.deliveries.length > 0) {
        const state = loadBridgeState(config)
        const exposedDeliveries = {
          ...(state.exposedDeliveries ?? {}),
        }
        for (const delivery of result.deliveries) {
          const current = exposedDeliveries[delivery.conversationId] ?? []
          if (
            !current.some((entry) => entry.deliveryId === delivery.deliveryId)
          ) {
            current.push(delivery)
          }
          exposedDeliveries[delivery.conversationId] = current.sort(
            (left, right) => left.sequence - right.sequence
          )
        }
        writeBridgeState(config, {
          ...state,
          lastToolName: "check_messages",
          exposedDeliveries,
          updatedAt: new Date().toISOString(),
        })
      }

      return jsonToolResult(result)
    }
  )

  server.registerTool(
    "read_history",
    {
      description:
        "Read visible conversation history for a specific conversation.",
      inputSchema: {
        conversationId: z.string().uuid(),
        afterSequence: z.number().int().min(0).optional(),
        beforeSequence: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      outputSchema: {
        items: z.array(z.any()),
      },
    },
    async ({ conversationId, afterSequence, beforeSequence, limit }) => {
      updateBridgeState(config, {
        lastConversationId: conversationId,
        lastToolName: "read_history",
      })
      const result = await requestJson<{ items: unknown[] }>(
        config,
        `/api/v1/internal/remote-agents/${config.remoteAgentId}/history/${conversationId}`,
        undefined,
        {
          afterSequence,
          beforeSequence,
          limit,
        }
      )
      const state = loadBridgeState(config)
      const exposed = state.exposedDeliveries?.[conversationId] ?? []
      const itemIds = new Set(
        result.items
          .map((item) =>
            item &&
            typeof item === "object" &&
            typeof (item as { id?: unknown }).id === "string"
              ? (item as { id: string }).id
              : null
          )
          .filter((itemId): itemId is string => Boolean(itemId))
      )
      const completedDeliveries = exposed.filter((delivery) =>
        itemIds.has(delivery.itemId)
      )
      if (completedDeliveries.length > 0) {
        await requestJson(
          config,
          `/api/v1/internal/remote-agents/${config.remoteAgentId}/complete-deliveries`,
          {
            method: "POST",
            body: JSON.stringify({
              deliveryIds: completedDeliveries.map(
                (delivery) => delivery.deliveryId
              ),
            }),
          }
        )
      }
      if (state.exposedDeliveries) {
        const remaining = exposed.filter(
          (delivery) =>
            !completedDeliveries.some(
              (entry) => entry.deliveryId === delivery.deliveryId
            )
        )
        writeBridgeState(config, {
          ...state,
          lastConversationId: conversationId,
          lastToolName: "read_history",
          exposedDeliveries: {
            ...state.exposedDeliveries,
            [conversationId]: remaining,
          },
          updatedAt: new Date().toISOString(),
        })
      }
      return jsonToolResult(result)
    }
  )

  server.registerTool(
    "send_message",
    {
      description:
        "Send a text reply into a Synapse conversation as this remote agent.",
      inputSchema: {
        conversationId: z.string().uuid(),
        content: z.string().trim().min(1).max(20000),
        replyToItemId: z.string().uuid().optional(),
      },
      outputSchema: {
        item: z.any(),
      },
    },
    async ({ conversationId, content, replyToItemId }) => {
      updateBridgeState(config, {
        lastConversationId: conversationId,
        lastToolName: "send_message",
      })
      const result = await requestJson<{ item: unknown }>(
        config,
        `/api/v1/internal/remote-agents/${config.remoteAgentId}/send`,
        {
          method: "POST",
          body: JSON.stringify({
            conversationId,
            clientMessageId: randomUUID(),
            contentBlocks: [textBlock(content)],
            replyToItemId,
          }),
        }
      )
      return jsonToolResult(result)
    }
  )

  server.registerTool(
    "search_messages",
    {
      description: "Search visible messages inside a specific conversation.",
      inputSchema: {
        conversationId: z.string().uuid(),
        query: z.string().trim().min(1).max(512),
        limit: z.number().int().min(1).max(100).optional(),
      },
      outputSchema: {
        matches: z.array(z.any()),
      },
    },
    async ({ conversationId, query, limit }) => {
      updateBridgeState(config, {
        lastConversationId: conversationId,
        lastToolName: "search_messages",
      })
      const result = await requestJson<{ matches: unknown[] }>(
        config,
        `/api/v1/internal/remote-agents/${config.remoteAgentId}/search`,
        undefined,
        {
          conversationId,
          q: query,
          limit,
        }
      )
      return jsonToolResult(result)
    }
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.stack || error.message : String(error)
  )
  process.exit(1)
})
