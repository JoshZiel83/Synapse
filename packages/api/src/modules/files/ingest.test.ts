// Unit tests for the unified tool-output ingest funnel.
//
// Storage is dependency-injected via IngestContext.storage so these tests
// don't touch disk/DB.
import test from "node:test"
import assert from "node:assert/strict"

import { ingestToolOutput } from "./ingest.js"
import type { CanonicalContentBlock, ToolResultOrigin } from "@synapse/shared"

const PNG_1X1_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="

let saveBase64Calls: any[] = []
let saveUrlCalls: any[] = []

function makeStorage() {
  saveBase64Calls = []
  saveUrlCalls = []
  return {
    saveFromBase64: async (
      base64: string,
      originalName: string,
      mimeType: string,
      workspaceId: string | null,
      uploaderUserId: string | null,
      origin: any
    ) => {
      saveBase64Calls.push({
        base64,
        originalName,
        mimeType,
        workspaceId,
        uploaderUserId,
        origin,
      })
      return {
        id: "stub-file-" + saveBase64Calls.length,
        workspaceId: workspaceId || "ws",
        originalName,
        storedName: `2025/01/01/${originalName}`,
        mimeType,
        sizeBytes: Buffer.from(base64, "base64").length,
        sha256: "x".repeat(64),
        backend: "local_fs",
        storageKey: `2025/01/01/${originalName}`,
      } as any
    },
    saveFromUrl: async (
      url: string,
      workspaceId: string | null,
      uploaderUserId: string | null,
      originalName: string | undefined,
      origin: any
    ) => {
      saveUrlCalls.push({
        url,
        workspaceId,
        uploaderUserId,
        originalName,
        origin,
      })
      return {
        id: "stub-url-file",
        workspaceId: workspaceId || "ws",
        originalName: originalName || "downloaded.bin",
        storedName: `2025/01/01/${originalName || "downloaded.bin"}`,
        mimeType: "image/png",
        sizeBytes: 64,
        sha256: "y".repeat(64),
        backend: "local_fs",
        storageKey: `2025/01/01/url`,
      } as any
    },
    toFileRefBlock: (rec: any): CanonicalContentBlock => ({
      type: "file_ref",
      id: `block-${rec.id}`,
      sha256: rec.sha256,
      mimeType: rec.mimeType,
      name: rec.originalName,
      sizeBytes: rec.sizeBytes,
      category: rec.mimeType.startsWith("image/")
        ? "image"
        : rec.mimeType.startsWith("audio/")
          ? "audio"
          : rec.mimeType.startsWith("video/")
            ? "video"
            : "document",
    }),
  }
}

const TEST_ORIGIN: ToolResultOrigin = {
  kind: "mcp_remote",
  serverKey: "test-server",
}

test("string input → single text block", async () => {
  const result = await ingestToolOutput("hello world", {
    workspaceId: "ws",
    origin: TEST_ORIGIN,
    storage: makeStorage(),
  })
  assert.equal(result.length, 1)
  assert.equal(result[0].type, "text")
  assert.equal((result[0] as any).text, "hello world")
})

test("text block passes through", async () => {
  const result = await ingestToolOutput([{ type: "text", text: "hello" }], {
    workspaceId: "ws",
    origin: TEST_ORIGIN,
    storage: makeStorage(),
  })
  assert.equal(result.length, 1)
  assert.equal((result[0] as any).text, "hello")
})

test("MCP-standard image {data, mimeType} → file_ref via saveFromBase64", async () => {
  const storage = makeStorage()
  const result = await ingestToolOutput(
    [{ type: "image", data: PNG_1X1_B64, mimeType: "image/png" }],
    { workspaceId: "ws", origin: TEST_ORIGIN, storage }
  )
  assert.equal(result[0].type, "file_ref")
  assert.equal(saveBase64Calls.length, 1)
  assert.equal(saveBase64Calls[0].mimeType, "image/png")
  assert.equal(saveBase64Calls[0].workspaceId, "ws")
})

test("Anthropic-style image source.base64 → file_ref", async () => {
  const storage = makeStorage()
  const result = await ingestToolOutput(
    [
      {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: PNG_1X1_B64 },
      },
    ],
    { workspaceId: "ws", origin: TEST_ORIGIN, storage }
  )
  assert.equal(result[0].type, "file_ref")
  assert.equal(saveBase64Calls[0].mimeType, "image/jpeg")
})

test("Anthropic-style image source.url → file_ref via saveFromUrl", async () => {
  const storage = makeStorage()
  const result = await ingestToolOutput(
    [
      {
        type: "image",
        source: { type: "url", url: "https://example.com/x.png" },
      },
    ],
    { workspaceId: "ws", origin: TEST_ORIGIN, storage }
  )
  assert.equal(result[0].type, "file_ref")
  assert.equal(saveUrlCalls.length, 1)
  assert.equal(saveUrlCalls[0].url, "https://example.com/x.png")
})

test("audio block → file_ref", async () => {
  const storage = makeStorage()
  const result = await ingestToolOutput(
    [{ type: "audio", data: "AAAA", mimeType: "audio/wav" }],
    { workspaceId: "ws", origin: TEST_ORIGIN, storage }
  )
  assert.equal(result[0].type, "file_ref")
  assert.equal(saveBase64Calls[0].mimeType, "audio/wav")
})

test("resource(text) → text block", async () => {
  const result = await ingestToolOutput(
    [
      {
        type: "resource",
        resource: {
          uri: "test://x",
          mimeType: "text/plain",
          text: "hello text",
        },
      },
    ],
    { workspaceId: "ws", origin: TEST_ORIGIN, storage: makeStorage() }
  )
  assert.equal(result[0].type, "text")
  assert.equal((result[0] as any).text, "hello text")
})

test("resource(blob) → file_ref preserving original name", async () => {
  const storage = makeStorage()
  const result = await ingestToolOutput(
    [
      {
        type: "resource",
        resource: {
          uri: "test://x.png",
          mimeType: "image/png",
          name: "alpha.png",
          blob: PNG_1X1_B64,
        },
      },
    ],
    { workspaceId: "ws", origin: TEST_ORIGIN, storage }
  )
  assert.equal(result[0].type, "file_ref")
  assert.equal((result[0] as any).name, "alpha.png")
})

test("resource with only uri → text block of uri", async () => {
  const result = await ingestToolOutput(
    [{ type: "resource", resource: { uri: "test://foo" } }],
    { workspaceId: "ws", origin: TEST_ORIGIN, storage: makeStorage() }
  )
  assert.equal(result[0].type, "text")
  assert.equal((result[0] as any).text, "test://foo")
})

test("pre-canonical file_ref passes through normalizer", async () => {
  const result = await ingestToolOutput(
    [
      {
        type: "file_ref",
        sha256: "a".repeat(64),
        path: "/conversation/report.pdf",
        mimeType: "application/pdf",
        name: "report.pdf",
        sizeBytes: 1024,
        category: "document",
      },
    ],
    { workspaceId: "ws", origin: TEST_ORIGIN, storage: makeStorage() }
  )
  assert.equal(result.length, 1)
  assert.equal(result[0].type, "file_ref")
  assert.equal((result[0] as any).sha256, "a".repeat(64))
})

test("mixed content preserves order", async () => {
  const result = await ingestToolOutput(
    [
      { type: "text", text: "Header" },
      { type: "image", data: PNG_1X1_B64, mimeType: "image/png" },
      { type: "text", text: "Footer" },
    ],
    { workspaceId: "ws", origin: TEST_ORIGIN, storage: makeStorage() }
  )
  assert.equal(result.length, 3)
  assert.equal(result[0].type, "text")
  assert.equal(result[1].type, "file_ref")
  assert.equal((result[2] as any).text, "Footer")
})

test("unknown block type → JSON-stringified text fallback", async () => {
  const result = await ingestToolOutput(
    [{ type: "weird", payload: { foo: 1 } }],
    { workspaceId: "ws", origin: TEST_ORIGIN, storage: makeStorage() }
  )
  assert.equal(result[0].type, "text")
  assert.match((result[0] as any).text, /"weird"/)
})

test("missing image data → text fallback noting missing data", async () => {
  const result = await ingestToolOutput([{ type: "image", note: "no data" }], {
    workspaceId: "ws",
    origin: TEST_ORIGIN,
    storage: makeStorage(),
  })
  assert.equal(result[0].type, "text")
  assert.match((result[0] as any).text, /missing data/)
})

test("non-object array items become text via String()", async () => {
  const result = await ingestToolOutput(["raw string", 42 as any], {
    workspaceId: "ws",
    origin: TEST_ORIGIN,
    storage: makeStorage(),
  })
  assert.equal(result.length, 2)
  assert.equal((result[0] as any).text, "raw string")
  assert.equal((result[1] as any).text, "42")
})

test("storage receives our ToolResultOrigin via origin.details.originKind", async () => {
  const storage = makeStorage()
  await ingestToolOutput(
    [{ type: "image", data: PNG_1X1_B64, mimeType: "image/png" }],
    {
      workspaceId: "ws",
      origin: {
        kind: "mcp_device",
        deviceId: "dev-1",
        exposureStableKey: "synapse.builtin.filesystem.v1",
      },
      storage,
    }
  )
  assert.equal(saveBase64Calls.length, 1)
  assert.equal(saveBase64Calls[0].origin.family, "tool_output")
  assert.equal(saveBase64Calls[0].origin.details.originKind, "mcp_device")
  assert.equal(saveBase64Calls[0].origin.details.deviceId, "dev-1")
})

test("model_response origin routes to model_output family", async () => {
  const storage = makeStorage()
  await ingestToolOutput(
    [{ type: "image", data: PNG_1X1_B64, mimeType: "image/png" }],
    {
      workspaceId: "ws",
      origin: { kind: "model_response", providerType: "anthropic" },
      storage,
    }
  )
  assert.equal(saveBase64Calls[0].origin.family, "model_output")
  assert.equal(saveBase64Calls[0].origin.providerKey, "anthropic")
})

test("binaryMetadata is merged into origin.details", async () => {
  const storage = makeStorage()
  await ingestToolOutput(
    [{ type: "image", data: PNG_1X1_B64, mimeType: "image/png" }],
    {
      workspaceId: "ws",
      origin: { kind: "mcp_remote", serverKey: "test-server" },
      binaryMetadata: { taskId: "task-123" },
      storage,
    }
  )
  assert.equal(saveBase64Calls[0].origin.details.taskId, "task-123")
})

test("resource(blob) merges resource.metadata into origin.details", async () => {
  const storage = makeStorage()
  await ingestToolOutput(
    [
      {
        type: "resource",
        resource: {
          mimeType: "image/jpeg",
          blob: PNG_1X1_B64,
          metadata: { chartId: "alpha" },
        },
      },
    ],
    {
      workspaceId: "ws",
      origin: { kind: "mcp_remote", serverKey: "test-server" },
      storage,
    }
  )
  assert.equal(saveBase64Calls[0].origin.details.chartId, "alpha")
})
