import test from "node:test"
import assert from "node:assert/strict"
import { parsePairOutput } from "./host-provider.js"

/**
 * host-provider parse robustness. The `synapse-device pair` CLI prints its
 * result via JSON.stringify(result, null, 2) — PRETTY, MULTI-LINE JSON, possibly
 * surrounded by log lines. The parser must extract the balanced {...} block, not
 * scan line-by-line (which never sees a complete object → provisioning fails).
 */

test("parsePairOutput: parses pretty-printed multi-line JSON (camelCase)", () => {
  const stdout = JSON.stringify(
    {
      deviceId: "dev-123",
      serviceId: "svc-456",
      controlPlaneUrl: "wss://x/cp",
    },
    null,
    2
  )
  const r = parsePairOutput(stdout)
  assert.ok(r)
  assert.equal(r?.deviceId, "dev-123")
  assert.equal(r?.serviceId, "svc-456")
  assert.equal(r?.controlPlaneUrl, "wss://x/cp")
})

test("parsePairOutput: tolerates surrounding log lines", () => {
  const stdout = [
    "[device] starting pairing...",
    "[device] connected",
    JSON.stringify({ device_id: "d1", service_id: "s1" }, null, 2),
    "[device] done",
  ].join("\n")
  const r = parsePairOutput(stdout)
  assert.ok(r)
  assert.equal(r?.deviceId, "d1")
  assert.equal(r?.serviceId, "s1")
})

test("parsePairOutput: accepts snake_case keys", () => {
  const r = parsePairOutput(
    '{"device_id":"d","service_id":"s","control_plane_url":"u"}'
  )
  assert.equal(r?.deviceId, "d")
  assert.equal(r?.serviceId, "s")
  assert.equal(r?.controlPlaneUrl, "u")
})

test("parsePairOutput: returns null when no device/service ids present", () => {
  assert.equal(parsePairOutput("no json here"), null)
  assert.equal(parsePairOutput('{"foo":"bar"}'), null)
  assert.equal(parsePairOutput(""), null)
})

test("parsePairOutput: rejects drifted pair output shapes", () => {
  assert.equal(parsePairOutput('{"deviceId":"","serviceId":"s"}'), null)
  assert.equal(parsePairOutput('{"deviceId":"d","serviceId":1}'), null)
  assert.equal(
    parsePairOutput(
      '{"device_id":"d","service_id":"s","control_plane_url":123}'
    ),
    null
  )
})

test("parsePairOutput: handles braces inside string values", () => {
  // A controlPlaneUrl containing a brace must not break balance tracking.
  const r = parsePairOutput(
    JSON.stringify(
      { deviceId: "d", serviceId: "s", controlPlaneUrl: "wss://x/{tok}" },
      null,
      2
    )
  )
  assert.equal(r?.deviceId, "d")
  assert.equal(r?.controlPlaneUrl, "wss://x/{tok}")
})
