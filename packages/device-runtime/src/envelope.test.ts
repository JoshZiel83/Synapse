import test from "node:test"
import assert from "node:assert/strict"
import { generateKeyPairSync, createSign } from "node:crypto"

import {
  createInMemoryEnvelopeVerifier,
  canonicalize,
  hashArguments,
} from "./envelope.js"
import type { OperationEnvelope } from "@synapse/device-protocol"

function makeKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  })
  return {
    publicPem: publicKey.export({ format: "pem", type: "spki" }) as string,
    privatePem: privateKey.export({ format: "pem", type: "pkcs8" }) as string,
  }
}

function signEnvelope(
  envelope: Omit<OperationEnvelope, "signature">,
  sk: string
): string {
  const payload = canonicalize({ ...envelope, signature: undefined })
  const sign = createSign("sha256")
  sign.update(payload)
  sign.end()
  return sign.sign(sk, "base64")
}

const baseEnvelope: Omit<OperationEnvelope, "signature"> = {
  operation_id: "11111111-1111-1111-1111-111111111111",
  attempt_id: "22222222-2222-2222-2222-222222222222",
  device_runtime_session_id: "33333333-3333-3333-3333-333333333333",
  device_capability_id: "44444444-4444-4444-4444-444444444444",
  device_exposure_id: "55555555-5555-5555-5555-555555555555",
  device_tool_id: "66666666-6666-6666-6666-666666666666",
  device_tool_revision_id: "77777777-7777-7777-7777-777777777777",
  input_hash: hashArguments({ foo: "bar" }),
  task_mode: "sync",
  issued_at: "2026-05-25T00:00:00.000Z",
  expires_at: "9999-12-31T00:00:00.000Z",
  signature_kid: "test-kid",
}

test("envelope verifier accepts a valid envelope", async () => {
  const { publicPem, privatePem } = makeKeys()
  const verifier = createInMemoryEnvelopeVerifier()
  const signature = signEnvelope(baseEnvelope, privatePem)
  const envelope: OperationEnvelope = { ...baseEnvelope, signature }
  const result = await verifier.verify(
    envelope,
    hashArguments({ foo: "bar" }),
    new Map([["test-kid", publicPem]])
  )
  assert.equal(result.ok, true)
})

test("envelope verifier rejects unknown signature_kid", async () => {
  const { privatePem } = makeKeys()
  const verifier = createInMemoryEnvelopeVerifier()
  const signature = signEnvelope(baseEnvelope, privatePem)
  const envelope: OperationEnvelope = { ...baseEnvelope, signature }
  const result = await verifier.verify(envelope, envelope.input_hash, new Map())
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, "invalid_request")
})

test("envelope verifier rejects replay on second attempt", async () => {
  const { publicPem, privatePem } = makeKeys()
  const verifier = createInMemoryEnvelopeVerifier()
  const signature = signEnvelope(baseEnvelope, privatePem)
  const envelope: OperationEnvelope = { ...baseEnvelope, signature }
  const keys = new Map([["test-kid", publicPem]])
  const first = await verifier.verify(envelope, envelope.input_hash, keys)
  assert.equal(first.ok, true)
  const second = await verifier.verify(envelope, envelope.input_hash, keys)
  assert.equal(second.ok, false)
  if (!second.ok) assert.equal(second.code, "replay_detected")
})

test("envelope verifier rejects expired envelope", async () => {
  const { publicPem, privatePem } = makeKeys()
  const verifier = createInMemoryEnvelopeVerifier()
  const expired = {
    ...baseEnvelope,
    attempt_id: "88888888-8888-8888-8888-888888888888",
    expires_at: "2020-01-01T00:00:00.000Z",
  }
  const signature = signEnvelope(expired, privatePem)
  const envelope: OperationEnvelope = { ...expired, signature }
  const result = await verifier.verify(
    envelope,
    envelope.input_hash,
    new Map([["test-kid", publicPem]])
  )
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, "expired_envelope")
})

test("envelope verifier rejects non-canonical instant strings", async () => {
  const { publicPem, privatePem } = makeKeys()
  const verifier = createInMemoryEnvelopeVerifier()
  const nonCanonical = {
    ...baseEnvelope,
    attempt_id: "99999999-8888-7777-6666-555555555555",
    issued_at: "2026-05-25T00:00:00Z",
  }
  const signature = signEnvelope(
    nonCanonical as unknown as Omit<OperationEnvelope, "signature">,
    privatePem
  )
  const envelope = {
    ...nonCanonical,
    signature,
  } as unknown as OperationEnvelope
  const result = await verifier.verify(
    envelope,
    envelope.input_hash,
    new Map([["test-kid", publicPem]])
  )
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, "invalid_request")
})

test("envelope verifier rejects input_hash mismatch", async () => {
  const { publicPem, privatePem } = makeKeys()
  const verifier = createInMemoryEnvelopeVerifier()
  const signature = signEnvelope(baseEnvelope, privatePem)
  const envelope: OperationEnvelope = { ...baseEnvelope, signature }
  const result = await verifier.verify(
    envelope,
    hashArguments({ foo: "different" }),
    new Map([["test-kid", publicPem]])
  )
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, "invalid_request")
})
