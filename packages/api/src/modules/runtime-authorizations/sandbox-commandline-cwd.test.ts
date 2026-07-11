// P5a: the sandbox commandline authorization branch of commandlinePolicyMatches
// must default a request's omitted working_directory to the sandbox default
// (/conversation) BEFORE handing the cwd to the shared matcher — otherwise an
// omitted-cwd command is force-denied (sandboxPolicyAllows fail-closes on a
// missing cwd), which breaks the sandbox happy path (bare runs commands in
// /conversation by default). The shared matcher stays fail-closed on a cwd that
// is present but outside the mount points / on win32.

import test from "node:test"
import assert from "node:assert/strict"

import { commandlinePolicyMatches } from "./service.js"
import type {
  SharedRuntimeAuthorizationGrantSpec,
  RuntimeAuthorizationRequestedAction,
} from "@synapse/shared"

const sandboxGrant: SharedRuntimeAuthorizationGrantSpec = {
  capability: "commandline",
  // No workingDirectory cap → the whole sandbox (all mount points), exactly the
  // grant createSandboxGrants mints.
  commandline: { executor: "sandbox" },
}

function shellAction(
  workingDirectory?: string
): RuntimeAuthorizationRequestedAction {
  return {
    capability: "commandline",
    toolName: "bash",
    summary: "run a shell command",
    commandline: {
      executor: "bash",
      commandMatchType: "exact",
      commandText: "ls",
      ...(workingDirectory ? { workingDirectory } : {}),
    },
  }
}

test("P5a: omitted-cwd sandbox command authorizes against the /conversation default (not force-denied)", () => {
  const action = shellAction(/* no workingDirectory */)
  assert.equal(action.commandline?.workingDirectory, undefined)
  assert.equal(
    commandlinePolicyMatches(sandboxGrant, action, { platform: "linux" }),
    true,
    "an omitted cwd must default to /conversation and authorize"
  )
})

test("P5a: an explicit in-mount cwd still authorizes (default does not regress the happy path)", () => {
  assert.equal(
    commandlinePolicyMatches(sandboxGrant, shellAction("/actor/sub"), {
      platform: "linux",
    }),
    true
  )
})

test("P5a: matcher stays fail-closed — a cwd OUTSIDE the mount points is denied", () => {
  assert.equal(
    commandlinePolicyMatches(sandboxGrant, shellAction("/etc"), {
      platform: "linux",
    }),
    false,
    "the default only fills an OMITTED cwd; a present-but-outside cwd is denied"
  )
})

test("P5a: matcher stays fail-closed — win32 sandbox request is denied even with default cwd", () => {
  assert.equal(
    commandlinePolicyMatches(sandboxGrant, shellAction(), {
      platform: "win32",
    }),
    false,
    "bwrap sandbox is Linux-only; the default cwd must not open a win32 hole"
  )
})
