// Framing round-trip tests for the Connect codec — the highest-risk piece of the
// CubeSandbox transport. Covers: single/multi-frame encode↔decode, the
// end-stream trailer bit + error extraction, oversize/partial guards, and the
// streaming reader across ADVERSARIAL chunk boundaries (1 byte at a time, and a
// frame split mid-header) since cross-chunk buffering is where framing breaks.

import test from "node:test"
import assert from "node:assert/strict"
import { Buffer } from "node:buffer"

import {
  CONNECT_COMPRESSED_FLAG,
  CONNECT_END_STREAM_FLAG,
  MAX_CONNECT_ENVELOPE_SIZE,
  decodeFrames,
  encodeEnvelope,
  encodeJsonEnvelope,
  isCompressedFlag,
  isEndStreamFlag,
  parseEndStreamError,
  readFrames,
} from "./connect-codec.js"
import { ConnectProtocolError } from "./types.js"

function streamFrom(
  data: Buffer,
  chunkSize: number
): ReadableStream<Uint8Array> {
  let offset = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= data.length) {
        controller.close()
        return
      }
      const end = Math.min(offset + chunkSize, data.length)
      controller.enqueue(new Uint8Array(data.subarray(offset, end)))
      offset = end
    },
  })
}

async function collect(
  stream: ReadableStream<Uint8Array>
): Promise<{ flags: number; payload: Buffer }[]> {
  const out: { flags: number; payload: Buffer }[] = []
  for await (const frame of readFrames(stream)) {
    out.push({ flags: frame.flags, payload: Buffer.from(frame.payload) })
  }
  return out
}

test("encodeEnvelope → decodeFrames round-trips a single frame byte-for-byte", () => {
  const payload = Buffer.from("hello envd", "utf-8")
  const frames = decodeFrames(encodeEnvelope(payload))
  assert.equal(frames.length, 1)
  assert.equal(frames[0].flags, 0)
  assert.deepEqual(frames[0].payload, payload)
})

test("encodeEnvelope writes [flags][BE32 len][payload] with a big-endian length", () => {
  const payload = Buffer.alloc(300, 0x41) // 300 = 0x0000012C
  const env = encodeEnvelope(payload, 0)
  assert.equal(env.readUInt8(0), 0)
  assert.equal(env.readUInt32BE(1), 300)
  assert.equal(env.length, 5 + 300)
})

test("decodeFrames handles many concatenated frames in order", () => {
  const payloads = ["a", "bb", "ccc", "", "dddd"].map((s) =>
    Buffer.from(s, "utf-8")
  )
  const wire = Buffer.concat(payloads.map((p) => encodeEnvelope(p)))
  const frames = decodeFrames(wire)
  assert.equal(frames.length, payloads.length)
  frames.forEach((f, i) => assert.deepEqual(f.payload, payloads[i]))
})

test("encodeJsonEnvelope round-trips a JSON object", () => {
  const value = {
    process: { cmd: "/bin/bash", args: ["-l", "-c", "echo hi"] },
    stdin: false,
  }
  const frames = decodeFrames(encodeJsonEnvelope(value))
  assert.equal(frames.length, 1)
  assert.deepEqual(JSON.parse(frames[0].payload.toString("utf-8")), value)
})

test("end-stream + compressed flag helpers read the right bits", () => {
  assert.equal(isEndStreamFlag(CONNECT_END_STREAM_FLAG), true)
  assert.equal(isEndStreamFlag(0), false)
  assert.equal(isCompressedFlag(CONNECT_COMPRESSED_FLAG), true)
  assert.equal(isCompressedFlag(CONNECT_END_STREAM_FLAG), false)
})

test("parseEndStreamError: empty trailer → null, error trailer → {code,message}", () => {
  assert.equal(parseEndStreamError(Buffer.alloc(0)), null)
  assert.equal(parseEndStreamError(Buffer.from("{}", "utf-8")), null)
  const err = parseEndStreamError(
    Buffer.from(
      JSON.stringify({ error: { code: "internal", message: "  boom  " } }),
      "utf-8"
    )
  )
  assert.deepEqual(err, { code: "internal", message: "boom" })
})

test("decodeFrames throws on a partial trailing frame", () => {
  const wire = encodeEnvelope(Buffer.from("payload", "utf-8"))
  assert.throws(
    () => decodeFrames(wire.subarray(0, wire.length - 2)),
    ConnectProtocolError
  )
})

test("decodeFrames throws on an oversized declared length", () => {
  const header = Buffer.allocUnsafe(5)
  header.writeUInt8(0, 0)
  header.writeUInt32BE(MAX_CONNECT_ENVELOPE_SIZE + 1, 1)
  assert.throws(() => decodeFrames(header), ConnectProtocolError)
})

test("readFrames reassembles frames delivered ONE BYTE at a time", async () => {
  const f1 = encodeEnvelope(
    Buffer.from(
      JSON.stringify({ event: { data: { stdout: "AA==" } } }),
      "utf-8"
    )
  )
  const f2 = encodeEnvelope(
    Buffer.from(JSON.stringify({ event: { end: { exitCode: 7 } } }), "utf-8")
  )
  const trailer = encodeEnvelope(
    Buffer.from("{}", "utf-8"),
    CONNECT_END_STREAM_FLAG
  )
  const wire = Buffer.concat([f1, f2, trailer])

  const frames = await collect(streamFrom(wire, 1))
  assert.equal(frames.length, 3)
  assert.deepEqual(JSON.parse(frames[0].payload.toString("utf-8")), {
    event: { data: { stdout: "AA==" } },
  })
  assert.deepEqual(JSON.parse(frames[1].payload.toString("utf-8")), {
    event: { end: { exitCode: 7 } },
  })
  assert.equal(isEndStreamFlag(frames[2].flags), true)
})

test("readFrames handles a large multi-frame stream split on odd boundaries", async () => {
  // 500 data frames + a trailer, delivered in 7-byte chunks (headers straddle
  // chunk boundaries) — exercises peek-across-chunks + take-across-chunks.
  const dataFrames = Array.from({ length: 500 }, (_, i) =>
    encodeEnvelope(
      Buffer.from(
        JSON.stringify({ event: { data: { stdout: `line-${i}` } } }),
        "utf-8"
      )
    )
  )
  const trailer = encodeEnvelope(Buffer.alloc(0), CONNECT_END_STREAM_FLAG)
  const wire = Buffer.concat([...dataFrames, trailer])

  const frames = await collect(streamFrom(wire, 7))
  assert.equal(frames.length, 501)
  assert.deepEqual(JSON.parse(frames[499].payload.toString("utf-8")), {
    event: { data: { stdout: "line-499" } },
  })
  assert.equal(isEndStreamFlag(frames[500].flags), true)
})

test("readFrames throws ConnectProtocolError when the stream ends mid-frame", async () => {
  const wire = encodeEnvelope(Buffer.from("truncated", "utf-8"))
  const partial = streamFrom(wire.subarray(0, wire.length - 3), 4)
  await assert.rejects(collect(partial), ConnectProtocolError)
})
