import type {
  BuiltinPluginExecuteResult,
  BuiltinPluginHandler,
} from "../../index.js"
import type { MijiaAuthState } from "../../../mijia/types.js"
import { MijiaCloudClient } from "../../../mijia/cloud-client.js"
import {
  markMijiaConnectionExpired,
  persistMijiaConnectionState,
} from "../../../mijia/connection-store.js"
import { executeMijiaTool, getMijiaToolDefinitions } from "./tool-specs.js"

function asObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function getAuthConnection(config: Record<string, unknown>) {
  const raw = asObject(config.mijiaAccount)
  const secretPayload = asObject(raw.secretPayload) as unknown as MijiaAuthState
  const connectionId =
    typeof raw.connectionId === "string" ? raw.connectionId : undefined
  return {
    connectionId,
    secretPayload,
  }
}

function getClient(config: Record<string, unknown>) {
  const connection = getAuthConnection(config)
  const client = new MijiaCloudClient(connection.secretPayload, {
    onAuthStateChanged: async (nextState) => {
      if (!connection.connectionId) return
      await persistMijiaConnectionState(connection.connectionId, nextState)
    },
  })
  return {
    client,
    connectionId: connection.connectionId,
  }
}

export const mijiaSmarthomeHandler: BuiltinPluginHandler & {
  getToolsFiltered(
    config: Record<string, unknown>
  ): ReturnType<typeof getMijiaToolDefinitions>
} = {
  getTools() {
    return getMijiaToolDefinitions({ exposeRawMiotTools: true })
  },

  getToolsFiltered(config) {
    return getMijiaToolDefinitions(config)
  },

  async execute(toolName, input, config): Promise<BuiltinPluginExecuteResult> {
    const { client, connectionId } = getClient(config)
    try {
      return await executeMijiaTool(toolName, input, config, client)
    } catch (error) {
      if (
        connectionId &&
        error instanceof Error &&
        /reconnect|token|authorization|oauth/i.test(error.message)
      ) {
        await markMijiaConnectionExpired(connectionId).catch(() => undefined)
      }
      throw error
    }
  },
}
