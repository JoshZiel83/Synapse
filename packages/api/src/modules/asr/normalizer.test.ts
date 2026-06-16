import test from "node:test"
import assert from "node:assert/strict"
import { assertIsoInstant } from "@synapse/shared/datetime"
import { AsrResultAccumulator } from "./normalizer.js"

test("AsrResultAccumulator emits partial and final utterances without duplicates", () => {
  const accumulator = new AsrResultAccumulator()

  const first = accumulator.ingest(
    {
      result: {
        text: "你好世",
        utterances: [
          {
            text: "你好",
            start_time: 0,
            end_time: 300,
            definite: true,
          },
          {
            text: "世",
            start_time: 301,
            end_time: 450,
            definite: false,
          },
        ],
      },
      audio_info: {
        duration: 450,
      },
    },
    assertIsoInstant("2026-04-02T00:00:00.000Z"),
    false
  )

  assert.deepEqual(first.partial, {
    displayText: "你好世",
    unstableText: "世",
    receivedAt: "2026-04-02T00:00:00.000Z",
  })
  assert.equal(first.segmentFinals.length, 1)
  assert.equal(first.segmentFinals[0]?.text, "你好")

  const second = accumulator.ingest(
    {
      result: {
        text: "你好世界",
        utterances: [
          {
            text: "你好",
            start_time: 0,
            end_time: 300,
            definite: true,
          },
          {
            text: "世界",
            start_time: 301,
            end_time: 900,
            definite: true,
          },
        ],
      },
      audio_info: {
        duration: 900,
      },
    },
    assertIsoInstant("2026-04-02T00:00:01.000Z"),
    true
  )

  assert.deepEqual(second.partial, {
    displayText: "你好世界",
    unstableText: "",
    receivedAt: "2026-04-02T00:00:01.000Z",
  })
  assert.equal(second.segmentFinals.length, 1)
  assert.equal(second.segmentFinals[0]?.text, "世界")
  assert.deepEqual(second.completed, {
    text: "你好世界",
    segments: [
      {
        text: "你好",
        segmentIndex: 0,
        startTimeMs: 0,
        endTimeMs: 300,
        receivedAt: "2026-04-02T00:00:00.000Z",
      },
      {
        text: "世界",
        segmentIndex: 1,
        startTimeMs: 301,
        endTimeMs: 900,
        receivedAt: "2026-04-02T00:00:01.000Z",
      },
    ],
    durationMs: 900,
  })
})

test("AsrResultAccumulator fails closed on drifted provider payload shapes", () => {
  const accumulator = new AsrResultAccumulator()
  const receivedAt = assertIsoInstant("2026-04-02T00:00:00.000Z")

  assert.deepEqual(
    accumulator.ingest(
      {
        result: {
          text: "ignored",
          utterances: "not-an-array",
        },
      },
      receivedAt,
      true
    ),
    { segmentFinals: [] }
  )

  assert.deepEqual(
    accumulator.ingest(
      {
        audio_info: {
          duration: "900",
        },
      },
      receivedAt,
      true
    ),
    { segmentFinals: [] }
  )
})
