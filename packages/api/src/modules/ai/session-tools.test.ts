import test from "node:test"
import assert from "node:assert/strict"
import {
  buildUserTaskTargetCandidatesFromEntries,
  buildUserTaskTargetCandidatesFromRows,
} from "./session-tool-user-task-targets.js"

test("buildUserTaskTargetCandidatesFromRows uses workspace_member_id for participant rows", () => {
  const candidates = buildUserTaskTargetCandidatesFromRows([
    {
      id: "participant-1",
      participantType: "workspace_member",
      state: "active",
      userName: "Demo User",
      workspaceMemberId: "workspace-member-1",
    },
    {
      id: "participant-ignored",
      participantType: "actor",
      state: "active",
      userName: null,
      workspaceMemberId: null,
    },
  ])

  assert.deepEqual(candidates, [
    {
      participantId: "participant-1",
      workspaceMemberId: "workspace-member-1",
      name: "Demo User",
      label: '"Demo User" (user)',
    },
  ])
})

test("buildUserTaskTargetCandidatesFromEntries supports tool context workspace_member entries", () => {
  const candidates = buildUserTaskTargetCandidatesFromEntries([
    {
      participantType: "workspace_member",
      id: "workspace-member-2",
      participantId: "participant-2",
      name: "Resolve Context User",
    },
    {
      participantType: "external",
      id: "external-1",
      name: "External User",
    },
  ])

  assert.deepEqual(candidates, [
    {
      participantId: "participant-2",
      workspaceMemberId: "workspace-member-2",
      name: "Resolve Context User",
      label: '"Resolve Context User" (user)',
    },
  ])
})
