import type {
  WorkspaceAccessBindingsAccessKey,
  WorkspaceMembersTrustLevel,
} from "../../infrastructure/database/generated/db.js"
import type {
  TableInsert,
  TableRow,
} from "../../infrastructure/database/kysely.js"

/**
 * Workspace data-access types. The ONLY workspace (non-invite) file allowed to
 * touch `generated/db` / `TableRow` (guard-layering r1/r2). Column-derived row
 * shapes and DB enum aliases live here so the service/controller and presenter
 * consume structural types without reaching into the DB layer. See §5.1 / §9.
 */

export type WorkspaceAccessKey = WorkspaceAccessBindingsAccessKey
export type WorkspaceTrustLevel = WorkspaceMembersTrustLevel

export type WorkspaceViewRow = Pick<
  TableRow<"workspaces">,
  | "id"
  | "name"
  | "slug"
  | "description"
  | "ownerId"
  | "isTrusted"
  | "createdAt"
  | "updatedAt"
>

export type WorkspaceListRow = WorkspaceViewRow & {
  currentWorkspaceMemberId?: string | null
  trustLevel?: string | null
}

export type WorkspaceMemberViewRow = Pick<
  TableRow<"workspaceMembers">,
  "id" | "workspaceId" | "userId" | "trustLevel" | "joinedAt"
> & {
  ownerId?: string | null
  accessKeys?: string[] | null
}

export type ActorRecord = TableRow<"actors">

export type ActorsConfig = TableInsert<"actors">["config"]
export type ActorVersionsConfig = TableInsert<"actorVersions">["config"]

export type WorkspaceChiefActorPreferenceRow = {
  workspaceId: string
  workspaceMemberId: string
  chiefActorId: string | null
  createdAt: Date
  updatedAt: Date
  chiefActorDisplayName: string | null
  chiefActorRole: string | null
  chiefActorTitle: string | null
  chiefActorAvatarFileId: string | null
}
