import { z } from "zod"

const qqGatewayUrlResponseSchema = z
  .object({
    url: z.string().min(1),
  })
  .passthrough()

const qqGatewayFrameSchema = z
  .object({
    op: z.number().int(),
    d: z.unknown().optional(),
    s: z.number().int().nonnegative().optional(),
    t: z.string().min(1).optional(),
  })
  .passthrough()

const qqGatewayHelloPayloadSchema = z
  .object({
    heartbeat_interval: z.number().positive().optional(),
  })
  .passthrough()

const qqGatewayReadyPayloadSchema = z
  .object({
    session_id: z.string().min(1).optional(),
    user: z.unknown().optional(),
  })
  .passthrough()

const qqGatewayReadyUserSchema = z
  .object({
    username: z.string().min(1).optional(),
  })
  .passthrough()

export interface QqGatewayFrame {
  op: number
  d?: unknown
  s?: number
  t?: string
}

export type QqGatewayFrameParseResult =
  | { ok: true; frame: QqGatewayFrame }
  | { ok: false; reason: "invalid_json" | "invalid_shape" }

export interface QqGatewayHelloPayload {
  heartbeatInterval?: number
}

export interface QqGatewayReadyPayload {
  sessionId?: string
  username?: string
}

function parseJsonText(text: string): unknown | null {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export function parseQqGatewayUrlResponse(json: unknown): string | null {
  const parsed = qqGatewayUrlResponseSchema.safeParse(json)
  return parsed.success ? parsed.data.url : null
}

export function parseQqGatewayFrame(raw: string): QqGatewayFrameParseResult {
  const json = parseJsonText(raw)
  if (json === null) {
    return { ok: false, reason: "invalid_json" }
  }
  const parsed = qqGatewayFrameSchema.safeParse(json)
  if (!parsed.success) {
    return { ok: false, reason: "invalid_shape" }
  }
  return { ok: true, frame: parsed.data }
}

export function parseQqGatewayHelloPayload(
  data: unknown
): QqGatewayHelloPayload {
  const parsed = qqGatewayHelloPayloadSchema.safeParse(data)
  if (!parsed.success || parsed.data.heartbeat_interval === undefined) {
    return {}
  }
  return { heartbeatInterval: parsed.data.heartbeat_interval }
}

export function parseQqGatewayReadyPayload(
  data: unknown
): QqGatewayReadyPayload {
  const parsed = qqGatewayReadyPayloadSchema.safeParse(data)
  if (!parsed.success) return {}
  const out: QqGatewayReadyPayload = {}
  if (parsed.data.session_id) {
    out.sessionId = parsed.data.session_id
  }
  const user = qqGatewayReadyUserSchema.safeParse(parsed.data.user)
  if (user.success && user.data.username) {
    out.username = user.data.username
  }
  return out
}
