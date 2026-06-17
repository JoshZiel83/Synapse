import assert from "node:assert/strict"
import test from "node:test"
import { WorkspaceCreateResultViewSchema } from "@synapse/shared/schemas"
import { presentActorRow, presentWorkspaceRow } from "./presenter.js"
import type { ActorRecord, WorkspaceViewRow } from "./repo.types.js"

const workspaceId = "00000000-0000-4000-8000-000000000001"
const actorId = "00000000-0000-4000-8000-000000000002"
const docId = "00000000-0000-4000-8000-000000000003"
const NOW = new Date("2026-06-14T00:00:00.000Z")

test("presentActorRow consumes repo-decoded actor config for workspace create result", () => {
  const workspaceRow: WorkspaceViewRow = {
    id: workspaceId,
    name: "Acme",
    slug: "acme",
    description: "Workspace",
    ownerId: workspaceId,
    isTrusted: false,
    createdAt: NOW,
    updatedAt: NOW,
  }
  const actorRow: ActorRecord = {
    id: actorId,
    role: "secretary",
    title: "Workspace Secretary",
    avatarFileId: null,
    avatarEmoji: null,
    parentId: null,
    canRepresentUser: false,
    specialties: ["coordination"],
    config: { is_chief_actor: true },
    currentVersion: 1,
    isPublicShared: false,
    createdAt: NOW,
    updatedAt: NOW,
  }

  const secretary = presentActorRow({
    row: actorRow,
    workspaceId,
    displayName: "Workspace Secretary",
    docs: [
      {
        id: docId,
        key: "mission",
        title: "Mission",
        content: [
          {
            id: "00000000-0000-4000-8000-000000000004",
            type: "text",
            text: "Coordinate workspace work.",
          },
        ],
        visibility: "always",
        priority: 0,
      },
    ],
  })
  const result = {
    ...presentWorkspaceRow(workspaceRow),
    secretary,
  }

  assert.deepEqual(secretary.definition.config, { is_chief_actor: true })
  assert.ok(
    WorkspaceCreateResultViewSchema.safeParse(result).success,
    "presented workspace create result should match the shared app schema"
  )
})
