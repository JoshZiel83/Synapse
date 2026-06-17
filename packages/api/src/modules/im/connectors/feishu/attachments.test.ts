/**
 * Tests for the Feishu attachment upload helpers.
 *
 * Pure logic — file_type derivation from mime/extension, and the outbound
 * upload path which reads bytes from our CAS by sha256. The byte read + Lark
 * SDK upload calls are exercised through an injected `readBytes` seam + fake
 * Lark client objects, so the test stays exit-clean (no FS / DB).
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
    feishuFileTypeFor({ mimeType: "application/pdf", name: "x.bin" }),
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
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
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

const reads = (bytes: Uint8Array) => async () => Buffer.from(bytes)

test("uploadFeishuImage: requires sha256 on the fileRef", async () => {
  await assert.rejects(
    uploadFeishuImage({
      client: fakeClient({ imageKey: "img_v1" }),
      fileRef: { mimeType: "image/png" },
      readBytes: reads(new Uint8Array([1])),
    }),
    /requires a CanonicalFileRef\.sha256/
  )
})

test("uploadFeishuImage: reads CAS by sha256 then calls im.image.create with the buffer", async () => {
  const calls: any[] = []
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
  const seen: string[] = []
  const key = await uploadFeishuImage({
    client: fakeClient({ imageKey: "img_v3_xyz", recordImage: calls }),
    fileRef: { sha256: "abc123" },
    readBytes: async (sha) => {
      seen.push(sha)
      return Buffer.from(bytes)
    },
  })
  assert.equal(key, "img_v3_xyz")
  assert.deepEqual(seen, ["abc123"])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].data.image_type, "message")
  assert.ok(Buffer.isBuffer(calls[0].data.image))
  assert.equal(calls[0].data.image.length, bytes.length)
})

test("uploadFeishuImage: throws when SDK returns no image_key", async () => {
  await assert.rejects(
    uploadFeishuImage({
      client: fakeClient({ imageKey: null }),
      fileRef: { sha256: "abc" },
      readBytes: reads(new Uint8Array([1, 2, 3])),
    }),
    /no image_key/
  )
})

test("uploadFeishuFile: reads by sha256 and passes file_name + derived file_type", async () => {
  const calls: any[] = []
  const bytes = new Uint8Array(Array.from({ length: 100 }, (_, i) => i))
  const key = await uploadFeishuFile({
    client: fakeClient({ fileKey: "file_v3_abc", recordFile: calls }),
    fileRef: { sha256: "pdfsha", name: "Q4 Report.pdf" },
    readBytes: reads(bytes),
  })
  assert.equal(key, "file_v3_abc")
  assert.equal(calls.length, 1)
  assert.equal(calls[0].data.file_type, "pdf")
  assert.equal(calls[0].data.file_name, "Q4 Report.pdf")
  assert.ok(Buffer.isBuffer(calls[0].data.file))
})

test("uploadFeishuFile: throws when SDK returns no file_key", async () => {
  await assert.rejects(
    uploadFeishuFile({
      client: fakeClient({ fileKey: null }),
      fileRef: { sha256: "s", name: "p.pdf" },
      readBytes: reads(new Uint8Array([1, 2])),
    }),
    /no file_key/
  )
})

test("uploadFeishuImage: rejects an image over the 10MB cap (declared sizeBytes, fail-fast)", async () => {
  let read = false
  await assert.rejects(
    uploadFeishuImage({
      client: fakeClient({ imageKey: "img" }),
      // 11MB declared — over the image cap (10MB) but under the file cap (30MB).
      fileRef: { sha256: "big", sizeBytes: 11 * 1024 * 1024 },
      readBytes: async () => {
        read = true
        return Buffer.alloc(0)
      },
    }),
    /exceeds 10485760 byte limit/
  )
  assert.equal(read, false, "must fail fast on sizeBytes before reading bytes")
})

test("uploadFeishuFile: accepts the same 11MB declared size (30MB file cap)", async () => {
  const key = await uploadFeishuFile({
    client: fakeClient({ fileKey: "file_ok" }),
    fileRef: { sha256: "big", name: "big.bin", sizeBytes: 11 * 1024 * 1024 },
    readBytes: reads(new Uint8Array([1, 2, 3])),
  })
  assert.equal(key, "file_ok")
})

test("uploadFeishuImage: rejects when the actual bytes exceed the cap", async () => {
  await assert.rejects(
    uploadFeishuImage({
      client: fakeClient({ imageKey: "img" }),
      fileRef: { sha256: "liar" }, // no declared size; actual bytes blow the cap
      readBytes: async () => Buffer.alloc(10 * 1024 * 1024 + 1),
    }),
    /exceeds 10485760 byte limit/
  )
})

test("uploadFeishuImage: empty body is rejected", async () => {
  await assert.rejects(
    uploadFeishuImage({
      client: fakeClient({ imageKey: "img" }),
      fileRef: { sha256: "empty" },
      readBytes: reads(new Uint8Array(0)),
    }),
    /is empty/
  )
})
