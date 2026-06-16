import assert from "node:assert/strict"
import test from "node:test"

import {
  parseToolPresentation,
  resolvePresentation,
  ToolPresentationDescriptorSchema,
  type ToolPresentationDescriptor,
} from "./index.js"

const descriptor: ToolPresentationDescriptor = {
  v: 1,
  icon: "wrench",
  title: {
    key: "tool.test.title",
    message: "Read {name}",
    args: {
      name: { path: "filePath", preprocess: "basename", default: "" },
    },
  },
  detail: {
    key: "tool.test.detail",
    message: "from {dir}",
    args: {
      dir: { path: "filePath", preprocess: "dirname", default: "." },
    },
  },
  request: {
    mode: "code",
    codeArg: { path: "content", preprocess: "truncate60" },
    secretArgs: ["token"],
  },
  result: {
    summary: {
      key: "tool.test.result",
      message: "{count} chars",
      args: { count: { path: "task.count", preprocess: "length" } },
    },
    bodyMode: "summary_then_raw",
    secretFields: ["meta.secret"],
  },
}

test("tool presentation descriptor schema accepts the shared descriptor shape", () => {
  assert.deepEqual(parseToolPresentation(descriptor), descriptor)
  assert.deepEqual(
    ToolPresentationDescriptorSchema.parse(descriptor),
    descriptor
  )
})

test("tool presentation descriptor schema rejects drifted plugin descriptors", () => {
  assert.equal(
    parseToolPresentation({
      ...descriptor,
      request: { ...descriptor.request, mode: "table" },
    }),
    null
  )
  assert.equal(
    parseToolPresentation({
      ...descriptor,
      unexpected: true,
    }),
    null
  )
})

test("resolvePresentation uses server-rendered fallback", () => {
  assert.equal(
    resolvePresentation({
      key: "tool.test.title",
      params: { name: "demo.txt" },
      fallback: "Read demo.txt",
    }),
    "Read demo.txt"
  )
  assert.equal(resolvePresentation(undefined), undefined)
})
