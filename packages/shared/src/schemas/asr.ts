import { z } from "zod"
import {
  REALTIME_ASR_AUDIO_CODEC,
  REALTIME_ASR_AUDIO_CODECS,
  REALTIME_ASR_AUDIO_FORMAT,
  REALTIME_ASR_AUDIO_FORMATS,
} from "../constants/enums.js"

/**
 * App-facing realtime ASR start-message audio config.
 *
 * Provider websocket framing remains API-local; this schema validates the
 * web/mobile payload before API adapts it to the Volcengine wire request.
 */
export const RealtimeAsrAudioConfigSchema = z
  .object({
    format: z.enum(REALTIME_ASR_AUDIO_FORMATS),
    codec: z.enum(REALTIME_ASR_AUDIO_CODECS),
    rate: z.literal(16000),
    bits: z.literal(16),
    channel: z.literal(1),
  })
  .superRefine((value, ctx) => {
    if (
      value.format === REALTIME_ASR_AUDIO_FORMAT.PCM &&
      value.codec !== REALTIME_ASR_AUDIO_CODEC.RAW
    ) {
      ctx.addIssue({
        code: "custom",
        message: "PCM audio must use the raw codec",
      })
    }

    if (
      value.format === REALTIME_ASR_AUDIO_FORMAT.OGG &&
      value.codec !== REALTIME_ASR_AUDIO_CODEC.OPUS
    ) {
      ctx.addIssue({
        code: "custom",
        message: "OGG audio must use the opus codec",
      })
    }
  })

export const RealtimeAsrClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("auth"),
    token: z.string().optional(),
    workspaceId: z.string().min(1),
  }),
  z.object({
    type: z.literal("start"),
    audio: RealtimeAsrAudioConfigSchema,
  }),
  z.object({
    type: z.literal("stop"),
  }),
  z.object({
    type: z.literal("cancel"),
  }),
  z.object({
    type: z.literal("pong"),
  }),
])
