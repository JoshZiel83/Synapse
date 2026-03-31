import crypto from "node:crypto";
import type pg from "pg";
import { query, transaction } from "../../infrastructure/database/index.js";
import {
  db,
  executeCompiledQuery,
  executeTakeFirst,
  type TableInsert,
} from "../../infrastructure/database/kysely.js";
import { DEFAULT_OFFICIAL_ACTOR_TEMPLATE_SLUG } from "../../infrastructure/database/seeds/actors/index.js";
import { getFileUrl } from "../../infrastructure/storage/index.js";
import { getFileUrlById } from "../files/service.js";
import {
  AUTHZ_PLATFORM_ID,
  deleteRelation,
  flushAuthzOutboxEntries,
  queueAuthzRelationships,
  touchRelation,
} from "../../infrastructure/authz/index.js";
import {
  INVITE_TRUST_LEVELS,
  normalizeActorDocs,
  type ActorDoc,
  type ActorDocInput,
  type ActorRole,
  type WorkspaceChiefActorPreference,
} from "@synapse/shared";
import type {
  WorkspaceAccessBindingsAccessKey,
  WorkspaceMembersTrustLevel,
} from "../../infrastructure/database/generated/db.js";
import { sql } from "kysely";
import { listAuthorizedResourceIds, userSubject } from "../access/service.js";

export interface CreateWorkspaceInput {
  name: string;
  description?: string;
  userId: string;
}

export interface AddMemberInput {
  workspaceId: string;
  userId: string;
  trustLevel: WorkspaceMembersTrustLevel;
}

export type WorkspaceAccessKey = WorkspaceAccessBindingsAccessKey;

function workspaceRelationFromTrustLevel(
  trustLevel: "owner" | typeof INVITE_TRUST_LEVELS[number],
) {
  return trustLevel;
}

function deriveWorkspaceTrustLevel(row: {
  owner_id?: string | null;
  user_id?: string | null;
  trust_level?: string | null;
}) {
  if (row.owner_id && row.user_id && row.owner_id === row.user_id) {
    return "owner";
  }
  return row.trust_level ?? null;
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

function toIsoString(value: string | Date | null | undefined) {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return undefined;
}

const OFFICIAL_ACTOR_PUBLISHER_SLUG = "synapse-official";
const OFFICIAL_CHIEF_ACTOR_CONFIG = { is_chief_actor: true } as const;
const OFFICIAL_CHIEF_ACTOR_CONFIG_JSON = JSON.stringify(
  OFFICIAL_CHIEF_ACTOR_CONFIG,
);

type OfficialActorTemplateRow = {
  package_id: string;
  package_slug: string;
  version_id: string;
  actor_role: ActorRole;
  actor_name: string;
  actor_avatar_file_id: string | null;
  actor_avatar_emoji: string | null;
  actor_title: string;
  actor_can_represent_user: boolean;
  actor_docs: ActorDocInput[] | string | null;
  actor_specialties: string[] | null;
  actor_config: Record<string, unknown> | string | null;
};

type LoadedOfficialActorTemplate = {
  packageId: string;
  packageSlug: string;
  versionId: string;
  actorName: string;
  actorRole: ActorRole;
  actorAvatarFileId?: string;
  actorAvatarEmoji?: string;
  actorTitle: string;
  canRepresentUser: boolean;
  actorDocs: ActorDoc[];
  actorSpecialties: string[];
  actorConfig: Record<string, unknown>;
  isChiefActor: boolean;
};

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function withOfficialChiefActorConfig(
  config: Record<string, unknown>,
  isChiefActor: boolean,
) {
  return isChiefActor
    ? {
        ...config,
        ...OFFICIAL_CHIEF_ACTOR_CONFIG,
      }
    : config;
}

async function findOfficialChiefActorId(
  client: pg.PoolClient,
  workspaceId: string,
) {
  const runner = { query: client.query.bind(client) as typeof query };
  const result = await executeTakeFirst<{ id: string }>(
    runner,
    db
      .selectFrom("actors as a")
      .leftJoin("actor_source_refs as source_ref", "source_ref.actor_id", "a.id")
      .leftJoin("catalog_items as item", "item.id", "source_ref.source_catalog_item_id")
      .select("a.id")
      .where("a.workspace_id", "=", workspaceId)
      .where("a.is_active", "=", true)
      .where((eb) =>
        eb.or([
          sql<boolean>`a.config @> ${OFFICIAL_CHIEF_ACTOR_CONFIG_JSON}::jsonb`,
          eb.and([
            eb("item.workspace_id", "is", null),
            eb("item.item_kind", "=", "actor_template"),
            eb("item.slug", "=", DEFAULT_OFFICIAL_ACTOR_TEMPLATE_SLUG),
          ]),
        ]),
      )
      .orderBy(sql`case when a.config @> ${OFFICIAL_CHIEF_ACTOR_CONFIG_JSON}::jsonb then 0 else 1 end`)
      .orderBy("a.created_at", "asc")
      .limit(1),
  );

  return result?.id ?? null;
}

export async function assignOfficialChiefActorPreference(
  client: pg.PoolClient,
  workspaceId: string,
  userId: string,
  actorId?: string | null,
) {
  const chiefActorId =
    typeof actorId === "string" && actorId.trim().length > 0
      ? actorId
      : await findOfficialChiefActorId(client, workspaceId);

  if (!chiefActorId) {
    return null;
  }

  const runner = { query: client.query.bind(client) as typeof query };
  await executeCompiledQuery(
    runner,
    db
      .insertInto("workspace_user_preferences")
      .values({
        workspace_id: workspaceId,
        user_id: userId,
        chief_actor_id: chiefActorId,
        created_at: sql`NOW()`,
        updated_at: sql`NOW()`,
      })
      .onConflict((oc) =>
        oc.columns(["workspace_id", "user_id"]).doUpdateSet({
          chief_actor_id: chiefActorId,
          updated_at: sql`NOW()`,
        }),
      ),
  );

  return chiefActorId;
}

function parseStoredActorDocs(value: ActorDocInput[] | string | null) {
  const docsValue = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  return normalizeActorDocs(
    Array.isArray(docsValue) ? (docsValue as ActorDocInput[]) : [],
  );
}

function isOfficialChiefTemplate(row: Pick<OfficialActorTemplateRow, "package_slug" | "actor_config">) {
  const config = parseJsonObject(row.actor_config);
  return (
    config.is_chief_actor === true ||
    row.package_slug === DEFAULT_OFFICIAL_ACTOR_TEMPLATE_SLUG
  );
}

async function loadOfficialActorTemplates(
  client: pg.PoolClient,
): Promise<LoadedOfficialActorTemplate[]> {
  const runner = { query: client.query.bind(client) as typeof query };
  const result = await executeCompiledQuery<OfficialActorTemplateRow>(
    runner,
    db
      .selectFrom("catalog_items as item")
      .innerJoin("publishers as publisher", "publisher.id", "item.publisher_id")
      .innerJoin("catalog_versions as version", "version.id", "item.latest_version_id")
      .innerJoin(
        "actor_template_version_specs as spec",
        "spec.catalog_version_id",
        "version.id",
      )
      .select([
        "item.id as package_id",
        "item.slug as package_slug",
        "version.id as version_id",
        "spec.role as actor_role",
        "spec.name as actor_name",
        "spec.avatar_file_id as actor_avatar_file_id",
        "spec.avatar_emoji as actor_avatar_emoji",
        "spec.title as actor_title",
        "spec.can_represent_user as actor_can_represent_user",
        "spec.docs as actor_docs",
        "spec.specialties as actor_specialties",
        "spec.config as actor_config",
      ])
      .where("publisher.slug", "=", OFFICIAL_ACTOR_PUBLISHER_SLUG)
      .where("item.workspace_id", "is", null)
      .where("item.item_kind", "=", "actor_template")
      .where("item.is_active", "=", true)
      .orderBy(
        sql`case when spec.config @> ${OFFICIAL_CHIEF_ACTOR_CONFIG_JSON}::jsonb or item.slug = ${DEFAULT_OFFICIAL_ACTOR_TEMPLATE_SLUG} then 0 else 1 end`,
      )
      .orderBy("item.created_at", "asc")
      .orderBy("item.slug", "asc"),
  );

  if (result.rows.length === 0) {
    throw new Error("Official actor templates are missing.");
  }

  return result.rows.map((row) => {
    const isChiefActor = isOfficialChiefTemplate(row);
    return {
      packageId: row.package_id,
      packageSlug: row.package_slug,
      versionId: row.version_id,
      actorName: row.actor_name,
      actorRole: row.actor_role,
      actorAvatarFileId: row.actor_avatar_file_id || undefined,
      actorAvatarEmoji: row.actor_avatar_emoji || undefined,
      actorTitle: row.actor_title,
      canRepresentUser: Boolean(row.actor_can_represent_user),
      actorDocs: parseStoredActorDocs(row.actor_docs),
      actorSpecialties: Array.isArray(row.actor_specialties)
        ? row.actor_specialties
        : [],
      actorConfig: withOfficialChiefActorConfig(
        parseJsonObject(row.actor_config),
        isChiefActor,
      ),
      isChiefActor,
    } satisfies LoadedOfficialActorTemplate;
  });
}

function buildWorkspaceActorAuthzRelations(
  workspaceId: string,
  actorId: string,
  ownerUserId: string,
) {
  return [
    touchRelation("workspace", workspaceId, "actor", "actor", actorId),
    touchRelation("actor", actorId, "workspace", "workspace", workspaceId),
    touchRelation("actor", actorId, "owner", "user", ownerUserId),
    touchRelation("actor", actorId, "discover_workspace", "workspace", workspaceId),
    touchRelation("actor", actorId, "invoke_workspace", "workspace", workspaceId),
    touchRelation("actor", actorId, "receive_workspace", "workspace", workspaceId),
  ];
}

export async function createWorkspace(input: CreateWorkspaceInput) {
  const slug = generateSlug(input.name);

  const result = await transaction(async (client: pg.PoolClient) => {
    const runner = { query: client.query.bind(client) as typeof query };
    // 1. Create workspace
    const workspace = await executeTakeFirst<Record<string, unknown>>(
      runner,
      db
        .insertInto("workspaces")
        .values({
          name: input.name,
          slug,
          description: input.description ?? null,
          owner_id: input.userId,
        })
        .returningAll(),
    );
    if (!workspace) {
      throw new Error("Failed to create workspace.");
    }

    // 2. Add creator as admin member; owner is derived from workspaces.owner_id.
    await executeCompiledQuery(
      runner,
      db
        .insertInto("workspace_members")
        .values({
          workspace_id: String(workspace.id),
          user_id: input.userId,
          trust_level: "admin",
        }),
    );

    const officialActorTemplates = await loadOfficialActorTemplates(client);
    const installedActors: Array<{
      actorRow: Record<string, unknown>;
      template: LoadedOfficialActorTemplate;
    }> = [];

    for (const template of officialActorTemplates) {
      const actorRow = await executeTakeFirst<Record<string, unknown>>(
        runner,
        db
          .insertInto("actors")
          .values({
            workspace_id: String(workspace.id),
            name: template.actorName,
            role: template.actorRole,
            title: template.actorTitle,
            avatar_file_id: template.actorAvatarFileId || null,
            avatar_emoji: template.actorAvatarEmoji || null,
            parent_id: null,
            can_represent_user: template.canRepresentUser,
            specialties: template.actorSpecialties,
            config: template.actorConfig as TableInsert<'actors'>['config'],
            current_version: 1,
            created_by: input.userId,
          })
          .returningAll(),
      );
      if (!actorRow) {
        throw new Error(`Failed to install actor ${template.actorName}`);
      }

      const actorVersionResult = await executeTakeFirst<{ id: string }>(
        runner,
        db
          .insertInto("actor_versions")
          .values({
            actor_id: String(actorRow.id),
            version: 1,
            name: template.actorName,
            role: template.actorRole,
            title: template.actorTitle,
            parent_id: null,
            can_represent_user: template.canRepresentUser,
            specialties: template.actorSpecialties,
            config: template.actorConfig as TableInsert<'actor_versions'>['config'],
            created_by: input.userId,
          })
          .returning("id"),
      );
      if (!actorVersionResult) {
        throw new Error(`Failed to create actor version for ${template.actorName}`);
      }
      const actorVersionId = actorVersionResult.id;

      for (const doc of template.actorDocs) {
        await executeCompiledQuery(
          runner,
          db
            .insertInto("actor_version_docs")
            .values({
              actor_version_id: actorVersionId,
              doc_key: doc.key,
              title: doc.title,
              visibility: doc.visibility,
              priority: doc.priority,
              content_blocks: sql`${JSON.stringify(doc.content)}::jsonb`,
            }),
        );
      }

      await executeCompiledQuery(
        runner,
        db
          .insertInto("actor_source_refs")
          .values({
            actor_id: String(actorRow.id),
            source_catalog_item_id: template.packageId,
            source_catalog_version_id: template.versionId,
            sync_mode: "notify",
            baseline_actor_version: 1,
            metadata: {} as TableInsert<'actor_source_refs'>['metadata'],
          }),
      );

      installedActors.push({
        actorRow,
        template,
      });
    }

    if (installedActors.length === 0) {
      throw new Error("Failed to install official actors for workspace.");
    }

    await executeCompiledQuery(
      runner,
      db
        .updateTable("catalog_items")
        .set({
          download_count: sql`download_count + 1`,
          updated_at: sql`NOW()`,
        })
        .where(
          "id",
          "in",
          officialActorTemplates.map((template) => template.packageId),
        ),
    );

    const chiefActor =
      installedActors.find(({ template }) => template.isChiefActor) ||
      installedActors[0]!;

    await assignOfficialChiefActorPreference(
      client,
      String(workspace.id),
      input.userId,
      String(chiefActor.actorRow.id),
    );

    const authzEntryIds = await queueAuthzRelationships(
      client,
      [
        touchRelation(
          "platform",
          AUTHZ_PLATFORM_ID,
          "workspace",
          "workspace",
          String(workspace.id),
        ),
        touchRelation(
          "workspace",
          String(workspace.id),
          "platform",
          "platform",
          AUTHZ_PLATFORM_ID,
        ),
        touchRelation(
          "workspace",
          String(workspace.id),
          workspaceRelationFromTrustLevel("owner"),
          "user",
          input.userId,
        ),
        ...installedActors.flatMap(({ actorRow }) =>
          buildWorkspaceActorAuthzRelations(
            String(workspace.id),
            String(actorRow.id),
            input.userId,
          ),
        ),
      ],
      {
        source: "workspace.create",
        workspaceId: String(workspace.id),
        userId: input.userId,
      },
    );

    return {
      workspace: mapWorkspaceRow(workspace),
      secretary: mapActorRow(
        chiefActor.actorRow,
        chiefActor.template.actorDocs,
      ),
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

  const rows = await db
    .selectFrom("workspaces as w")
    .leftJoin("workspace_members as wm", (join) =>
      join
        .onRef("wm.workspace_id", "=", "w.id")
        .on("wm.user_id", "=", userId),
    )
    .selectAll("w")
    .select("wm.trust_level")
    .where("w.id", "in", workspaceIds)
    .orderBy("w.created_at", "desc")
    .execute();
  return rows.map((row) => ({
    ...mapWorkspaceRow(row),
    trustLevel: deriveWorkspaceTrustLevel(row),
  }));
}

export async function getWorkspaceById(workspaceId: string) {
  const row = await db
    .selectFrom("workspaces")
    .selectAll()
    .where("id", "=", workspaceId)
    .executeTakeFirst();
  return row ? mapWorkspaceRow(row) : null;
}

export async function getWorkspaceChiefActorPreference(
  workspaceId: string,
  userId: string,
): Promise<WorkspaceChiefActorPreference> {
  const row = await db
    .selectFrom("workspace_user_preferences as pref")
    .leftJoin("actors as a", (join) =>
      join
        .onRef("a.id", "=", "pref.chief_actor_id")
        .onRef("a.workspace_id", "=", "pref.workspace_id")
        .on("a.is_active", "=", true),
    )
    .leftJoin("files as avatar_file", "avatar_file.id", "a.avatar_file_id")
    .select([
      "pref.workspace_id",
      "pref.user_id",
      "pref.chief_actor_id",
      "pref.created_at",
      "pref.updated_at",
      "a.name as chief_actor_name",
      "a.role as chief_actor_role",
      "a.title as chief_actor_title",
      "avatar_file.stored_name as chief_actor_avatar_stored_name",
    ])
    .where("pref.workspace_id", "=", workspaceId)
    .where("pref.user_id", "=", userId)
    .limit(1)
    .executeTakeFirst();
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
    await db
      .deleteFrom("workspace_user_preferences")
      .where("workspace_id", "=", workspaceId)
      .where("user_id", "=", userId)
      .execute();

    return {
      workspaceId,
      userId,
    };
  }

  const actorRow = await db
    .selectFrom("actors")
    .select("id")
    .where("id", "=", chiefActorId)
    .where("workspace_id", "=", workspaceId)
    .where("is_active", "=", true)
    .limit(1)
    .executeTakeFirst();

  if (!actorRow) {
    throw new Error("Chief actor is not available in this workspace");
  }

  await db
    .insertInto("workspace_user_preferences")
    .values({
      workspace_id: workspaceId,
      user_id: userId,
      chief_actor_id: chiefActorId,
      created_at: sql`NOW()`,
      updated_at: sql`NOW()`,
    })
    .onConflict((oc) =>
      oc.columns(["workspace_id", "user_id"]).doUpdateSet({
        chief_actor_id: chiefActorId,
        updated_at: sql`NOW()`,
      }),
    )
    .execute();

  return getWorkspaceChiefActorPreference(workspaceId, userId);
}

export async function updateWorkspace(
  workspaceId: string,
  updates: { name?: string; description?: string },
) {
  if (updates.name === undefined && updates.description === undefined) {
    return getWorkspaceById(workspaceId);
  }

  const row = await db
    .updateTable("workspaces")
    .set({
      ...(updates.name !== undefined ? { name: updates.name } : {}),
      ...(updates.description !== undefined
        ? { description: updates.description }
        : {}),
      updated_at: sql`NOW()`,
    })
    .where("id", "=", workspaceId)
    .returningAll()
    .executeTakeFirst();
  return row ? mapWorkspaceRow(row) : null;
}

export async function checkMembership(workspaceId: string, userId: string) {
  const row = await db
    .selectFrom("workspaces as w")
    .leftJoin("workspace_members as wm", (join) =>
      join
        .onRef("wm.workspace_id", "=", "w.id")
        .on("wm.user_id", "=", userId),
    )
    .select(["w.owner_id", "wm.user_id", "wm.trust_level"])
    .where("w.id", "=", workspaceId)
    .executeTakeFirst();
  return row ? deriveWorkspaceTrustLevel(row) : null;
}

export async function addMember(input: AddMemberInput) {
  const result = await transaction(async (client: pg.PoolClient) => {
    const runner = { query: client.query.bind(client) as typeof query };
    const memberRow = await executeTakeFirst(
      runner,
      db
        .insertInto("workspace_members")
        .values({
          workspace_id: input.workspaceId,
          user_id: input.userId,
          trust_level: input.trustLevel,
        })
        .onConflict((oc) => oc.columns(["workspace_id", "user_id"]).doNothing())
        .returningAll(),
    );

    if (!memberRow) {
      return null;
    }

    await assignOfficialChiefActorPreference(
      client,
      input.workspaceId,
      input.userId,
    );

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
      member: mapMemberRow(memberRow),
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
  const accessMap = db
    .selectFrom("workspace_access_bindings")
    .select([
      "workspace_id",
      "user_id",
      sql<string[]>`array_agg(access_key order by access_key)`.as("access_keys"),
    ])
    .groupBy(["workspace_id", "user_id"])
    .as("access_map");

  const rows = await db
    .selectFrom("workspace_members as wm")
    .innerJoin("workspaces as w", "w.id", "wm.workspace_id")
    .innerJoin("users as u", "u.id", "wm.user_id")
    .leftJoin(accessMap, (join) =>
      join
        .onRef("access_map.workspace_id", "=", "wm.workspace_id")
        .onRef("access_map.user_id", "=", "wm.user_id"),
    )
    .select([
      "wm.id",
      "wm.workspace_id",
      "wm.user_id",
      "wm.trust_level",
      "w.owner_id",
      "wm.joined_at",
      "u.name as user_name",
      "u.email as user_email",
      "u.avatar_file_id",
      sql<string[]>`COALESCE(access_map.access_keys, '{}'::text[])`.as("access_keys"),
    ])
    .where("wm.workspace_id", "=", workspaceId)
    .orderBy("wm.joined_at", "asc")
    .execute();
  return rows.map((row) => ({
    ...mapMemberRow(row),
    userName: row.user_name,
    userEmail: row.user_email,
    avatarUrl: row.avatar_file_id ? getFileUrlById(row.avatar_file_id) : null,
    accessKeys: Array.isArray(row.access_keys) ? row.access_keys : [],
  }));
}

export async function listWorkspaceAccessBindings(workspaceId: string) {
  const rows = await db
    .selectFrom("workspace_access_bindings as wab")
    .innerJoin("workspaces as w", "w.id", "wab.workspace_id")
    .innerJoin("users as u", "u.id", "wab.user_id")
    .innerJoin("workspace_members as wm", (join) =>
      join
        .onRef("wm.workspace_id", "=", "wab.workspace_id")
        .onRef("wm.user_id", "=", "wab.user_id"),
    )
    .select([
      "wab.workspace_id",
      "wab.user_id",
      "wab.access_key",
      "wab.assigned_by",
      "wab.metadata",
      "wab.created_at",
      "wab.updated_at",
      "u.name as user_name",
      "u.email as user_email",
      "u.avatar_file_id",
      "w.owner_id",
      "wm.trust_level",
    ])
    .where("wab.workspace_id", "=", workspaceId)
    .orderBy("wab.access_key", "asc")
    .orderBy("wab.created_at", "asc")
    .execute();

  return rows.map((row) => ({
    workspaceId: row.workspace_id,
    userId: row.user_id,
    accessKey: row.access_key as WorkspaceAccessKey,
    assignedBy: row.assigned_by ?? null,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    trustLevel: deriveWorkspaceTrustLevel(row),
    userName: row.user_name,
    userEmail: row.user_email,
    avatarUrl: row.avatar_file_id ? getFileUrlById(row.avatar_file_id) : null,
  }));
}

export async function grantWorkspaceAccess(input: {
  workspaceId: string;
  userId: string;
  accessKey: WorkspaceAccessKey;
  assignedBy: string;
  metadata?: Record<string, unknown>;
}) {
  const membership = await db
    .selectFrom("workspace_members")
    .select("id")
    .where("workspace_id", "=", input.workspaceId)
    .where("user_id", "=", input.userId)
    .limit(1)
    .executeTakeFirst();

  if (!membership) {
    throw new Error("User is not a member of this workspace");
  }

  const row = await db
    .insertInto("workspace_access_bindings")
    .values({
      workspace_id: input.workspaceId,
      user_id: input.userId,
      access_key: input.accessKey,
      assigned_by: input.assignedBy,
      metadata: (input.metadata || {}) as TableInsert<'workspace_access_bindings'>['metadata'],
    })
    .onConflict((oc) =>
      oc.columns(["workspace_id", "user_id", "access_key"]).doNothing(),
    )
    .returningAll()
    .executeTakeFirst();

  if (!row) {
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
    workspaceId: row.workspace_id,
    userId: row.user_id,
    accessKey: row.access_key as WorkspaceAccessKey,
    assignedBy: row.assigned_by ?? null,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function revokeWorkspaceAccess(
  workspaceId: string,
  userId: string,
  accessKey: WorkspaceAccessKey,
) {
  const row = await db
    .deleteFrom("workspace_access_bindings")
    .where("workspace_id", "=", workspaceId)
    .where("user_id", "=", userId)
    .where("access_key", "=", accessKey)
    .returning(["workspace_id", "user_id", "access_key"])
    .executeTakeFirst();

  if (!row) {
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
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapActorRow(row: any, docs: ActorDoc[]) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    definition: {
      name: row.name,
      role: row.role,
      title: row.title,
      avatarFileId: row.avatar_file_id ?? undefined,
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
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapMemberRow(row: any) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    trustLevel: deriveWorkspaceTrustLevel(row),
    accessKeys: Array.isArray(row.access_keys) ? row.access_keys : [],
    joinedAt: toIsoString(row.joined_at),
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
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
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
