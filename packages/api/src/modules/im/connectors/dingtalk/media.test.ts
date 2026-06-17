import test from "node:test"
import assert from "node:assert/strict"
import {
  downloadDingtalkMessageFile,
  extensionOf,
  uploadDingtalkMedia,
} from "./media.js"
import { planDingtalkSends } from "./render.js"
import { sendDingtalkMessage } from "./outbound.js"
import { _resetDingtalkTokenCache } from "./client.js"
import { buildCanonicalMessage } from "../../messaging/canonical-message.js"

// ─────────── pure helpers ───────────

test("extensionOf: lowercased extension without dot", () => {
  assert.equal(extensionOf("Report.PDF"), "pdf")
  assert.equal(extensionOf("a.b.tar.gz"), "gz")
  assert.equal(extensionOf("noext"), "")
  assert.equal(extensionOf("trailing."), "")
  assert.equal(extensionOf(undefined), "")
})

test("planDingtalkSends: splits text + image + voice + file in order", () => {
  const msg = buildCanonicalMessage([
    { type: "text", text: "hello" },
    { type: "image", fileRef: { sha256: "a".repeat(64) } },
    { type: "voice", fileRef: { sha256: "b".repeat(64) }, durationMs: 1500 },
    { type: "file", fileRef: { sha256: "c".repeat(64), name: "doc.pdf" } },
  ])
  const plan = planDingtalkSends(msg)
  assert.deepEqual(
    plan.map((p) => p.kind),
    ["text", "image", "voice", "file"]
  )
  const voice = plan.find((p) => p.kind === "voice")!
  assert.equal((voice as { durationMs?: number }).durationMs, 1500)
})

test("planDingtalkSends: media-only message emits no empty text send", () => {
  const msg = buildCanonicalMessage([
    { type: "image", fileRef: { sha256: "a".repeat(64) } },
  ])
  const plan = planDingtalkSends(msg)
  assert.deepEqual(
    plan.map((p) => p.kind),
    ["image"]
  )
})

test("planDingtalkSends: text-only message emits a single text send", () => {
  const msg = buildCanonicalMessage([{ type: "text", text: "hi" }])
  const plan = planDingtalkSends(msg)
  assert.deepEqual(
    plan.map((p) => p.kind),
    ["text"]
  )
})

// ─────────── upload / download units (fetchImpl seam) ───────────

test("uploadDingtalkMedia: posts multipart to /media/upload and returns raw media_id (keeps @)", async () => {
  let seenUrl = ""
  let seenBodyIsFormData = false
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    seenUrl = String(url)
    seenBodyIsFormData =
      typeof FormData !== "undefined" && init?.body instanceof FormData
    return new Response(JSON.stringify({ errcode: 0, media_id: "@lADOabc" }), {
      status: 200,
    })
  }) as unknown as typeof fetch

  const mediaId = await uploadDingtalkMedia({
    oapiToken: "OAPITKN",
    type: "image",
    buffer: Buffer.from("pngbytes"),
    filename: "x.png",
    mime: "image/png",
    fetchImpl,
  })
  assert.equal(mediaId, "@lADOabc") // leading @ preserved
  assert.match(seenUrl, /oapi\.dingtalk\.com\/media\/upload/)
  assert.match(seenUrl, /access_token=OAPITKN/)
  assert.match(seenUrl, /type=image/)
  assert.equal(seenBodyIsFormData, true)
})

test("uploadDingtalkMedia: throws when response has no media_id", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ errcode: 40004, errmsg: "bad" }), {
      status: 200,
    })) as unknown as typeof fetch
  await assert.rejects(
    uploadDingtalkMedia({
      oapiToken: "T",
      type: "file",
      buffer: Buffer.from("x"),
      filename: "f",
      fetchImpl,
    }),
    /no media_id/
  )
})

test("uploadDingtalkMedia: rejects an over-cap buffer before any network call", async () => {
  let called = false
  const fetchImpl = (async () => {
    called = true
    return new Response("{}", { status: 200 })
  }) as unknown as typeof fetch
  await assert.rejects(
    uploadDingtalkMedia({
      oapiToken: "T",
      type: "image",
      buffer: Buffer.alloc(11 * 1024 * 1024),
      filename: "big.png",
      fetchImpl,
    }),
    /local cap/
  )
  assert.equal(called, false)
})

test("downloadDingtalkMessageFile: two-step download (messageFiles/download → GET) returns bytes", async () => {
  const calls: string[] = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push(String(url))
    if (String(url).includes("messageFiles/download")) {
      const body = JSON.parse(String(init?.body))
      assert.equal(body.robotCode, "robot-1")
      assert.equal(body.downloadCode, "DC123")
      assert.equal(
        (init?.headers as Record<string, string>)[
          "x-acs-dingtalk-access-token"
        ],
        "TKN"
      )
      return new Response(
        JSON.stringify({ downloadUrl: "https://down.example/blob" }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    }
    // Step 2: pre-signed GET — must NOT carry the auth header.
    assert.equal(
      (init?.headers as Record<string, string> | undefined)?.[
        "x-acs-dingtalk-access-token"
      ],
      undefined
    )
    return new Response(Buffer.from("IMGDATA"), {
      status: 200,
      headers: { "content-type": "image/png" },
    })
  }) as unknown as typeof fetch

  const { buffer, mime } = await downloadDingtalkMessageFile({
    accessToken: "TKN",
    robotCode: "robot-1",
    downloadCode: "DC123",
    fetchImpl,
  })
  assert.equal(buffer.toString(), "IMGDATA")
  assert.equal(mime, "image/png")
  assert.equal(calls.length, 2)
  assert.match(
    calls[0],
    /api\.dingtalk\.com\/v1\.0\/robot\/messageFiles\/download/
  )
  assert.equal(calls[1], "https://down.example/blob")
})

test("downloadDingtalkMessageFile: throws when downloadUrl missing", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ errcode: 404 }), {
      status: 200,
    })) as unknown as typeof fetch
  await assert.rejects(
    downloadDingtalkMessageFile({
      accessToken: "T",
      robotCode: "r",
      downloadCode: "DC",
      fetchImpl,
    }),
    /no downloadUrl/
  )
})

// ─────────── outbound media send (global fetch mock) ───────────

interface MockCall {
  kind: string
  url: string
  body: unknown
}

function classify(url: string): string {
  if (url.includes("oapi.dingtalk.com/gettoken")) return "oapitoken"
  if (url.includes("/v1.0/oauth2/accessToken")) return "token"
  if (url.includes("oapi.dingtalk.com/media/upload")) return "upload"
  if (url.includes("/robot/groupMessages/send")) return "group"
  if (url.includes("/robot/oToMessages/batchSend")) return "direct"
  return "unknown"
}

function installMediaFetchMock() {
  const calls: MockCall[] = []
  const previous = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const kind = classify(url)
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : init?.body
    calls.push({ kind, url, body })
    switch (kind) {
      case "oapitoken":
        return new Response(
          JSON.stringify({
            errcode: 0,
            access_token: "OAPITKN",
            expires_in: 7200,
          })
        )
      case "token":
        return new Response(
          JSON.stringify({ accessToken: "TKN", expireIn: 7200 })
        )
      case "upload":
        return new Response(JSON.stringify({ errcode: 0, media_id: "@MEDIA1" }))
      case "group":
        return new Response(JSON.stringify({ processQueryKey: "pqk-g" }))
      case "direct":
        return new Response(JSON.stringify({ processQueryKey: "pqk-d" }))
      default:
        throw new Error(`unmocked URL ${url}`)
    }
  }) as typeof fetch
  return {
    calls,
    restore: () => {
      globalThis.fetch = previous
      _resetDingtalkTokenCache()
    },
  }
}

const ACCOUNT = {
  id: "acc-1",
  workspaceId: "ws-1",
  transportKind: "dingtalk",
  credentials: { clientId: "ding-1", clientSecret: "secret-1" },
} as never

function groupEndpoint(meta: Record<string, unknown> = {}) {
  return {
    endpointType: "group" as const,
    externalId: "cid-group-1",
    metadata: { robotCode: "robot-1", ...meta },
  }
}

test("outbound image: uploads (type=image) then sends sampleImageMsg{photoURL:@mediaId} via group OpenAPI", async () => {
  const mock = installMediaFetchMock()
  try {
    const msg = buildCanonicalMessage([
      {
        type: "image",
        fileRef: {
          sha256: "a".repeat(64),
          mimeType: "image/png",
          name: "x.png",
        },
      },
    ])
    const r = await sendDingtalkMessage({
      account: ACCOUNT,
      endpoint: groupEndpoint(),
      message: msg,
      readBytes: async () => Buffer.from("PNGBYTES"),
    })
    assert.equal(r.externalMessageId, "pqk-g")
    const kinds = mock.calls.map((c) => c.kind)
    // legacy token for upload, the upload, v1 token for send, the group send
    assert.deepEqual(kinds, ["oapitoken", "upload", "token", "group"])
    const upload = mock.calls.find((c) => c.kind === "upload")!
    assert.match(upload.url, /type=image/)
    assert.match(upload.url, /access_token=OAPITKN/)
    const group = mock.calls.find((c) => c.kind === "group")!
    const b = group.body as {
      msgKey: string
      msgParam: string
      robotCode: string
    }
    assert.equal(b.msgKey, "sampleImageMsg")
    assert.deepEqual(JSON.parse(b.msgParam), { photoURL: "@MEDIA1" })
    assert.equal(b.robotCode, "robot-1")
  } finally {
    mock.restore()
  }
})

test("outbound file: sends sampleFile{mediaId,fileName,fileType} with extension-derived fileType", async () => {
  const mock = installMediaFetchMock()
  try {
    const msg = buildCanonicalMessage([
      { type: "file", fileRef: { sha256: "c".repeat(64), name: "报表.xlsx" } },
    ])
    await sendDingtalkMessage({
      account: ACCOUNT,
      endpoint: groupEndpoint(),
      message: msg,
      readBytes: async () => Buffer.from("XLSXBYTES"),
    })
    const upload = mock.calls.find((c) => c.kind === "upload")!
    assert.match(upload.url, /type=file/)
    const group = mock.calls.find((c) => c.kind === "group")!
    const b = group.body as { msgKey: string; msgParam: string }
    assert.equal(b.msgKey, "sampleFile")
    assert.deepEqual(JSON.parse(b.msgParam), {
      mediaId: "@MEDIA1",
      fileName: "报表.xlsx",
      fileType: "xlsx",
    })
  } finally {
    mock.restore()
  }
})

test("outbound voice: uploads type=voice and sends sampleAudio{mediaId,duration(ms)}", async () => {
  const mock = installMediaFetchMock()
  try {
    const msg = buildCanonicalMessage([
      { type: "voice", fileRef: { sha256: "b".repeat(64) }, durationMs: 3200 },
    ])
    await sendDingtalkMessage({
      account: ACCOUNT,
      endpoint: groupEndpoint(),
      message: msg,
      readBytes: async () => Buffer.from("AMRBYTES"),
    })
    const upload = mock.calls.find((c) => c.kind === "upload")!
    assert.match(upload.url, /type=voice/)
    const group = mock.calls.find((c) => c.kind === "group")!
    const b = group.body as { msgKey: string; msgParam: string }
    assert.equal(b.msgKey, "sampleAudio")
    assert.deepEqual(JSON.parse(b.msgParam), {
      mediaId: "@MEDIA1",
      duration: "3200",
    })
  } finally {
    mock.restore()
  }
})

test("outbound media: missing sha256 fileRef throws before any upload", async () => {
  const mock = installMediaFetchMock()
  try {
    const msg = buildCanonicalMessage([
      { type: "image", fileRef: { mimeType: "image/png" } },
    ])
    await assert.rejects(
      sendDingtalkMessage({
        account: ACCOUNT,
        endpoint: groupEndpoint(),
        message: msg,
        readBytes: async () => Buffer.from("x"),
      }),
      /requires a CanonicalFileRef\.sha256/
    )
    assert.equal(
      mock.calls.find((c) => c.kind === "upload"),
      undefined
    )
  } finally {
    mock.restore()
  }
})
