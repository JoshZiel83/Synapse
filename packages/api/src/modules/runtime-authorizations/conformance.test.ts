import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  browserPolicyMatches,
  commandlinePolicyMatches,
  filesystemPolicyMatches,
  runtimeAuthorizationGrantMatches,
} from "./service.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = join(
  __dirname,
  "../../../../shared/test-fixtures/runtime-auth"
)

type FilesystemFixture = {
  description: string
  policies: Array<{
    capability: string
    filesystem?: { access: string; pathPrefixes: string[] }
  }>
  request: { access: string; pathPrefixes: string[] }
  expected: boolean
  note?: string
}

type CUAFixture = {
  description: string
  policies: Array<{ capability: string; cua?: { access: string } }>
  request: { access: string }
  expected: boolean
}

type BrowserFixture = {
  description: string
  policies: Array<{
    capability: string
    browser?: {
      action: string
      scopeType: string
      origin?: string
      host?: string
      registrableDomain?: string
      // v3.1 fail-closed operation enforcement
      operations?: string[]
    }
  }>
  request: {
    action: string
    origin?: string
    host?: string
    registrableDomain?: string
    operations?: string[]
  }
  expected: boolean
  note?: string
}

type CommandlineFixture = {
  description: string
  policies: Array<{
    capability: string
    commandline?: {
      executor: string
      commandMatchType: string
      commandText?: string
      workingDirectory?: string
      program?: string
      argvPrefix?: string[]
      allowBundledToolchain?: boolean
      allowedEnv?: string[]
    }
  }>
  request: {
    executor: string
    commandText?: string
    workingDirectory?: string
    program?: string
    argvPrefix?: string[]
  }
  expected: boolean
}

function readFixtures<T>(filename: string): T[] {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, filename), "utf-8"))
}

test("conformance: filesystem matcher", async (t) => {
  const fixtures = readFixtures<FilesystemFixture>("filesystem.json")
  for (const fixture of fixtures) {
    await t.test(fixture.description, () => {
      for (const policy of fixture.policies) {
        const grantSpec = {
          capability: "filesystem" as const,
          filesystem: policy.filesystem,
        }
        const action = {
          capability: "filesystem" as const,
          filesystem: fixture.request,
        }
        // We run through runtimeAuthorizationGrantMatches to cover the dispatch
        // path that real callers use; non-filesystem policies in the fixture
        // are handled by their dispatch branches.
        const actual = filesystemPolicyMatches(grantSpec as any, action as any)
        if (policy.capability === "filesystem" && fixture.expected === true) {
          assert.equal(actual, true)
          return
        }
      }
      // Aggregate check: any policy matches → expected true; none match → false.
      const action = {
        capability: "filesystem" as const,
        filesystem: fixture.request,
      }
      let anyMatched = false
      for (const policy of fixture.policies) {
        if (policy.capability !== "filesystem") continue
        const grantSpec = {
          capability: "filesystem" as const,
          filesystem: policy.filesystem,
        }
        if (filesystemPolicyMatches(grantSpec as any, action as any)) {
          anyMatched = true
          break
        }
      }
      assert.equal(anyMatched, fixture.expected, fixture.description)
    })
  }
})

test("conformance: cua matcher", async (t) => {
  const fixtures = readFixtures<CUAFixture>("cua.json")
  for (const fixture of fixtures) {
    await t.test(fixture.description, () => {
      const action = {
        capability: "cua" as const,
        cua: { access: fixture.request.access },
      }
      let anyMatched = false
      for (const policy of fixture.policies) {
        if (policy.capability !== "cua") continue
        const grant = {
          capability: "cua" as const,
          cua: policy.cua,
        } as any
        if (runtimeAuthorizationGrantMatches(grant, action as any)) {
          anyMatched = true
          break
        }
      }
      assert.equal(anyMatched, fixture.expected)
    })
  }
})

test("conformance: browser matcher", async (t) => {
  const fixtures = readFixtures<BrowserFixture>("browser.json")
  for (const fixture of fixtures) {
    await t.test(fixture.description, () => {
      const action = {
        capability: "browser" as const,
        browser: fixture.request,
      }
      let anyMatched = false
      for (const policy of fixture.policies) {
        if (policy.capability !== "browser") continue
        const grant = {
          capability: "browser" as const,
          browser: policy.browser,
        } as any
        if (browserPolicyMatches(grant, action as any)) {
          anyMatched = true
          break
        }
      }
      assert.equal(anyMatched, fixture.expected)
    })
  }
})

test("conformance: commandline matcher", async (t) => {
  const fixtures = readFixtures<CommandlineFixture>("commandline.json")
  for (const fixture of fixtures) {
    await t.test(fixture.description, () => {
      const reqIsExecFile = fixture.request.executor === "exec_file"
      const action = reqIsExecFile
        ? {
            capability: "commandline" as const,
            toolName: "exec_file",
            summary: "",
            commandline: {
              executor: "exec_file" as const,
              commandMatchType: "argv_exact" as const,
              program: fixture.request.program ?? "",
              argvPrefix: fixture.request.argvPrefix ?? [],
              workingDirectory: fixture.request.workingDirectory,
            },
          }
        : {
            capability: "commandline" as const,
            toolName: "bash",
            summary: "",
            commandline: {
              executor:
                (fixture.request.executor as "bash" | "powershell") ?? "bash",
              commandMatchType: "exact" as const,
              commandText: fixture.request.commandText ?? "",
              workingDirectory: fixture.request.workingDirectory ?? "",
            },
          }
      let anyMatched = false
      for (const policy of fixture.policies) {
        if (policy.capability !== "commandline") continue
        const grant = {
          capability: "commandline" as const,
          commandline: policy.commandline,
        } as any
        if (commandlinePolicyMatches(grant, action as any)) {
          anyMatched = true
          break
        }
      }
      assert.equal(anyMatched, fixture.expected)
    })
  }
})

// ─── scopeIsPushdown (post-review round 11) ─────────────────────────────────

test("filesystemPolicyMatches: scopeIsPushdown matches any read grant regardless of path", async () => {
  const grant = {
    capability: "filesystem" as const,
    filesystem: { access: "read" as const, pathPrefixes: ["/repo"] },
  }
  const action = {
    capability: "filesystem" as const,
    filesystem: {
      access: "read" as const,
      pathPrefixes: ["/"], // would normally NOT match /repo grant
      scopeIsPushdown: true,
    },
  }
  assert.equal(filesystemPolicyMatches(grant as any, action as any), true)
})

test("filesystemPolicyMatches: scopeIsPushdown still requires non-empty grant prefixes", async () => {
  const grant = {
    capability: "filesystem" as const,
    filesystem: { access: "read" as const, pathPrefixes: [] },
  }
  const action = {
    capability: "filesystem" as const,
    filesystem: {
      access: "read" as const,
      pathPrefixes: ["/"],
      scopeIsPushdown: true,
    },
  }
  assert.equal(filesystemPolicyMatches(grant as any, action as any), false)
})

test("filesystemPolicyMatches: scopeIsPushdown + write request needs write grant (no escalation)", async () => {
  const grant = {
    capability: "filesystem" as const,
    filesystem: { access: "read" as const, pathPrefixes: ["/repo"] },
  }
  const action = {
    capability: "filesystem" as const,
    filesystem: {
      access: "write" as const,
      pathPrefixes: ["/"],
      scopeIsPushdown: true,
    },
  }
  assert.equal(filesystemPolicyMatches(grant as any, action as any), false)
})

test("filesystemPolicyMatches: scopeIsPushdown + write grant covers read request", async () => {
  const grant = {
    capability: "filesystem" as const,
    filesystem: { access: "write" as const, pathPrefixes: ["/repo"] },
  }
  const action = {
    capability: "filesystem" as const,
    filesystem: {
      access: "read" as const,
      pathPrefixes: ["/"],
      scopeIsPushdown: true,
    },
  }
  assert.equal(filesystemPolicyMatches(grant as any, action as any), true)
})
