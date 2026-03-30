import { db } from "../../infrastructure/database/kysely.js";

type ContactScope = "workspace" | "personal";
type ContactTargetType = "user" | "actor";
type TimestampValue = string | Date | null | undefined;

type ContactRecordRow = {
  id: string;
  scope: ContactScope | string;
  owner_user_id: string | null;
  target_type: string;
  target_workspace_id: string;
  target_user_id: string | null;
  target_actor_id: string | null;
  created_at: TimestampValue;
};

type ActorTargetRow = {
  id: string;
  workspace_id: string;
  name: string;
  title: string;
  role: string;
  avatar_emoji: string | null;
  avatar_stored_name: string | null;
  workspace_name: string;
  workspace_slug: string;
};

type UserTargetRow = {
  id: string;
  name: string;
  email: string;
  avatar_file_id: string | null;
  workspace_id: string;
  workspace_name: string;
  workspace_slug: string;
};

function toIsoString(value: TimestampValue) {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return new Date(0).toISOString();
}

function targetKey(row: {
  target_type: ContactTargetType | string;
  target_workspace_id: string;
  target_user_id?: string | null;
  target_actor_id?: string | null;
}) {
  return row.target_type === "actor"
    ? `actor:${row.target_actor_id}`
    : `user:${row.target_user_id}:${row.target_workspace_id}`;
}

async function resolveActorTarget(actorId: string): Promise<ActorTargetRow | null> {
  return (
    (await db
      .selectFrom("actors as a")
      .innerJoin("workspaces as w", "w.id", "a.workspace_id")
      .leftJoin("files as avatar_file", "avatar_file.id", "a.avatar_file_id")
      .select([
        "a.id",
        "a.workspace_id",
        "a.name",
        "a.title",
        "a.role",
        "a.avatar_emoji",
        "avatar_file.stored_name as avatar_stored_name",
        "w.name as workspace_name",
        "w.slug as workspace_slug",
      ])
      .where("a.id", "=", actorId)
      .where("a.is_active", "=", true)
      .limit(1)
      .executeTakeFirst()) ?? null
  ) as ActorTargetRow | null;
}

async function resolveUserTarget(
  userId: string,
  targetWorkspaceId: string,
): Promise<UserTargetRow | null> {
  return (
    (await db
      .selectFrom("workspace_members as wm")
      .innerJoin("users as u", "u.id", "wm.user_id")
      .innerJoin("workspaces as w", "w.id", "wm.workspace_id")
      .select([
        "u.id",
        "u.name",
        "u.email",
        "u.avatar_file_id",
        "wm.workspace_id",
        "w.name as workspace_name",
        "w.slug as workspace_slug",
      ])
      .where("wm.workspace_id", "=", targetWorkspaceId)
      .where("wm.user_id", "=", userId)
      .limit(1)
      .executeTakeFirst()) ?? null
  ) as UserTargetRow | null;
}

async function loadWorkspaceContactRecord(contactId: string) {
  return (
    (await db
      .selectFrom("workspace_contacts")
      .selectAll()
      .where("id", "=", contactId)
      .where("scope", "=", "workspace")
      .limit(1)
      .executeTakeFirst()) ?? null
  );
}

async function loadWorkspaceUserContactRecord(contactId: string) {
  return (
    (await db
      .selectFrom("workspace_contacts")
      .selectAll()
      .where("id", "=", contactId)
      .where("scope", "=", "personal")
      .limit(1)
      .executeTakeFirst()) ?? null
  );
}

async function loadTargetWorkspace(workspaceId: string) {
  return (
    (await db
      .selectFrom("workspaces")
      .select(["id", "name", "slug"])
      .where("id", "=", workspaceId)
      .limit(1)
      .executeTakeFirst()) ?? null
  );
}

async function mapContactRecord(scope: ContactScope, row: ContactRecordRow) {
  const targetWorkspace = await loadTargetWorkspace(row.target_workspace_id);

  if (row.target_type === "actor" && row.target_actor_id) {
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
      createdAt: toIsoString(row.created_at),
    };
  }

  const user = row.target_user_id
    ? await resolveUserTarget(row.target_user_id, row.target_workspace_id)
    : null;
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
    createdAt: toIsoString(row.created_at),
  };
}

async function findExistingContact(params: {
  scope: ContactScope;
  workspaceId: string;
  ownerUserId?: string;
  targetType: ContactTargetType;
  targetWorkspaceId: string;
  targetUserId?: string;
  targetActorId?: string;
}) {
  let baseQuery = db
    .selectFrom("workspace_contacts")
    .selectAll()
    .where("workspace_id", "=", params.workspaceId)
    .where("scope", "=", params.scope);

  if (params.scope === "workspace") {
    baseQuery = baseQuery.where("owner_user_id", "is", null);
  } else {
    baseQuery = baseQuery.where("owner_user_id", "=", params.ownerUserId || null);
  }

  if (params.targetType === "actor") {
    if (!params.targetActorId) return null;
    return (
      (await baseQuery
        .where("target_actor_id", "=", params.targetActorId)
        .limit(1)
        .executeTakeFirst()) ?? null
    );
  }

  return (
    (await baseQuery
      .where("target_user_id", "=", params.targetUserId || null)
      .where("target_workspace_id", "=", params.targetWorkspaceId)
      .limit(1)
      .executeTakeFirst()) ?? null
  );
}

export async function listScopedContacts(params: {
  workspaceId: string;
  userId: string;
}) {
  const [workspaceRows, personalRows] = await Promise.all([
    db
      .selectFrom("workspace_contacts")
      .selectAll()
      .where("workspace_id", "=", params.workspaceId)
      .where("scope", "=", "workspace")
      .orderBy("created_at", "desc")
      .execute(),
    db
      .selectFrom("workspace_contacts")
      .selectAll()
      .where("workspace_id", "=", params.workspaceId)
      .where("scope", "=", "personal")
      .where("owner_user_id", "=", params.userId)
      .orderBy("created_at", "desc")
      .execute(),
  ]);

  return {
    workspaceContacts: await Promise.all(
      workspaceRows.map((row) => mapContactRecord("workspace", row as ContactRecordRow)),
    ),
    personalContacts: await Promise.all(
      personalRows.map((row) => mapContactRecord("personal", row as ContactRecordRow)),
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
    const existing = await findExistingContact({
      scope: "workspace",
      workspaceId: params.workspaceId,
      targetType: "actor",
      targetWorkspaceId: actor.workspace_id,
      targetActorId: actor.id,
    });
    if (existing) return mapContactRecord("workspace", existing as ContactRecordRow);

    const row = await db
      .insertInto("workspace_contacts")
      .values({
        workspace_id: params.workspaceId,
        scope: "workspace",
        owner_user_id: null,
        target_type: "actor",
        target_workspace_id: actor.workspace_id,
        target_actor_id: actor.id,
        created_by: params.createdBy,
      })
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      throw new Error("Failed to create workspace contact");
    }
    return mapContactRecord("workspace", row as ContactRecordRow);
  }

  const user = await resolveUserTarget(
    params.targetUserId || "",
    params.targetWorkspaceId,
  );
  if (!user) throw new Error("User not found in target workspace");

  const existing = await findExistingContact({
    scope: "workspace",
    workspaceId: params.workspaceId,
    targetType: "user",
    targetWorkspaceId: params.targetWorkspaceId,
    targetUserId: params.targetUserId,
  });
  if (existing) return mapContactRecord("workspace", existing as ContactRecordRow);

  const row = await db
    .insertInto("workspace_contacts")
    .values({
      workspace_id: params.workspaceId,
      scope: "workspace",
      owner_user_id: null,
      target_type: "user",
      target_workspace_id: params.targetWorkspaceId,
      target_user_id: params.targetUserId || null,
      created_by: params.createdBy,
    })
    .returningAll()
    .executeTakeFirst();
  if (!row) {
    throw new Error("Failed to create workspace contact");
  }
  return mapContactRecord("workspace", row as ContactRecordRow);
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
    const existing = await findExistingContact({
      scope: "personal",
      workspaceId: params.workspaceId,
      ownerUserId: params.ownerUserId,
      targetType: "actor",
      targetWorkspaceId: actor.workspace_id,
      targetActorId: actor.id,
    });
    if (existing) return mapContactRecord("personal", existing as ContactRecordRow);

    const row = await db
      .insertInto("workspace_contacts")
      .values({
        workspace_id: params.workspaceId,
        scope: "personal",
        owner_user_id: params.ownerUserId,
        target_type: "actor",
        target_workspace_id: actor.workspace_id,
        target_actor_id: actor.id,
        created_by: params.createdBy,
      })
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      throw new Error("Failed to create personal contact");
    }
    return mapContactRecord("personal", row as ContactRecordRow);
  }

  const user = await resolveUserTarget(
    params.targetUserId || "",
    params.targetWorkspaceId,
  );
  if (!user) throw new Error("User not found in target workspace");

  const existing = await findExistingContact({
    scope: "personal",
    workspaceId: params.workspaceId,
    ownerUserId: params.ownerUserId,
    targetType: "user",
    targetWorkspaceId: params.targetWorkspaceId,
    targetUserId: params.targetUserId,
  });
  if (existing) return mapContactRecord("personal", existing as ContactRecordRow);

  const row = await db
    .insertInto("workspace_contacts")
    .values({
      workspace_id: params.workspaceId,
      scope: "personal",
      owner_user_id: params.ownerUserId,
      target_type: "user",
      target_workspace_id: params.targetWorkspaceId,
      target_user_id: params.targetUserId || null,
      created_by: params.createdBy,
    })
    .returningAll()
    .executeTakeFirst();
  if (!row) {
    throw new Error("Failed to create personal contact");
  }
  return mapContactRecord("personal", row as ContactRecordRow);
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

  let actorQuery = db
    .selectFrom("actors as a")
    .innerJoin("workspaces as w", "w.id", "a.workspace_id")
    .leftJoin("files as avatar_file", "avatar_file.id", "a.avatar_file_id")
    .select([
      "a.id",
      "a.workspace_id",
      "a.name",
      "a.title",
      "a.role",
      "a.avatar_emoji",
      "avatar_file.stored_name as avatar_stored_name",
      "w.name as workspace_name",
      "w.slug as workspace_slug",
    ])
    .where("a.is_active", "=", true)
    .where("a.workspace_id", "<>", params.workspaceId);

  if (rawQuery) {
    actorQuery = actorQuery.where((eb) =>
      eb.or([
        eb("a.name", "ilike", pattern),
        eb("a.title", "ilike", pattern),
        eb("a.role", "ilike", pattern),
        eb("w.name", "ilike", pattern),
      ]),
    );
  }

  let userQuery = db
    .selectFrom("workspace_members as wm")
    .innerJoin("users as u", "u.id", "wm.user_id")
    .innerJoin("workspaces as w", "w.id", "wm.workspace_id")
    .select([
      "u.id as user_id",
      "u.name",
      "u.email",
      "u.avatar_file_id",
      "wm.workspace_id",
      "w.name as workspace_name",
      "w.slug as workspace_slug",
    ])
    .where("wm.workspace_id", "<>", params.workspaceId)
    .where("u.id", "<>", params.userId);

  if (rawQuery) {
    userQuery = userQuery.where((eb) =>
      eb.or([
        eb("u.name", "ilike", pattern),
        eb("u.email", "ilike", pattern),
        eb("w.name", "ilike", pattern),
      ]),
    );
  }

  const [actorsResult, usersResult, workspaceRows, personalRows] = await Promise.all([
    actorQuery.orderBy("a.updated_at", "desc").limit(limit).execute(),
    userQuery.orderBy("wm.joined_at", "desc").limit(limit).execute(),
    db
      .selectFrom("workspace_contacts")
      .select([
        "scope",
        "owner_user_id",
        "target_type",
        "target_user_id",
        "target_actor_id",
        "target_workspace_id",
      ])
      .where("workspace_id", "=", params.workspaceId)
      .where("scope", "=", "workspace")
      .execute(),
    db
      .selectFrom("workspace_contacts")
      .select([
        "scope",
        "owner_user_id",
        "target_type",
        "target_user_id",
        "target_actor_id",
        "target_workspace_id",
      ])
      .where("workspace_id", "=", params.workspaceId)
      .where("scope", "=", "personal")
      .where("owner_user_id", "=", params.userId)
      .execute(),
  ]);

  const workspaceContactKeys = new Set(
    workspaceRows.map((row) => targetKey(row)),
  );
  const personalContactKeys = new Set(
    personalRows.map((row) => targetKey(row)),
  );

  return {
    actors: actorsResult.map((row) => {
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
    users: usersResult.map((row) => {
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
  return row ? mapContactRecord("workspace", row as ContactRecordRow) : null;
}

export async function getWorkspaceUserContactById(contactId: string) {
  const row = await loadWorkspaceUserContactRecord(contactId);
  return row ? mapContactRecord("personal", row as ContactRecordRow) : null;
}
