// EnvelopeVerifier — v3.0 implementation of the §4.5 device-side verification
// chain. The MCP host calls verify() before any side effect; failures map to
// the device-side error codes in DEVICE_MCP_ERROR_CODES.

import {
  createHash,
  createPublicKey,
  verify as cryptoVerify,
} from "node:crypto"
import {
  canonicalizeEnvelopePayload,
  OperationEnvelopeSchema,
  type OperationEnvelope,
} from "@synapse/device-protocol"
import {
  fromExternalRfc3339,
  parseIsoInstant,
} from "@synapse/device-protocol/instant"
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
      const parsedEnvelope = OperationEnvelopeSchema.safeParse(envelope)
      if (!parsedEnvelope.success) {
        return {
          ok: false,
          code: "invalid_request",
          message: "operation envelope schema validation failed",
        }
      }
      const normalizedEnvelope = parsedEnvelope.data
      // 1. signature
      const serverPubkey = serverPublicKeys.get(
        normalizedEnvelope.signature_kid
      )
      if (!serverPubkey) {
        return {
          ok: false,
          code: "invalid_request",
          message: `unknown signature_kid: ${normalizedEnvelope.signature_kid}`,
        }
      }
      const signedPayload = canonicalizeEnvelopePayload({
        ...normalizedEnvelope,
        signature: undefined,
      })
      try {
        const pubKey = createPublicKey({
          key: serverPubkey,
          format: "pem",
        })
        const ok = cryptoVerify(
          null,
          Buffer.from(signedPayload, "utf8"),
          pubKey,
          Buffer.from(normalizedEnvelope.signature, "base64")
        )
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
      // 2. expires_at — route through the canonical parser (C1). A present-but-
      // unparseable expires_at must NOT be treated as "not expired" (C2): map a
      // thrown parse error to the SAME expired/invalid branch as a past expiry.
      let expiresAt: number
      try {
        expiresAt = parseIsoInstant(
          fromExternalRfc3339(normalizedEnvelope.expires_at)
        ).getTime()
      } catch {
        return {
          ok: false,
          code: "expired_envelope",
          message: "envelope expired",
        }
      }
      if (!Number.isFinite(expiresAt) || expiresAt < now()) {
        return {
          ok: false,
          code: "expired_envelope",
          message: "envelope expired",
        }
      }
      // 3. atomic replay reserve
      if (replay.has(normalizedEnvelope.attempt_id)) {
        return {
          ok: false,
          code: "replay_detected",
          message: "attempt already executed",
        }
      }
      replay.set(normalizedEnvelope.attempt_id, { expiresAt })
      gc()
      // 4. input hash match
      if (actualArgsHash !== normalizedEnvelope.input_hash) {
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
  return canonicalizeEnvelopePayload(value)
}

export function hashArguments(value: unknown): string {
  const canonical = canonicalize(value)
  const hash = createHash("sha256").update(canonical).digest("hex")
  return `sha256:${hash}`
}
