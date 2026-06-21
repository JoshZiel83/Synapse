import test from "node:test"
import assert from "node:assert/strict"
import { callMethod, callMethodMultipart, TelegramApiError } from "./client.js"

const CREDS = { botToken: "123:ABC" }

function withFetch(
  impl: (url: string, init?: RequestInit) => Promise<Response>,
  run: () => Promise<void>
): Promise<void> {
  const orig = globalThis.fetch
  globalThis.fetch = impl as typeof fetch
  return run().finally(() => {
    globalThis.fetch = orig
  })
}

test("callMethod: unwraps ok:true result + posts JSON to method URL", async () => {
  let seenUrl = ""
  let seenBody = ""
  await withFetch(
    async (url, init) => {
      seenUrl = String(url)
      seenBody = String(init?.body)
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 9 } }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    },
    async () => {
      const r = await callMethod<{ message_id: number }>(CREDS, "sendMessage", {
        chat_id: "5",
        text: "hi",
      })
      assert.equal(r.message_id, 9)
      assert.equal(seenUrl, "https://api.telegram.org/bot123:ABC/sendMessage")
      assert.deepEqual(JSON.parse(seenBody), { chat_id: "5", text: "hi" })
    }
  )
})

test("callMethod: ok:false => TelegramApiError with code + retry_after", async () => {
  await withFetch(
    async () =>
      new Response(
        JSON.stringify({
          ok: false,
          error_code: 429,
          description: "Too Many Requests",
          parameters: { retry_after: 7 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      ),
    async () => {
      await assert.rejects(
        () => callMethod(CREDS, "sendMessage", {}),
        (err: unknown) => {
          assert.ok(err instanceof TelegramApiError)
          assert.equal(err.errorCode, 429)
          assert.equal(err.retryAfter, 7)
          return true
        }
      )
    }
  )
})

test("callMethod: migrate_to_chat_id surfaced on error", async () => {
  await withFetch(
    async () =>
      new Response(
        JSON.stringify({
          ok: false,
          error_code: 400,
          description: "group migrated",
          parameters: { migrate_to_chat_id: -1009 },
        }),
        { status: 400, headers: { "content-type": "application/json" } }
      ),
    async () => {
      await assert.rejects(
        () => callMethod(CREDS, "sendMessage", {}),
        (err: unknown) => {
          assert.ok(err instanceof TelegramApiError)
          assert.equal(err.migrateToChatId, -1009)
          return true
        }
      )
    }
  )
})

test("callMethodMultipart: builds FormData with file part", async () => {
  let form: FormData | undefined
  await withFetch(
    async (_url, init) => {
      form = init?.body as FormData
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 3 } }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    },
    async () => {
      const r = await callMethodMultipart<{ message_id: number }>(
        CREDS,
        "sendPhoto",
        { chat_id: "5", caption: "c" },
        [
          {
            field: "photo",
            filename: "x.jpg",
            buffer: Buffer.from([1, 2, 3]),
            contentType: "image/jpeg",
          },
        ]
      )
      assert.equal(r.message_id, 3)
      assert.ok(form instanceof FormData)
      assert.equal(form!.get("chat_id"), "5")
      assert.ok(form!.get("photo") instanceof Blob)
    }
  )
})
