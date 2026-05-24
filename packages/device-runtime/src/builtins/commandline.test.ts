import test from "node:test"
import assert from "node:assert/strict"
import { createCommandlineBuiltin, executeBash } from "./commandline.js"

test("commandline builtin exposes a bash tool", async () => {
  const builtin = createCommandlineBuiltin()
  const exposures = await builtin.describeExposures()
  assert.equal(exposures.length, 1)
  assert.equal(exposures[0]!.builtin_kind, "commandline")
  assert.equal(exposures[0]!.tools.length, 1)
  assert.equal(exposures[0]!.tools[0]!.name, "bash")
})

test("executeBash captures stdout + exit code", async () => {
  const result = await executeBash({
    command: 'printf "hello world\\n"',
    timeoutMs: 5000,
  })
  assert.equal(result.exitCode, 0)
  assert.match(result.stdout, /hello world/)
  assert.equal(result.killed, false)
})

test("executeBash surfaces non-zero exit codes without throwing", async () => {
  const result = await executeBash({
    command: "exit 7",
    timeoutMs: 5000,
  })
  assert.equal(result.exitCode, 7)
})

test("executeBash kills runaway processes via timeout", async () => {
  const result = await executeBash({
    command: "sleep 5",
    timeoutMs: 200,
  })
  assert.equal(result.killed, true)
})
