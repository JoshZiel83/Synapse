import type { SendMsgBody, WsFrame } from "@wecom/aibot-node-sdk"
import { z } from "zod"

const frameBodySchema = z
  .object({
    chatid: z.string().min(1),
    body: z.record(z.string(), z.unknown()),
  })
  .passthrough()

const wireRequestSchema = z
  .object({
    requestId: z.string().min(1),
    frameBody: frameBodySchema,
  })
  .strict()

const wireSuccessResponseSchema = z
  .object({
    ok: z.literal(true),
    raw: z.unknown(),
  })
  .passthrough()
  .refine((value) => Object.hasOwn(value, "raw"))

const wireFailureResponseSchema = z
  .object({
    ok: z.literal(false),
    error: z.string().min(1),
  })
  .passthrough()

const wireResponseSchema = z.union([
  wireSuccessResponseSchema,
  wireFailureResponseSchema,
])

export interface FrameBody {
  chatid: string
  body: SendMsgBody
}

export interface WireRequest {
  requestId: string
  frameBody: FrameBody
}

export type WireResponse =
  | { ok: true; raw: WsFrame }
  | { ok: false; error: string }

function parseJsonText(text: string): unknown | null {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export function parseWecomOutboundRequestPayload(
  payload: string
): WireRequest | null {
  const json = parseJsonText(payload)
  if (json === null) return null
  const parsed = wireRequestSchema.safeParse(json)
  if (!parsed.success) return null
  return {
    requestId: parsed.data.requestId,
    frameBody: parsed.data.frameBody as unknown as FrameBody,
  }
}

export function parseWecomOutboundResponsePayload(
  payload: string
): WireResponse | null {
  const json = parseJsonText(payload)
  if (json === null) return null
  const parsed = wireResponseSchema.safeParse(json)
  if (!parsed.success) return null
  if (parsed.data.ok) {
    return { ok: true, raw: parsed.data.raw as WsFrame }
  }
  return { ok: false, error: parsed.data.error }
}
