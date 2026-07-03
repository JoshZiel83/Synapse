// Generic (provider-neutral) validation of the client's realtime audio config.
// This is the frozen @synapse/shared wire contract — NOT a Volcengine concern —
// so it lives in the core. Each provider validates/adapts the parsed config
// against its own upstream requirements inside its start() (accept-and-forward,
// transcode/resample, or reject with ASR_INVALID_AUDIO_CONFIG).

import type { RealtimeAsrAudioConfig } from "@synapse/shared"
import { RealtimeAsrAudioConfigSchema } from "@synapse/shared/schemas"

export function validateRealtimeAsrAudioConfig(
  input: unknown
): RealtimeAsrAudioConfig {
  return RealtimeAsrAudioConfigSchema.parse(input) as RealtimeAsrAudioConfig
}
