// EnvelopeVerifier — v3.0 implementation of the §4.5 device-side verification
// chain. The MCP host (PR #6 follow-up) calls verify() before any side
// effect; failures map to the device-side error codes in
// DEVICE_MCP_ERROR_CODES.

import { createHash, createVerify } from "node:crypto"
import type { OperationEnvelope } from "@synapse/device-protocol"
import type { EnvelopeVerifier, EnvelopeVerifyResult } from "./types.js"

interface ReplayStoreEntry {
  expiresAt: number
}

export interface InMemoryEnvelopeVerifierOptions {
  /**
   * Max number of attempt_ids to remember. Older entries are evicted lazily
   * on insert. v3.0 default sized for ~5 minutes of dispatch at 100 RPS.
   */
  replayCapacity?: number
  now?: () => number
}

export function createInMemoryEnvelopeVerifier(
  opts: InMemoryEnvelopeVerifierOptions = {}
): EnvelopeVerifier {
  const capacity = opts.replayCapacity ?? 30_000
  const now = opts.now ?? Date.now
  const replay = new Map<string, ReplayStoreEntry>()

  function gc() {
    if (replay.size <= capacity) return
    const cutoff = now()
    for (const [attemptId, entry] of replay) {
      if (entry.expiresAt < cutoff) replay.delete(attemptId)
      if (replay.size <= capacity) return
    }
  }

  return {
    async verify(
      envelope: OperationEnvelope,
      actualArgsHash: string,
      serverPublicKeys: ReadonlyMap<string, string>
    ): Promise<EnvelopeVerifyResult> {
      // 1. signature
      const serverPubkey = serverPublicKeys.get(envelope.signature_kid)
      if (!serverPubkey) {
        return {
          ok: false,
          code: "invalid_request",
          message: `unknown signature_kid: ${envelope.signature_kid}`,
        }
      }
      const signedPayload = canonicalize({
        ...envelope,
        signature: undefined,
      })
      try {
        const verifier = createVerify("sha256")
        verifier.update(signedPayload)
        verifier.end()
        const ok = verifier.verify(serverPubkey, envelope.signature, "base64")
        if (!ok) {
          return {
            ok: false,
            code: "invalid_request",
            message: "envelope signature verification failed",
          }
        }
      } catch (err) {
        return {
          ok: false,
          code: "invalid_request",
          message: `envelope signature error: ${(err as Error).message}`,
        }
      }
      // 2. expires_at
      const expiresAt = Date.parse(envelope.expires_at)
      if (!Number.isFinite(expiresAt) || expiresAt < now()) {
        return {
          ok: false,
          code: "expired_envelope",
          message: "envelope expired",
        }
      }
      // 3. atomic replay reserve
      if (replay.has(envelope.attempt_id)) {
        return {
          ok: false,
          code: "replay_detected",
          message: "attempt already executed",
        }
      }
      replay.set(envelope.attempt_id, { expiresAt })
      gc()
      // 4. input hash match
      if (actualArgsHash !== envelope.input_hash) {
        return {
          ok: false,
          code: "invalid_request",
          message: "input_hash mismatch",
        }
      }
      return { ok: true }
    },
  }
}

export function canonicalize(value: unknown): string {
  if (value === undefined) return "null"
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`)
    .join(",")}}`
}

export function hashArguments(value: unknown): string {
  const canonical = canonicalize(value)
  const hash = createHash("sha256").update(canonical).digest("hex")
  return `sha256:${hash}`
}
