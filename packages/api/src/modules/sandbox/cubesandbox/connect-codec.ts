// Connect-protocol envelope codec (the wire framing envd speaks).
//
// The Connect streaming/enveloped framing is a series of frames, each:
//   [flags:1 byte][length:4 bytes big-endian][payload:length bytes]
//
// - A request carries exactly ONE envelope (encoded here with `encodeEnvelope`).
// - A server-stream response is a sequence of frames. A frame whose `flags` has
//   the end-stream bit (0x02) set is the trailer; its JSON payload may carry an
//   `{ error }`. The compressed bit (0x01) is unsupported (we send
//   `Connect-Content-Encoding: identity`).
//
// This file is pure over Uint8Array/Buffer plus an async reader over a fetch
// Response body stream — the framing round-trip is unit-tested
// (connect-codec.test.ts) because it is the highest-risk piece of the transport.

import { Buffer } from "node:buffer"

import { ConnectProtocolError } from "./types.js"

/** End-of-stream trailer bit in a Connect frame's flags byte. */
export const CONNECT_END_STREAM_FLAG = 0x02
/** Compressed-payload bit (unsupported — we always negotiate identity). */
export const CONNECT_COMPRESSED_FLAG = 0x01
/** Hard cap on a single frame's declared length; guards against a bad/huge header. */
export const MAX_CONNECT_ENVELOPE_SIZE = 64 * 1024 * 1024

/** One decoded Connect frame. */
export interface ConnectFrame {
  readonly flags: number
  readonly payload: Buffer
}

/** A parsed end-stream trailer error. */
export interface ConnectStreamError {
  readonly code?: string
  readonly message: string
}

/** True when the flags byte marks an end-of-stream trailer frame. */
export function isEndStreamFlag(flags: number): boolean {
  return (flags & CONNECT_END_STREAM_FLAG) !== 0
}

/** True when the flags byte marks a compressed frame (unsupported). */
export function isCompressedFlag(flags: number): boolean {
  return (flags & CONNECT_COMPRESSED_FLAG) !== 0
}

/** Encode a single Connect envelope: `[flags][len:BE32][payload]`. */
export function encodeEnvelope(payload: Uint8Array, flags = 0): Buffer {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const header = Buffer.allocUnsafe(5)
  header.writeUInt8(flags & 0xff, 0)
  header.writeUInt32BE(body.length, 1)
  return Buffer.concat([header, body])
}

/** Encode a JSON value as a single Connect envelope. */
export function encodeJsonEnvelope(value: unknown, flags = 0): Buffer {
  return encodeEnvelope(Buffer.from(JSON.stringify(value), "utf-8"), flags)
}

/**
 * Parse the `{ error }` out of an end-stream trailer payload. Returns `null`
 * when the payload is empty, not JSON, or carries no error.
 */
export function parseEndStreamError(
  payload: Buffer
): ConnectStreamError | null {
  if (payload.length === 0) {
    return null
  }
  let data: unknown
  try {
    data = JSON.parse(payload.toString("utf-8"))
  } catch {
    return null
  }
  if (typeof data !== "object" || data === null) {
    return null
  }
  const error = (data as { error?: unknown }).error
  if (typeof error !== "object" || error === null) {
    return null
  }
  const { code, message } = error as { code?: unknown; message?: unknown }
  const text =
    typeof message === "string" && message.trim()
      ? message.trim()
      : "Connect stream error"
  return { code: typeof code === "string" ? code : undefined, message: text }
}

/**
 * Incremental frame extractor. Bytes are pushed in as they arrive (in arbitrary
 * chunk boundaries) and complete frames are drained out. Chunks are held in a
 * list and only copied when a full frame spans a boundary, so each received
 * byte is copied at most once (no quadratic `Buffer.concat`).
 */
class FrameDecoder {
  private readonly chunks: Buffer[] = []
  private buffered = 0

  push(chunk: Buffer): void {
    if (chunk.length === 0) {
      return
    }
    this.chunks.push(chunk)
    this.buffered += chunk.length
  }

  /** Bytes buffered but not yet forming a complete frame. */
  get remaining(): number {
    return this.buffered
  }

  /** Yield every complete frame currently available, consuming its bytes. */
  *drain(): Generator<ConnectFrame> {
    while (this.buffered >= 5) {
      const { flags, size } = this.peekHeader()
      if (size > MAX_CONNECT_ENVELOPE_SIZE) {
        throw new ConnectProtocolError(`Connect frame too large: ${size} bytes`)
      }
      if (this.buffered < 5 + size) {
        break
      }
      const frame = this.take(5 + size)
      yield { flags, payload: frame.subarray(5, 5 + size) }
    }
  }

  // Read the 5-byte header without consuming it. Requires `buffered >= 5`.
  private peekHeader(): { flags: number; size: number } {
    const first = this.chunks[0]
    if (first.length >= 5) {
      return { flags: first.readUInt8(0), size: first.readUInt32BE(1) }
    }
    const head = Buffer.allocUnsafe(5)
    let filled = 0
    for (const chunk of this.chunks) {
      const n = Math.min(chunk.length, 5 - filled)
      chunk.copy(head, filled, 0, n)
      filled += n
      if (filled === 5) {
        break
      }
    }
    return { flags: head.readUInt8(0), size: head.readUInt32BE(1) }
  }

  // Remove and return the first `n` bytes. Requires `buffered >= n`.
  private take(n: number): Buffer {
    const first = this.chunks[0]
    if (first.length >= n) {
      this.buffered -= n
      if (first.length === n) {
        this.chunks.shift()
        return first
      }
      this.chunks[0] = first.subarray(n)
      return first.subarray(0, n)
    }
    const out = Buffer.allocUnsafe(n)
    let filled = 0
    while (filled < n) {
      const chunk = this.chunks[0]
      const need = n - filled
      if (chunk.length <= need) {
        chunk.copy(out, filled)
        filled += chunk.length
        this.chunks.shift()
      } else {
        chunk.copy(out, filled, 0, need)
        this.chunks[0] = chunk.subarray(need)
        filled = n
      }
    }
    this.buffered -= n
    return out
  }
}

/**
 * Decode a COMPLETE buffer of concatenated Connect frames. Throws
 * {@link ConnectProtocolError} if the buffer ends mid-frame. Pure — the inverse
 * of {@link encodeEnvelope} for round-trip testing and whole-response decoding.
 */
export function decodeFrames(data: Uint8Array): ConnectFrame[] {
  const decoder = new FrameDecoder()
  decoder.push(Buffer.isBuffer(data) ? data : Buffer.from(data))
  const frames = [...decoder.drain()]
  if (decoder.remaining > 0) {
    throw new ConnectProtocolError("Connect buffer ended with a partial frame")
  }
  return frames
}

/**
 * Consume a fetch Response body stream of Connect-framed bytes, yielding each
 * complete frame as it becomes available. `onFrame` (if given) fires once per
 * yielded frame — used by callers to reset an idle-timeout on activity. Throws
 * {@link ConnectProtocolError} if the stream ends mid-frame.
 */
export async function* readFrames(
  body: ReadableStream<Uint8Array>,
  onFrame?: () => void
): AsyncGenerator<ConnectFrame> {
  const reader = body.getReader()
  const decoder = new FrameDecoder()
  try {
    for (;;) {
      for (const frame of decoder.drain()) {
        onFrame?.()
        yield frame
      }
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      if (value && value.length > 0) {
        decoder.push(Buffer.from(value))
      }
    }
  } finally {
    reader.releaseLock()
  }
  if (decoder.remaining > 0) {
    throw new ConnectProtocolError("Connect stream ended with a partial frame")
  }
}
