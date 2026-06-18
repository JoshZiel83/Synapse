import test from "node:test"
import assert from "node:assert/strict"
import { DisconnectReason } from "baileys"
import { decideDisconnect, statusCodeFromError } from "./disconnect-policy.js"

test("restartRequired (515) → restart (new socket, no backoff)", () => {
  assert.deepEqual(decideDisconnect(DisconnectReason.restartRequired, false), {
    action: "restart",
  })
})

test("loggedOut (401) → wipe + logged_out", () => {
  assert.deepEqual(decideDisconnect(DisconnectReason.loggedOut, false), {
    action: "wipe",
    pauseReason: "logged_out",
  })
})

test("forbidden (403) → wipe + forbidden", () => {
  assert.deepEqual(decideDisconnect(DisconnectReason.forbidden, false), {
    action: "wipe",
    pauseReason: "forbidden",
  })
})

test("multideviceMismatch (411) → wipe", () => {
  assert.equal(
    decideDisconnect(DisconnectReason.multideviceMismatch, false).action,
    "wipe"
  )
})

test("transient codes (428/408/440/500/503) → reconnect", () => {
  for (const code of [
    DisconnectReason.connectionClosed,
    DisconnectReason.connectionLost, // === timedOut (408)
    DisconnectReason.connectionReplaced,
    DisconnectReason.badSession,
    DisconnectReason.unavailableService,
  ]) {
    assert.equal(
      decideDisconnect(code, false).action,
      "reconnect",
      `code ${code}`
    )
  }
})

test("unknown/undefined code → reconnect", () => {
  assert.equal(decideDisconnect(undefined, false).action, "reconnect")
  assert.equal(decideDisconnect(9999, false).action, "reconnect")
})

test("intentionalStop short-circuits to stop regardless of code", () => {
  assert.equal(
    decideDisconnect(DisconnectReason.restartRequired, true).action,
    "stop"
  )
  assert.equal(
    decideDisconnect(DisconnectReason.loggedOut, true).action,
    "stop"
  )
})

test("statusCodeFromError reads Boom output.statusCode", () => {
  assert.equal(statusCodeFromError({ output: { statusCode: 401 } }), 401)
  assert.equal(statusCodeFromError({ statusCode: 515 }), 515)
  assert.equal(statusCodeFromError(new Error("x")), undefined)
  assert.equal(statusCodeFromError(undefined), undefined)
})

test("DisconnectReason codes match the installed baileys version", () => {
  // Locks the version-sensitive surface the plan flagged.
  assert.equal(DisconnectReason.connectionClosed, 428)
  assert.equal(DisconnectReason.connectionLost, 408)
  assert.equal(DisconnectReason.timedOut, 408)
  assert.equal(DisconnectReason.connectionReplaced, 440)
  assert.equal(DisconnectReason.loggedOut, 401)
  assert.equal(DisconnectReason.restartRequired, 515)
  assert.equal(DisconnectReason.forbidden, 403)
  assert.equal(DisconnectReason.multideviceMismatch, 411)
})
