/**
 * No-leak guard for the value redactor (Phase 1 gate).
 *
 * Two layers, both asserted here:
 *  1. A deterministic value-shape pre-scrub (always-on) for the real free-text
 *     threat model — Bearer tokens, `?token=` URLs, AWS/GCP key shapes, PEM
 *     private keys — i.e. the secrets shared/utils/redact.ts key-name matching
 *     CANNOT catch because they live inside a value (bash `command`, stdout).
 *  2. secretlint's recommend preset on top (vendor rules + entropy), exercised
 *     via GitHub/Stripe which the preset reliably flags.
 */

import test from "node:test"
import assert from "node:assert/strict"
import { redactDeep, redactText } from "./redact.js"

function assertNoLeak(out: string, planted: string[]) {
  for (const secret of planted) {
    assert.ok(!out.includes(secret), `secret leaked: ${secret} -> ${out}`)
  }
}

// ── Layer 1: deterministic value-shape pre-scrub ────────────────────────────

test("redact: Bearer token in a bash command (the core threat model)", async () => {
  const tok = "sk-ant-api03-abcdefghijklmnop1234567890" // gitleaks:allow
  const out = await redactText(
    `curl -H "Authorization: Bearer ${tok}" https://x`
  )
  assertNoLeak(out, [tok, `Bearer ${tok}`])
})

test("redact: ?token= in a URL", async () => {
  const tok = "abcdef1234567890SECRETvalue" // gitleaks:allow
  const out = await redactText(
    `fetched https://api.example.com/x?token=${tok}&page=1`
  )
  assertNoLeak(out, [tok])
  assert.match(out, /token=\[redacted\]/)
})

test("redact: AWS access key id shape", async () => {
  const key = "AKIA2E0A8F3B244C9986" // gitleaks:allow
  const out = await redactText(`aws creds ${key} here`)
  assertNoLeak(out, [key])
})

test("redact: GCP API key shape", async () => {
  const key = "AIzaSyA1234567890abcdefghijklmnopqrstuv" // gitleaks:allow
  const out = await redactText(`key=${key}`)
  assertNoLeak(out, [key])
})

test("redact: PEM private key block", async () => {
  const pem =
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAsecret\n-----END RSA PRIVATE KEY-----" // gitleaks:allow
  const out = await redactText(`config:\n${pem}\n`)
  assertNoLeak(out, ["MIIEpAIBAAKCAQEAsecret"])
})

// ── Layer 2: secretlint preset ──────────────────────────────────────────────

test("redact: GitHub PAT (secretlint preset)", async () => {
  const tok = "ghp_1234567890abcdefABCDEF1234567890abcd" // gitleaks:allow
  const out = await redactText(`git clone https://${tok}@github.com/x/y`)
  assertNoLeak(out, [tok])
})

test("redact: Stripe live key (secretlint preset)", async () => {
  const tok = "sk_live_1234567890abcdefABCDEFghij" // gitleaks:allow
  const out = await redactText(`STRIPE=${tok}`)
  assertNoLeak(out, [tok])
})

// ── Invariants ──────────────────────────────────────────────────────────────

test("redact: clean text passes through unchanged", async () => {
  const clean = "正在编辑 foo.ts, 2 处修改"
  assert.equal(await redactText(clean), clean)
})

test("redact: over-long input truncated (tail cannot leak)", async () => {
  const tok = "AKIA2E0A8F3B244C9986" // gitleaks:allow
  const big = "a".repeat(20_000) + tok
  const out = await redactText(big)
  assertNoLeak(out, [tok])
  assert.ok(out.includes("truncated"))
})

test("redactDeep: masks secrets in nested string leaves, preserves structure", async () => {
  const tok = "ghp_1234567890abcdefABCDEF1234567890abcd" // gitleaks:allow
  const input = {
    title: { fallback: "运行 git push", params: { cmd: "git push" } },
    blocks: [{ type: "text", text: `using ${tok}` }],
    count: 3,
  }
  const out = await redactDeep(input)
  assert.equal(out.count, 3)
  assert.equal(out.title.fallback, "运行 git push")
  assertNoLeak(out.blocks[0].text, [tok])
})
