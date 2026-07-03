// The self-hosted streaming sherpa-onnx realtime-ASR adapter object. The ONLY
// reader of config.asr.sherpaStream.* (via session.ts) outside this directory.

import type { RealtimeAsrProvider } from "../../types.js"
import {
  isSherpaStreamConfigured,
  SherpaStreamRealtimeAsrSession,
} from "./session.js"

export const sherpaStreamProvider: RealtimeAsrProvider = {
  key: "sherpa-stream",
  isConfigured: isSherpaStreamConfigured,
  createSession: (input) => new SherpaStreamRealtimeAsrSession(input),
}
