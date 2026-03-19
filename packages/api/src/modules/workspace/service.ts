import crypto from "node:crypto";
import type pg from "pg";
import { query, transaction } from "../../infrastructure/database/index.js";
import { getFileUrl } from "../../infrastructure/storage/index.js";
import {
  AUTHZ_PLATFORM_ID,
  deleteRelation,
  flushAuthzOutboxEntries,
  queueAuthzRelationships,
  touchRelation,
} from "../../infrastructure/authz/index.js";
import {
  SECRETARY_DEFAULT_DOCS,
  type WorkspaceChiefActorPreference,
} from "@synapse/shared";
import { listAuthorizedResourceIds, userSubject } from "../access/service.js";

export interface CreateWorkspaceInput {
  name: string;
  description?: string;
  userId: string;
}

export interface AddMemberInput {
  workspaceId: string;
  userId: string;
  trustLevel: "admin" | "member" | "guest";
}

export type WorkspaceAccessKey =
  | "model_admin"
  | "actor_admin"
  | "skill_admin"
  | "plugin_admin"
  | "memory_admin"
  | "relay_admin"
  | "conversation_admin";

function workspaceRelationFromTrustLevel(
  trustLevel: "owner" | "admin" | "member" | "guest",
) {
  return trustLevel;
}

async function flushQueuedAuthzEntries(entryIds: string[], source: string) {
  if (entryIds.length === 0) return;

  try {
    await flushAuthzOutboxEntries(entryIds);
  } catch (error) {
    console.error(
      `[authz] Failed to flush ${source} relationship updates:`,
      error,
    );
  }
}

function generateSlug(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const suffix = crypto.randomBytes(4).toString("hex");
  return `${base}-${suffix}`;
}

export async function createWorkspace(input: CreateWorkspaceInput) {
  const slug = generateSlug(input.name);
  const secretaryDocs = SECRETARY_DEFAULT_DOCS;
  const secretarySpecialties = ["delegation", "reporting", "organization"];

  const result = await transaction(async (client: pg.PoolClient) => {
    // 1. Create workspace
    const wsResult = await client.query(
      `INSERT INTO workspaces (name, slug, description, owner_id)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [input.name, slug, input.description ?? null, input.userId],
    );
    const workspace = wsResult.rows[0];

    // 2. Add creator as owner member
    await client.query(
      `INSERT INTO workspace_members (workspace_id, user_id, trust_level)
       VALUES ($1, $2, 'owner')`,
      [workspace.id, input.userId],
    );

    // 3. Auto-create secretary actor
    const secretaryResult = await client.query(
      `INSERT INTO actors (
         workspace_id,
         name,
         role,
         title,
         parent_id,
         can_represent_user,
         specialties,
         config,
         current_version,
         created_by
       )
       VALUES ($1, $2, $3, $4, NULL, FALSE, $5, '{}'::jsonb, 1, $6)
       RETURNING *`,
      [
        workspace.id,
        "Secretary",
        "secretary",
        "Personal Secretary",
        secretarySpecialties,
        input.userId,
      ],
    );
    const secretary = secretaryResult.rows[0];

    // 4. Create initial actor_versions record for secretary
    const actorVersionResult = await client.query<{ id: string }>(
      `INSERT INTO actor_versions (
         actor_id,
         version,
         name,
         role,
         title,
         avatar_blob_id,
         parent_id,
         can_represent_user,
         specialties,
         config,
         created_by
       )
       VALUES ($1, 1, $2, $3, $4, NULL, NULL, FALSE, $5, '{}'::jsonb, $6)
       RETURNING id`,
      [
        secretary.id,
        secretary.name,
        secretary.role,
        secretary.title,
        secretarySpecialties,
        input.userId,
      ],
    );
    const actorVersionId = actorVersionResult.rows[0]!.id;

    for (const doc of secretaryDocs) {
      await client.query(
        `INSERT INTO actor_version_docs (
           actor_version_id,
           doc_key,
           title,
           visibility,
           priority,
           content_blocks
         )
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          actorVersionId,
          doc.key,
          doc.title,
          doc.visibility,
          doc.priority,
          JSON.stringify(doc.content),
        ],
      );
    }

    const authzEntryIds = await queueAuthzRelationships(
      client,
      [
        touchRelation(
          "platform",
          AUTHZ_PLATFORM_ID,
          "workspace",
          "workspace",
          workspace.id,
        ),
        touchRelation(
          "workspace",
          workspace.id,
          "platform",
          "platform",
          AUTHZ_PLATFORM_ID,
        ),
        touchRelation(
          "workspace",
          workspace.id,
          workspaceRelationFromTrustLevel("owner"),
          "user",
          input.userId,
        ),
        touchRelation(
          "workspace",
          workspace.id,
          "actor",
          "actor",
          secretary.id,
        ),
        touchRelation(
          "actor",
          secretary.id,
          "workspace",
          "workspace",
          workspace.id,
        ),
        touchRelation("actor", secretary.id, "owner", "user", input.userId),
        touchRelation(
          "actor",
          secretary.id,
          "discover_workspace",
          "workspace",
          workspace.id,
        ),
        touchRelation(
          "actor",
          secretary.id,
          "invoke_workspace",
          "workspace",
          workspace.id,
        ),
        touchRelation(
          "actor",
          secretary.id,
          "receive_workspace",
          "workspace",
          workspace.id,
        ),
      ],
      {
        source: "workspace.create",
        workspaceId: workspace.id,
        userId: input.userId,
      },
    );

    return {
      workspace: mapWorkspaceRow(workspace),
      secretary: mapActorRow(secretary, secretaryDocs),
      authzEntryIds,
    };
  });

  await flushQueuedAuthzEntries(result.authzEntryIds, "workspace.create");

  return {
    ...result.workspace,
    secretary: result.secretary,
  };
}

export async function listUserWorkspaces(userId: string) {
  const workspaceIds = await listAuthorizedResourceIds({
    subject: userSubject(userId),
    action: "workspace.view",
  });

  if (workspaceIds.length === 0) {
    return [];
  }

  const result = await query(
    `SELECT w.*, wm.trust_level
     FROM workspaces w
     LEFT JOIN workspace_members wm
       ON wm.workspace_id = w.id
      AND wm.user_id = $1
     WHERE w.id = ANY($2)
     ORDER BY w.created_at DESC`,
    [userId, workspaceIds],
  );
  return result.rows.map((row) => ({
    ...mapWorkspaceRow(row),
    trustLevel: row.trust_level ?? null,
  }));
}

export async function getWorkspaceById(workspaceId: string) {
  const result = await query("SELECT * FROM workspaces WHERE id = $1", [
    workspaceId,
  ]);
  return result.rows.length > 0 ? mapWorkspaceRow(result.rows[0]) : null;
}

export async function getWorkspaceChiefActorPreference(
  workspaceId: string,
  userId: string,
): Promise<WorkspaceChiefActorPreference> {
  const result = await query(
    `SELECT
        pref.workspace_id,
        pref.user_id,
        pref.chief_actor_id,
        pref.created_at,
        pref.updated_at,
        a.name AS chief_actor_name,
        a.role AS chief_actor_role,
        a.title AS chief_actor_title,
        avatar_file.stored_name AS chief_actor_avatar_stored_name
     FROM workspace_user_preferences pref
     LEFT JOIN actors a
       ON a.id = pref.chief_actor_id
      AND a.workspace_id = pref.workspace_id
      AND a.is_active = TRUE
     LEFT JOIN files avatar_file
       ON avatar_file.id = a.avatar_file_id
     WHERE pref.workspace_id = $1
       AND pref.user_id = $2
     LIMIT 1`,
    [workspaceId, userId],
  );

  const row = result.rows[0];
  if (!row) {
    return {
      workspaceId,
      userId,
    };
  }

  return mapWorkspaceChiefActorPreferenceRow(row);
}

export async function updateWorkspaceChiefActorPreference(
  workspaceId: string,
  userId: string,
  chiefActorId?: string | null,
): Promise<WorkspaceChiefActorPreference> {
  if (!chiefActorId) {
    await query(
      `DELETE FROM workspace_user_preferences
       WHERE workspace_id = $1
         AND user_id = $2`,
      [workspaceId, userId],
    );

    return {
      workspaceId,
      userId,
    };
  }

  const actorResult = await query(
    `SELECT id
     FROM actors
     WHERE id = $1
       AND workspace_id = $2
       AND is_active = TRUE
     LIMIT 1`,
    [chiefActorId, workspaceId],
  );

  if (actorResult.rows.length === 0) {
    throw new Error("Chief actor is not available in this workspace");
  }

  await query(
    `INSERT INTO workspace_user_preferences
       (workspace_id, user_id, chief_actor_id, created_at, updated_at)
     VALUES ($1, $2, $3, NOW(), NOW())
     ON CONFLICT (workspace_id, user_id)
     DO UPDATE SET
       chief_actor_id = EXCLUDED.chief_actor_id,
       updated_at = NOW()`,
    [workspaceId, userId, chiefActorId],
  );

  return getWorkspaceChiefActorPreference(workspaceId, userId);
}

export async function updateWorkspace(
  workspaceId: string,
  updates: { name?: string; description?: string },
) {
  const fields: string[] = [];
  const values: any[] = [];
  let idx = 1;

  if (updates.name !== undefined) {
    fields.push(`name = $${idx++}`);
    values.push(updates.name);
  }
  if (updates.description !== undefined) {
    fields.push(`description = $${idx++}`);
    values.push(updates.description);
  }

  if (fields.length === 0) {
    return getWorkspaceById(workspaceId);
  }

  values.push(workspaceId);
  const result = await query(
    `UPDATE workspaces SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`,
    values,
  );
  return result.rows.length > 0 ? mapWorkspaceRow(result.rows[0]) : null;
}

export async function checkMembership(workspaceId: string, userId: string) {
  const result = await query(
    "SELECT trust_level FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
    [workspaceId, userId],
  );
  return result.rows.length > 0 ? (result.rows[0].trust_level as string) : null;
}

export async function addMember(input: AddMemberInput) {
  const result = await transaction(async (client: pg.PoolClient) => {
    const memberResult = await client.query(
      `INSERT INTO workspace_members (workspace_id, user_id, trust_level)
       VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, user_id) DO NOTHING
       RETURNING *`,
      [input.workspaceId, input.userId, input.trustLevel],
    );

    if (memberResult.rows.length === 0) {
      return null;
    }

    const authzEntryIds = await queueAuthzRelationships(
      client,
      [
        touchRelation(
          "workspace",
          input.workspaceId,
          workspaceRelationFromTrustLevel(input.trustLevel),
          "user",
          input.userId,
        ),
      ],
      {
        source: "workspace.add_member",
        workspaceId: input.workspaceId,
        userId: input.userId,
        trustLevel: input.trustLevel,
      },
    );

    return {
      member: mapMemberRow(memberResult.rows[0]),
      authzEntryIds,
    };
  });

  if (!result) {
    return null;
  }

  await flushQueuedAuthzEntries(result.authzEntryIds, "workspace.add_member");
  return result.member;
}

export async function listMembers(workspaceId: string) {
  const result = await query(
    `SELECT
        wm.*,
        u.name AS user_name,
        u.email AS user_email,
        u.avatar_url,
        COALESCE(access_map.access_keys, '{}'::text[]) AS access_keys
     FROM workspace_members wm
     INNER JOIN users u ON u.id = wm.user_id
     LEFT JOIN (
       SELECT workspace_id, user_id, ARRAY_AGG(access_key ORDER BY access_key) AS access_keys
       FROM workspace_access_bindings
       GROUP BY workspace_id, user_id
     ) access_map
       ON access_map.workspace_id = wm.workspace_id
      AND access_map.user_id = wm.user_id
     WHERE wm.workspace_id = $1
     ORDER BY wm.joined_at ASC`,
    [workspaceId],
  );
  return result.rows.map((row) => ({
    ...mapMemberRow(row),
    userName: row.user_name,
    userEmail: row.user_email,
    avatarUrl: row.avatar_url ?? null,
    accessKeys: Array.isArray(row.access_keys) ? row.access_keys : [],
  }));
}

export async function listWorkspaceAccessBindings(workspaceId: string) {
  const result = await query(
    `SELECT
        wab.workspace_id,
        wab.user_id,
        wab.access_key,
        wab.assigned_by,
        wab.metadata,
        wab.created_at,
        wab.updated_at,
        u.name AS user_name,
        u.email AS user_email,
        u.avatar_url,
        wm.trust_level
     FROM workspace_access_bindings wab
     JOIN users u ON u.id = wab.user_id
     JOIN workspace_members wm
       ON wm.workspace_id = wab.workspace_id
      AND wm.user_id = wab.user_id
     WHERE wab.workspace_id = $1
     ORDER BY wab.access_key ASC, wab.created_at ASC`,
    [workspaceId],
  );

  return result.rows.map((row) => ({
    workspaceId: row.workspace_id,
    userId: row.user_id,
    accessKey: row.access_key as WorkspaceAccessKey,
    assignedBy: row.assigned_by ?? null,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    trustLevel: row.trust_level,
    userName: row.user_name,
    userEmail: row.user_email,
    avatarUrl: row.avatar_url ?? null,
  }));
}

export async function grantWorkspaceAccess(input: {
  workspaceId: string;
  userId: string;
  accessKey: WorkspaceAccessKey;
  assignedBy: string;
  metadata?: Record<string, unknown>;
}) {
  const membership = await query(
    `SELECT 1
     FROM workspace_members
     WHERE workspace_id = $1
       AND user_id = $2
     LIMIT 1`,
    [input.workspaceId, input.userId],
  );

  if (membership.rows.length === 0) {
    throw new Error("User is not a member of this workspace");
  }

  const result = await query(
    `INSERT INTO workspace_access_bindings (workspace_id, user_id, access_key, assigned_by, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (workspace_id, user_id, access_key) DO NOTHING
     RETURNING *`,
    [
      input.workspaceId,
      input.userId,
      input.accessKey,
      input.assignedBy,
      JSON.stringify(input.metadata || {}),
    ],
  );

  if (result.rows.length === 0) {
    throw new Error("Access already granted");
  }

  const authzEntryIds = await queueAccessBindingRelation({
    operation: "touch",
    workspaceId: input.workspaceId,
    userId: input.userId,
    accessKey: input.accessKey,
    source: "workspace.access.grant",
    metadata: {
      assignedBy: input.assignedBy,
      ...input.metadata,
    },
  });
  await flushQueuedAuthzEntries(authzEntryIds, "workspace.access.grant");

  return {
    workspaceId: result.rows[0].workspace_id,
    userId: result.rows[0].user_id,
    accessKey: result.rows[0].access_key as WorkspaceAccessKey,
    assignedBy: result.rows[0].assigned_by ?? null,
    metadata: result.rows[0].metadata ?? {},
    createdAt: result.rows[0].created_at,
    updatedAt: result.rows[0].updated_at,
  };
}

export async function revokeWorkspaceAccess(
  workspaceId: string,
  userId: string,
  accessKey: WorkspaceAccessKey,
) {
  const result = await query(
    `DELETE FROM workspace_access_bindings
     WHERE workspace_id = $1
       AND user_id = $2
       AND access_key = $3
     RETURNING workspace_id, user_id, access_key`,
    [workspaceId, userId, accessKey],
  );

  if (result.rows.length === 0) {
    throw new Error("Access grant not found");
  }

  const authzEntryIds = await queueAccessBindingRelation({
    operation: "delete",
    workspaceId,
    userId,
    accessKey,
    source: "workspace.access.revoke",
  });
  await flushQueuedAuthzEntries(authzEntryIds, "workspace.access.revoke");
}

// ── Row mappers ──

function mapWorkspaceRow(row: any) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description ?? null,
    ownerId: row.owner_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapActorRow(row: any, docs: typeof SECRETARY_DEFAULT_DOCS) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    definition: {
      name: row.name,
      role: row.role,
      title: row.title,
      avatarFileId: row.avatar_blob_id ?? undefined,
      parentId: row.parent_id ?? undefined,
      canRepresentUser: Boolean(row.can_represent_user),
      docs,
      specialties: Array.isArray(row.specialties) ? row.specialties : [],
      config: row.config
        ? typeof row.config === "string"
          ? JSON.parse(row.config)
          : row.config
        : {},
    },
    currentVersion: Number(row.current_version || 1),
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMemberRow(row: any) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    trustLevel: row.trust_level,
    accessKeys: Array.isArray(row.access_keys) ? row.access_keys : [],
    joinedAt: row.joined_at,
  };
}

function mapWorkspaceChiefActorPreferenceRow(
  row: any,
): WorkspaceChiefActorPreference {
  const chiefActorId =
    row.chief_actor_id && row.chief_actor_name ? row.chief_actor_id : undefined;

  return {
    workspaceId: row.workspace_id,
    userId: row.user_id,
    chiefActorId,
    chiefActor:
      chiefActorId && row.chief_actor_name
        ? {
            id: chiefActorId,
            name: row.chief_actor_name,
            role: row.chief_actor_role,
            title: row.chief_actor_title || row.chief_actor_role || "Actor",
            avatarUrl: row.chief_actor_avatar_stored_name
              ? getFileUrl(row.chief_actor_avatar_stored_name)
              : undefined,
          }
        : undefined,
    createdAt: row.created_at || undefined,
    updatedAt: row.updated_at || undefined,
  };
}

async function queueAccessBindingRelation(input: {
  operation: "touch" | "delete";
  workspaceId: string;
  userId: string;
  accessKey: WorkspaceAccessKey;
  source: string;
  metadata?: Record<string, unknown>;
}) {
  return transaction(async (client: pg.PoolClient) =>
    queueAuthzRelationships(
      client,
      [
        input.operation === "touch"
          ? touchRelation(
              "workspace",
              input.workspaceId,
              input.accessKey,
              "user",
              input.userId,
            )
          : deleteRelation(
              "workspace",
              input.workspaceId,
              input.accessKey,
              "user",
              input.userId,
            ),
      ],
      {
        source: input.source,
        workspaceId: input.workspaceId,
        userId: input.userId,
        accessKey: input.accessKey,
        ...(input.metadata || {}),
      },
    ),
  );
}
