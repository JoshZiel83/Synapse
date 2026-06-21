import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, promises as fsp } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createFilesystemBuiltin,
  type FilesystemBuiltinOptions,
} from "./filesystem.js"
import { assertIsoInstantString } from "@synapse/device-protocol/instant"
import type { FsHelperClient } from "./fs-helper-client.js"
import type {
  HistoryGetResult,
  HistoryDiffResult,
  HistoryRestoreResult,
  IndexStatusResult,
  IndexRebuildResult,
  SearchContentResult,
  SearchPathResult,
} from "./fs-helper-types.js"

interface FakeHistoryRow {
  version: number
  path: string
  prior_exists: boolean
  prior_sha256: string | null
  prior_size: number
  prior_mtime_ms: number | null
  op: string
}

function boundaryUnder(path: string, prefix: string): boolean {
  if (prefix === "/") return true
  if (path === prefix) return true
  return path.startsWith(`${prefix}/`)
}

function makeFakeHelper() {
  const history: FakeHistoryRow[] = []
  let versionSeq = 0
  const indexUpsertCalls: string[] = []
  const indexRemoveCalls: string[] = []
  const helper = {
    isAvailable: () => true,
    stop: async () => {},
    historyGet: async ({
      path,
      version,
    }: {
      path: string
      version: number
    }) => {
      const row = history.find((r) => r.path === path && r.version === version)
      if (!row) throw new Error("-32004: cross-path or unknown version")
      return {
        prior_exists: row.prior_exists,
        size: row.prior_size,
        sha256: row.prior_sha256,
        mtime_ms: row.prior_mtime_ms,
        op: row.op as HistoryGetResult["op"],
        recorded_at: new Date().toISOString(),
      }
    },
    historySnapshot: async (input: {
      path: string
      prior_exists: boolean
      expected_sha256?: string | null
      prior_size: number
      prior_mtime_ms: number | null
      op: "pre_write" | "pre_edit" | "pre_restore"
    }) => {
      versionSeq += 1
      // For content-bearing rows, derive a recorded sha from synthetic bytes
      // we can also return from restore. This keeps history.get and
      // history.restore aligned (real sidecar guarantees this by reading
      // the same blob both times).
      let recordedSha: string | null = null
      if (input.prior_exists) {
        const cryptoMod = await import("node:crypto")
        const bytes = Buffer.from(`fake-restored-${versionSeq}`, "utf8")
        recordedSha = cryptoMod.createHash("sha256").update(bytes).digest("hex")
      }
      history.push({
        version: versionSeq,
        path: input.path,
        prior_exists: input.prior_exists,
        prior_sha256: recordedSha,
        prior_size: input.prior_size,
        prior_mtime_ms: input.prior_mtime_ms,
        op: input.op,
      })
      return { version: versionSeq, blob_dedup: false }
    },
    historySnapshotDelete: async (input: {
      path: string
      prior_exists: boolean
      expected_sha256?: string | null
      prior_size: number
      prior_mtime_ms: number | null
    }) => {
      versionSeq += 1
      history.push({
        version: versionSeq,
        path: input.path,
        prior_exists: input.prior_exists,
        prior_sha256: input.expected_sha256 ?? null,
        prior_size: input.prior_size,
        prior_mtime_ms: input.prior_mtime_ms,
        op: "delete",
      })
      return { version: versionSeq, blob_dedup: false }
    },
    historyList: async ({
      path,
      allowed_path_prefixes,
      limit,
      offset,
    }: {
      path?: string
      allowed_path_prefixes?: string[]
      limit?: number
      offset?: number
    }) => {
      let rows = history.slice()
      if (path) rows = rows.filter((r) => r.path === path)
      if (allowed_path_prefixes && allowed_path_prefixes.length > 0) {
        rows = rows.filter((r) =>
          allowed_path_prefixes.some((p) => boundaryUnder(r.path, p))
        )
      }
      const o = offset ?? 0
      const l = limit ?? 50
      const entries = rows.slice(o, o + l).map((r) => ({
        version: r.version,
        path: r.path,
        op: r.op,
        prior_exists: r.prior_exists,
        size: r.prior_size,
        sha256: r.prior_sha256,
        mtime_ms: r.prior_mtime_ms,
        recorded_at: new Date().toISOString(),
      }))
      return { entries }
    },
    historyDiff: async ({
      path,
      version_a,
      version_b,
    }: {
      path: string
      version_a: number
      version_b: number
    }) => {
      const a = history.find((r) => r.path === path && r.version === version_a)
      const b = history.find((r) => r.path === path && r.version === version_b)
      if (!a || !b) throw new Error("-32004: cross-path version")
      return {
        is_text: true,
        unified: "diff body",
        meta_diff: { size_delta: b.prior_size - a.prior_size },
      } as HistoryDiffResult
    },
    historyRestore: async ({
      path,
      version,
    }: {
      path: string
      version: number
    }) => {
      const row = history.find((r) => r.path === path && r.version === version)
      if (!row) throw new Error("-32004: cross-path version")
      if (!row.prior_exists) return { mode: "delete" } as HistoryRestoreResult
      const synthetic = Buffer.from(`fake-restored-${row.version}`, "utf8")
      return {
        mode: "inline",
        content_b64: synthetic.toString("base64"),
        sha256: row.prior_sha256 ?? undefined,
        size: synthetic.length,
      } as HistoryRestoreResult
    },
    indexRebuild: async () => ({ task_id: "rebuild-1" }) as IndexRebuildResult,
    indexStatus: async ({ subtree }: { subtree?: string }) =>
      ({
        subtree: subtree ?? "/",
        last_indexed_at: null,
        doc_count: 0,
        queue_depth: 0,
        errors: { extract_failed: 0, watcher_starved: 0 },
      }) as IndexStatusResult,
    indexUpsert: async ({ path }: { path: string }) => {
      indexUpsertCalls.push(path)
    },
    indexRemove: async ({ path }: { path: string }) => {
      indexRemoveCalls.push(path)
    },
    searchContent: async () => ({ hits: [] }) as SearchContentResult,
    searchPath: async () => ({ hits: [] }) as SearchPathResult,
    extractText: async () => ({
      text: "",
      mime: "text/plain",
      truncated: false,
      source: "text" as const,
    }),
  }
  return {
    helper: helper as unknown as FsHelperClient,
    history,
    indexUpsertCalls,
    indexRemoveCalls,
  }
}

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "synapse-fs-builtin-"))
}
function freshWorkDir(): string {
  return mkdtempSync(join(tmpdir(), "synapse-fs-work-"))
}

function makeEnvelope(
  grants: Array<{ access: "read" | "write"; pathPrefixes: string[] }>
) {
  return {
    runtime_authorization: {
      grant_specs: grants.map((g) => ({
        capability: "filesystem" as const,
        filesystem: { access: g.access, path_prefixes: g.pathPrefixes },
      })),
    },
  } as never
}

async function makeBuiltin(opts: Partial<FilesystemBuiltinOptions> = {}) {
  const root = freshRoot()
  const work = freshWorkDir()
  const fake = makeFakeHelper()
  const trashed: string[] = []
  const builtin = createFilesystemBuiltin({
    rootPath: root,
    helperPath: "/usr/bin/true",
    helperWorkDir: work,
    enableWrite: true,
    enableDelete: true,
    enableHistory: true,
    enableIndex: false,
    enableLiveSearch: false,
    skipWorkDirAssertion: true,
    helperClientImpl: fake.helper,
    trashImpl: async (paths: string[]) => {
      trashed.push(...paths)
    },
    ...opts,
  })
  return {
    builtin,
    helper: fake.helper,
    history: fake.history,
    indexUpsertCalls: fake.indexUpsertCalls,
    indexRemoveCalls: fake.indexRemoveCalls,
    trashed,
    root,
    work,
    cleanup() {
      rmSync(root, { recursive: true, force: true })
      rmSync(work, { recursive: true, force: true })
    },
  }
}

function getMeta(r: { _meta?: unknown }): {
  synapse_error?: { code?: string; message?: string }
  [k: string]: unknown
} {
  return (r._meta ?? {}) as Record<string, unknown> as {
    synapse_error?: { code?: string; message?: string }
  }
}

// ─────────────────────────── catalog visibility ──────────────────────────────

test("enableWrite=false hides fs_write/fs_edit/fs_history_restore", async () => {
  const root = freshRoot()
  try {
    const b = createFilesystemBuiltin({
      rootPath: root,
      enableWrite: false,
      enableLiveSearch: false,
      enableIndex: false,
    })
    const ex = (await b.describeExposures())[0]!
    const names = ex.tools.map((t) => t.name)
    assert.ok(names.includes("list_dir"))
    assert.ok(names.includes("fs_read"))
    assert.ok(!names.includes("fs_write"))
    assert.ok(!names.includes("fs_edit"))
    assert.ok(!names.includes("fs_history_restore"))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("enableRead=false hides read tools and fs_edit but NOT fs_history_restore", async () => {
  const { builtin, cleanup } = await makeBuiltin({ enableRead: false })
  try {
    const ex = (await builtin.describeExposures())[0]!
    const names = ex.tools.map((t) => t.name)
    assert.ok(!names.includes("list_dir"))
    assert.ok(!names.includes("fs_stat"))
    assert.ok(!names.includes("fs_read"))
    assert.ok(!names.includes("fs_edit"))
    assert.ok(!names.includes("fs_history_list"))
    assert.ok(!names.includes("fs_history_diff"))
    assert.ok(names.includes("fs_history_restore"))
  } finally {
    cleanup()
  }
})

test("enableDelete=false hides fs_delete", async () => {
  const { builtin, cleanup } = await makeBuiltin({ enableDelete: false })
  try {
    const ex = (await builtin.describeExposures())[0]!
    assert.ok(!ex.tools.map((t) => t.name).includes("fs_delete"))
  } finally {
    cleanup()
  }
})

test("fs_history_restore hidden when helper unavailable", async () => {
  const root = freshRoot()
  try {
    const b = createFilesystemBuiltin({
      rootPath: root,
      enableWrite: true,
      enableHistory: true,
      enableLiveSearch: false,
      enableIndex: false,
    })
    const ex = (await b.describeExposures())[0]!
    assert.ok(!ex.tools.map((t) => t.name).includes("fs_history_restore"))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ─────────────────────────── grant_specs ─────────────────────────────────────

test("fs_write rejects when no grant covers the path", async () => {
  const { builtin, cleanup } = await makeBuiltin()
  try {
    const r = await builtin.invokeTool!({
      toolName: "fs_write",
      args: { path: "/foo", content: "x", encoding: "utf-8" },
      envelope: makeEnvelope([{ access: "write", pathPrefixes: ["/other"] }]),
    })
    assert.equal(r.isError, true)
    assert.equal(getMeta(r).synapse_error?.code, "permission_denied")
  } finally {
    cleanup()
  }
})

test("fs_write succeeds with covering write grant", async () => {
  const { builtin, root, cleanup } = await makeBuiltin()
  try {
    const r = await builtin.invokeTool!({
      toolName: "fs_write",
      args: { path: "/hello", content: "world", encoding: "utf-8" },
      envelope: makeEnvelope([{ access: "write", pathPrefixes: ["/"] }]),
    })
    assert.equal(r.isError, undefined)
    assert.equal((await fsp.readFile(join(root, "hello"))).toString(), "world")
  } finally {
    cleanup()
  }
})

test("fs_edit write-only grant succeeds (write implies read)", async () => {
  const { builtin, root, cleanup } = await makeBuiltin()
  try {
    writeFileSync(join(root, "f.txt"), "hello world")
    const r = await builtin.invokeTool!({
      toolName: "fs_edit",
      args: {
        path: "/f.txt",
        edits: [{ old_string: "world", new_string: "there" }],
      },
      envelope: makeEnvelope([{ access: "write", pathPrefixes: ["/"] }]),
    })
    assert.equal(r.isError, undefined, JSON.stringify(r._meta))
    assert.equal(
      (await fsp.readFile(join(root, "f.txt"))).toString(),
      "hello there"
    )
  } finally {
    cleanup()
  }
})

test("fs_edit read-only grant denied (no write capability)", async () => {
  const { builtin, root, cleanup } = await makeBuiltin()
  try {
    writeFileSync(join(root, "f.txt"), "x")
    const r = await builtin.invokeTool!({
      toolName: "fs_edit",
      args: { path: "/f.txt", edits: [{ old_string: "x", new_string: "y" }] },
      envelope: makeEnvelope([{ access: "read", pathPrefixes: ["/"] }]),
    })
    assert.equal(r.isError, true)
  } finally {
    cleanup()
  }
})

// ─────────────────────────── write size + base64 + utf8 ──────────────────────

test("fs_write rejects oversize utf-8 payload BEFORE any IO", async () => {
  const { builtin, cleanup } = await makeBuiltin({ maxWriteBytes: 16 })
  try {
    const r = await builtin.invokeTool!({
      toolName: "fs_write",
      args: { path: "/big", content: "x".repeat(64), encoding: "utf-8" },
      envelope: makeEnvelope([{ access: "write", pathPrefixes: ["/"] }]),
    })
    assert.equal(r.isError, true)
    assert.match(getMeta(r).synapse_error?.message ?? "", /write_too_large/)
  } finally {
    cleanup()
  }
})

test("fs_write base64 boundary: payload exactly at cap accepted", async () => {
  const { builtin, root, cleanup } = await makeBuiltin({ maxWriteBytes: 6 })
  try {
    // "aGVsbG8h" base64 = "hello!" = 6 bytes (at cap)
    const r = await builtin.invokeTool!({
      toolName: "fs_write",
      args: { path: "/atcap", content: "aGVsbG8h", encoding: "base64" },
      envelope: makeEnvelope([{ access: "write", pathPrefixes: ["/"] }]),
    })
    assert.equal(r.isError, undefined, JSON.stringify(r._meta))
    assert.equal((await fsp.readFile(join(root, "atcap"))).toString(), "hello!")
  } finally {
    cleanup()
  }
})

test("fs_write base64 oversize rejected", async () => {
  const { builtin, cleanup } = await makeBuiltin({ maxWriteBytes: 4 })
  try {
    const r = await builtin.invokeTool!({
      toolName: "fs_write",
      args: { path: "/big", content: "aGVsbG8h", encoding: "base64" }, // 6 bytes
      envelope: makeEnvelope([{ access: "write", pathPrefixes: ["/"] }]),
    })
    assert.equal(r.isError, true)
    assert.match(getMeta(r).synapse_error?.message ?? "", /write_too_large/)
  } finally {
    cleanup()
  }
})

test("fs_write base64 invalid alphabet rejected", async () => {
  const { builtin, cleanup } = await makeBuiltin()
  try {
    const r = await builtin.invokeTool!({
      toolName: "fs_write",
      args: { path: "/x", content: "not_base64!!", encoding: "base64" },
      envelope: makeEnvelope([{ access: "write", pathPrefixes: ["/"] }]),
    })
    assert.equal(r.isError, true)
    assert.match(getMeta(r).synapse_error?.message ?? "", /invalid_base64/)
  } finally {
    cleanup()
  }
})

test("fs_write base64 wrong length-mod-4 rejected", async () => {
  const { builtin, cleanup } = await makeBuiltin()
  try {
    const r = await builtin.invokeTool!({
      toolName: "fs_write",
      args: { path: "/x", content: "aGVsb", encoding: "base64" }, // 5 chars
      envelope: makeEnvelope([{ access: "write", pathPrefixes: ["/"] }]),
    })
    assert.equal(r.isError, true)
    assert.match(getMeta(r).synapse_error?.message ?? "", /invalid_base64/)
  } finally {
    cleanup()
  }
})

test("fs_edit rejects non-UTF-8 source", async () => {
  const { builtin, root, cleanup } = await makeBuiltin()
  try {
    // Write some clearly-invalid UTF-8 bytes.
    writeFileSync(join(root, "bin"), Buffer.from([0xff, 0xfe, 0x00, 0x01]))
    const r = await builtin.invokeTool!({
      toolName: "fs_edit",
      args: { path: "/bin", edits: [{ old_string: "a", new_string: "b" }] },
      envelope: makeEnvelope([{ access: "write", pathPrefixes: ["/"] }]),
    })
    assert.equal(r.isError, true)
    assert.match(getMeta(r).synapse_error?.message ?? "", /edit_not_utf8/)
  } finally {
    cleanup()
  }
})

test("fs_edit rejects empty old_string", async () => {
  const { builtin, root, cleanup } = await makeBuiltin()
  try {
    writeFileSync(join(root, "f"), "hello")
    const r = await builtin.invokeTool!({
      toolName: "fs_edit",
      args: { path: "/f", edits: [{ old_string: "", new_string: "x" }] },
      envelope: makeEnvelope([{ access: "write", pathPrefixes: ["/"] }]),
    })
    assert.equal(r.isError, true)
    assert.match(
      getMeta(r).synapse_error?.message ?? "",
      /edit_old_string_empty/
    )
  } finally {
    cleanup()
  }
})

test("fs_edit byte-vs-char projection catches multi-byte explosion", async () => {
  const { builtin, root, cleanup } = await makeBuiltin({ maxEditFileBytes: 32 })
  try {
    // 16 'a' chars (16 bytes); replace each with 'é' (2 bytes UTF-8) = 32 bytes;
    // adding one more replacement char would exceed cap. Use a tighter cap.
    writeFileSync(join(root, "f"), "a".repeat(20))
    const r = await builtin.invokeTool!({
      toolName: "fs_edit",
      args: {
        path: "/f",
        edits: [{ old_string: "a", new_string: "é", replace_all: true }],
      },
      envelope: makeEnvelope([{ access: "write", pathPrefixes: ["/"] }]),
    })
    assert.equal(r.isError, true)
    assert.match(
      getMeta(r).synapse_error?.message ?? "",
      /edit_result_too_large/
    )
    // file unchanged
    assert.equal(
      (await fsp.readFile(join(root, "f"))).toString(),
      "a".repeat(20)
    )
  } finally {
    cleanup()
  }
})

// ─────────────────────────── stale_write phases ──────────────────────────────

test("fs_write expected_sha256 mismatch returns stale_write_detected before snapshot", async () => {
  const { builtin, root, history, cleanup } = await makeBuiltin()
  try {
    writeFileSync(join(root, "f"), "v1")
    const beforeHistory = history.length
    const r = await builtin.invokeTool!({
      toolName: "fs_write",
      args: {
        path: "/f",
        content: "v2",
        encoding: "utf-8",
        expected_sha256: "0".repeat(64),
      },
      envelope: makeEnvelope([{ access: "write", pathPrefixes: ["/"] }]),
    })
    assert.equal(r.isError, true)
    assert.match(
      getMeta(r).synapse_error?.message ?? "",
      /stale_write_detected/
    )
    // No phantom history row.
    assert.equal(history.length, beforeHistory)
  } finally {
    cleanup()
  }
})

// ─────────────────────────── delete ──────────────────────────────────────────

test("fs_delete rejects directories with not_a_file", async () => {
  const { builtin, root, cleanup } = await makeBuiltin()
  try {
    const { mkdirSync } = await import("node:fs")
    mkdirSync(join(root, "dir"))
    const r = await builtin.invokeTool!({
      toolName: "fs_delete",
      args: { path: "/dir" },
      envelope: makeEnvelope([{ access: "write", pathPrefixes: ["/"] }]),
    })
    assert.equal(r.isError, true)
    assert.match(getMeta(r).synapse_error?.message ?? "", /not_a_file/)
  } finally {
    cleanup()
  }
})

test("fs_delete trash mode invokes trashImpl and snapshots history", async () => {
  const { builtin, root, history, trashed, cleanup } = await makeBuiltin()
  try {
    writeFileSync(join(root, "f"), "bye")
    const before = history.length
    const r = await builtin.invokeTool!({
      toolName: "fs_delete",
      args: { path: "/f", mode: "trash" },
      envelope: makeEnvelope([{ access: "write", pathPrefixes: ["/"] }]),
    })
    assert.equal(r.isError, undefined)

    assert.equal(trashed.length, 1)
    assert.ok(trashed[0]!.endsWith("/f"))
    assert.equal(history.length, before + 1)
    assert.equal(history[history.length - 1]!.op, "delete")
  } finally {
    cleanup()
  }
})

test("fs_delete trash falls back to history_only when trashImpl fails", async () => {
  const root = freshRoot()
  const work = freshWorkDir()
  const fake = makeFakeHelper()
  try {
    const builtin = createFilesystemBuiltin({
      rootPath: root,
      helperPath: "/usr/bin/true",
      helperWorkDir: work,
      enableWrite: true,
      enableDelete: true,
      enableHistory: true,
      enableLiveSearch: false,
      enableIndex: false,
      skipWorkDirAssertion: true,
      helperClientImpl: fake.helper,
      trashImpl: async () => {
        throw new Error("trash unavailable")
      },
    })
    writeFileSync(join(root, "g"), "x")
    const r = await builtin.invokeTool!({
      toolName: "fs_delete",
      args: { path: "/g" },
      envelope: makeEnvelope([{ access: "write", pathPrefixes: ["/"] }]),
    })
    assert.equal(r.isError, undefined, JSON.stringify(r._meta))
    const meta = r._meta as { trash_mode?: string }
    assert.equal(meta.trash_mode, "history_only")
    await assert.rejects(() => fsp.stat(join(root, "g")))
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
})

test("fs_delete permanent without history rejects permanent_delete_requires_history", async () => {
  const root = freshRoot()
  try {
    const b = createFilesystemBuiltin({
      rootPath: root,
      enableWrite: true,
      enableDelete: true,
      allowUnversionedWrite: true,
      enableLiveSearch: false,
      enableIndex: false,
    })
    writeFileSync(join(root, "f"), "x")
    const r = await b.invokeTool!({
      toolName: "fs_delete",
      args: { path: "/f", mode: "permanent" },
      envelope: makeEnvelope([{ access: "write", pathPrefixes: ["/"] }]),
    })
    assert.equal(r.isError, true)
    assert.match(
      getMeta(r).synapse_error?.message ?? "",
      /permanent_delete_requires_history/
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ─────────────────────────── history flow ────────────────────────────────────

test("fs_write seeds history; fs_history_list pushes down grant prefixes", async () => {
  const { builtin, cleanup } = await makeBuiltin()
  try {
    await builtin.invokeTool!({
      toolName: "fs_write",
      args: { path: "/a/x", content: "1", encoding: "utf-8" },
      envelope: makeEnvelope([{ access: "write", pathPrefixes: ["/"] }]),
    })
    await builtin.invokeTool!({
      toolName: "fs_write",
      args: { path: "/b/y", content: "2", encoding: "utf-8" },
      envelope: makeEnvelope([{ access: "write", pathPrefixes: ["/"] }]),
    })
    // History list with no path + only /a grant → only /a entries.
    const r = await builtin.invokeTool!({
      toolName: "fs_history_list",
      args: {},
      envelope: makeEnvelope([{ access: "read", pathPrefixes: ["/a"] }]),
    })
    assert.equal(r.isError, undefined)
    const body = JSON.parse((r.content[0] as { text: string }).text) as {
      entries: Array<{ path: string }>
    }
    assert.ok(body.entries.length > 0)
    assert.ok(body.entries.every((e) => e.path.startsWith("/a")))
  } finally {
    cleanup()
  }
})

test("fs_history_restore strips content_b64 / tmp_token / sha / size / mode from response", async () => {
  const { builtin, history, cleanup } = await makeBuiltin()
  try {
    // Seed a write so history has a content version.
    await builtin.invokeTool!({
      toolName: "fs_write",
      args: { path: "/f", content: "orig", encoding: "utf-8" },
      envelope: makeEnvelope([{ access: "write", pathPrefixes: ["/"] }]),
    })
    // Now overwrite to add a content-bearing version with prior_exists=true.
    await builtin.invokeTool!({
      toolName: "fs_write",
      args: { path: "/f", content: "next", encoding: "utf-8" },
      envelope: makeEnvelope([{ access: "write", pathPrefixes: ["/"] }]),
    })
    // The history snapshot for the second write has prior_exists=true.
    const ver = history.find(
      (h) => h.path === "/f" && h.prior_exists === true
    )!.version
    const r = await builtin.invokeTool!({
      toolName: "fs_history_restore",
      args: { path: "/f", version: ver },
      envelope: makeEnvelope([{ access: "write", pathPrefixes: ["/"] }]),
    })
    assert.equal(r.isError, undefined, JSON.stringify(r._meta))
    const body = JSON.parse((r.content[0] as { text: string }).text)
    assert.deepEqual(Object.keys(body).sort(), ["path", "restored", "version"])
    assert.equal(body.restored, true)
    assert.ok(!("content_b64" in body))
    assert.ok(!("tmp_token" in body))
    assert.ok(!("sha256" in body))
    assert.ok(!("size" in body))
    assert.ok(!("mode" in body))
  } finally {
    cleanup()
  }
})

test("fs_history_restore of prior_exists=false snapshot requires enableDelete", async () => {
  const root = freshRoot()
  const work = freshWorkDir()
  const fake = makeFakeHelper()
  try {
    // Seed a snapshot for a not-yet-existing path.
    const builtinWrite = createFilesystemBuiltin({
      rootPath: root,
      helperPath: "/usr/bin/true",
      helperWorkDir: work,
      enableWrite: true,
      enableDelete: true,
      enableHistory: true,
      enableLiveSearch: false,
      enableIndex: false,
      skipWorkDirAssertion: true,
      helperClientImpl: fake.helper,
    })
    await builtinWrite.invokeTool!({
      toolName: "fs_write",
      args: { path: "/new", content: "hello", encoding: "utf-8" },
      envelope: makeEnvelope([{ access: "write", pathPrefixes: ["/"] }]),
    })
    const priorAbsentVersion = fake.history.find(
      (h) => h.path === "/new" && h.prior_exists === false
    )!.version
    // Now create a builtin with enableDelete=false. Restore would delete /new.
    const builtinNoDelete = createFilesystemBuiltin({
      rootPath: root,
      helperPath: "/usr/bin/true",
      helperWorkDir: work,
      enableWrite: true,
      enableDelete: false,
      enableHistory: true,
      enableLiveSearch: false,
      enableIndex: false,
      skipWorkDirAssertion: true,
      helperClientImpl: fake.helper,
    })
    const r = await builtinNoDelete.invokeTool!({
      toolName: "fs_history_restore",
      args: { path: "/new", version: priorAbsentVersion },
      envelope: makeEnvelope([{ access: "write", pathPrefixes: ["/"] }]),
    })
    assert.equal(r.isError, true)
    assert.match(
      getMeta(r).synapse_error?.message ?? "",
      /restore_delete_requires_enable_delete/
    )
    // file still there
    assert.equal((await fsp.readFile(join(root, "new"))).toString(), "hello")
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
})

test("fs_history_restore response omits 'mode' when restoring to delete", async () => {
  const { builtin, history, root, cleanup } = await makeBuiltin()
  try {
    await builtin.invokeTool!({
      toolName: "fs_write",
      args: { path: "/n", content: "hi", encoding: "utf-8" },
      envelope: makeEnvelope([{ access: "write", pathPrefixes: ["/"] }]),
    })
    const ver = history.find(
      (h) => h.path === "/n" && h.prior_exists === false
    )!.version
    const r = await builtin.invokeTool!({
      toolName: "fs_history_restore",
      args: { path: "/n", version: ver },
      envelope: makeEnvelope([{ access: "write", pathPrefixes: ["/"] }]),
    })
    assert.equal(r.isError, undefined, JSON.stringify(r._meta))
    const body = JSON.parse((r.content[0] as { text: string }).text)
    assert.equal(body.restored, false)
    assert.ok(!("mode" in body))
    // File should have been deleted.
    await assert.rejects(() => fsp.stat(join(root, "n")))
  } finally {
    cleanup()
  }
})

// ─────────────────────────── search guards ───────────────────────────────────

test("fs_search indexed:true with regex returns regex_requires_live_search", async () => {
  const { builtin, cleanup } = await makeBuiltin({ enableIndex: true })
  try {
    const r = await builtin.invokeTool!({
      toolName: "fs_search",
      args: { mode: "content", query: ".*", regex: true, indexed: true },
      envelope: makeEnvelope([{ access: "read", pathPrefixes: ["/"] }]),
    })
    assert.equal(r.isError, true)
    assert.match(
      getMeta(r).synapse_error?.message ?? "",
      /regex_requires_live_search/
    )
  } finally {
    cleanup()
  }
})

test("fs_search indexed:true with glob returns glob_requires_live_search", async () => {
  const { builtin, cleanup } = await makeBuiltin({ enableIndex: true })
  try {
    const r = await builtin.invokeTool!({
      toolName: "fs_search",
      args: { mode: "content", query: "x", glob: "*.md", indexed: true },
      envelope: makeEnvelope([{ access: "read", pathPrefixes: ["/"] }]),
    })
    assert.equal(r.isError, true)
    assert.match(
      getMeta(r).synapse_error?.message ?? "",
      /glob_requires_live_search/
    )
  } finally {
    cleanup()
  }
})

test("fs_index_status response does NOT include storage field", async () => {
  const { builtin, cleanup } = await makeBuiltin({ enableIndex: true })
  try {
    const r = await builtin.invokeTool!({
      toolName: "fs_index_status",
      args: { subtree: "/" },
      envelope: makeEnvelope([{ access: "read", pathPrefixes: ["/"] }]),
    })
    assert.equal(r.isError, undefined)
    const body = JSON.parse((r.content[0] as { text: string }).text)
    assert.ok(!("storage" in body))
  } finally {
    cleanup()
  }
})

// ─────────────────────────── pagination validation ───────────────────────────

test("fs_history_list rejects offset out of range and limit out of range", async () => {
  const { builtin, cleanup } = await makeBuiltin()
  try {
    const r1 = await builtin.invokeTool!({
      toolName: "fs_history_list",
      args: { offset: -1 },
      envelope: makeEnvelope([{ access: "read", pathPrefixes: ["/"] }]),
    })
    assert.equal(r1.isError, true)
    assert.match(
      getMeta(r1).synapse_error?.message ?? "",
      /offset_out_of_range/
    )
    const r2 = await builtin.invokeTool!({
      toolName: "fs_history_list",
      args: { limit: 0 },
      envelope: makeEnvelope([{ access: "read", pathPrefixes: ["/"] }]),
    })
    assert.equal(r2.isError, true)
    assert.match(getMeta(r2).synapse_error?.message ?? "", /limit_out_of_range/)
  } finally {
    cleanup()
  }
})

test("canonicalize gate exact /.synapse-internal rejection (and normalize-then-equal)", async () => {
  const { builtin, cleanup } = await makeBuiltin()
  try {
    for (const p of [
      "/.synapse-internal",
      "/.synapse-internal/",
      "/.synapse-internal/.",
      "/.synapse-internal/foo/..",
      "/.synapse-internal/tmp/x",
    ]) {
      const r = await builtin.invokeTool!({
        toolName: "list_dir",
        args: { path: p },
        envelope: makeEnvelope([{ access: "read", pathPrefixes: ["/"] }]),
      })
      assert.equal(r.isError, true, `path ${p} should be rejected`)
    }
  } finally {
    cleanup()
  }
})

test("list root excludes .synapse-internal entry", async () => {
  const { builtin, root, cleanup } = await makeBuiltin()
  try {
    writeFileSync(join(root, "visible.txt"), "yes")
    const r = await builtin.invokeTool!({
      toolName: "list_dir",
      args: { path: "/" },
      envelope: makeEnvelope([{ access: "read", pathPrefixes: ["/"] }]),
    })
    assert.equal(r.isError, undefined)
    const body = JSON.parse((r.content[0] as { text: string }).text) as {
      entries: Array<{ name: string }>
    }
    const names = body.entries.map((e) => e.name).sort()
    assert.deepEqual(names, ["visible.txt"])
  } finally {
    cleanup()
  }
})

test("fs_index_rebuild silently drops any caller-supplied ignore_patterns", async () => {
  const { builtin, cleanup } = await makeBuiltin({ enableIndex: true })
  try {
    const r = await builtin.invokeTool!({
      toolName: "fs_index_rebuild",
      args: {
        subtree: "/",
        ignore_patterns: ["**/*.pdf"],
      } as unknown as Record<string, unknown>,
      envelope: makeEnvelope([{ access: "read", pathPrefixes: ["/"] }]),
    })
    assert.equal(r.isError, undefined)
  } finally {
    cleanup()
  }
})

// ─────────────────────────── P1 regression tests ─────────────────────────────

test("fs_delete trash path performs final pre_delete CAS", async () => {
  const root = freshRoot()
  const work = freshWorkDir()
  const fake = makeFakeHelper()
  let trashCalls = 0
  // trash impl that always succeeds — we want the CAS recheck to fire BEFORE
  // we get to trashFn, not just on the fallback fs.rm path.
  const builtin = createFilesystemBuiltin({
    rootPath: root,
    helperPath: "/usr/bin/true",
    helperWorkDir: work,
    enableWrite: true,
    enableDelete: true,
    enableHistory: true,
    enableIndex: false,
    enableLiveSearch: false,
    skipWorkDirAssertion: true,
    helperClientImpl: fake.helper,
    trashImpl: async (paths) => {
      trashCalls += 1
      // simulate OS trash removing the file
      for (const p of paths) {
        await fsp.unlink(p).catch(() => {})
      }
    },
  })
  try {
    writeFileSync(join(root, "f"), "original")
    // Race the delete: between snapshot and trash, an external process
    // overwrites the file. The handler must detect this via the final CAS.
    const origStreamSha256 = fake.helper.historySnapshotDelete
    fake.helper.historySnapshotDelete = async (
      input: Parameters<typeof origStreamSha256>[0]
    ) => {
      // After snapshot is recorded, simulate the external write.
      const result = await (origStreamSha256 as typeof origStreamSha256).call(
        fake.helper,
        input
      )
      writeFileSync(join(root, "f"), "TAMPERED")
      return result
    }
    const r = await builtin.invokeTool!({
      toolName: "fs_delete",
      args: { path: "/f", mode: "trash" },
      envelope: makeEnvelope([{ access: "write", pathPrefixes: ["/"] }]),
    })
    assert.equal(r.isError, true, JSON.stringify(r._meta))
    const err = getMeta(r).synapse_error
    assert.match(err?.message ?? "", /stale_write_detected/)
    const meta = r._meta as {
      synapse_error?: { details?: { stale_write_phase?: string } }
    }
    assert.equal(meta.synapse_error?.details?.stale_write_phase, "pre_delete")
    // Trash MUST NOT have run (CAS short-circuits before).
    assert.equal(trashCalls, 0)
    // File still has the externally-written content.
    assert.equal((await fsp.readFile(join(root, "f"))).toString(), "TAMPERED")
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
})

test("fs_write of NEW file with helper unavailable + !allowUnversionedWrite rejects history_unavailable", async () => {
  const root = freshRoot()
  try {
    const builtin = createFilesystemBuiltin({
      rootPath: root,
      // No helperPath → helper unavailable.
      enableWrite: true,
      enableHistory: true,
      enableLiveSearch: false,
      enableIndex: false,
      allowUnversionedWrite: false,
    })
    // The catalog rule already hides fs_write when (history OR
    // allowUnversionedWrite) is false; runtime call must also reject.
    const r = await builtin.invokeTool!({
      toolName: "fs_write",
      args: { path: "/newfile", content: "x", encoding: "utf-8" },
      envelope: makeEnvelope([{ access: "write", pathPrefixes: ["/"] }]),
    })
    assert.equal(r.isError, true)
    // Either permission_denied (catalog rule) or runtime_constraint —
    // both are correct disposition; the load-bearing assertion is "we
    // didn't silently create /newfile".
    await assert.rejects(() => fsp.stat(join(root, "newfile")))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("fs_search hidden when enableRead=false even with index/live available", async () => {
  const { builtin, cleanup } = await makeBuiltin({
    enableRead: false,
    enableIndex: true,
  })
  try {
    const ex = (await builtin.describeExposures())[0]!
    const names = ex.tools.map((t) => t.name)
    assert.ok(!names.includes("fs_search"))
    assert.ok(!names.includes("fs_index_status"))
    assert.ok(!names.includes("fs_index_rebuild"))
  } finally {
    cleanup()
  }
})

test("fs_history_restore rejects when sidecar returns corrupt blob (sha mismatch)", async () => {
  const root = freshRoot()
  const work = freshWorkDir()
  const fake = makeFakeHelper()
  try {
    const builtin = createFilesystemBuiltin({
      rootPath: root,
      helperPath: "/usr/bin/true",
      helperWorkDir: work,
      enableWrite: true,
      enableDelete: true,
      enableHistory: true,
      enableIndex: false,
      enableLiveSearch: false,
      skipWorkDirAssertion: true,
      helperClientImpl: fake.helper,
    })
    await builtin.invokeTool!({
      toolName: "fs_write",
      args: { path: "/f", content: "orig", encoding: "utf-8" },
      envelope: makeEnvelope([{ access: "write", pathPrefixes: ["/"] }]),
    })
    await builtin.invokeTool!({
      toolName: "fs_write",
      args: { path: "/f", content: "next", encoding: "utf-8" },
      envelope: makeEnvelope([{ access: "write", pathPrefixes: ["/"] }]),
    })
    const ver = fake.history.find(
      (h) => h.path === "/f" && h.prior_exists === true
    )!.version
    // Make the fake helper return WRONG bytes for restore — simulate a
    // tampered/corrupted blob. The TS handler must reject with
    // restore_blob_corrupt before writing anything.
    const originalRestore = fake.helper.historyRestore
    fake.helper.historyRestore = async (input) => {
      const r = await originalRestore.call(fake.helper, input)
      if (r.mode === "inline") {
        return { ...r, content_b64: Buffer.from("BOGUS").toString("base64") }
      }
      return r
    }
    const r = await builtin.invokeTool!({
      toolName: "fs_history_restore",
      args: { path: "/f", version: ver },
      envelope: makeEnvelope([{ access: "write", pathPrefixes: ["/"] }]),
    })
    assert.equal(r.isError, true)
    assert.match(
      getMeta(r).synapse_error?.message ?? "",
      /restore_blob_corrupt/
    )
    // File still has the second write's content, NOT BOGUS.
    assert.equal((await fsp.readFile(join(root, "f"))).toString(), "next")
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
})

test("fs_index_task_status returns the task when grant covers its subtree", async () => {
  const { builtin, helper, cleanup } = await makeBuiltin({ enableIndex: true })
  try {
    // Fake helper records nothing about rebuild; we install an
    // indexTaskStatus that returns a synthetic task.
    helper.indexTaskStatus = async ({ task_id }) => ({
      task_id,
      subtree: "/allowed",
      status: "completed" as const,
      started_at: assertIsoInstantString("2026-01-01T00:00:00.000Z"),
      finished_at: assertIsoInstantString("2026-01-01T00:00:05.000Z"),
      error: null,
    })
    const r = await builtin.invokeTool!({
      toolName: "fs_index_task_status",
      args: { task_id: "rebuild-abc" },
      envelope: makeEnvelope([{ access: "read", pathPrefixes: ["/allowed"] }]),
    })
    assert.equal(r.isError, undefined, JSON.stringify(r._meta))
    const body = JSON.parse((r.content[0] as { text: string }).text)
    assert.equal(body.task_id, "rebuild-abc")
    assert.equal(body.subtree, "/allowed")
  } finally {
    cleanup()
  }
})

test("fs_index_task_status denies with same error as not_found (no side channel)", async () => {
  const { builtin, helper, cleanup } = await makeBuiltin({ enableIndex: true })
  try {
    helper.indexTaskStatus = async ({ task_id }) => ({
      task_id,
      subtree: "/secret",
      status: "completed" as const,
      started_at: assertIsoInstantString("2026-01-01T00:00:00.000Z"),
      finished_at: assertIsoInstantString("2026-01-01T00:00:05.000Z"),
      error: null,
    })
    const r = await builtin.invokeTool!({
      toolName: "fs_index_task_status",
      args: { task_id: "rebuild-secret" },
      envelope: makeEnvelope([{ access: "read", pathPrefixes: ["/public"] }]),
    })
    assert.equal(r.isError, true)
    // Critical: same error code + message shape as a not_found, so a
    // caller can't probe task existence by trying an id and comparing
    // permission_denied vs task_not_found.
    assert.equal(getMeta(r).synapse_error?.code, "runtime_constraint")
    assert.match(
      getMeta(r).synapse_error?.message ?? "",
      /task_not_found_or_denied/
    )
  } finally {
    cleanup()
  }
})

test("fs_index_task_status maps sidecar -32004 to task_not_found_or_denied (same as denied)", async () => {
  const { builtin, helper, cleanup } = await makeBuiltin({ enableIndex: true })
  try {
    helper.indexTaskStatus = async () => {
      const { FsHelperRpcError } = await import("./fs-helper-client.js")
      throw new FsHelperRpcError(
        "fs.index.task_status",
        -32004,
        "task rebuild-nope"
      )
    }
    const r = await builtin.invokeTool!({
      toolName: "fs_index_task_status",
      args: { task_id: "rebuild-nope" },
      envelope: makeEnvelope([{ access: "read", pathPrefixes: ["/"] }]),
    })
    assert.equal(r.isError, true)
    assert.equal(getMeta(r).synapse_error?.code, "runtime_constraint")
    assert.match(
      getMeta(r).synapse_error?.message ?? "",
      /task_not_found_or_denied/
    )
  } finally {
    cleanup()
  }
})

test("fs_index_status drops ancestor rebuild_task when caller can't read its subtree", async () => {
  const { builtin, helper, cleanup } = await makeBuiltin({ enableIndex: true })
  try {
    // Sidecar reports a /-wide rebuild as the latest task. A /public-only
    // caller asks for /public status — runtime must strip rebuild_task
    // because the caller can't read /, even though /public is technically
    // an "intersect" subtree of / (the sidecar's per-subtree filter
    // surfaces ancestor tasks). Closes the global rebuild leak.
    helper.indexStatus = async ({ subtree }) =>
      ({
        subtree: subtree ?? "/",
        last_indexed_at: null,
        doc_count: 0,
        queue_depth: 0,
        errors: { extract_failed: 0, watcher_starved: 0 },
        rebuild_task: {
          task_id: "rebuild-global",
          subtree: "/",
          status: "running" as const,
          started_at: "2026-01-01T00:00:00.000Z",
          finished_at: null,
          error: null,
        },
      }) as never
    const r = await builtin.invokeTool!({
      toolName: "fs_index_status",
      args: { subtree: "/public" },
      envelope: makeEnvelope([{ access: "read", pathPrefixes: ["/public"] }]),
    })
    assert.equal(r.isError, undefined, JSON.stringify(r._meta))
    const body = JSON.parse((r.content[0] as { text: string }).text)
    assert.ok(
      !("rebuild_task" in body),
      `rebuild_task leaked to /public-only caller: ${JSON.stringify(body)}`
    )
  } finally {
    cleanup()
  }
})

test("fs_index_status keeps rebuild_task when caller's grant covers the task subtree", async () => {
  const { builtin, helper, cleanup } = await makeBuiltin({ enableIndex: true })
  try {
    helper.indexStatus = async ({ subtree }) =>
      ({
        subtree: subtree ?? "/",
        last_indexed_at: null,
        doc_count: 0,
        queue_depth: 0,
        errors: { extract_failed: 0, watcher_starved: 0 },
        rebuild_task: {
          task_id: "rebuild-global",
          subtree: "/",
          status: "running" as const,
          started_at: "2026-01-01T00:00:00.000Z",
          finished_at: null,
          error: null,
        },
      }) as never
    const r = await builtin.invokeTool!({
      toolName: "fs_index_status",
      args: { subtree: "/" },
      envelope: makeEnvelope([{ access: "read", pathPrefixes: ["/"] }]),
    })
    assert.equal(r.isError, undefined)
    const body = JSON.parse((r.content[0] as { text: string }).text)
    assert.equal(body.rebuild_task.task_id, "rebuild-global")
  } finally {
    cleanup()
  }
})

// ─── numeric validation (post-review round 10) ─────────────────────────────

test("fs_read rejects non-integer start_byte with invalid_request", async () => {
  const { builtin, cleanup } = await makeBuiltin()
  try {
    const r = await builtin.invokeTool!({
      toolName: "fs_read",
      args: { path: "/x.txt", start_byte: 1.5 },
      envelope: makeEnvelope([{ access: "read", pathPrefixes: ["/"] }]),
    })
    assert.equal(r.isError, true)
    assert.equal(getMeta(r).synapse_error?.code, "invalid_request")
    assert.match(
      getMeta(r).synapse_error?.message ?? "",
      /start_byte_out_of_range/
    )
  } finally {
    cleanup()
  }
})

test("fs_read rejects negative end_byte with invalid_request", async () => {
  const { builtin, cleanup } = await makeBuiltin()
  try {
    const r = await builtin.invokeTool!({
      toolName: "fs_read",
      args: { path: "/x.txt", end_byte: -1 },
      envelope: makeEnvelope([{ access: "read", pathPrefixes: ["/"] }]),
    })
    assert.equal(r.isError, true)
    assert.equal(getMeta(r).synapse_error?.code, "invalid_request")
    assert.match(
      getMeta(r).synapse_error?.message ?? "",
      /end_byte_out_of_range/
    )
  } finally {
    cleanup()
  }
})

test("fs_read rejects NaN max_bytes with invalid_request", async () => {
  const { builtin, cleanup } = await makeBuiltin()
  try {
    const r = await builtin.invokeTool!({
      toolName: "fs_read",
      args: { path: "/x.txt", max_bytes: Number.NaN },
      envelope: makeEnvelope([{ access: "read", pathPrefixes: ["/"] }]),
    })
    assert.equal(r.isError, true)
    assert.equal(getMeta(r).synapse_error?.code, "invalid_request")
    assert.match(
      getMeta(r).synapse_error?.message ?? "",
      /max_bytes_out_of_range/
    )
  } finally {
    cleanup()
  }
})

test("fs_read rejects zero max_bytes with invalid_request (must be positive)", async () => {
  const { builtin, cleanup } = await makeBuiltin()
  try {
    const r = await builtin.invokeTool!({
      toolName: "fs_read",
      args: { path: "/x.txt", max_bytes: 0 },
      envelope: makeEnvelope([{ access: "read", pathPrefixes: ["/"] }]),
    })
    assert.equal(r.isError, true)
    assert.equal(getMeta(r).synapse_error?.code, "invalid_request")
  } finally {
    cleanup()
  }
})

test("fs_read can read later chunks of files larger than maxReadBytes", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const root = mkdtempSync(join(tmpdir(), "synapse-fs-read-large-"))
  try {
    // 16-byte file, maxReadBytes=5: read 2 bytes starting at offset 10.
    writeFileSync(join(root, "big.bin"), "ABCDEFGHIJKLMNOP")
    const builtin = createFilesystemBuiltin({
      rootPath: root,
      maxReadBytes: 5,
      skipWorkDirAssertion: true,
    })
    const r = await builtin.invokeTool!({
      toolName: "fs_read",
      args: { path: "/big.bin", start_byte: 10, max_bytes: 2 },
      envelope: makeEnvelope([{ access: "read", pathPrefixes: ["/"] }]),
    })
    assert.equal(r.isError, undefined, JSON.stringify(r._meta))
    const body = JSON.parse((r.content[0] as { text: string }).text)
    assert.equal(body.content, "KL")
    rmSync(root, { recursive: true, force: true })
  } catch (err) {
    rmSync(root, { recursive: true, force: true })
    throw err
  }
})
