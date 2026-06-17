/**
 * Tests for the Feishu attachment upload helpers.
 *
 * Pure logic — file_type derivation from mime/extension, error paths
 * when the CanonicalFileRef lacks a fetchable url. The actual HTTP
 * fetch + Lark SDK upload calls are exercised through fake fetch +
 * fake Lark client objects so the test stays exit-clean.
 */

import test from "node:test"
import assert from "node:assert/strict"
import {
  feishuFileTypeFor,
  uploadFeishuFile,
  uploadFeishuImage,
} from "./attachments.js"

// ───────────────────────── feishuFileTypeFor ─────────────────────────

test("feishuFileTypeFor: pdf detected by mime", () => {
  assert.equal(
    feishuFileTypeFor({ mime: "application/pdf", name: "x.bin" }),
    "pdf"
  )
})

test("feishuFileTypeFor: pdf detected by extension when mime absent", () => {
  assert.equal(feishuFileTypeFor({ name: "report.pdf" }), "pdf")
})

test("feishuFileTypeFor: docx maps to doc bucket", () => {
  assert.equal(feishuFileTypeFor({ name: "spec.docx" }), "doc")
  assert.equal(
    feishuFileTypeFor({
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      name: "x.bin",
    }),
    "doc"
  )
})

test("feishuFileTypeFor: xlsx maps to xls bucket", () => {
  assert.equal(feishuFileTypeFor({ name: "sheet.xlsx" }), "xls")
})

test("feishuFileTypeFor: pptx maps to ppt bucket", () => {
  assert.equal(feishuFileTypeFor({ name: "deck.pptx" }), "ppt")
})

test("feishuFileTypeFor: mp4 detected", () => {
  assert.equal(feishuFileTypeFor({ name: "clip.mp4" }), "mp4")
})

test("feishuFileTypeFor: unknown falls back to stream", () => {
  assert.equal(feishuFileTypeFor({ name: "blob.bin" }), "stream")
  assert.equal(feishuFileTypeFor({}), "stream")
})

// ───────────────────────── uploadFeishuImage / uploadFeishuFile ─────────────────────────

function fakeClient(opts: {
  imageKey?: string | null
  fileKey?: string | null
  recordImage?: any[]
  recordFile?: any[]
}) {
  return {
    im: {
      image: {
        create: async (payload: any) => {
          opts.recordImage?.push(payload)
          if (opts.imageKey === null) return null
          if (opts.imageKey === undefined) return {}
          return { image_key: opts.imageKey }
        },
      },
      file: {
        create: async (payload: any) => {
          opts.recordFile?.push(payload)
          if (opts.fileKey === null) return null
          if (opts.fileKey === undefined) return {}
          return { file_key: opts.fileKey }
        },
      },
    },
  } as any
}

function withFakeFetch<T>(
  bodyBytes: Uint8Array,
  contentType: string,
  fn: () => Promise<T>
): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(bodyBytes, {
      status: 200,
      headers: { "content-type": contentType },
    })
  return fn().finally(() => {
    globalThis.fetch = original
  })
}

test("uploadFeishuImage: requires url on the fileRef", async () => {
  await assert.rejects(
    uploadFeishuImage({
      client: fakeClient({ imageKey: "img_v1" }),
      fileRef: { mime: "image/png" },
    }),
    /requires a CanonicalFileRef\.url/
  )
})

test("uploadFeishuImage: downloads then calls im.image.create with the buffer", async () => {
  const calls: any[] = []
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
  const key = await withFakeFetch(bytes, "image/png", () =>
    uploadFeishuImage({
      client: fakeClient({ imageKey: "img_v3_xyz", recordImage: calls }),
      fileRef: { url: "https://x/p.png" },
    })
  )
  assert.equal(key, "img_v3_xyz")
  assert.equal(calls.length, 1)
  assert.equal(calls[0].data.image_type, "message")
  assert.ok(Buffer.isBuffer(calls[0].data.image))
  assert.equal(calls[0].data.image.length, bytes.length)
})

test("uploadFeishuImage: throws when SDK returns no image_key", async () => {
  await withFakeFetch(new Uint8Array([1, 2, 3]), "image/png", async () => {
    await assert.rejects(
      uploadFeishuImage({
        client: fakeClient({ imageKey: null }),
        fileRef: { url: "https://x/p.png" },
      }),
      /no image_key/
    )
  })
})

test("uploadFeishuFile: requires url and passes file_name + derived file_type", async () => {
  const calls: any[] = []
  const bytes = new Uint8Array(Array.from({ length: 100 }, (_, i) => i))
  const key = await withFakeFetch(bytes, "application/pdf", () =>
    uploadFeishuFile({
      client: fakeClient({ fileKey: "file_v3_abc", recordFile: calls }),
      fileRef: { url: "https://x/q4.pdf", name: "Q4 Report.pdf" },
    })
  )
  assert.equal(key, "file_v3_abc")
  assert.equal(calls.length, 1)
  assert.equal(calls[0].data.file_type, "pdf")
  assert.equal(calls[0].data.file_name, "Q4 Report.pdf")
  assert.ok(Buffer.isBuffer(calls[0].data.file))
})

test("uploadFeishuFile: throws when SDK returns no file_key", async () => {
  await withFakeFetch(new Uint8Array([1, 2]), "application/pdf", async () => {
    await assert.rejects(
      uploadFeishuFile({
        client: fakeClient({ fileKey: null }),
        fileRef: { url: "https://x/p.pdf", name: "p.pdf" },
      }),
      /no file_key/
    )
  })
})

function withFakeFetchHeaders<T>(
  contentLength: number,
  bodyBytes: Uint8Array,
  fn: () => Promise<T>
): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = (async () => ({
    ok: true,
    headers: {
      get: (k: string) =>
        k.toLowerCase() === "content-length"
          ? String(contentLength)
          : "application/octet-stream",
    },
    body: new Response(bodyBytes).body,
  })) as unknown as typeof fetch
  return fn().finally(() => {
    globalThis.fetch = original
  })
}

test("uploadFeishuImage: rejects an image over the 10MB image cap", async () => {
  // 11MB declared — over the image cap (10MB) but under the file cap (30MB).
  await withFakeFetchHeaders(11 * 1024 * 1024, new Uint8Array([1, 2, 3]), () =>
    assert.rejects(
      uploadFeishuImage({
        client: fakeClient({ imageKey: "img" }),
        fileRef: { url: "https://x/big.png" },
      }),
      /exceeds 10485760 byte limit/
    )
  )
})

test("uploadFeishuFile: accepts the same 11MB declared size (30MB file cap)", async () => {
  const key = await withFakeFetchHeaders(
    11 * 1024 * 1024,
    new Uint8Array([1, 2, 3]),
    () =>
      uploadFeishuFile({
        client: fakeClient({ fileKey: "file_ok" }),
        fileRef: { url: "https://x/big.bin", name: "big.bin" },
      })
  )
  assert.equal(key, "file_ok")
})

test("uploadFeishuImage: empty download body is rejected", async () => {
  await withFakeFetch(new Uint8Array(0), "image/png", async () => {
    await assert.rejects(
      uploadFeishuImage({
        client: fakeClient({ imageKey: "img" }),
        fileRef: { url: "https://x/p.png" },
      }),
      /is empty/
    )
  })
})
