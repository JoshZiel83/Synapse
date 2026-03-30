import { query } from "../../infrastructure/database/index.js";

type ContactScope = "workspace" | "personal";
type ContactTargetType = "user" | "actor";

function targetKey(row: {
  target_type: ContactTargetType;
  target_workspace_id: string;
  target_user_id?: string | null;
  target_actor_id?: string | null;
}) {
  return row.target_type === "actor"
    ? `actor:${row.target_actor_id}`
    : `user:${row.target_user_id}:${row.target_workspace_id}`;
}

async function resolveActorTarget(actorId: string) {
  const result = await query(
    `SELECT a.id,
            a.workspace_id,
            a.name,
            a.title,
            a.role,
            a.avatar_emoji,
            avatar_file.stored_name AS avatar_stored_name,
            w.name AS workspace_name,
            w.slug AS workspace_slug
     FROM actors a
     JOIN workspaces w ON w.id = a.workspace_id
     LEFT JOIN files avatar_file ON avatar_file.id = a.avatar_file_id
     WHERE a.id = $1
       AND a.is_active = TRUE
     LIMIT 1`,
    [actorId],
  );
  return result.rows[0] ?? null;
}

async function resolveUserTarget(userId: string, targetWorkspaceId: string) {
  const result = await query(
    `SELECT u.id,
            u.name,
            u.email,
            u.avatar_file_id,
            wm.workspace_id,
            w.name AS workspace_name,
            w.slug AS workspace_slug
     FROM workspace_members wm
     JOIN users u ON u.id = wm.user_id
     JOIN workspaces w ON w.id = wm.workspace_id
     WHERE wm.workspace_id = $1
       AND wm.user_id = $2
     LIMIT 1`,
    [targetWorkspaceId, userId],
  );
  return result.rows[0] ?? null;
}

async function loadWorkspaceContactRecord(contactId: string) {
  const result = await query(
    `SELECT *
     FROM workspace_contacts
     WHERE id = $1
     LIMIT 1`,
    [contactId],
  );
  return result.rows[0] ?? null;
}

async function loadWorkspaceUserContactRecord(contactId: string) {
  const result = await query(
    `SELECT *
     FROM workspace_user_contacts
     WHERE id = $1
     LIMIT 1`,
    [contactId],
  );
  return result.rows[0] ?? null;
}

async function loadTargetWorkspace(workspaceId: string) {
  const result = await query(
    `SELECT id, name, slug
     FROM workspaces
     WHERE id = $1
     LIMIT 1`,
    [workspaceId],
  );
  return result.rows[0] ?? null;
}

async function mapContactRecord(scope: ContactScope, row: any) {
  const targetWorkspace = await loadTargetWorkspace(row.target_workspace_id);

  if (row.target_type === "actor") {
    const actor = await resolveActorTarget(row.target_actor_id);
    return {
      id: row.id,
      scope,
      targetType: "actor" as const,
      targetWorkspace: {
        id: targetWorkspace?.id || row.target_workspace_id,
        name: targetWorkspace?.name || "Unknown workspace",
        slug: targetWorkspace?.slug || "",
      },
      actor: actor
        ? {
            id: actor.id,
            workspaceId: actor.workspace_id,
            name: actor.name,
            title: actor.title,
            role: actor.role,
            avatarEmoji: actor.avatar_emoji || undefined,
            avatarStoredName: actor.avatar_stored_name || undefined,
          }
        : null,
      user: null,
      createdAt: row.created_at,
    };
  }

  const user = await resolveUserTarget(row.target_user_id, row.target_workspace_id);
  return {
    id: row.id,
    scope,
    targetType: "user" as const,
    targetWorkspace: {
      id: targetWorkspace?.id || row.target_workspace_id,
      name: targetWorkspace?.name || "Unknown workspace",
      slug: targetWorkspace?.slug || "",
    },
    actor: null,
    user: user
      ? {
          id: user.id,
          workspaceId: user.workspace_id,
          name: user.name,
          email: user.email,
          avatarFileId: user.avatar_file_id || undefined,
        }
      : null,
    createdAt: row.created_at,
  };
}

async function findExistingWorkspaceContact(params: {
  workspaceId: string;
  targetType: ContactTargetType;
  targetWorkspaceId: string;
  targetUserId?: string;
  targetActorId?: string;
}) {
  if (params.targetType === "actor") {
    const result = await query(
      `SELECT *
       FROM workspace_contacts
       WHERE workspace_id = $1
         AND target_actor_id = $2
       LIMIT 1`,
      [params.workspaceId, params.targetActorId || null],
    );
    return result.rows[0] ?? null;
  }

  const result = await query(
    `SELECT *
     FROM workspace_contacts
     WHERE workspace_id = $1
       AND target_user_id = $2
       AND target_workspace_id = $3
     LIMIT 1`,
    [params.workspaceId, params.targetUserId || null, params.targetWorkspaceId],
  );
  return result.rows[0] ?? null;
}

async function findExistingWorkspaceUserContact(params: {
  workspaceId: string;
  ownerUserId: string;
  targetType: ContactTargetType;
  targetWorkspaceId: string;
  targetUserId?: string;
  targetActorId?: string;
}) {
  if (params.targetType === "actor") {
    const result = await query(
      `SELECT *
       FROM workspace_user_contacts
       WHERE workspace_id = $1
         AND owner_user_id = $2
         AND target_actor_id = $3
       LIMIT 1`,
      [params.workspaceId, params.ownerUserId, params.targetActorId || null],
    );
    return result.rows[0] ?? null;
  }

  const result = await query(
    `SELECT *
     FROM workspace_user_contacts
     WHERE workspace_id = $1
       AND owner_user_id = $2
       AND target_user_id = $3
       AND target_workspace_id = $4
     LIMIT 1`,
    [
      params.workspaceId,
      params.ownerUserId,
      params.targetUserId || null,
      params.targetWorkspaceId,
    ],
  );
  return result.rows[0] ?? null;
}

export async function listScopedContacts(params: {
  workspaceId: string;
  userId: string;
}) {
  const [workspaceRows, personalRows] = await Promise.all([
    query(
      `SELECT *
       FROM workspace_contacts
       WHERE workspace_id = $1
       ORDER BY created_at DESC`,
      [params.workspaceId],
    ),
    query(
      `SELECT *
       FROM workspace_user_contacts
       WHERE workspace_id = $1
         AND owner_user_id = $2
       ORDER BY created_at DESC`,
      [params.workspaceId, params.userId],
    ),
  ]);

  return {
    workspaceContacts: await Promise.all(
      workspaceRows.rows.map((row) => mapContactRecord("workspace", row)),
    ),
    personalContacts: await Promise.all(
      personalRows.rows.map((row) => mapContactRecord("personal", row)),
    ),
  };
}

export async function createWorkspaceContact(params: {
  workspaceId: string;
  createdBy: string;
  targetType: ContactTargetType;
  targetUserId?: string;
  targetActorId?: string;
  targetWorkspaceId: string;
}) {
  if (params.targetType === "actor") {
    const actor = await resolveActorTarget(params.targetActorId || "");
    if (!actor) throw new Error("Actor not found");
    const existing = await findExistingWorkspaceContact({
      workspaceId: params.workspaceId,
      targetType: "actor",
      targetWorkspaceId: actor.workspace_id,
      targetActorId: actor.id,
    });
    if (existing) return mapContactRecord("workspace", existing);

    const result = await query(
      `INSERT INTO workspace_contacts
         (id, workspace_id, target_type, target_workspace_id, target_actor_id, created_by, metadata, created_at, updated_at)
       VALUES (uuid_generate_v4(), $1, 'actor', $2, $3, $4, '{}'::jsonb, NOW(), NOW())
       RETURNING *`,
      [params.workspaceId, actor.workspace_id, actor.id, params.createdBy],
    );
    return mapContactRecord("workspace", result.rows[0]);
  }

  const user = await resolveUserTarget(
    params.targetUserId || "",
    params.targetWorkspaceId,
  );
  if (!user) throw new Error("User not found in target workspace");

  const existing = await findExistingWorkspaceContact({
    workspaceId: params.workspaceId,
    targetType: "user",
    targetWorkspaceId: params.targetWorkspaceId,
    targetUserId: params.targetUserId,
  });
  if (existing) return mapContactRecord("workspace", existing);

  const result = await query(
    `INSERT INTO workspace_contacts
       (id, workspace_id, target_type, target_workspace_id, target_user_id, created_by, metadata, created_at, updated_at)
     VALUES (uuid_generate_v4(), $1, 'user', $2, $3, $4, '{}'::jsonb, NOW(), NOW())
     RETURNING *`,
    [
      params.workspaceId,
      params.targetWorkspaceId,
      params.targetUserId || null,
      params.createdBy,
    ],
  );
  return mapContactRecord("workspace", result.rows[0]);
}

export async function createWorkspaceUserContact(params: {
  workspaceId: string;
  ownerUserId: string;
  createdBy: string;
  targetType: ContactTargetType;
  targetUserId?: string;
  targetActorId?: string;
  targetWorkspaceId: string;
}) {
  if (params.targetType === "actor") {
    const actor = await resolveActorTarget(params.targetActorId || "");
    if (!actor) throw new Error("Actor not found");
    const existing = await findExistingWorkspaceUserContact({
      workspaceId: params.workspaceId,
      ownerUserId: params.ownerUserId,
      targetType: "actor",
      targetWorkspaceId: actor.workspace_id,
      targetActorId: actor.id,
    });
    if (existing) return mapContactRecord("personal", existing);

    const result = await query(
      `INSERT INTO workspace_user_contacts
         (id, workspace_id, owner_user_id, target_type, target_workspace_id, target_actor_id, created_by, metadata, created_at, updated_at)
       VALUES (uuid_generate_v4(), $1, $2, 'actor', $3, $4, $5, '{}'::jsonb, NOW(), NOW())
       RETURNING *`,
      [
        params.workspaceId,
        params.ownerUserId,
        actor.workspace_id,
        actor.id,
        params.createdBy,
      ],
    );
    return mapContactRecord("personal", result.rows[0]);
  }

  const user = await resolveUserTarget(
    params.targetUserId || "",
    params.targetWorkspaceId,
  );
  if (!user) throw new Error("User not found in target workspace");

  const existing = await findExistingWorkspaceUserContact({
    workspaceId: params.workspaceId,
    ownerUserId: params.ownerUserId,
    targetType: "user",
    targetWorkspaceId: params.targetWorkspaceId,
    targetUserId: params.targetUserId,
  });
  if (existing) return mapContactRecord("personal", existing);

  const result = await query(
    `INSERT INTO workspace_user_contacts
       (id, workspace_id, owner_user_id, target_type, target_workspace_id, target_user_id, created_by, metadata, created_at, updated_at)
     VALUES (uuid_generate_v4(), $1, $2, 'user', $3, $4, $5, '{}'::jsonb, NOW(), NOW())
     RETURNING *`,
    [
      params.workspaceId,
      params.ownerUserId,
      params.targetWorkspaceId,
      params.targetUserId || null,
      params.createdBy,
    ],
  );
  return mapContactRecord("personal", result.rows[0]);
}

export async function discoverContacts(params: {
  workspaceId: string;
  userId: string;
  queryText?: string;
  limit?: number;
}) {
  const limit = Math.min(Math.max(params.limit || 20, 1), 50);
  const rawQuery = (params.queryText || "").trim();
  const pattern = `%${rawQuery}%`;

  const [actorsResult, usersResult, workspaceRows, personalRows] = await Promise.all([
    query(
      `SELECT a.id,
              a.workspace_id,
              a.name,
              a.title,
              a.role,
              a.avatar_emoji,
              avatar_file.stored_name AS avatar_stored_name,
              w.name AS workspace_name,
              w.slug AS workspace_slug
       FROM actors a
       JOIN workspaces w ON w.id = a.workspace_id
       LEFT JOIN files avatar_file ON avatar_file.id = a.avatar_file_id
       WHERE a.is_active = TRUE
         AND a.workspace_id <> $1
         AND (
           $2 = ''
           OR a.name ILIKE $3
           OR a.title ILIKE $3
           OR a.role ILIKE $3
           OR w.name ILIKE $3
         )
       ORDER BY a.updated_at DESC
       LIMIT $4`,
      [params.workspaceId, rawQuery, pattern, limit],
    ),
    query(
      `SELECT u.id AS user_id,
              u.name,
              u.email,
              u.avatar_file_id,
              wm.workspace_id,
              w.name AS workspace_name,
              w.slug AS workspace_slug
       FROM workspace_members wm
       JOIN users u ON u.id = wm.user_id
       JOIN workspaces w ON w.id = wm.workspace_id
       WHERE wm.workspace_id <> $1
         AND u.id <> $2
         AND (
           $3 = ''
           OR u.name ILIKE $4
           OR u.email ILIKE $4
           OR w.name ILIKE $4
         )
       ORDER BY wm.joined_at DESC
       LIMIT $5`,
      [params.workspaceId, params.userId, rawQuery, pattern, limit],
    ),
    query(
      `SELECT target_type, target_user_id, target_actor_id, target_workspace_id
       FROM workspace_contacts
       WHERE workspace_id = $1`,
      [params.workspaceId],
    ),
    query(
      `SELECT target_type, target_user_id, target_actor_id, target_workspace_id
       FROM workspace_user_contacts
       WHERE workspace_id = $1
         AND owner_user_id = $2`,
      [params.workspaceId, params.userId],
    ),
  ]);

  const workspaceContactKeys = new Set(
    workspaceRows.rows.map((row) => targetKey(row)),
  );
  const personalContactKeys = new Set(
    personalRows.rows.map((row) => targetKey(row)),
  );

  return {
    actors: actorsResult.rows.map((row) => {
      const key = targetKey({
        target_type: "actor",
        target_actor_id: row.id,
        target_workspace_id: row.workspace_id,
      });
      return {
        targetType: "actor" as const,
        actorId: row.id,
        name: row.name,
        title: row.title,
        role: row.role,
        avatarEmoji: row.avatar_emoji || undefined,
        avatarStoredName: row.avatar_stored_name || undefined,
        targetWorkspace: {
          id: row.workspace_id,
          name: row.workspace_name,
          slug: row.workspace_slug,
        },
        alreadyInWorkspaceContacts: workspaceContactKeys.has(key),
        alreadyInPersonalContacts: personalContactKeys.has(key),
      };
    }),
    users: usersResult.rows.map((row) => {
      const key = targetKey({
        target_type: "user",
        target_user_id: row.user_id,
        target_workspace_id: row.workspace_id,
      });
      return {
        targetType: "user" as const,
        userId: row.user_id,
        name: row.name,
        email: row.email,
        avatarFileId: row.avatar_file_id || undefined,
        targetWorkspace: {
          id: row.workspace_id,
          name: row.workspace_name,
          slug: row.workspace_slug,
        },
        alreadyInWorkspaceContacts: workspaceContactKeys.has(key),
        alreadyInPersonalContacts: personalContactKeys.has(key),
      };
    }),
  };
}

export async function getWorkspaceContactById(contactId: string) {
  const row = await loadWorkspaceContactRecord(contactId);
  return row ? mapContactRecord("workspace", row) : null;
}

export async function getWorkspaceUserContactById(contactId: string) {
  const row = await loadWorkspaceUserContactRecord(contactId);
  return row ? mapContactRecord("personal", row) : null;
}
