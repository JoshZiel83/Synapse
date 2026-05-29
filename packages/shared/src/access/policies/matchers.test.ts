// Shape-level invariants for the bundle-safe policy matchers. Two suites:
// (1) browserPolicyAllows(neededOperations) fail-closed semantics (pairs with
//     shared/test-fixtures/runtime-auth/browser.json), and
// (2) commandlinePolicyAllows shell + exec_file discriminated-union matching.

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  browserPolicyAllows,
  commandlinePolicyAllows,
  type BrowserPolicyShape,
  type CommandlineExecFilePolicyShape,
  type CommandlineShellPolicyShape,
} from "./matchers.js"
import { BrowserPolicySchema } from "./browser.js"
import { GrantPolicySchema } from "./grant.js"
import {
  parseCommandlinePolicyFromWire,
  serializeCommandlinePolicyToWire,
} from "./commandline.js"

// ─────────────────────────── browser branch ──────────────────────────────────

const base: BrowserPolicyShape = {
  action: "write",
  scopeType: "origin",
  origin: "https://example.com",
}

test("browserPolicyAllows — neededOperations omitted ⇒ legacy path (scope+action only)", () => {
  assert.equal(
    browserPolicyAllows(base, {
      needed: "read",
      origin: "https://example.com",
    }),
    true
  )
})

test("browserPolicyAllows — neededOperations supplied but policy.operations missing ⇒ fail closed", () => {
  assert.equal(
    browserPolicyAllows(base, {
      needed: "read",
      origin: "https://example.com",
      neededOperations: ["page.read"],
    }),
    false
  )
})

test("browserPolicyAllows — neededOperations supplied + policy.operations subset ⇒ deny missing op", () => {
  const policy: BrowserPolicyShape = { ...base, operations: ["page.read"] }
  assert.equal(
    browserPolicyAllows(policy, {
      needed: "write",
      origin: "https://example.com",
      neededOperations: ["page.input"],
    }),
    false
  )
})

test("browserPolicyAllows — every needed op present ⇒ allow", () => {
  const policy: BrowserPolicyShape = {
    ...base,
    operations: ["page.read", "page.input"],
  }
  assert.equal(
    browserPolicyAllows(policy, {
      needed: "write",
      origin: "https://example.com",
      neededOperations: ["page.input"],
    }),
    true
  )
})

test("browserPolicyAllows — write covers read still holds with operations", () => {
  const policy: BrowserPolicyShape = { ...base, operations: ["page.read"] }
  assert.equal(
    browserPolicyAllows(policy, {
      needed: "read",
      origin: "https://example.com",
      neededOperations: ["page.read"],
    }),
    true
  )
})

test("BrowserPolicySchema.strip() drops unknown scopeSource on parse", () => {
  const parsed = BrowserPolicySchema.parse({
    action: "read",
    scopeType: "origin",
    origin: "https://example.com",
    operations: ["page.read"],
    scopeSource: "args", // unknown to schema
  } as Record<string, unknown>)
  assert.equal((parsed as Record<string, unknown>).scopeSource, undefined)
})

test("GrantPolicySchema.parse with browser block strips scopeSource (3rd line of defence)", () => {
  const parsed = GrantPolicySchema.parse({
    capability: "browser",
    browser: {
      action: "read",
      scopeType: "origin",
      origin: "https://example.com",
      operations: ["page.read"],
      scopeSource: "runtime_active_page",
    },
  } as Record<string, unknown>)
  const browser = parsed.browser as Record<string, unknown> | undefined
  assert.ok(browser)
  assert.equal(browser?.scopeSource, undefined)
})

// ─────────────────────────── shell branch ────────────────────────────────────

test("commandlinePolicyAllows: bash exact hit", () => {
  const policy: CommandlineShellPolicyShape = {
    executor: "bash",
    commandMatchType: "exact",
    commandText: "git status",
  }
  const result = commandlinePolicyAllows(policy, {
    kind: "shell",
    executor: "bash",
    command: "git status",
  })
  assert.ok(result)
  assert.equal(result?.executor, "bash")
})

test("commandlinePolicyAllows: bash prefix matches token boundary; rejects compound ops", () => {
  const policy: CommandlineShellPolicyShape = {
    executor: "bash",
    commandMatchType: "prefix",
    commandText: "git",
  }
  assert.ok(
    commandlinePolicyAllows(policy, {
      kind: "shell",
      executor: "bash",
      command: "git status",
    })
  )
  assert.equal(
    commandlinePolicyAllows(policy, {
      kind: "shell",
      executor: "bash",
      command: "git status && cat /etc/passwd",
    }),
    null
  )
})

test("commandlinePolicyAllows: bash tool first-token match", () => {
  const policy: CommandlineShellPolicyShape = {
    executor: "bash",
    commandMatchType: "tool",
    commandText: "ls",
  }
  assert.ok(
    commandlinePolicyAllows(policy, {
      kind: "shell",
      executor: "bash",
      command: "ls -la /tmp",
    })
  )
  assert.equal(
    commandlinePolicyAllows(policy, {
      kind: "shell",
      executor: "bash",
      command: "cat /etc/passwd",
    }),
    null
  )
})

test("commandlinePolicyAllows: powershell only accepts commandMatchType=exact in v1", () => {
  const policy: CommandlineShellPolicyShape = {
    executor: "powershell",
    commandMatchType: "prefix",
    commandText: "Get-Process",
  }
  assert.equal(
    commandlinePolicyAllows(policy, {
      kind: "shell",
      executor: "powershell",
      command: "Get-Process Sysmon",
    }),
    null
  )
  const exact: CommandlineShellPolicyShape = {
    executor: "powershell",
    commandMatchType: "exact",
    commandText: "Get-Process",
  }
  assert.ok(
    commandlinePolicyAllows(exact, {
      kind: "shell",
      executor: "powershell",
      command: "Get-Process",
    })
  )
})

test("commandlinePolicyAllows: shell requires same executor on request and policy", () => {
  const policy: CommandlineShellPolicyShape = {
    executor: "bash",
    commandMatchType: "exact",
    commandText: "ls",
  }
  assert.equal(
    commandlinePolicyAllows(policy, {
      kind: "shell",
      executor: "powershell",
      command: "ls",
    }),
    null
  )
})

// ─────────────────────────── exec_file branch ────────────────────────────────

test("commandlinePolicyAllows: argv_exact full match", () => {
  const policy: CommandlineExecFilePolicyShape = {
    executor: "exec_file",
    commandMatchType: "argv_exact",
    program: "git",
    argvPrefix: ["status", "--short"],
  }
  assert.ok(
    commandlinePolicyAllows(policy, {
      kind: "exec_file",
      program: "git",
      argv: ["status", "--short"],
    })
  )
  // Extra arg => mismatch.
  assert.equal(
    commandlinePolicyAllows(policy, {
      kind: "exec_file",
      program: "git",
      argv: ["status", "--short", "--branch"],
    }),
    null
  )
})

test("commandlinePolicyAllows: argv_exact allows empty argv (bare program)", () => {
  const policy: CommandlineExecFilePolicyShape = {
    executor: "exec_file",
    commandMatchType: "argv_exact",
    program: "python",
    argvPrefix: [],
  }
  assert.ok(
    commandlinePolicyAllows(policy, {
      kind: "exec_file",
      program: "python",
      argv: [],
    })
  )
})

test("commandlinePolicyAllows: argv_exact missing argvPrefix => fail closed", () => {
  const policy = {
    executor: "exec_file",
    commandMatchType: "argv_exact",
    program: "git",
  } as unknown as CommandlineExecFilePolicyShape
  assert.equal(
    commandlinePolicyAllows(policy, {
      kind: "exec_file",
      program: "git",
      argv: [],
    }),
    null
  )
})

test("commandlinePolicyAllows: argv_prefix matches any args after prefix", () => {
  const policy: CommandlineExecFilePolicyShape = {
    executor: "exec_file",
    commandMatchType: "argv_prefix",
    program: "git",
    argvPrefix: ["log"],
  }
  assert.ok(
    commandlinePolicyAllows(policy, {
      kind: "exec_file",
      program: "git",
      argv: ["log", "--oneline", "-n", "10"],
    })
  )
})

test("commandlinePolicyAllows: argv_prefix with empty prefix => fail closed", () => {
  const policy: CommandlineExecFilePolicyShape = {
    executor: "exec_file",
    commandMatchType: "argv_prefix",
    program: "git",
    argvPrefix: [],
  }
  assert.equal(
    commandlinePolicyAllows(policy, {
      kind: "exec_file",
      program: "git",
      argv: ["status"],
    }),
    null
  )
})

test("commandlinePolicyAllows: argv_exact_preapproved hits whitelist (node --version)", () => {
  const policy: CommandlineExecFilePolicyShape = {
    executor: "exec_file",
    commandMatchType: "argv_exact_preapproved",
    program: "node",
  }
  assert.ok(
    commandlinePolicyAllows(policy, {
      kind: "exec_file",
      program: "node",
      argv: ["--version"],
    })
  )
  assert.ok(
    commandlinePolicyAllows(policy, {
      kind: "exec_file",
      program: "node",
      argv: ["-v"],
    })
  )
  // Extra arg outside whitelist => null.
  assert.equal(
    commandlinePolicyAllows(policy, {
      kind: "exec_file",
      program: "node",
      argv: ["--version", "extra"],
    }),
    null
  )
})

test("commandlinePolicyAllows: argv_exact_preapproved does NOT include git", () => {
  const policy: CommandlineExecFilePolicyShape = {
    executor: "exec_file",
    commandMatchType: "argv_exact_preapproved",
    program: "git",
  }
  assert.equal(
    commandlinePolicyAllows(policy, {
      kind: "exec_file",
      program: "git",
      argv: ["status"],
    }),
    null
  )
})

test("commandlinePolicyAllows: argv_prefix accepts python3 when policy says python (alias)", () => {
  const policy: CommandlineExecFilePolicyShape = {
    executor: "exec_file",
    commandMatchType: "argv_prefix",
    program: "python",
    argvPrefix: ["-m"],
  }
  assert.ok(
    commandlinePolicyAllows(policy, {
      kind: "exec_file",
      program: "python3",
      argv: ["-m", "pytest"],
    })
  )
})

test("commandlinePolicyAllows: kind mismatch fails closed", () => {
  const execFile: CommandlineExecFilePolicyShape = {
    executor: "exec_file",
    commandMatchType: "argv_exact",
    program: "git",
    argvPrefix: [],
  }
  // shell request against exec_file policy
  assert.equal(
    commandlinePolicyAllows(execFile, {
      kind: "shell",
      executor: "bash",
      command: "git",
    }),
    null
  )
  const shell: CommandlineShellPolicyShape = {
    executor: "bash",
    commandMatchType: "exact",
    commandText: "git",
  }
  // exec_file request against shell policy
  assert.equal(
    commandlinePolicyAllows(shell, {
      kind: "exec_file",
      program: "git",
      argv: [],
    }),
    null
  )
})

test("commandlinePolicyAllows: win32 platform + policy.workingDirectory => null", () => {
  const policy: CommandlineShellPolicyShape = {
    executor: "bash",
    commandMatchType: "exact",
    commandText: "ls",
    workingDirectory: "/repo",
  }
  assert.equal(
    commandlinePolicyAllows(policy, {
      kind: "shell",
      executor: "bash",
      command: "ls",
      platform: "win32",
    }),
    null
  )
})

test("commandlinePolicyAllows: win32 platform + request.workingDirectory but no policy.workingDirectory => null", () => {
  const policy: CommandlineShellPolicyShape = {
    executor: "bash",
    commandMatchType: "exact",
    commandText: "ls",
  }
  // Request tries to sneak a cwd in on Windows; matcher must deny.
  assert.equal(
    commandlinePolicyAllows(policy, {
      kind: "shell",
      executor: "bash",
      command: "ls",
      workingDirectory: "C:\\Users\\x",
      platform: "win32",
    }),
    null
  )
})

test("commandlinePolicyAllows: undefined platform does not trigger Windows guard", () => {
  // Even with workingDirectory present, no platform means we don't apply the
  // Windows-specific check; matcher falls through to normal path-prefix.
  const policy: CommandlineShellPolicyShape = {
    executor: "bash",
    commandMatchType: "exact",
    commandText: "ls",
    workingDirectory: "/repo",
  }
  assert.ok(
    commandlinePolicyAllows(policy, {
      kind: "shell",
      executor: "bash",
      command: "ls",
      workingDirectory: "/repo/subdir",
    })
  )
})

// ─────────────────────────── serializer round-trip ───────────────────────────

test("serializeCommandlinePolicyToWire / parseCommandlinePolicyFromWire: shell branch", () => {
  const original = {
    executor: "bash" as const,
    commandMatchType: "exact" as const,
    commandText: "git status",
    workingDirectory: "/repo",
    allowBundledToolchain: true,
    allowedEnv: ["NODE_OPTIONS"],
  }
  const wire = serializeCommandlinePolicyToWire(original)
  assert.equal(wire.executor, "bash")
  assert.equal((wire as { command_text?: string }).command_text, "git status")
  assert.equal(
    (wire as { allow_bundled_toolchain?: boolean }).allow_bundled_toolchain,
    true
  )
  const roundTrip = parseCommandlinePolicyFromWire(wire)
  assert.deepEqual(roundTrip, original)
})

test("serializeCommandlinePolicyToWire / parseCommandlinePolicyFromWire: exec_file branch", () => {
  const original = {
    executor: "exec_file" as const,
    commandMatchType: "argv_prefix" as const,
    program: "git",
    argvPrefix: ["log"],
    workingDirectory: "/repo",
    allowBundledToolchain: true,
    allowedEnv: [],
  }
  const wire = serializeCommandlinePolicyToWire(original)
  assert.equal(wire.executor, "exec_file")
  assert.equal((wire as { program?: string }).program, "git")
  assert.deepEqual((wire as { argv_prefix?: string[] }).argv_prefix, ["log"])
  const roundTrip = parseCommandlinePolicyFromWire(wire)
  assert.deepEqual(roundTrip, original)
})

test("parseCommandlinePolicyFromWire: rejects unknown executor", () => {
  assert.throws(() =>
    parseCommandlinePolicyFromWire({
      executor: "fish",
      command_match_type: "exact",
    } as unknown)
  )
})

test("commandlinePolicyAllows: requiresBundled=true requires grant.allowBundledToolchain=true", () => {
  // Regression for the "approved-but-unrunnable" hole: when the API
  // decides the current call needs bundled fallback (e.g. system lacks
  // node), an older grant that approved the same command WITHOUT
  // allowBundledToolchain must NOT count as covering — otherwise the
  // server skips the new auth request, signs the envelope with the old
  // grant, and the device fails at execution.
  const grantNoBundle: CommandlineExecFilePolicyShape = {
    executor: "exec_file",
    commandMatchType: "argv_exact",
    program: "node",
    argvPrefix: ["--version"],
    // allowBundledToolchain intentionally undefined
  }
  const grantWithBundle: CommandlineExecFilePolicyShape = {
    ...grantNoBundle,
    allowBundledToolchain: true,
  }
  const requestNeedsBundle = {
    kind: "exec_file" as const,
    program: "node",
    argv: ["--version"],
    requiresBundled: true,
  }
  // Old grant (no bundle) MUST NOT cover a bundle-required request.
  assert.equal(commandlinePolicyAllows(grantNoBundle, requestNeedsBundle), null)
  // New grant (with bundle) covers.
  assert.ok(commandlinePolicyAllows(grantWithBundle, requestNeedsBundle))
  // A request that DOESN'T require bundle is fine with either grant
  // (back-compat — we only tighten when the API explicitly asks).
  const requestNoBundleNeeded = {
    kind: "exec_file" as const,
    program: "node",
    argv: ["--version"],
  }
  assert.ok(commandlinePolicyAllows(grantNoBundle, requestNoBundleNeeded))
  assert.ok(commandlinePolicyAllows(grantWithBundle, requestNoBundleNeeded))
})
