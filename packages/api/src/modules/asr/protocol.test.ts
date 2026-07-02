import test from "node:test"
import assert from "node:assert/strict"
import { gzipSync } from "node:zlib"
import {
  decodeProviderFrame,
  encodeAudioOnlyRequest,
  encodeFullClientRequest,
} from "./protocol.js"

function buildServerResponseFrame(payload: unknown, isFinal = false) {
  const serialized = Buffer.from(JSON.stringify(payload), "utf8")
  const compressed = gzipSync(serialized)
  const header = Buffer.from([0x11, isFinal ? 0x93 : 0x91, 0x11, 0x00])
  const sequence = Buffer.alloc(4)
  sequence.writeInt32BE(isFinal ? 3 : 2, 0)
  const payloadSize = Buffer.alloc(4)
  payloadSize.writeUInt32BE(compressed.length, 0)
  return Buffer.concat([header, sequence, payloadSize, compressed])
}

function buildErrorFrame(code: number, payload: unknown) {
  const serialized = Buffer.from(JSON.stringify(payload), "utf8")
  const header = Buffer.from([0x11, 0xf0, 0x10, 0x00])
  const errorCode = Buffer.alloc(4)
  errorCode.writeUInt32BE(code, 0)
  const payloadSize = Buffer.alloc(4)
  payloadSize.writeUInt32BE(serialized.length, 0)
  return Buffer.concat([header, errorCode, payloadSize, serialized])
}

test("encodeFullClientRequest uses expected protocol header", () => {
  const frame = encodeFullClientRequest({
    audio: {
      format: "pcm",
      codec: "raw",
      rate: 16000,
      bits: 16,
      channel: 1,
    },
    request: {
      model_name: "bigmodel",
      enable_nonstream: true,
      enable_itn: true,
      enable_punc: true,
      show_utterances: true,
      result_type: "full",
      end_window_size: 800,
      force_to_speech_time: 1000,
    },
  })

  assert.equal(frame[0], 0x11)
  assert.equal(frame[1], 0x10)
  assert.equal(frame[2], 0x11)
  assert.equal(frame[3], 0x00)
})

test("encodeAudioOnlyRequest marks the final packet", () => {
  const frame = encodeAudioOnlyRequest(Buffer.from([1, 2, 3]), true)

  assert.equal(frame[0], 0x11)
  assert.equal(frame[1], 0x22)
  assert.equal(frame[2], 0x01)
  assert.equal(frame[3], 0x00)
})

test("decodeProviderFrame parses full server responses", () => {
  const frame = buildServerResponseFrame({
    result: {
      text: "你好世界",
    },
    audio_info: {
      duration: 1200,
    },
  })

  const decoded = decodeProviderFrame(frame)
  assert.equal(decoded.kind, "response")
  assert.equal(decoded.sequence, 2)
  assert.equal(decoded.isFinal, false)
  assert.deepEqual(decoded.payload, {
    result: {
      text: "你好世界",
    },
    audio_info: {
      duration: 1200,
    },
  })
})

test("decodeProviderFrame parses provider error frames", () => {
  const frame = buildErrorFrame(55000031, {
    message: "server busy",
  })

  const decoded = decodeProviderFrame(frame)
  assert.equal(decoded.kind, "error")
  assert.equal(decoded.code, 55000031)
  assert.deepEqual(decoded.payload, {
    message: "server busy",
  })
})

test("decodeProviderFrame preserves the error code when the payload is not valid JSON", () => {
  // serialization=JSON (byte2 high nibble 0x1) but payload is a bare non-JSON
  // UTF-8 string, as the doc allows ("Error Message (UTF-8 String)"). The code
  // must survive rather than being masked by a JSON.parse throw.
  const message = Buffer.from("服务器繁忙", "utf8")
  const header = Buffer.from([0x11, 0xf0, 0x10, 0x00])
  const errorCode = Buffer.alloc(4)
  errorCode.writeUInt32BE(55000031, 0)
  const payloadSize = Buffer.alloc(4)
  payloadSize.writeUInt32BE(message.length, 0)
  const frame = Buffer.concat([header, errorCode, payloadSize, message])

  const decoded = decodeProviderFrame(frame)
  assert.equal(decoded.kind, "error")
  assert.equal(decoded.code, 55000031)
  assert.equal(decoded.payload, "服务器繁忙")
})

test("decodeProviderFrame rejects non-object JSON provider payloads", () => {
  for (const payload of [["not", "object"], "not-object", 123, null]) {
    assert.throws(
      () => decodeProviderFrame(buildServerResponseFrame(payload)),
      /JSON payload must be an object/
    )
  }
})
