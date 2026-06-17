// Direct invokeTool tests for the exec_file + powershell tools added in
// Commit 7. These bypass the MCP host and call the builtin's invokeTool
// callback directly, with a hand-built envelope, so we can assert the
// permission gate + resolver + descriptor pieces independently of the
// envelope verification stack (which envelope-dispatch.test.ts covers).

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

import { createCommandlineBuiltin } from "./commandline.js"
import { detectTerminalEnvironment } from "../terminal/environment.js"
import {
  createToolchainManager,
  type ArchiveLocator,
} from "../terminal/toolchain-manager.js"
import type {
  PathResolver,
  ResolvedTerminalEnvironment,
} from "../terminal/types.js"
import type {
  OperationEnvelope,
  RuntimeAuthorizationGrantWireSpec,
} from "@synapse/device-protocol"

const HERE = new URL(".", import.meta.url).pathname
const FIXTURE_MANIFEST = join(
  HERE,
  "..",
  "..",
  "bundles",
  "__fixtures__",
  "manifest.fixture.json"
)

function makeTmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function fakeEnvelope(
  grantSpecs: RuntimeAuthorizationGrantWireSpec[]
): OperationEnvelope {
  return {
    operation_id: randomUUID(),
    attempt_id: randomUUID(),
    device_runtime_session_id: randomUUID(),
    device_capability_id: randomUUID(),
    device_exposure_id: randomUUID(),
    device_tool_id: randomUUID(),
    device_tool_revision_id: randomUUID(),
    input_hash: "sha256:test",
    task_mode: "sync",
    runtime_authorization: {
      grant_ids: ["test-grant"],
      grant_scope: "actor",
      grant_specs: grantSpecs,
    },
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    signature_kid: "test-kid",
    signature: "test-sig",
  }
}

async function linuxBuiltin(options: {
  pathResolver: PathResolver
  toolchainDir?: string
}) {
  const env: ResolvedTerminalEnvironment = await detectTerminalEnvironment({
    platform: "linux",
    arch: "x64",
    osEnv: { PATH: "/usr/bin", LANG: "en_US.UTF-8" },
    pathResolver: options.pathResolver,
  })
  const manager = createToolchainManager({
    manifestPath: FIXTURE_MANIFEST,
    toolchainDir: options.toolchainDir ?? makeTmp("synapse-builtin-tc-"),
    environment: env,
    pathResolver: options.pathResolver,
  })
  return createCommandlineBuiltin({
    environment: env,
    toolchainManager: manager,
    pathResolver: options.pathResolver,
  })
}

test("exec_file: rejects path-separator in program with invalid_request", async () => {
  const builtin = await linuxBuiltin({
    pathResolver: (name) => (name === "bash" ? "/bin/bash" : null),
  })
  const result = await builtin.invokeTool!({
    toolName: "exec_file",
    args: { program: "/usr/bin/git", args: ["status"] },
    envelope: fakeEnvelope([]),
  })
  assert.equal(result.isError, true)
  const meta = (result._meta ?? {}) as { synapse_error?: { code?: string } }
  assert.equal(meta.synapse_error?.code, "invalid_request")
})

test("exec_file: rejects non-string args[] elements with invalid_request", async () => {
  const builtin = await linuxBuiltin({
    pathResolver: () => null,
  })
  const result = await builtin.invokeTool!({
    toolName: "exec_file",
    args: { program: "git", args: ["status", 42 as unknown as string] },
    envelope: fakeEnvelope([]),
  })
  assert.equal(result.isError, true)
  const meta = (result._meta ?? {}) as { synapse_error?: { code?: string } }
  assert.equal(meta.synapse_error?.code, "invalid_request")
})

test("exec_file: argv_exact mismatch -> permission_denied", async () => {
  const builtin = await linuxBuiltin({
    pathResolver: () => null,
  })
  const result = await builtin.invokeTool!({
    toolName: "exec_file",
    args: { program: "git", args: ["status", "--branch"] },
    envelope: fakeEnvelope([
      {
        capability: "commandline",
        commandline: {
          executor: "exec_file",
          command_match_type: "argv_exact",
          program: "git",
          argv_prefix: ["status"],
        },
      },
    ]),
  })
  assert.equal(result.isError, true)
  const meta = (result._meta ?? {}) as { synapse_error?: { code?: string } }
  assert.equal(meta.synapse_error?.code, "permission_denied")
})

test("exec_file: missing managed program + policy denies bundled -> runtime_constraint", async () => {
  // python is bundle-eligible per BUNDLE_ELIGIBLE_PROGRAMS in
  // @synapse/shared. With allow_bundled_toolchain=false, resolve hits
  // ToolchainUnavailableError instead of falling back to the fixture
  // archive — surfaced as runtime_constraint to the caller.
  const builtin = await linuxBuiltin({
    pathResolver: () => null, // python is "not present" on PATH
  })
  const result = await builtin.invokeTool!({
    toolName: "exec_file",
    args: { program: "python", args: ["--version"] },
    envelope: fakeEnvelope([
      {
        capability: "commandline",
        commandline: {
          executor: "exec_file",
          command_match_type: "argv_exact",
          program: "python",
          argv_prefix: ["--version"],
          allow_bundled_toolchain: false,
        },
      },
    ]),
  })
  assert.equal(result.isError, true)
  const meta = (result._meta ?? {}) as {
    synapse_error?: { code?: string; details?: { reason?: string } }
  }
  assert.equal(meta.synapse_error?.code, "runtime_constraint")
})

// NOTE: a previous test asserted "git on Linux with no system git ->
// toolchain_unavailable" as device-side defense in depth. The bundled-
// fixture manifest in this package ships a fake git/linux-x64 entry
// (test infrastructure for install + resolve mechanics), so the
// fixture-based builtin can't simulate "no manifest entry for
// linux-x64". The behavior is covered by other suites:
//   * shared/access/policies/commandline-normalize.test.ts asserts
//     `isBundleAvailableForPlatform("git", "linux", "x64") === false`
//     so the API gate never grants bundled fallback for git on Linux.
//   * device-runtime/src/terminal/manifest.test.ts parity test asserts
//     the production manifest's git entries match
//     BUNDLE_PROGRAM_PLATFORM_KEYS.git (win32 only) — drift would fire
//     red.
//   * "exec_file: missing managed program + policy denies bundled ->
//     runtime_constraint" above covers the analogous unavailable-
//     manifest-entry path for python.

test("exec_file: unmanaged program not on PATH -> permission_denied program_not_found", async () => {
  const builtin = await linuxBuiltin({
    pathResolver: () => null,
  })
  const result = await builtin.invokeTool!({
    toolName: "exec_file",
    args: { program: "ripgrep", args: ["--version"] },
    envelope: fakeEnvelope([
      {
        capability: "commandline",
        commandline: {
          executor: "exec_file",
          command_match_type: "argv_exact",
          program: "ripgrep",
          argv_prefix: ["--version"],
        },
      },
    ]),
  })
  assert.equal(result.isError, true)
  const meta = (result._meta ?? {}) as {
    synapse_error?: { code?: string; details?: { reason?: string } }
  }
  assert.equal(meta.synapse_error?.code, "permission_denied")
  assert.equal(meta.synapse_error?.details?.reason, "program_not_found")
})

test("exec_file: allowedEnv containing PATH -> invalid_request allowed_env_path_forbidden", async () => {
  const builtin = await linuxBuiltin({
    pathResolver: (name) => (name === "node" ? "/usr/bin/node" : null),
  })
  const result = await builtin.invokeTool!({
    toolName: "exec_file",
    args: { program: "node", args: ["--version"] },
    envelope: fakeEnvelope([
      {
        capability: "commandline",
        commandline: {
          executor: "exec_file",
          command_match_type: "argv_exact",
          program: "node",
          argv_prefix: ["--version"],
          allowed_env: ["PATH"],
        },
      },
    ]),
  })
  assert.equal(result.isError, true)
  const meta = (result._meta ?? {}) as {
    synapse_error?: { code?: string; details?: { reason?: string } }
  }
  assert.equal(meta.synapse_error?.code, "invalid_request")
  assert.equal(
    meta.synapse_error?.details?.reason,
    "allowed_env_path_forbidden"
  )
})

test("exec_file: end-to-end via system PATH (node --version)", async () => {
  // Skip if host has no node — but our package tests run via npx tsx so node
  // is always present. The pathResolver here points at the real host node.
  const realResolver: PathResolver = (name, env, platform) => {
    if (name === "node") return process.execPath
    if (name === "bash" && platform !== "win32") return "/bin/bash"
    return null
  }
  const builtin = await linuxBuiltin({ pathResolver: realResolver })
  const result = await builtin.invokeTool!({
    toolName: "exec_file",
    args: { program: "node", args: ["--version"] },
    envelope: fakeEnvelope([
      {
        capability: "commandline",
        commandline: {
          executor: "exec_file",
          command_match_type: "argv_exact",
          program: "node",
          argv_prefix: ["--version"],
        },
      },
    ]),
  })
  assert.equal(result.isError, false, JSON.stringify(result))
  const meta = (result._meta ?? {}) as {
    toolchain_source?: string
    exit_code?: number
  }
  assert.equal(meta.toolchain_source, "system")
  assert.equal(meta.exit_code, 0)
  const textBlock = result.content[0] as { text: string }
  assert.match(textBlock.text, /v\d+\./)
})

test("exec_file: alias python3 hit when policy says python", async () => {
  // Resolver only knows python3; the program=python3 request must be
  // honored as-is (matcher accepts via alias).
  const builtin = await linuxBuiltin({
    pathResolver: (name) => (name === "python3" ? "/usr/bin/python3" : null),
  })
  const result = await builtin.invokeTool!({
    toolName: "exec_file",
    args: { program: "python3", args: ["--version"] },
    envelope: fakeEnvelope([
      {
        capability: "commandline",
        commandline: {
          executor: "exec_file",
          command_match_type: "argv_exact_preapproved",
          program: "python",
        },
      },
    ]),
  })
  // The matcher allows; resolver finds python3; we won't actually exec a
  // fake binary, so just check we got past auth + resolution.
  // The actual spawn will fail (python3 path is fake), but the gate passed.
  // What we care about: error is not invalid_request / permission_denied.
  const meta = (result._meta ?? {}) as {
    synapse_error?: { code?: string }
    toolchain_source?: string
  }
  assert.notEqual(meta.synapse_error?.code, "invalid_request")
  assert.notEqual(meta.synapse_error?.code, "permission_denied")
})
