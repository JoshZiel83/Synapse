import test from "node:test"
import assert from "node:assert/strict"
import { createCommandlineBuiltin, executeBash } from "./commandline.js"
import { detectTerminalEnvironment } from "../terminal/environment.js"
import { PosixBashProvider } from "../terminal/shell-provider.js"

test("commandline builtin exposes bash + exec_file tools on POSIX", async () => {
  const builtin = createCommandlineBuiltin()
  const exposures = await builtin.describeExposures()
  assert.equal(exposures.length, 1)
  assert.equal(exposures[0]!.builtin_kind, "commandline")
  const toolNames = exposures[0]!.tools.map((t) => t.name).sort()
  // On POSIX with bash present, expect at least [bash, exec_file].
  assert.ok(toolNames.includes("bash"))
  assert.ok(toolNames.includes("exec_file"))
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

test("regression: bash provider spawns absolute bash path with -c (not -lc)", async () => {
  const env = await detectTerminalEnvironment()
  if (!env.bash) return // Skip on hosts without bash (Windows CI)
  const provider = PosixBashProvider.fromEnvironment(env)!
  const desc = provider.buildShellDescriptor({
    kind: "shell",
    executor: "bash",
    command: "echo hi",
  })
  // The descriptor program must be the resolved ABSOLUTE bash path.
  assert.ok(
    desc.program.startsWith("/"),
    `expected absolute path, got ${desc.program}`
  )
  // Args must be exactly ["-c", command], NOT ["-lc", command].
  assert.equal(desc.args[0], "-c")
  assert.ok(!desc.args.includes("-lc"))
})

test("regression: executeBash sees the spawn env it built, NOT process.env", async () => {
  const env = await detectTerminalEnvironment()
  if (!env.bash) return
  // GIT_TERMINAL_PROMPT is in ALWAYS_INJECT_ENV; baseEnv must contain it.
  const result = await executeBash({
    command:
      'printf "PROMPT=%s|EDITOR=%s|PAGER=%s" "${GIT_TERMINAL_PROMPT-}" "${GIT_EDITOR-}" "${GIT_PAGER-}"',
    timeoutMs: 5000,
  })
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout, "PROMPT=0|EDITOR=true|PAGER=cat")
})
