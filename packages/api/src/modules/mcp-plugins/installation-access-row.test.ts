import test from "node:test"
import assert from "node:assert/strict"
import {
  installationAccessRowToTarget,
  type InstallationAccessRow,
} from "./service.js"

// Regression for the CamelCasePlugin raw-result-key bug: listPluginInstallationAccessRows
// is a Kysely builder query, but CamelCasePlugin.transformResult camelCases every
// top-level result key unconditionally — so the rows arrive camelCased and
// installationAccessRowToTarget MUST read camelCase keys. The earlier snake_case reads
// (row.access_target_type / row.actor_id / …) were undefined at runtime, so the switch
// fell through and returned an undefined target (silent grant-target loss).
function rowFixture(
  over: Partial<InstallationAccessRow>
): InstallationAccessRow {
  return {
    id: "g1",
    workspaceId: "w1",
    installationId: "i1",
    accessTargetType: "workspace",
    conversationId: null,
    actorId: null,
    remoteAgentId: null,
    workspaceMemberId: null,
    conversationTypeMaskOverride: null,
    status: "active",
    source: "manual",
    createdByWorkspaceMemberId: null,
    reason: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    revokedAt: null,
    ...over,
  } as InstallationAccessRow
}

test("installationAccessRowToTarget reads camelCase keys (CamelCasePlugin raw-result regression)", () => {
  const actorTarget = installationAccessRowToTarget(
    rowFixture({
      accessTargetType: "actor",
      actorId: "a1",
      conversationId: "c1",
    })
  )
  assert.equal(actorTarget.subject.kind, "actor")
  assert.equal((actorTarget.subject as { actorId: string }).actorId, "a1")
  assert.equal(actorTarget.scope?.kind, "conversation")

  const workspaceTarget = installationAccessRowToTarget(
    rowFixture({ accessTargetType: "workspace" })
  )
  assert.equal(workspaceTarget.subject.kind, "workspace")
  assert.equal(
    (workspaceTarget.subject as { workspaceId: string }).workspaceId,
    "w1"
  )

  const remoteTarget = installationAccessRowToTarget(
    rowFixture({ accessTargetType: "remote_agent", remoteAgentId: "ra1" })
  )
  assert.equal(remoteTarget.subject.kind, "remote_agent")
  assert.equal(
    (remoteTarget.subject as { remoteAgentId: string }).remoteAgentId,
    "ra1"
  )
})
