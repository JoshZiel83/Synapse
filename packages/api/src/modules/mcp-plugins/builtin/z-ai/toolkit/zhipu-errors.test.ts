import { test } from "node:test"
import assert from "node:assert/strict"
import {
  normalizeZhipuTransportError,
  throwZhipuApiError,
} from "./zhipu-errors.js"

async function captureZhipuApiError(response: Response) {
  try {
    await throwZhipuApiError("Zhipu test API", response)
  } catch (error) {
    return error
  }
  throw new Error("Expected throwZhipuApiError to throw")
}

test("throwZhipuApiError extracts provider error code and message", async () => {
  const error = await captureZhipuApiError(
    new Response(
      JSON.stringify({
        error: {
          code: "1301",
          message: "unsafe content",
        },
      }),
      { status: 429 }
    )
  )

  assert.ok(error instanceof Error)
  assert.match(error.message, /HTTP 状态码: 429/)
  assert.match(error.message, /业务错误码: 1301/)
  assert.match(error.message, /原始错误消息: unsafe content/)
  assert.match(error.message, /输入或生成内容可能包含不安全或敏感内容/)
})

test("throwZhipuApiError falls back to body preview for malformed JSON", async () => {
  const error = await captureZhipuApiError(
    new Response("{not-json", { status: 500 })
  )

  assert.ok(error instanceof Error)
  assert.match(error.message, /HTTP 状态码: 500/)
  assert.match(error.message, /响应体: \{not-json/)
})

test("throwZhipuApiError ignores drifted provider error shapes", async () => {
  const error = await captureZhipuApiError(
    new Response(JSON.stringify({ error: "bad-shape" }), { status: 400 })
  )

  assert.ok(error instanceof Error)
  assert.match(error.message, /HTTP 状态码: 400/)
  assert.doesNotMatch(error.message, /业务错误码:/)
  assert.match(error.message, /响应体: \{"error":"bad-shape"\}/)
})

test("normalizeZhipuTransportError keeps timeout and network messages", () => {
  assert.match(
    normalizeZhipuTransportError(
      "Zhipu test API",
      new DOMException("aborted", "AbortError")
    ).message,
    /调用超时/
  )

  assert.match(
    normalizeZhipuTransportError("Zhipu test API", new Error("fetch failed"))
      .message,
    /网络错误/
  )
})
