import assert from "node:assert/strict"
import test from "node:test"

import {
  FeishuApiClient,
  parseJsonArrayInput,
  parseJsonObjectInput,
} from "./client.js"

async function withFetch<T>(
  handler: typeof fetch,
  run: () => Promise<T>
): Promise<T> {
  const originalFetch = globalThis.fetch
  globalThis.fetch = handler
  try {
    return await run()
  } finally {
    globalThis.fetch = originalFetch
  }
}

test("parseJsonObjectInput accepts only JSON object inputs", () => {
  assert.deepEqual(parseJsonObjectInput('{"filter":{"x":1}}', "filter"), {
    filter: { x: 1 },
  })
  assert.deepEqual(parseJsonObjectInput({ filter: { x: 1 } }, "filter"), {
    filter: { x: 1 },
  })

  assert.throws(() => parseJsonObjectInput("[1]", "filter"), {
    message: "filter must be a JSON object.",
  })
  assert.throws(() => parseJsonObjectInput('"x"', "filter"), {
    message: "filter must be a JSON object.",
  })
  assert.throws(() => parseJsonObjectInput("{not-json", "filter"), {
    message: "filter must be a JSON object.",
  })
})

test("parseJsonArrayInput accepts only JSON array inputs", () => {
  assert.deepEqual(parseJsonArrayInput('["a","b"]', "values"), ["a", "b"])
  assert.deepEqual(parseJsonArrayInput(["a", 1], "values"), ["a", 1])

  assert.throws(() => parseJsonArrayInput('{"a":1}', "values"), {
    message: "values must be a JSON array.",
  })
  assert.throws(() => parseJsonArrayInput('"x"', "values"), {
    message: "values must be a JSON array.",
  })
  assert.throws(() => parseJsonArrayInput("{not-json", "values"), {
    message: "values must be a JSON array.",
  })
})

test("FeishuApiClient.requestJson requires successful provider responses to be JSON objects", async () => {
  const client = new FeishuApiClient("https://open.feishu.example", "token")

  await withFetch(
    (async () =>
      new Response(JSON.stringify({ code: 0, data: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
    async () => {
      assert.deepEqual(await client.requestJson({ path: "/ok" }), {
        ok: true,
      })
    }
  )

  await withFetch(
    (async () =>
      new Response("[1,2,3]", {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
    async () => {
      await assert.rejects(client.requestJson({ path: "/array" }), {
        message: "Feishu API response must be a JSON object.",
      })
    }
  )

  await withFetch(
    (async () =>
      new Response("{not-json", {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
    async () => {
      await assert.rejects(client.requestJson({ path: "/bad-json" }), {
        message: "Feishu API response must be valid JSON.",
      })
    }
  )
})

test("FeishuApiClient.requestJson still surfaces provider business errors", async () => {
  const client = new FeishuApiClient("https://open.feishu.example", "token")

  await withFetch(
    (async () =>
      new Response(JSON.stringify({ code: 999, msg: "scope denied" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
    async () => {
      await assert.rejects(client.requestJson({ path: "/error" }), {
        message: "[999] scope denied",
      })
    }
  )
})

test("FeishuApiClient.requestJson parses non-2xx provider error objects only", async () => {
  const client = new FeishuApiClient("https://open.feishu.example", "token")

  await withFetch(
    (async () =>
      new Response(JSON.stringify({ code: 999, msg: "scope denied" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
    async () => {
      await assert.rejects(client.requestJson({ path: "/forbidden" }), {
        message: "[999] scope denied",
      })
    }
  )

  await withFetch(
    (async () =>
      new Response("[1,2,3]", {
        status: 502,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
    async () => {
      await assert.rejects(client.requestJson({ path: "/bad-error" }), {
        message: "HTTP 502",
      })
    }
  )
})
