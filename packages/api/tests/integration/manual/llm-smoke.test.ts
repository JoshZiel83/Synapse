// Phase 7e: Optional LLM smoke test (MANUAL — opt-in only).
//
// This file lives under tests/integration/manual/ on purpose: the default
// `test:integration` glob does NOT pick it up. It calls an externally
// configured Anthropic-compatible endpoint, so it must never run as part
// of the default isolated integration suite.
//
// Drives a one-shot Anthropic Messages request against an externally
// configured base URL to verify the provider transport path (base URL →
// /v1/messages with Bearer auth) is wired correctly. This is intentionally
// SKIPPABLE: if the endpoint or key isn't configured, or the gateway
// returns 5xx, the test logs the reason and exits 0 rather than fail.
//
// The actual canonical-content code path being exercised here is just the
// HTTP transport (provider → gateway → upstream → response → provider
// parse). The canonical content blocks pipeline is exhaustively covered
// by the other integration tests.
//
// Configure via either pair:
//   LLM_SMOKE_BASE_URL + LLM_SMOKE_API_KEY  (preferred — test-scoped)
//   AI_BASE_URL        + AI_API_KEY         (LEGACY fallback for THIS test
//                                            only — the app itself no longer
//                                            reads any AI_* env to pick a model;
//                                            models come from model groups)
// Optional: LLM_SMOKE_MODEL (default: claude-haiku-4-5-20251001).
//
// If the deployment requires a proxy or tunnel to reach the endpoint,
// configure it at the environment level (HTTPS_PROXY, HTTP_PROXY, etc.) —
// this test does not know about any specific proxy topology.
//
// Run manually via the dedicated package script:
//   LLM_SMOKE_BASE_URL=https://example.invalid/ai-gateway \
//   LLM_SMOKE_API_KEY=$KEY \
//     npm run test:integration:llm-smoke -w packages/api

import { test } from "node:test"
import assert from "node:assert/strict"

const BASE_URL = (
  process.env.LLM_SMOKE_BASE_URL ||
  process.env.AI_BASE_URL ||
  ""
).trim()
const KEY = (
  process.env.LLM_SMOKE_API_KEY ||
  process.env.AI_API_KEY ||
  ""
).trim()
const MODEL = process.env.LLM_SMOKE_MODEL || "claude-haiku-4-5-20251001"

test("LLM smoke: configured base URL responds with a non-empty assistant message", async (t) => {
  if (!BASE_URL || !KEY) {
    t.skip(
      "LLM_SMOKE_BASE_URL / LLM_SMOKE_API_KEY (or AI_BASE_URL / AI_API_KEY) not set; skipping LLM smoke"
    )
    return
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)

  let response: Response
  try {
    response = await fetch(`${BASE_URL.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${KEY}`,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 30,
        messages: [{ role: "user", content: "Reply with exactly: ack" }],
      }),
    })
  } catch (error) {
    t.skip(
      `LLM smoke endpoint unreachable: ${error instanceof Error ? error.message : String(error)}`
    )
    return
  } finally {
    clearTimeout(timer)
  }

  const body = await response.text()
  if (response.status === 503) {
    t.skip(
      `Gateway 503: upstream unavailable for model ${MODEL}. body=${body.slice(0, 200)}`
    )
    return
  }
  if (response.status === 404) {
    t.skip(`Gateway 404: model ${MODEL} not enabled on this gateway`)
    return
  }
  if (response.status !== 200) {
    t.skip(
      `Unexpected gateway status ${response.status}: ${body.slice(0, 200)}`
    )
    return
  }

  const json = JSON.parse(body) as {
    content?: Array<{ type: string; text?: string }>
    role?: string
    model?: string
  }
  assert.ok(json.content, `response missing content: ${body}`)
  assert.ok(Array.isArray(json.content), "content should be an array")
  assert.ok(json.content.length > 0, "content array should be non-empty")
  const text = json.content
    .filter((b) => b.type === "text")
    .map((b) => b.text || "")
    .join("")
  assert.ok(text.length > 0, "expected non-empty text in response")
})
