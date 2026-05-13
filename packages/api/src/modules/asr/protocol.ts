import { gzipSync, gunzipSync } from "node:zlib"

const PROTOCOL_VERSION = 0x1
const HEADER_SIZE_WORDS = 0x1
const HEADER_SIZE_BYTES = HEADER_SIZE_WORDS * 4

const MESSAGE_TYPE_FULL_CLIENT_REQUEST = 0x1
const MESSAGE_TYPE_AUDIO_ONLY_REQUEST = 0x2
const MESSAGE_TYPE_FULL_SERVER_RESPONSE = 0x9
const MESSAGE_TYPE_ERROR_RESPONSE = 0xf

const MESSAGE_FLAG_NONE = 0x0
const MESSAGE_FLAG_SEQUENCE = 0x1
const MESSAGE_FLAG_FINAL = 0x2
const MESSAGE_FLAG_FINAL_WITH_SEQUENCE = 0x3

const SERIALIZATION_NONE = 0x0
const SERIALIZATION_JSON = 0x1

const COMPRESSION_NONE = 0x0
const COMPRESSION_GZIP = 0x1

export interface VolcengineAsrFullClientRequest {
  user?: {
    uid?: string
    did?: string
    platform?: string
    sdk_version?: string
    app_version?: string
  }
  audio: {
    format: "pcm" | "ogg"
    codec: "raw" | "opus"
    rate: 16000
    bits: 16
    channel: 1
  }
  request: {
    model_name: "bigmodel"
    enable_nonstream: true
    enable_itn: true
    enable_punc: true
    show_utterances: true
    result_type: "full"
    end_window_size: 800
    force_to_speech_time: 1000
  }
}

type DecodedFrameBase = {
  messageType: number
  flags: number
  serialization: number
  compression: number
}

export type DecodedServerResponseFrame = DecodedFrameBase & {
  kind: "response"
  sequence?: number
  isFinal: boolean
  payloadSize: number
  payload: unknown
}

export type DecodedErrorFrame = DecodedFrameBase & {
  kind: "error"
  code: number
  payloadSize: number
  payload: unknown
}

export type DecodedProviderFrame =
  | DecodedServerResponseFrame
  | DecodedErrorFrame

function buildHeader(
  messageType: number,
  flags: number,
  serialization: number,
  compression: number
) {
  return Buffer.from([
    (PROTOCOL_VERSION << 4) | HEADER_SIZE_WORDS,
    (messageType << 4) | flags,
    (serialization << 4) | compression,
    0x00,
  ])
}

function maybeDecompress(compression: number, payload: Buffer) {
  if (compression === COMPRESSION_NONE) {
    return payload
  }

  if (compression === COMPRESSION_GZIP) {
    return gunzipSync(payload)
  }

  throw new Error(`Unsupported compression method: ${compression}`)
}

function maybeDeserialize(serialization: number, payload: Buffer): unknown {
  if (serialization === SERIALIZATION_NONE) {
    return payload
  }

  if (serialization === SERIALIZATION_JSON) {
    const text = payload.toString("utf8")
    return text.trim() ? JSON.parse(text) : {}
  }

  throw new Error(`Unsupported serialization method: ${serialization}`)
}

function assertLength(frame: Buffer, offset: number, requiredBytes: number) {
  if (frame.length < offset + requiredBytes) {
    throw new Error("Malformed Volcengine ASR frame: truncated payload")
  }
}

export function encodeFullClientRequest(
  payload: VolcengineAsrFullClientRequest
) {
  const serializedPayload = Buffer.from(JSON.stringify(payload), "utf8")
  const compressedPayload = gzipSync(serializedPayload)
  const header = buildHeader(
    MESSAGE_TYPE_FULL_CLIENT_REQUEST,
    MESSAGE_FLAG_NONE,
    SERIALIZATION_JSON,
    COMPRESSION_GZIP
  )
  const payloadSize = Buffer.allocUnsafe(4)
  payloadSize.writeUInt32BE(compressedPayload.length, 0)
  return Buffer.concat([header, payloadSize, compressedPayload])
}

export function encodeAudioOnlyRequest(audioChunk: Buffer, isFinal = false) {
  const compressedPayload = gzipSync(audioChunk)
  const header = buildHeader(
    MESSAGE_TYPE_AUDIO_ONLY_REQUEST,
    isFinal ? MESSAGE_FLAG_FINAL : MESSAGE_FLAG_NONE,
    SERIALIZATION_NONE,
    COMPRESSION_GZIP
  )
  const payloadSize = Buffer.allocUnsafe(4)
  payloadSize.writeUInt32BE(compressedPayload.length, 0)
  return Buffer.concat([header, payloadSize, compressedPayload])
}

export function decodeProviderFrame(frame: Buffer): DecodedProviderFrame {
  assertLength(frame, 0, HEADER_SIZE_BYTES)

  const headerSizeWords = frame[0]! & 0x0f
  const headerSize = headerSizeWords * 4
  assertLength(frame, 0, headerSize)

  const messageType = frame[1]! >> 4
  const flags = frame[1]! & 0x0f
  const serialization = frame[2]! >> 4
  const compression = frame[2]! & 0x0f

  let offset = headerSize

  if (messageType === MESSAGE_TYPE_FULL_SERVER_RESPONSE) {
    let sequence: number | undefined
    if (
      flags === MESSAGE_FLAG_SEQUENCE ||
      flags === MESSAGE_FLAG_FINAL_WITH_SEQUENCE
    ) {
      assertLength(frame, offset, 4)
      sequence = frame.readInt32BE(offset)
      offset += 4
    }

    assertLength(frame, offset, 4)
    const payloadSize = frame.readUInt32BE(offset)
    offset += 4
    assertLength(frame, offset, payloadSize)
    const rawPayload = frame.subarray(offset, offset + payloadSize)
    const payload = maybeDeserialize(
      serialization,
      maybeDecompress(compression, rawPayload)
    )

    return {
      kind: "response",
      messageType,
      flags,
      serialization,
      compression,
      sequence,
      isFinal:
        flags === MESSAGE_FLAG_FINAL ||
        flags === MESSAGE_FLAG_FINAL_WITH_SEQUENCE,
      payloadSize,
      payload,
    }
  }

  if (messageType === MESSAGE_TYPE_ERROR_RESPONSE) {
    assertLength(frame, offset, 8)
    const code = frame.readUInt32BE(offset)
    offset += 4
    const payloadSize = frame.readUInt32BE(offset)
    offset += 4
    assertLength(frame, offset, payloadSize)
    const rawPayload = frame.subarray(offset, offset + payloadSize)
    const payload = maybeDeserialize(
      serialization,
      maybeDecompress(compression, rawPayload)
    )

    return {
      kind: "error",
      messageType,
      flags,
      serialization,
      compression,
      code,
      payloadSize,
      payload,
    }
  }

  throw new Error(`Unsupported Volcengine ASR message type: ${messageType}`)
}
