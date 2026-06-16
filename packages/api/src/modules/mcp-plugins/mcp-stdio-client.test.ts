import { test } from "node:test"
import assert from "node:assert/strict"
import os from "os"
import { parseStdioEntryPoint } from "./mcp-stdio-client.js"

test("parseStdioEntryPoint resolves stdio templates", () => {
  process.env.__STDIO_ENTRYPOINT_TEST__ = "from-env"
  const spec = parseStdioEntryPoint(
    JSON.stringify({
      command: "${node}",
      args: ["--token", "${config:token}", "${instanceKey}"],
      env: {
        FROM_ENV: "${env:__STDIO_ENTRYPOINT_TEST__}",
        FROM_CONFIG: "${config:nested.value}",
        EMPTY_DROPPED: "${config:missing}",
      },
      cwd: "${tmpdir}",
    }),
    {
      config: { token: "tok", nested: { value: "nested-value" } },
      instanceKey: "instance-1",
    }
  )

  assert.equal(spec.command, process.execPath)
  assert.deepEqual(spec.args, ["--token", "tok", "instance-1"])
  assert.deepEqual(spec.env, {
    FROM_ENV: "from-env",
    FROM_CONFIG: "nested-value",
  })
  assert.equal(spec.cwd, os.tmpdir())
  delete process.env.__STDIO_ENTRYPOINT_TEST__
})

test("parseStdioEntryPoint rejects malformed JSON", () => {
  assert.throws(
    () => parseStdioEntryPoint('{"command":', { config: {}, instanceKey: "i" }),
    /Invalid stdio entry point JSON/
  )
})

test("parseStdioEntryPoint rejects invalid JSON shape", () => {
  for (const raw of [
    "[]",
    JSON.stringify({ command: 1 }),
    JSON.stringify({ command: "node", args: ["ok", 1] }),
    JSON.stringify({ command: "node", env: { A: 1 } }),
    JSON.stringify({ command: "node", cwd: 1 }),
  ]) {
    assert.throws(
      () => parseStdioEntryPoint(raw, { config: {}, instanceKey: "i" }),
      /Stdio entry point JSON has invalid shape/
    )
  }
})

test("parseStdioEntryPoint rejects missing or empty command", () => {
  for (const raw of [
    JSON.stringify({}),
    JSON.stringify({ command: "" }),
    JSON.stringify({ command: "${config:missing}" }),
  ]) {
    assert.throws(
      () => parseStdioEntryPoint(raw, { config: {}, instanceKey: "i" }),
      /Stdio entry point is missing a command/
    )
  }
})
