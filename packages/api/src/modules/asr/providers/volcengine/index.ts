// The Volcengine 豆包 SAUC realtime-ASR adapter object. The ONLY reader of
// config.asr.volcengine.* (via session.ts / isVolcengineConfigured) outside this
// provider directory.

import type { RealtimeAsrProvider } from "../../types.js"
import {
  isVolcengineConfigured,
  VolcengineRealtimeAsrSession,
} from "./session.js"

export const volcengineProvider: RealtimeAsrProvider = {
  key: "volcengine",
  isConfigured: isVolcengineConfigured,
  createSession: (input) => new VolcengineRealtimeAsrSession(input),
}
