import assert from "node:assert/strict"
import test from "node:test"
import {
  RUNTIME_AUTHORIZATION_CAPABILITIES,
  SUBJECT_KIND,
} from "@synapse/shared"
import {
  InvalidGrantSubjectRowError,
  runtimeAuthorizationGrantPolicyCapability,
  runtimeAuthorizationGrantRowToCandidate,
} from "./repo.js"
import { mapRuntimeAuthorizationGrantCandidate } from "./presenter.js"
import type { RuntimeAuthorizationGrantCandidateRow } from "./repo.types.js"

const [filesystemCapability] = RUNTIME_AUTHORIZATION_CAPABILITIES

function grantRow(
  overrides: Partial<RuntimeAuthorizationGrantCandidateRow> = {}
): RuntimeAuthorizationGrantCandidateRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    workspaceId: "00000000-0000-4000-8000-000000000002",
    deviceId: "00000000-0000-4000-8000-000000000003",
    deviceCapabilityId: "00000000-0000-4000-8000-000000000004",
    deviceExposureId: "00000000-0000-4000-8000-000000000005",
    subjectId: "00000000-0000-4000-8000-000000000006",
    scopeSubjectId: null,
    createdByWorkspaceMemberId: null,
    sourceTaskId: null,
    retention: "until_revoked",
    status: "active",
    policy: {
      capability: filesystemCapability,
      filesystem: { access: "read", pathPrefixes: ["/tmp"] },
    },
    sourceRetryNonce: null,
    sourceRuntimeSessionId: null,
    sourceRequestArgs: {},
    consumedAt: null,
    revokedAt: null,
    supersededAt: null,
    createdAt: new Date("2026-06-13T00:00:00.000Z"),
    updatedAt: new Date("2026-06-13T00:00:00.000Z"),
    subjectKind: SUBJECT_KIND.WORKSPACE,
    subjectWorkspaceId: "00000000-0000-4000-8000-000000000002",
    subjectWorkspaceMemberId: null,
    subjectActorId: null,
    subjectRemoteAgentId: null,
    subjectConversationId: null,
    scopeKind: null,
    scopeWorkspaceId: null,
    scopeConversationId: null,
    ...overrides,
  } as RuntimeAuthorizationGrantCandidateRow
}

test("runtimeAuthorizationGrantRowToCandidate parses and validates policy JSON at repo exit", () => {
  const candidate = runtimeAuthorizationGrantRowToCandidate(grantRow())

  assert.equal(candidate.subject.kind, SUBJECT_KIND.WORKSPACE)
  assert.equal(candidate.policyValidationResult.ok, true)
  if (!candidate.policyValidationResult.ok) {
    throw new Error("expected valid policy")
  }
  assert.equal(
    candidate.policyValidationResult.parsed.capability,
    filesystemCapability
  )
  assert.deepEqual(candidate.policyValidationResult.parsed.filesystem, {
    access: "read",
    pathPrefixes: ["/tmp"],
  })
})

test("runtimeAuthorizationGrantRowToCandidate decodes source request args at repo exit", () => {
  const candidate = runtimeAuthorizationGrantRowToCandidate(
    grantRow({
      sourceRequestArgs: JSON.stringify({
        path: "/tmp/report.txt",
        recursive: false,
      }),
    })
  )
  assert.equal(candidate.policyValidationResult.ok, true)
  if (!candidate.policyValidationResult.ok) {
    throw new Error("expected valid policy")
  }

  assert.deepEqual(candidate.rawRow.sourceRequestArgs, {
    path: "/tmp/report.txt",
    recursive: false,
  })

  const record = mapRuntimeAuthorizationGrantCandidate(
    candidate,
    candidate.policyValidationResult.parsed
  )
  assert.deepEqual(record.sourceRequestArgs, {
    path: "/tmp/report.txt",
    recursive: false,
  })
})

test("runtimeAuthorizationGrantRowToCandidate reports branch-level corrupt policy without throwing", () => {
  const candidate = runtimeAuthorizationGrantRowToCandidate(
    grantRow({
      policy: { capability: filesystemCapability },
    })
  )

  assert.equal(candidate.policyValidationResult.ok, false)
  if (candidate.policyValidationResult.ok) {
    throw new Error("expected invalid policy")
  }
  assert.equal(
    candidate.policyValidationResult.failure.kind,
    "missing_branch_payload"
  )
  assert.equal(
    candidate.policyValidationResult.failure.capability,
    filesystemCapability
  )
})

test("runtimeAuthorizationGrantRowToCandidate reports malformed policy JSON without throwing", () => {
  const candidate = runtimeAuthorizationGrantRowToCandidate(
    grantRow({
      policy: "not json",
    })
  )

  assert.equal(candidate.policyValidationResult.ok, false)
  if (candidate.policyValidationResult.ok) {
    throw new Error("expected invalid policy")
  }
  assert.equal(candidate.policyValidationResult.failure.kind, "parse_error")
  assert.match(
    candidate.policyValidationResult.failure.issues[0]?.message ?? "",
    /runtime authorization grant policy must be valid JSON/
  )
})

test("runtimeAuthorizationGrantRowToCandidate reports non-object policy JSON without throwing", () => {
  const candidate = runtimeAuthorizationGrantRowToCandidate(
    grantRow({
      policy: JSON.stringify(["not", "an", "object"]),
    })
  )

  assert.equal(candidate.policyValidationResult.ok, false)
  if (candidate.policyValidationResult.ok) {
    throw new Error("expected invalid policy")
  }
  assert.equal(candidate.policyValidationResult.failure.kind, "parse_error")
  assert.match(
    candidate.policyValidationResult.failure.issues[0]?.message ?? "",
    /runtime authorization grant policy must be a JSON object/
  )
})

test("runtimeAuthorizationGrantRowToCandidate rejects malformed source request args at repo exit", () => {
  assert.throws(
    () =>
      runtimeAuthorizationGrantRowToCandidate(
        grantRow({
          sourceRequestArgs: "not json",
        })
      ),
    /runtime authorization grant sourceRequestArgs must be valid JSON/
  )
})

test("runtimeAuthorizationGrantRowToCandidate rejects non-object source request args at repo exit", () => {
  assert.throws(
    () =>
      runtimeAuthorizationGrantRowToCandidate(
        grantRow({
          sourceRequestArgs: JSON.stringify(["not", "an", "object"]),
        })
      ),
    /runtime authorization grant sourceRequestArgs must be a JSON object/
  )
})

test("runtimeAuthorizationGrantRowToCandidate rejects corrupt joined subject rows", () => {
  assert.throws(
    () =>
      runtimeAuthorizationGrantRowToCandidate(
        grantRow({ subjectWorkspaceId: null })
      ),
    InvalidGrantSubjectRowError
  )
})

test("runtimeAuthorizationGrantPolicyCapability reads capability through repo-owned JSON decode", () => {
  assert.equal(
    runtimeAuthorizationGrantPolicyCapability(
      JSON.stringify({ capability: filesystemCapability })
    ),
    filesystemCapability
  )
  assert.equal(runtimeAuthorizationGrantPolicyCapability("not json"), undefined)
  assert.equal(
    runtimeAuthorizationGrantPolicyCapability(JSON.stringify(["array"])),
    undefined
  )
})
