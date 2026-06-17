import { test } from "node:test"
import assert from "node:assert/strict"
import { parseSherpaOnnxConfigJson } from "./audio-fallback-config.js"

test("parseSherpaOnnxConfigJson treats blank config as disabled", () => {
  assert.equal(parseSherpaOnnxConfigJson(""), null)
  assert.equal(parseSherpaOnnxConfigJson("   "), null)
})

test("parseSherpaOnnxConfigJson accepts JSON object config", () => {
  assert.deepEqual(
    parseSherpaOnnxConfigJson(
      JSON.stringify({
        model: "model.onnx",
        tokens: "tokens.txt",
        numThreads: 2,
      })
    ),
    {
      model: "model.onnx",
      tokens: "tokens.txt",
      numThreads: 2,
    }
  )
})

test("parseSherpaOnnxConfigJson rejects malformed JSON", () => {
  assert.throws(
    () => parseSherpaOnnxConfigJson("{"),
    /invalid SHERPA_ONNX_CONFIG_JSON/
  )
})

test("parseSherpaOnnxConfigJson rejects non-object JSON", () => {
  for (const raw of ["[]", "null", '"model"', "1", "true"]) {
    assert.throws(
      () => parseSherpaOnnxConfigJson(raw),
      /invalid SHERPA_ONNX_CONFIG_JSON: expected a JSON object/
    )
  }
})
