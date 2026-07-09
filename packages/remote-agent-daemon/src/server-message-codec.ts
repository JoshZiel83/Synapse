import { z } from "zod"
import { RUNTIME_KINDS, type RuntimeKind } from "./drivers/types.js"

export type AgentStartMessage = {
  type: "agent:start"
  remoteAgentId: string
  conversationId?: string
  runtimeKind: RuntimeKind
  runtimePath?: string | null
  localRootPath?: string | null
  sessionId?: string | null
  fencingToken?: string
  serverUrl?: string
  /** W3C traceparent of the api-side request that triggered this start. */
  traceparent?: string
}

export type Delivery = {
  remoteAgentId: string
  deliveryId: string
  conversationId: string
  itemId: string
  /** Per-delivery W3C traceparent (the enqueuing request's persisted trace). */
  traceparent?: string
}

export type DeliveryMessage = {
  type: "agent:deliver"
  deliveries: Delivery[]
}

export type TaskResolvedMessage = {
  type: "agent:task:resolved"
  remoteAgentId: string
  taskId: string
  task: Record<string, unknown>
  /** W3C traceparent of the request that resolved this task. */
  traceparent?: string
}

export type AgentStopMessage = {
  type: "agent:stop"
  remoteAgentId: string
}

export type ConnectedMessage = {
  type: "connected"
  machineId: string
  sessionId: string
  fencingToken?: string
}

export type AuthErrorMessage = {
  type: "auth_error"
  message: string
}

export type FencedMessage = {
  type: "fenced"
  reason?: string
}

export type PongMessage = {
  type: "pong"
}

export type ServerMessage =
  | ConnectedMessage
  | AuthErrorMessage
  | FencedMessage
  | PongMessage
  | AgentStartMessage
  | AgentStopMessage
  | DeliveryMessage
  | TaskResolvedMessage

const runtimeKindSchema = z.enum(RUNTIME_KINDS)

const connectedSchema = z.strictObject({
  type: z.literal("connected"),
  machine_id: z.string().min(1),
  session_id: z.string().min(1),
  fencing_token: z.string().optional(),
})

const authErrorSchema = z.strictObject({
  type: z.literal("auth_error"),
  message: z.string().min(1),
})

const fencedSchema = z.strictObject({
  type: z.literal("fenced"),
  reason: z.string().optional(),
})

const pongSchema = z.strictObject({
  type: z.literal("pong"),
})

const agentStartSchema = z.strictObject({
  type: z.literal("agent:start"),
  remote_agent_id: z.string().min(1),
  conversation_id: z.string().min(1).nullable().optional(),
  runtime_kind: runtimeKindSchema,
  runtime_path: z.string().nullable().optional(),
  local_root_path: z.string().nullable().optional(),
  session_id: z.string().nullable().optional(),
  fencing_token: z.string().optional(),
  server_url: z.string().optional(),
  traceparent: z.string().optional(),
})

const agentStopSchema = z.strictObject({
  type: z.literal("agent:stop"),
  remote_agent_id: z.string().min(1),
})

const deliverySchema = z.strictObject({
  remote_agent_id: z.string().min(1),
  delivery_id: z.string().min(1),
  conversation_id: z.string().min(1),
  item_id: z.string().min(1),
  traceparent: z.string().optional(),
})

const agentDeliverSchema = z.strictObject({
  type: z.literal("agent:deliver"),
  deliveries: z.array(deliverySchema),
})

const taskResolvedSchema = z.strictObject({
  type: z.literal("agent:task:resolved"),
  remote_agent_id: z.string().min(1),
  task_id: z.string().min(1),
  task: z.record(z.string(), z.unknown()),
  traceparent: z.string().optional(),
})

const serverMessageWireSchema = z.discriminatedUnion("type", [
  connectedSchema,
  authErrorSchema,
  fencedSchema,
  pongSchema,
  agentStartSchema,
  agentStopSchema,
  agentDeliverSchema,
  taskResolvedSchema,
])

export function parseServerMessage(raw: unknown): ServerMessage | null {
  let value: unknown
  try {
    value = JSON.parse(String(raw))
  } catch {
    return null
  }

  const parsed = serverMessageWireSchema.safeParse(value)
  if (!parsed.success) return null
  const message = parsed.data
  switch (message.type) {
    case "connected":
      return {
        type: "connected",
        machineId: message.machine_id,
        sessionId: message.session_id,
        fencingToken: message.fencing_token,
      }
    case "auth_error":
      return {
        type: "auth_error",
        message: message.message,
      }
    case "fenced":
      return {
        type: "fenced",
        reason: message.reason,
      }
    case "pong":
      return { type: "pong" }
    case "agent:start":
      return {
        type: "agent:start",
        remoteAgentId: message.remote_agent_id,
        conversationId: message.conversation_id ?? undefined,
        runtimeKind: message.runtime_kind,
        runtimePath: message.runtime_path ?? undefined,
        localRootPath: message.local_root_path ?? undefined,
        sessionId: message.session_id ?? null,
        fencingToken: message.fencing_token,
        serverUrl: message.server_url,
        traceparent: message.traceparent,
      }
    case "agent:stop":
      return {
        type: "agent:stop",
        remoteAgentId: message.remote_agent_id,
      }
    case "agent:deliver":
      return {
        type: "agent:deliver",
        deliveries: message.deliveries.map((delivery) => ({
          remoteAgentId: delivery.remote_agent_id,
          deliveryId: delivery.delivery_id,
          conversationId: delivery.conversation_id,
          itemId: delivery.item_id,
          traceparent: delivery.traceparent,
        })),
      }
    case "agent:task:resolved":
      return {
        type: "agent:task:resolved",
        remoteAgentId: message.remote_agent_id,
        taskId: message.task_id,
        task: message.task,
        traceparent: message.traceparent,
      }
  }
}
