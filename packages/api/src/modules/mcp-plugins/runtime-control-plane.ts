import crypto from "node:crypto"
import os from "node:os"
import { z } from "zod"
import { redis } from "../../infrastructure/redis/index.js"
import { createLogger } from "../../infrastructure/logger/index.js"

const log = createLogger("mcp.runtime")

const COMMAND_STREAM_PREFIX = "mcp:runtime:commands:"
const REPLY_LIST_PREFIX = "mcp:runtime:reply:"
const MAX_STREAM_LENGTH = 5000
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000

const RuntimeCommandEnvelopeSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    payload: z.string(),
    replyKey: z.string().min(1),
  })
  .strict()

const RuntimeCommandErrorSchema = z
  .object({
    name: z.string().min(1),
    message: z.string(),
    stack: z.string().optional(),
  })
  .strict()

const RuntimeCommandResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      result: z.unknown().optional(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: RuntimeCommandErrorSchema,
    })
    .strict(),
])

type RuntimeCommandEnvelope = z.infer<typeof RuntimeCommandEnvelopeSchema>
type RuntimeCommandResult = z.infer<typeof RuntimeCommandResultSchema>

type RuntimeCommandHandler = (payload: unknown) => Promise<unknown>

const runtimeNodeId =
  process.env.MCP_RUNTIME_NODE_ID?.trim() ||
  `${os.hostname()}:${process.pid}:${crypto.randomUUID()}`

const handlers = new Map<string, RuntimeCommandHandler>()
let commandReader: any | null = null
let listenerRunning = false
let listenerLoop: Promise<void> | null = null
let lastStreamId = "$"

function runtimeCommandStreamKey(nodeId: string) {
  return `${COMMAND_STREAM_PREFIX}${nodeId}`
}

function runtimeReplyKey(commandId: string) {
  return `${REPLY_LIST_PREFIX}${commandId}`
}

export function parseRuntimeCommandEnvelopeFields(
  entryId: string,
  fields: string[]
): RuntimeCommandEnvelope | null {
  const values = new Map<string, string>()
  for (let index = 0; index < fields.length; index += 2) {
    values.set(fields[index]!, fields[index + 1] || "")
  }

  const parsed = RuntimeCommandEnvelopeSchema.safeParse({
    id: values.get("id") || entryId,
    type: values.get("type") || "",
    payload: values.get("payload") || "{}",
    replyKey: values.get("reply_key") || "",
  })
  return parsed.success ? parsed.data : null
}

export function parseRuntimeCommandPayload(raw: string): unknown {
  return raw ? JSON.parse(raw) : {}
}

export function parseRuntimeCommandResult(raw: string): RuntimeCommandResult {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `Runtime command reply is invalid JSON: ${(error as Error).message}`
    )
  }

  const parsed = RuntimeCommandResultSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error("Runtime command reply has invalid shape")
  }
  return parsed.data
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    }
  }
  return {
    name: "Error",
    message:
      typeof error === "string" ? error : "Unknown runtime control plane error",
  }
}

async function pushCommandReply(
  replyKey: string,
  result: RuntimeCommandResult
) {
  await redis
    .multi()
    .lpush(replyKey, JSON.stringify(result))
    .pexpire(replyKey, DEFAULT_COMMAND_TIMEOUT_MS)
    .exec()
}

async function handleCommand(envelope: RuntimeCommandEnvelope) {
  const handler = handlers.get(envelope.type)
  if (!handler) {
    await pushCommandReply(envelope.replyKey, {
      ok: false,
      error: {
        name: "UnhandledRuntimeCommandError",
        message: `Unhandled runtime command type '${envelope.type}'`,
      },
    })
    return
  }

  let payload: unknown = {}
  try {
    payload = parseRuntimeCommandPayload(envelope.payload)
  } catch (error) {
    await pushCommandReply(envelope.replyKey, {
      ok: false,
      error: serializeError(error),
    })
    return
  }

  try {
    const result = await handler(payload)
    await pushCommandReply(envelope.replyKey, {
      ok: true,
      result,
    })
  } catch (error) {
    await pushCommandReply(envelope.replyKey, {
      ok: false,
      error: serializeError(error),
    })
  }
}

async function runCommandListener() {
  if (!commandReader) {
    commandReader = (redis as any).duplicate()
  }
  const streamKey = runtimeCommandStreamKey(runtimeNodeId)
  while (listenerRunning) {
    try {
      const result = await commandReader.xread(
        "BLOCK",
        1000,
        "COUNT",
        10,
        "STREAMS",
        streamKey,
        lastStreamId
      )
      if (!listenerRunning || !result || result.length === 0) {
        continue
      }

      for (const [, entries] of result as [string, [string, string[]][]][]) {
        for (const [entryId, fields] of entries) {
          lastStreamId = entryId
          const envelope = parseRuntimeCommandEnvelopeFields(entryId, fields)
          if (!envelope) {
            log.warn({ entryId }, "[mcp-runtime] invalid command envelope")
            await redis.xdel(streamKey, entryId).catch(() => undefined)
            continue
          }
          await handleCommand(envelope)
          await redis.xdel(streamKey, entryId).catch(() => undefined)
        }
      }
    } catch (error) {
      if (!listenerRunning) {
        break
      }
      log.error({ err: error }, "[mcp-runtime] control plane listener error")
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
}

export function getRuntimeNodeId() {
  return runtimeNodeId
}

export function registerRuntimeCommandHandler(
  type: string,
  handler: RuntimeCommandHandler
) {
  handlers.set(type, handler)
}

export async function initRuntimeControlPlane() {
  if (listenerRunning) {
    return
  }
  listenerRunning = true
  listenerLoop = runCommandListener()
}

export async function shutdownRuntimeControlPlane() {
  listenerRunning = false
  const loop = listenerLoop
  listenerLoop = null
  if (commandReader) {
    try {
      await commandReader.quit()
    } catch {
      commandReader.disconnect()
    }
    commandReader = null
  }
  await loop?.catch(() => undefined)
}

export async function sendRuntimeCommand<T>(
  nodeId: string,
  type: string,
  payload: unknown,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS
): Promise<T> {
  const commandId = crypto.randomUUID()
  const replyKey = runtimeReplyKey(commandId)
  const replyClient = (redis as any).duplicate()

  try {
    await redis.xadd(
      runtimeCommandStreamKey(nodeId),
      "MAXLEN",
      "~",
      MAX_STREAM_LENGTH,
      "*",
      "id",
      commandId,
      "type",
      type,
      "payload",
      JSON.stringify(payload ?? {}),
      "reply_key",
      replyKey
    )

    const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000))
    const reply = await replyClient.brpop(replyKey, timeoutSeconds)
    if (!reply || reply.length < 2) {
      throw new Error(
        `Runtime command '${type}' timed out after ${timeoutMs}ms`
      )
    }

    const message = parseRuntimeCommandResult(reply[1])
    if (!message.ok) {
      const error = new Error(message.error.message)
      error.name = message.error.name
      if (message.error.stack) {
        error.stack = message.error.stack
      }
      throw error
    }

    return message.result as T
  } finally {
    try {
      await replyClient.quit()
    } catch {
      replyClient.disconnect()
    }
    await redis.del(replyKey).catch(() => undefined)
  }
}
