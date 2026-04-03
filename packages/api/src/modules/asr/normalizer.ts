import type {
  RealtimeAsrFinalSegment,
  RealtimeAsrSocketEventPayloadMap,
} from "@synapse/shared";

type ProviderUtterance = {
  text?: string;
  start_time?: number;
  end_time?: number;
  definite?: boolean;
};

type ProviderPayload = {
  result?: {
    text?: string;
    utterances?: ProviderUtterance[];
  };
  audio_info?: {
    duration?: number;
  };
};

export type NormalizedAsrEvents = {
  partial?: RealtimeAsrSocketEventPayloadMap["asr.partial"];
  segmentFinals: RealtimeAsrFinalSegment[];
  completed?: RealtimeAsrSocketEventPayloadMap["asr.completed"];
};

function isProviderPayload(value: unknown): value is ProviderPayload {
  return Boolean(value && typeof value === "object");
}

export class AsrResultAccumulator {
  private readonly finalizedSegments: RealtimeAsrFinalSegment[] = [];

  private lastDisplayText = "";

  private lastDurationMs = 0;

  ingest(
    payload: unknown,
    receivedAt: string,
    isFinal: boolean,
  ): NormalizedAsrEvents {
    if (!isProviderPayload(payload)) {
      return { segmentFinals: [] };
    }

    const segmentFinals: RealtimeAsrFinalSegment[] = [];
    const utterances = Array.isArray(payload.result?.utterances)
      ? payload.result?.utterances ?? []
      : [];

    if (typeof payload.audio_info?.duration === "number") {
      this.lastDurationMs = payload.audio_info.duration;
    }

    const definiteUtterances = utterances.filter((utterance) => utterance?.definite);
    for (
      let index = this.finalizedSegments.length;
      index < definiteUtterances.length;
      index += 1
    ) {
      const utterance = definiteUtterances[index]!;
      const segment: RealtimeAsrFinalSegment = {
        text: utterance.text?.trim() || "",
        segmentIndex: index,
        startTimeMs:
          typeof utterance.start_time === "number" ? utterance.start_time : 0,
        endTimeMs:
          typeof utterance.end_time === "number" ? utterance.end_time : 0,
        receivedAt,
      };
      this.finalizedSegments.push(segment);
      segmentFinals.push(segment);
    }

    const displayText =
      typeof payload.result?.text === "string"
        ? payload.result.text
        : this.lastDisplayText;
    const finalizedText = this.finalizedSegments.map((segment) => segment.text).join("");

    let partial: RealtimeAsrSocketEventPayloadMap["asr.partial"] | undefined;
    if (displayText && displayText !== this.lastDisplayText) {
      partial = {
        displayText,
        unstableText: displayText.startsWith(finalizedText)
          ? displayText.slice(finalizedText.length)
          : displayText,
        receivedAt,
      };
      this.lastDisplayText = displayText;
    }

    if (!isFinal) {
      return { partial, segmentFinals };
    }

    const completedText = this.lastDisplayText || finalizedText;
    return {
      partial,
      segmentFinals,
      completed: {
        text: completedText,
        segments: [...this.finalizedSegments],
        durationMs: this.lastDurationMs,
      },
    };
  }

  buildFallbackCompletedPayload(): RealtimeAsrSocketEventPayloadMap["asr.completed"] {
    return {
      text: this.lastDisplayText,
      segments: [...this.finalizedSegments],
      durationMs: this.lastDurationMs,
    };
  }
}
