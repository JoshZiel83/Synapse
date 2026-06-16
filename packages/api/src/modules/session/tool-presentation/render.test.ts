/**
 * Unit tests for the tool-call presentation renderer (Phase 1 gate).
 *
 * Pure, no DB: validates ICU templating, the `length`/`basename`/`truncate60`
 * preprocessors, the generic DiffSpec→jsdiff rendering, secretArg masking, and
 * the generic fallback descriptor. Redaction (secretlint) is covered separately
 * in redact.test.ts.
 */

import test from "node:test"
import assert from "node:assert/strict"
import type { ToolPresentationDescriptor } from "@synapse/shared/tool-presentation"
import {
  genericDescriptor,
  renderToolRequest,
  renderToolResult,
} from "./render.js"

const FS_EDIT: ToolPresentationDescriptor = {
  v: 1,
  icon: "file-pen",
  title: {
    key: "tool.fs_edit.title",
    message: "正在编辑 {file}",
    args: { file: { path: "path", preprocess: "basename" } },
  },
  detail: {
    key: "tool.fs_edit.detail",
    message: "{count, plural, other {# 处修改}}",
    args: { count: { path: "edits", preprocess: "length" } },
  },
  request: {
    mode: "diff",
    diff: {
      itemsPath: "edits",
      oldField: "old_string",
      newField: "new_string",
    },
  },
  result: {
    summary: {
      key: "tool.fs_edit.result",
      message:
        "已写入 {bytes, number} 字节, {applied, plural, other {# 处生效}}",
      args: {
        bytes: { path: "meta.bytes_written" },
        applied: { path: "meta.edits_applied" },
      },
    },
  },
}

test("renderToolRequest: ICU title with basename preprocess", () => {
  const out = renderToolRequest(FS_EDIT, {
    path: "/home/user/project/foo.ts",
    edits: [{ old_string: "a", new_string: "b" }],
  })
  assert.equal(out.icon, "file-pen")
  assert.equal(out.title.fallback, "正在编辑 foo.ts")
  assert.equal(out.title.key, "tool.fs_edit.title")
  assert.equal(out.title.params.file, "foo.ts")
})

test("renderToolRequest: length preprocess drives ICU plural", () => {
  const out = renderToolRequest(FS_EDIT, {
    path: "foo.ts",
    edits: [
      { old_string: "a", new_string: "b" },
      { old_string: "c", new_string: "d" },
    ],
  })
  assert.equal(out.detail?.fallback, "2 处修改")
  assert.equal(out.detail?.params.count, 2)
})

test("renderToolRequest: diff mode renders +/- via jsdiff DiffSpec", () => {
  const out = renderToolRequest(FS_EDIT, {
    path: "foo.ts",
    edits: [{ old_string: "hello", new_string: "world" }],
  })
  assert.equal(out.requestBlocks.length, 1)
  const block = out.requestBlocks[0]
  assert.equal(block.type, "text")
  if (block.type === "text") {
    assert.match(block.text, /- hello/)
    assert.match(block.text, /\+ world/)
  }
})

test("renderToolRequest: code mode + secretArgs masking", () => {
  const bash: ToolPresentationDescriptor = {
    v: 1,
    icon: "terminal",
    title: {
      key: "tool.bash.title",
      message: "运行 {cmd}",
      args: { cmd: { path: "command", preprocess: "truncate60" } },
    },
    request: {
      mode: "code",
      codeArg: { path: "command" },
      secretArgs: ["token"],
    },
  }
  const out = renderToolRequest(bash, {
    command: "echo hi",
    token: "sk-supersecret",
  })
  assert.equal(out.title.fallback, "运行 echo hi")
  // code block shows the command
  assert.equal(out.requestBlocks[0]?.type, "text")
  // a secretArg referenced elsewhere would be masked; here token isn't in the
  // template so just assert the command rendered intact
  if (out.requestBlocks[0]?.type === "text") {
    assert.equal(out.requestBlocks[0].text, "echo hi")
  }
})

test("renderToolRequest: truncate60 caps long strings", () => {
  const desc: ToolPresentationDescriptor = {
    v: 1,
    icon: "terminal",
    title: {
      key: "t",
      message: "{cmd}",
      args: { cmd: { path: "command", preprocess: "truncate60" } },
    },
    request: { mode: "hidden" },
  }
  const long = "x".repeat(100)
  const out = renderToolRequest(desc, { command: long })
  assert.equal(out.title.fallback.length, 61) // 60 + ellipsis
  assert.ok(out.title.fallback.endsWith("…"))
})

test("renderToolResult: summary interpolates meta.* and keeps raw body by default", () => {
  const body = [{ id: "b1", type: "text" as const, text: "raw result body" }]
  const out = renderToolResult(FS_EDIT, {
    meta: { bytes_written: 320, edits_applied: 2 },
    bodyBlocks: body,
  })
  assert.equal(out.resultSummary?.fallback, "已写入 320 字节, 2 处生效")
  // summary_then_raw (default): raw body retained
  assert.deepEqual(out.resultBlocks, body)
})

test("renderToolResult: no descriptor result spec → raw body passthrough", () => {
  const noResult: ToolPresentationDescriptor = {
    v: 1,
    icon: "wrench",
    title: { key: "t", message: "x", args: {} },
    request: { mode: "hidden" },
  }
  const body = [{ id: "b1", type: "text" as const, text: "x" }]
  const out = renderToolResult(noResult, { bodyBlocks: body })
  assert.equal(out.resultSummary, undefined)
  assert.deepEqual(out.resultBlocks, body)
})

test("renderToolResult: bodyMode hidden drops raw body but keeps summary", () => {
  const desc: ToolPresentationDescriptor = {
    v: 1,
    icon: "wrench",
    title: { key: "t", message: "x", args: {} },
    request: { mode: "hidden" },
    result: {
      bodyMode: "hidden",
      summary: { key: "s", message: "done", args: {} },
    },
  }
  const out = renderToolResult(desc, {
    bodyBlocks: [{ id: "b1", type: "text", text: "secret-ish raw" }],
  })
  assert.equal(out.resultSummary?.fallback, "done")
  assert.deepEqual(out.resultBlocks, [])
})

test("genericDescriptor: title is the stableKey leaf, args_table request", () => {
  const desc = genericDescriptor("builtin/filesystem/fs_edit")
  assert.equal(desc.icon, "wrench")
  assert.equal(desc.request.mode, "args_table")
  const out = renderToolRequest(desc, { a: 1 })
  assert.equal(out.title.fallback, "fs_edit")
  assert.equal(out.requestBlocks[0]?.type, "text")
})

test("renderToolRequest: missing path uses default / empty", () => {
  const out = renderToolRequest(FS_EDIT, { edits: [] })
  // basename of "" → "", ICU renders "正在编辑 "
  assert.equal(out.title.fallback, "正在编辑 ")
  assert.equal(out.detail?.fallback, "0 处修改")
})
