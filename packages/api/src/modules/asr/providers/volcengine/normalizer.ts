import type {
  RealtimeAsrFinalSegment,
  RealtimeAsrSocketEventPayloadMap,
} from "@synapse/shared"
import type { IsoInstantString } from "@synapse/shared/datetime"
import { z } from "zod"

const ProviderUtteranceSchema = z
  .object({
    text: z.string().optional(),
    start_time: z.number().optional(),
    end_time: z.number().optional(),
    definite: z.boolean().optional(),
  })
  .passthrough()

const ProviderResultSchema = z
  .object({
    text: z.string().optional(),
    utterances: z.array(ProviderUtteranceSchema).optional(),
  })
  .passthrough()

const ProviderPayloadSchema = z
  .object({
    // The official doc §6 labels `result` a list while every observed
    // bigmodel_async response returns it as a single object. Accept both and
    // collapse an array to its last (most complete) entry so a documented-but-
    // unobserved list shape does not silently drop the entire transcript.
    result: z
      .union([ProviderResultSchema, z.array(ProviderResultSchema)])
      .transform((value) => (Array.isArray(value) ? value.at(-1) : value))
      .optional(),
    audio_info: z
      .object({
        duration: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

type ProviderPayload = z.infer<typeof ProviderPayloadSchema>

export type AsrPayloadParseError = {
  payloadShape: string | string[]
  issues: string[]
}

export type NormalizedAsrEvents = {
  partial?: RealtimeAsrSocketEventPayloadMap["asr.partial"]
  segmentFinals: RealtimeAsrFinalSegment[]
  completed?: RealtimeAsrSocketEventPayloadMap["asr.completed"]
  // Set when the provider payload failed schema validation. The frame is still
  // dropped (fail closed), but the caller can log the drift instead of the
  // failure being silently swallowed.
  parseError?: AsrPayloadParseError
}

export class AsrResultAccumulator {
  private readonly finalizedSegments: RealtimeAsrFinalSegment[] = []

  private lastDisplayText = ""

  private lastDurationMs = 0

  ingest(
    payload: unknown,
    receivedAt: IsoInstantString,
    isFinal: boolean
  ): NormalizedAsrEvents {
    const parsed = ProviderPayloadSchema.safeParse(payload)
    if (!parsed.success) {
      return {
        segmentFinals: [],
        parseError: {
          payloadShape:
            payload && typeof payload === "object" && !Array.isArray(payload)
              ? Object.keys(payload as Record<string, unknown>)
              : typeof payload,
          issues: parsed.error.issues.map(
            (issue) => `${issue.path.join(".")}: ${issue.message}`
          ),
        },
      }
    }
    const providerPayload: ProviderPayload = parsed.data

    const segmentFinals: RealtimeAsrFinalSegment[] = []
    const utterances = providerPayload.result?.utterances ?? []

    if (typeof providerPayload.audio_info?.duration === "number") {
      this.lastDurationMs = providerPayload.audio_info.duration
    }

    const definiteUtterances = utterances.filter(
      (utterance) => utterance?.definite
    )
    for (
      let index = this.finalizedSegments.length;
      index < definiteUtterances.length;
      index += 1
    ) {
      const utterance = definiteUtterances[index]!
      const segment: RealtimeAsrFinalSegment = {
        text: utterance.text?.trim() || "",
        segmentIndex: index,
        startTimeMs:
          typeof utterance.start_time === "number" ? utterance.start_time : 0,
        endTimeMs:
          typeof utterance.end_time === "number" ? utterance.end_time : 0,
        receivedAt,
      }
      this.finalizedSegments.push(segment)
      segmentFinals.push(segment)
    }

    const displayText =
      typeof providerPayload.result?.text === "string"
        ? providerPayload.result.text
        : this.lastDisplayText
    const finalizedText = this.finalizedSegments
      .map((segment) => segment.text)
      .join("")

    let partial: RealtimeAsrSocketEventPayloadMap["asr.partial"] | undefined
    if (displayText && displayText !== this.lastDisplayText) {
      partial = {
        displayText,
        unstableText: displayText.startsWith(finalizedText)
          ? displayText.slice(finalizedText.length)
          : displayText,
        receivedAt,
      }
      this.lastDisplayText = displayText
    }

    if (!isFinal) {
      return { partial, segmentFinals }
    }

    const completedText = this.lastDisplayText || finalizedText
    return {
      partial,
      segmentFinals,
      completed: {
        text: completedText,
        segments: [...this.finalizedSegments],
        durationMs: this.lastDurationMs,
      },
    }
  }

  buildFallbackCompletedPayload(): RealtimeAsrSocketEventPayloadMap["asr.completed"] {
    return {
      text: this.lastDisplayText,
      segments: [...this.finalizedSegments],
      durationMs: this.lastDurationMs,
    }
  }
}
