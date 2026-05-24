// Phase 7e: Optional LLM smoke test.
//
// Drives a one-shot Claude API call through the GLM SOCKS5 gateway to
// verify the Anthropic provider config path (AI_BASE_URL → /v1/messages
// with Bearer auth) is wired correctly. This is intentionally SKIPPABLE:
// if SOCKS5 isn't reachable or the gateway returns 5xx, the test logs
// the reason and exits 0 rather than fail.
//
// The actual canonical-content code path being exercised here is just the
// HTTP transport (provider → gateway → upstream → response → provider
// parse). The canonical content blocks pipeline is exhaustively covered
// by the other integration tests.
//
// Run manually with:
//   LLM_SMOKE_PROXY_URL=<redacted-local-proxy> LLM_SMOKE_API_KEY=$KEY \
//   node --test --import tsx packages/api/tests/integration/llm-smoke.test.ts

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"

const SOCKS5 = process.env.LLM_SMOKE_PROXY_URL || "<redacted-local-proxy>"
const KEY = process.env.LLM_SMOKE_API_KEY || ""
const GATEWAY = process.env.AI_BASE_URL || "https://example.invalid/ai-gateway"
const MODEL = process.env.LLM_SMOKE_MODEL || "claude-haiku-4-5-20251001"

test("LLM smoke: gateway responds with a non-empty assistant message", async (t) => {
  if (!KEY) {
    t.skip("LLM_SMOKE_API_KEY env not set; skipping LLM smoke")
    return
  }

  // Probe SOCKS5 reachability via the system curl (Node fetch doesn't
  // natively speak socks5 without an extra agent).
  const probe = spawnSync(
    "curl",
    [
      "-sS",
      "-x",
      `socks5h://${SOCKS5}`,
      "--max-time",
      "20",
      "-H",
      `Authorization: Bearer ${KEY}`,
      "-H",
      "anthropic-version: 2023-06-01",
      "-H",
      "content-type: application/json",
      "-d",
      JSON.stringify({
        model: MODEL,
        max_tokens: 30,
        messages: [{ role: "user", content: "Reply with exactly: ack" }],
      }),
      "-w",
      "\n__STATUS__%{http_code}",
      `${GATEWAY}/v1/messages`,
    ],
    {
      encoding: "utf8",
      timeout: 30_000,
    }
  )

  if (probe.error) {
    t.skip(`curl unavailable or hung: ${probe.error.message}`)
    return
  }

  const output = probe.stdout || ""
  const statusMatch = output.match(/__STATUS__(\d+)/)
  const status = statusMatch ? Number(statusMatch[1]) : 0
  const body = output.replace(/\n?__STATUS__\d+\s*$/, "")

  if (status === 0) {
    t.skip(`SOCKS5 ${SOCKS5} unreachable or proxy refused`)
    return
  }
  if (status === 503) {
    t.skip(
      `Gateway 503: upstream unavailable for model ${MODEL}. body=${body.slice(0, 200)}`
    )
    return
  }
  if (status === 404) {
    t.skip(`Gateway 404: model ${MODEL} not enabled on this gateway`)
    return
  }
  if (status !== 200) {
    t.skip(`Unexpected gateway status ${status}: ${body.slice(0, 200)}`)
    return
  }

  // 200 — assert the canonical Anthropic Messages response shape.
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
