// Server-side OperationEnvelope signer. Loads an Ed25519 signing key from
// SYNAPSE_DEVICE_ENVELOPE_SIGNING_KEY (PEM) at first use and exposes the
// signature_kid (sha256(spki(pubkey)).hex.slice(0,16)) so the device runtime
// can look it up in its trusted-server-keys map.

import { createHash, createPrivateKey, createPublicKey } from "node:crypto"
import {
  signOperationEnvelope,
  type OperationEnvelope,
  type UnsignedOperationEnvelope,
} from "@synapse/device-protocol"

interface LoadedSigner {
  privateKeyPem: string
  publicKeyPem: string
  signatureKid: string
}

let cached: LoadedSigner | null = null

function readKeyMaterial(): string | null {
  const env = process.env.SYNAPSE_DEVICE_ENVELOPE_SIGNING_KEY
  if (env && env.includes("BEGIN PRIVATE KEY")) {
    return env
  }
  // PEM may be base64-blob in the env; decode and re-inject the PEM headers
  // is not v3 scope — the operator-facing contract is "drop the PEM in
  // verbatim, including the BEGIN/END markers".
  return env && env.length > 0 ? env : null
}

export function loadEnvelopeSigner(): LoadedSigner {
  if (cached) return cached
  const pem = readKeyMaterial()
  if (!pem) {
    throw new Error(
      "SYNAPSE_DEVICE_ENVELOPE_SIGNING_KEY is not set — the device dispatcher cannot sign operation envelopes without it. Generate an Ed25519 key with `openssl genpkey -algorithm Ed25519` and set the env var to the PEM."
    )
  }
  const priv = createPrivateKey({ key: pem, format: "pem" })
  const pub = createPublicKey(priv)
  const pubPem = pub.export({ format: "pem", type: "spki" }) as string
  const kid = createHash("sha256").update(pubPem).digest("hex").slice(0, 16)
  cached = { privateKeyPem: pem, publicKeyPem: pubPem, signatureKid: kid }
  return cached
}

/**
 * Sign an envelope. The caller fills in everything EXCEPT signature_kid +
 * signature; this helper adds them.
 */
export function signEnvelopeForDispatch(
  payload: Omit<UnsignedOperationEnvelope, "signature_kid">
): OperationEnvelope {
  const signer = loadEnvelopeSigner()
  return signOperationEnvelope(
    {
      ...payload,
      signature_kid: signer.signatureKid,
    },
    signer.privateKeyPem
  )
}

/** Public key + kid that the operator publishes to device runtimes. */
export function getEnvelopeServerPublicKey(): {
  signatureKid: string
  publicKeyPem: string
} {
  const signer = loadEnvelopeSigner()
  return {
    signatureKid: signer.signatureKid,
    publicKeyPem: signer.publicKeyPem,
  }
}

/** Test helper — reset the cached signer so tests can re-init with a new env. */
export function resetEnvelopeSignerCache(): void {
  cached = null
}
