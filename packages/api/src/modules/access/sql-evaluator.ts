import {
  DEFAULT_CONVERSATION_TYPE_MASK,
  maskAllowsConversationType,
  resolveEffectiveConversationTypeMask,
  resolveNarrowedConversationTypeMask,
} from "@synapse/shared";
import { sql } from "kysely";
import { db, executeSql } from "../../infrastructure/database/kysely.js";
import { getWorkspaceCapabilityConversationTypePolicyMap } from "../capabilities/conversation-type-policies.js";

type AccessResourceType =
  | "platform"
  | "workspace"
  | "workspace_member"
  | "user"
  | "actor"
  | "installed_skill"
  | "plugin_installation"
  | "automation_event_source"
  | "relay_device"
  | "relay_exposure"
  | "relay_capability"
  | "conversation_actor_context"
  | "conversation"
  | "memory_space"
  | "memory_item"
  | "model_group"
  | "model_profile";

type PermissionSubject = {
  type: "user" | "workspace_member" | "actor" | "workspace" | "conversation_actor_context";
  id: string;
};

const PLATFORM_RESOURCE_ID = "synapse";

type WorkspaceMemberAccess = {
  id: string;
  workspaceId: string;
  userId: string;
  trustLevel: string;
  ownerId: string | null;
  accessKeys: string[];
};

type ActorRow = {
  id: string;
  workspace_id: string;
  access_policy: "workspace_open" | "approval_required";
  created_by_workspace_member_id: string | null;
  is_active: boolean;
};

type ConversationRow = {
  id: string;
  workspace_id: string;
  kind: "private" | "group" | "virtual";
  boundary: "internal" | "external";
};

type ConversationActorContextRow = {
  id: string;
  actor_id: string;
  conversation_id: string;
  session_id: string | null;
};

type ResourceGrantMatch = {
  resource_id: string;
};

async function loadWorkspaceMemberAccess(
  workspaceMemberId: string,
): Promise<WorkspaceMemberAccess | null> {
  const row = await db
    .selectFrom("workspace_members as wm")
    .innerJoin("workspaces as w", "w.id", "wm.workspace_id")
    .select([
      "wm.id",
      "wm.workspace_id",
      "wm.user_id",
      "wm.trust_level",
      "w.owner_id",
    ])
    .where("wm.id", "=", workspaceMemberId)
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;

  const accessRows = await db
    .selectFrom("workspace_access_bindings")
    .select("access_key")
    .where("workspace_member_id", "=", workspaceMemberId)
    .execute();

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    trustLevel: row.trust_level,
    ownerId: row.owner_id,
    accessKeys: accessRows.map((entry) => entry.access_key),
  };
}

async function loadActorRow(actorId: string): Promise<ActorRow | null> {
  return (await db
    .selectFrom("actors")
    .select([
      "id",
      "workspace_id",
      "access_policy",
      "created_by_workspace_member_id",
      "is_active",
    ])
    .where("id", "=", actorId)
    .limit(1)
    .executeTakeFirst()) as ActorRow | null;
}

async function loadConversationRow(
  conversationId: string,
): Promise<ConversationRow | null> {
  return (await db
    .selectFrom("conversations as conversation")
    .leftJoin(
      "workspace_members as creator_member",
      "creator_member.id",
      "conversation.created_by_workspace_member_id",
    )
    .select([
      "conversation.id as id",
      sql<string | null>`COALESCE(
        conversation.internal_workspace_id,
        creator_member.workspace_id
      )`.as("workspace_id"),
      "conversation.kind as kind",
      "conversation.boundary as boundary",
    ])
    .where("conversation.id", "=", conversationId)
    .limit(1)
    .executeTakeFirst()) as unknown as ConversationRow | null;
}

async function loadConversationActorContext(
  contextId: string,
): Promise<ConversationActorContextRow | null> {
  return (await db
    .selectFrom("conversation_actor_contexts")
    .select(["id", "actor_id", "conversation_id", "session_id"])
    .where("id", "=", contextId)
    .limit(1)
    .executeTakeFirst()) as ConversationActorContextRow | null;
}

async function loadPlatformAccessKeysForUser(userId: string) {
  const rows = await db
    .selectFrom("platform_access_bindings")
    .select("access_key")
    .where("user_id", "=", userId)
    .execute();
  return rows.map((row) => row.access_key);
}

function isWorkspaceOwnerOrAdmin(access: WorkspaceMemberAccess) {
  return access.ownerId === access.userId || access.trustLevel === "admin";
}

function hasWorkspaceAccessKey(
  access: WorkspaceMemberAccess,
  accessKey: string,
) {
  return access.accessKeys.includes(accessKey);
}

async function hasPlatformPermission(
  subject: PermissionSubject,
  permission: string,
): Promise<boolean> {
  let userId: string | null = null;
  if (subject.type === "user") {
    userId = subject.id;
  } else if (subject.type === "workspace_member") {
    const access = await loadWorkspaceMemberAccess(subject.id);
    userId = access?.userId || null;
  }
  if (!userId) {
    return false;
  }

  const accessKeys = await loadPlatformAccessKeysForUser(userId);
  switch (permission) {
    case "manage":
      return accessKeys.length > 0;
    case "manage_workspaces":
      return accessKeys.includes("super_admin") || accessKeys.includes("workspace_admin");
    case "manage_models":
      return accessKeys.includes("super_admin") || accessKeys.includes("model_admin");
    case "support_access":
      return accessKeys.includes("super_admin") || accessKeys.includes("support");
    case "audit":
      return accessKeys.includes("super_admin") || accessKeys.includes("auditor");
    default:
      return false;
  }
}

function workspacePermissionFromAccess(
  access: WorkspaceMemberAccess,
  permission: string,
) {
  const isAdmin = isWorkspaceOwnerOrAdmin(access);
  switch (permission) {
    case "view":
      return true;
    case "manage":
    case "manage_members":
      return isAdmin;
    case "manage_actors":
      return isAdmin || hasWorkspaceAccessKey(access, "actor_admin");
    case "use_actors":
      return true;
    case "manage_conversations":
      return isAdmin || hasWorkspaceAccessKey(access, "conversation_admin");
    case "create_conversation":
      return access.trustLevel !== "guest";
    case "manage_skills":
      return isAdmin || hasWorkspaceAccessKey(access, "skill_admin");
    case "manage_plugins":
      return isAdmin || hasWorkspaceAccessKey(access, "plugin_admin");
    case "manage_memories":
      return isAdmin || hasWorkspaceAccessKey(access, "memory_admin");
    case "manage_relays":
      return isAdmin || hasWorkspaceAccessKey(access, "relay_admin");
    case "manage_models":
      return isAdmin || hasWorkspaceAccessKey(access, "model_admin");
    default:
      return false;
  }
}

async function hasWorkspacePermission(
  subject: PermissionSubject,
  workspaceId: string,
  permission: string,
): Promise<boolean> {
  if (subject.type === "workspace") {
    return subject.id === workspaceId;
  }
  if (subject.type !== "workspace_member") {
    return false;
  }

  const access = await loadWorkspaceMemberAccess(subject.id);
  if (!access || access.workspaceId !== workspaceId) {
    return false;
  }

  return workspacePermissionFromAccess(access, permission);
}

async function hasActiveConversationMembership(params: {
  conversationId: string;
  workspaceMemberId?: string | null;
  actorId?: string | null;
}) {
  let query = db
    .selectFrom("conversation_participants")
    .select(["id", "role_key"])
    .where("conversation_id", "=", params.conversationId)
    .where("state", "=", "active");

  if (params.workspaceMemberId) {
    query = query
      .where("participant_kind", "=", "workspace_member")
      .where("workspace_member_id", "=", params.workspaceMemberId);
  } else if (params.actorId) {
    query = query
      .where("participant_kind", "=", "actor")
      .where("actor_id", "=", params.actorId);
  } else {
    return null;
  }

  return query.limit(1).executeTakeFirst();
}

async function hasConversationPermission(
  subject: PermissionSubject,
  conversationId: string,
  permission: string,
): Promise<boolean> {
  const conversation = await loadConversationRow(conversationId);
  if (!conversation) {
    return false;
  }

  if (subject.type === "workspace_member") {
    const access = await loadWorkspaceMemberAccess(subject.id);
    if (!access) {
      return false;
    }
    const membership = await hasActiveConversationMembership({
      conversationId,
      workspaceMemberId: subject.id,
    });
    const sameWorkspace =
      Boolean(conversation.workspace_id) &&
      access.workspaceId === conversation.workspace_id;
    const isConversationAdmin =
      membership?.role_key === "owner" || membership?.role_key === "admin";
    const isWorkspaceConversationAdmin =
      sameWorkspace && workspacePermissionFromAccess(access, "manage_conversations");

    switch (permission) {
      case "view":
        return Boolean(membership);
      case "send":
      case "memory_read":
        return Boolean(membership);
      case "memory_edit":
        return Boolean(membership);
      case "manage":
      case "manage_members":
      case "moderate":
      case "attach_resources":
      case "memory_retarget":
      case "memory_delete":
        return isConversationAdmin || isWorkspaceConversationAdmin;
      default:
        return false;
    }
  }

  if (subject.type === "actor") {
    const membership = await hasActiveConversationMembership({
      conversationId,
      actorId: subject.id,
    });
    if (!membership) {
      return false;
    }
    switch (permission) {
      case "view":
      case "send":
      case "memory_read":
      case "memory_edit":
        return true;
      default:
        return false;
    }
  }

  return false;
}

async function hasFriendActorAccess(
  workspaceId: string,
  workspaceMemberId: string,
  actorId: string,
) {
  const row = await db
    .selectFrom("workspace_friend_entries")
    .select("id")
    .where("workspace_id", "=", workspaceId)
    .where("owner_workspace_member_id", "=", workspaceMemberId)
    .where("peer_type", "=", "actor")
    .where("peer_actor_id", "=", actorId)
    .limit(1)
    .executeTakeFirst();
  return Boolean(row);
}

async function hasActorPermission(
  subject: PermissionSubject,
  actorId: string,
  permission: string,
): Promise<boolean> {
  const actor = await loadActorRow(actorId);
  if (!actor || !actor.is_active) {
    return false;
  }

  if (subject.type === "actor") {
    if (subject.id !== actorId) {
      return false;
    }
    switch (permission) {
      case "discover":
      case "view":
      case "invoke":
      case "receive_message":
      case "memory_read":
      case "memory_edit":
      case "memory_retarget":
      case "memory_delete":
        return true;
      default:
        return false;
    }
  }

  if (subject.type !== "workspace_member") {
    return false;
  }

  const access = await loadWorkspaceMemberAccess(subject.id);
  if (!access || access.workspaceId !== actor.workspace_id) {
    return false;
  }

  const canManage =
    isWorkspaceOwnerOrAdmin(access) ||
    hasWorkspaceAccessKey(access, "actor_admin") ||
    actor.created_by_workspace_member_id === access.id;
  const canUse =
    canManage ||
    actor.access_policy === "workspace_open" ||
    (await hasFriendActorAccess(actor.workspace_id, access.id, actorId));

  switch (permission) {
    case "discover":
    case "view":
    case "invoke":
    case "receive_message":
    case "memory_read":
    case "memory_edit":
      return canUse;
    case "edit":
    case "grant":
    case "delete":
    case "memory_retarget":
    case "memory_delete":
      return canManage;
    default:
      return false;
  }
}

async function hasConversationActorContextPermission(
  subject: PermissionSubject,
  contextId: string,
  permission: string,
): Promise<boolean> {
  const context = await loadConversationActorContext(contextId);
  if (!context) {
    return false;
  }

  if (subject.type === "actor") {
    const membership =
      subject.id === context.actor_id
        ? await hasActiveConversationMembership({
            conversationId: context.conversation_id,
            actorId: subject.id,
          })
        : null;

    if (!membership) {
      return false;
    }

    switch (permission) {
      case "memory_read":
      case "memory_edit":
      case "memory_retarget":
      case "memory_delete":
        return true;
      default:
        return false;
    }
  }

  if (subject.type !== "workspace_member") {
    return false;
  }

  const inConversation = await hasActiveConversationMembership({
    conversationId: context.conversation_id,
    workspaceMemberId: subject.id,
  });
  if (!inConversation) {
    return false;
  }

  switch (permission) {
    case "memory_read":
    case "memory_edit":
      return hasActorPermission(subject, context.actor_id, permission);
    case "memory_retarget":
    case "memory_delete":
      return hasActorPermission(subject, context.actor_id, permission);
    default:
      return false;
  }
}

type ResourceGrantRow = {
  resource_id: string;
  target_type: "workspace" | "conversation" | "actor" | "actor_in_conversation";
  subject_workspace_id: string | null;
  subject_actor_id: string | null;
  subject_conversation_id: string | null;
  subject_conversation_actor_context_id: string | null;
};

async function listResourceGrantRows(
  resourceType: "installed_skill" | "plugin_installation" | "relay_capability" | "automation_event_source",
  resourceId: string | null,
  subject: PermissionSubject,
) {
  const resourceColumn =
    resourceType === "installed_skill"
      ? "binding.installed_skill_id"
      : resourceType === "plugin_installation"
        ? "binding.plugin_installation_id"
        : resourceType === "relay_capability"
          ? "binding.relay_capability_id"
          : "binding.automation_event_source_id";

  const whereClauses: string[] = ["binding.status = 'active'"];
  const values: unknown[] = [];

  if (resourceId) {
    values.push(resourceId);
    whereClauses.push(`${resourceColumn} = $${values.length}::uuid`);
  }

  if (subject.type === "workspace") {
    values.push(subject.id);
    whereClauses.push(
      `binding.target_type = 'workspace' AND binding.subject_workspace_id = $${values.length}::uuid`,
    );
  } else if (subject.type === "actor") {
    values.push(subject.id);
    whereClauses.push(
      `binding.target_type = 'actor' AND binding.subject_actor_id = $${values.length}::uuid`,
    );
  } else if (subject.type === "conversation_actor_context") {
    const context = await loadConversationActorContext(subject.id);
    if (!context) {
      return [] as ResourceGrantRow[];
    }
    const membership = await hasActiveConversationMembership({
      conversationId: context.conversation_id,
      actorId: context.actor_id,
    });
    if (!membership) {
      return [] as ResourceGrantRow[];
    }
    values.push(subject.id);
    const contextIdIndex = values.length;
    values.push(context.conversation_id);
    const conversationIdIndex = values.length;
    whereClauses.push(
      `(
        (binding.target_type = 'actor_in_conversation' AND binding.subject_conversation_actor_context_id = $${contextIdIndex}::uuid)
        OR
        (binding.target_type = 'conversation' AND binding.subject_conversation_id = $${conversationIdIndex}::uuid)
      )`,
    );
  } else if (subject.type === "workspace_member") {
    const access = await loadWorkspaceMemberAccess(subject.id);
    if (!access) {
      return [] as ResourceGrantRow[];
    }
    values.push(access.workspaceId);
    whereClauses.push(
      `binding.target_type = 'workspace' AND binding.subject_workspace_id = $${values.length}::uuid`,
    );
  } else {
    return [] as ResourceGrantRow[];
  }

  const result = await executeSql<ResourceGrantRow>(
    `SELECT
       COALESCE(
         binding.installed_skill_id::text,
         binding.plugin_installation_id::text,
         binding.relay_capability_id::text,
         binding.automation_event_source_id::text
       ) AS resource_id,
       binding.target_type,
       binding.subject_workspace_id,
       binding.subject_actor_id,
       binding.subject_conversation_id,
       binding.subject_conversation_actor_context_id
     FROM resource_access_bindings binding
     WHERE ${whereClauses.join(" AND ")}`,
    values,
  );
  return result.rows;
}

async function hasResourceGrant(
  resourceType: "installed_skill" | "plugin_installation" | "relay_capability" | "automation_event_source",
  resourceId: string,
  subject: PermissionSubject,
) {
  const rows = await listResourceGrantRows(resourceType, resourceId, subject);
  return rows.length > 0;
}

async function listGrantedResourceIds(
  resourceType: "installed_skill" | "plugin_installation" | "relay_capability" | "automation_event_source",
  subject: PermissionSubject,
  limit?: number,
) {
  const rows = await listResourceGrantRows(resourceType, null, subject);
  const ids = Array.from(new Set(rows.map((row) => row.resource_id)));
  return typeof limit === "number" && limit > 0 ? ids.slice(0, limit) : ids;
}

function finalizeResourceIdList(groups: readonly string[][], limit?: number) {
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const group of groups) {
    for (const id of group) {
      if (!id || seen.has(id)) {
        continue;
      }
      seen.add(id);
      merged.push(id);
      if (typeof limit === "number" && limit > 0 && merged.length >= limit) {
        return merged;
      }
    }
  }

  return merged;
}

async function listManageableInstalledSkillIds(
  subject: PermissionSubject,
  limit?: number,
) {
  if (subject.type !== "workspace_member") {
    return [] as string[];
  }

  const access = await loadWorkspaceMemberAccess(subject.id);
  if (!access) {
    return [] as string[];
  }

  let query = db
    .selectFrom("installed_skills")
    .select("id")
    .where("workspace_id", "=", access.workspaceId)
    .where("is_active", "=", true)
    .orderBy("updated_at", "desc");

  if (!workspacePermissionFromAccess(access, "manage_skills")) {
    query = query.where("created_by_workspace_member_id", "=", access.id);
  }

  const rows = await query
    .limit(limit && limit > 0 ? limit : 1000)
    .execute();
  return rows.map((row) => row.id);
}

async function listManageablePluginInstallationIds(
  subject: PermissionSubject,
  limit?: number,
) {
  if (subject.type !== "workspace_member") {
    return [] as string[];
  }

  const access = await loadWorkspaceMemberAccess(subject.id);
  if (!access) {
    return [] as string[];
  }

  let query = db
    .selectFrom("plugin_installations")
    .select("id")
    .where("workspace_id", "=", access.workspaceId)
    .where("status", "=", "active")
    .orderBy("updated_at", "desc");

  if (!workspacePermissionFromAccess(access, "manage_plugins")) {
    query = query.where("installed_by_workspace_member_id", "=", access.id);
  }

  const rows = await query
    .limit(limit && limit > 0 ? limit : 1000)
    .execute();
  return rows.map((row) => row.id);
}

async function listManageableRelayCapabilityIds(
  subject: PermissionSubject,
  limit?: number,
) {
  if (subject.type !== "workspace_member") {
    return [] as string[];
  }

  const access = await loadWorkspaceMemberAccess(subject.id);
  if (!access) {
    return [] as string[];
  }

  let query = db
    .selectFrom("relay_capabilities as capability")
    .innerJoin("relay_exposures as exposure", "exposure.id", "capability.exposure_id")
    .innerJoin("relay_devices as device", "device.id", "exposure.device_id")
    .select("capability.id")
    .where("capability.workspace_id", "=", access.workspaceId)
    .where("capability.status", "=", "active")
    .orderBy("capability.updated_at", "desc");

  if (!workspacePermissionFromAccess(access, "manage_relays")) {
    query = query.where("device.owner_workspace_member_id", "=", access.id);
  }

  const rows = await query
    .limit(limit && limit > 0 ? limit : 1000)
    .execute();
  return rows.map((row) => row.id);
}

async function hasInstalledSkillPermission(
  subject: PermissionSubject,
  skillId: string,
  permission: string,
): Promise<boolean> {
  const row = await db
    .selectFrom("installed_skills")
    .select(["workspace_id", "created_by_workspace_member_id", "is_active"])
    .where("id", "=", skillId)
    .limit(1)
    .executeTakeFirst();
  if (!row || !row.is_active) {
    return false;
  }

  if (permission === "use" || permission === "view") {
    if (await hasResourceGrant("installed_skill", skillId, subject)) {
      return true;
    }
  }

  if (subject.type !== "workspace_member") {
    return false;
  }

  const access = await loadWorkspaceMemberAccess(subject.id);
  if (!access || access.workspaceId !== row.workspace_id) {
    return false;
  }

  const canManage =
    workspacePermissionFromAccess(access, "manage_skills") ||
    row.created_by_workspace_member_id === access.id;
  if (permission === "view" || permission === "use") {
    return canManage;
  }
  return canManage;
}

async function hasPluginInstallationPermission(
  subject: PermissionSubject,
  installationId: string,
  permission: string,
): Promise<boolean> {
  const row = await db
    .selectFrom("plugin_installations")
    .select(["workspace_id", "installed_by_workspace_member_id", "status"])
    .where("id", "=", installationId)
    .limit(1)
    .executeTakeFirst();
  if (!row || row.status !== "active") {
    return false;
  }

  if (permission === "use" || permission === "view") {
    if (await hasResourceGrant("plugin_installation", installationId, subject)) {
      return true;
    }
  }

  if (subject.type !== "workspace_member") {
    return false;
  }

  const access = await loadWorkspaceMemberAccess(subject.id);
  if (!access || access.workspaceId !== row.workspace_id) {
    return false;
  }

  const canManage =
    workspacePermissionFromAccess(access, "manage_plugins") ||
    row.installed_by_workspace_member_id === access.id;
  if (permission === "view" || permission === "use") {
    return canManage;
  }
  return canManage;
}

async function hasRelayDevicePermission(
  subject: PermissionSubject,
  deviceId: string,
  permission: string,
): Promise<boolean> {
  const row = await db
    .selectFrom("relay_devices")
    .select(["workspace_id", "owner_workspace_member_id"])
    .where("id", "=", deviceId)
    .limit(1)
    .executeTakeFirst();
  if (!row) {
    return false;
  }

  if (subject.type === "user") {
    if (permission !== "authorize_relay_authorization") {
      return false;
    }
    return hasPlatformPermission(subject, "manage");
  }

  if (subject.type !== "workspace_member") {
    return false;
  }

  const access = await loadWorkspaceMemberAccess(subject.id);
  if (!access || access.workspaceId !== row.workspace_id) {
    return false;
  }

  const canManage =
    workspacePermissionFromAccess(access, "manage_relays") ||
    row.owner_workspace_member_id === access.id;

  switch (permission) {
    case "view":
    case "manage":
    case "delete":
    case "authorize_relay_authorization":
      return canManage;
    default:
      return false;
  }
}

async function hasRelayExposurePermission(
  subject: PermissionSubject,
  exposureId: string,
  permission: string,
): Promise<boolean> {
  const row = await db
    .selectFrom("relay_exposures as exposure")
    .innerJoin("relay_devices as device", "device.id", "exposure.device_id")
    .select(["device.id as device_id"])
    .where("exposure.id", "=", exposureId)
    .limit(1)
    .executeTakeFirst();
  if (!row?.device_id) {
    return false;
  }
  return hasRelayDevicePermission(subject, row.device_id, permission === "view" ? "view" : "manage");
}

async function hasRelayCapabilityPermission(
  subject: PermissionSubject,
  capabilityId: string,
  permission: string,
): Promise<boolean> {
  const row = await db
    .selectFrom("relay_capabilities as capability")
    .innerJoin("relay_exposures as exposure", "exposure.id", "capability.exposure_id")
    .innerJoin("relay_devices as device", "device.id", "exposure.device_id")
    .select([
      "capability.workspace_id",
      "capability.status",
      "device.id as device_id",
      "device.owner_workspace_member_id",
    ])
    .where("capability.id", "=", capabilityId)
    .limit(1)
    .executeTakeFirst();
  if (!row || row.status !== "active") {
    return false;
  }

  if (
    permission === "use" ||
    permission === "view" ||
    permission === "request_relay_authorization"
  ) {
    if (await hasResourceGrant("relay_capability", capabilityId, subject)) {
      return true;
    }
  }

  if (subject.type !== "workspace_member") {
    return false;
  }

  const access = await loadWorkspaceMemberAccess(subject.id);
  if (!access || access.workspaceId !== row.workspace_id) {
    return false;
  }

  const canManage =
    workspacePermissionFromAccess(access, "manage_relays") ||
    row.owner_workspace_member_id === access.id;

  if (
    permission === "view" ||
    permission === "use" ||
    permission === "request_relay_authorization"
  ) {
    return canManage;
  }
  return canManage;
}

async function listActorIds(subject: PermissionSubject, limit?: number) {
  if (subject.type !== "workspace_member") {
    return subject.type === "actor" ? [subject.id] : [];
  }

  const access = await loadWorkspaceMemberAccess(subject.id);
  if (!access) {
    return [];
  }

  let query = db
    .selectFrom("actors as a")
    .select("a.id")
    .where("a.workspace_id", "=", access.workspaceId)
    .where("a.is_active", "=", true);

  if (
    !isWorkspaceOwnerOrAdmin(access) &&
    !hasWorkspaceAccessKey(access, "actor_admin")
  ) {
    query = query.where((eb) =>
      eb.or([
        eb("a.access_policy", "=", "workspace_open"),
        eb("a.created_by_workspace_member_id", "=", access.id),
        sql<boolean>`EXISTS (
          SELECT 1
          FROM workspace_friend_entries friend
          WHERE friend.workspace_id = ${access.workspaceId}
            AND friend.owner_workspace_member_id = ${access.id}
            AND friend.peer_type = 'actor'
            AND friend.peer_actor_id = a.id
        )`,
      ]),
    );
  }

  const rows = await query
    .orderBy("a.created_at", "desc")
    .limit(limit && limit > 0 ? limit : 1000)
    .execute();
  return rows.map((row) => row.id);
}

async function listModelGroupIds(subject: PermissionSubject, limit?: number) {
  if (subject.type === "actor") {
    const actor = await loadActorRow(subject.id);
    if (!actor) {
      return [];
    }
    const rows = await db
      .selectFrom("model_groups as mg")
      .distinct()
      .leftJoin("model_group_grants as mgg", (join) =>
        join
          .onRef("mgg.group_id", "=", "mg.id")
          .on("mgg.status", "=", "active"),
      )
      .select("mg.id")
      .where("mg.is_enabled", "=", true)
      .where((eb) =>
        eb.or([
          eb.and([
            eb("mg.owner_type", "=", "workspace"),
            eb("mg.owner_workspace_id", "=", actor.workspace_id),
          ]),
          eb("mgg.grant_scope", "=", "platform"),
          eb.and([
            eb("mgg.grant_scope", "=", "workspace"),
            eb("mgg.workspace_id", "=", actor.workspace_id),
          ]),
          eb.and([
            eb("mgg.grant_scope", "=", "actor"),
            eb("mgg.workspace_id", "=", actor.workspace_id),
            eb("mgg.actor_id", "=", subject.id),
          ]),
        ]),
      )
      .limit(limit && limit > 0 ? limit : 1000)
      .execute();
    return rows.map((row) => row.id);
  }

  if (subject.type !== "workspace_member") {
    return [];
  }

  const access = await loadWorkspaceMemberAccess(subject.id);
  if (!access) {
    return [];
  }

  const rows = await db
    .selectFrom("model_groups as mg")
    .distinct()
    .leftJoin("model_group_grants as mgg", (join) =>
      join
        .onRef("mgg.group_id", "=", "mg.id")
        .on("mgg.status", "=", "active"),
    )
    .select("mg.id")
    .where("mg.is_enabled", "=", true)
    .where((eb) =>
      eb.or([
        eb.and([
          eb("mg.owner_type", "=", "workspace"),
          eb("mg.owner_workspace_id", "=", access.workspaceId),
        ]),
        eb.and([
          eb("mg.owner_type", "=", "workspace_member"),
          eb("mg.owner_workspace_member_id", "=", access.id),
        ]),
        eb("mgg.grant_scope", "=", "platform"),
        eb.and([
          eb("mgg.grant_scope", "=", "workspace"),
          eb("mgg.workspace_id", "=", access.workspaceId),
        ]),
        eb.and([
          eb("mgg.grant_scope", "=", "workspace_member"),
          eb("mgg.workspace_member_id", "=", access.id),
        ]),
      ]),
    )
    .limit(limit && limit > 0 ? limit : 1000)
    .execute();
  return rows.map((row) => row.id);
}

async function hasModelGroupPermission(
  subject: PermissionSubject,
  groupId: string,
  permission: string,
): Promise<boolean> {
  const row = await db
    .selectFrom("model_groups")
    .select([
      "id",
      "owner_type",
      "owner_workspace_id",
      "owner_workspace_member_id",
      "is_enabled",
    ])
    .where("id", "=", groupId)
    .limit(1)
    .executeTakeFirst();
  if (!row || !row.is_enabled) {
    return false;
  }

  if (permission === "use" || permission === "view") {
    const allowedIds = new Set(await listModelGroupIds(subject));
    if (allowedIds.has(groupId)) {
      return true;
    }
  }

  if (subject.type === "workspace_member") {
    const access = await loadWorkspaceMemberAccess(subject.id);
    if (!access) {
      return false;
    }

    if (
      row.owner_type === "workspace_member" &&
      row.owner_workspace_member_id === access.id
    ) {
      return true;
    }

    if (
      row.owner_type === "workspace" &&
      row.owner_workspace_id === access.workspaceId &&
      workspacePermissionFromAccess(access, "manage_models")
    ) {
      return true;
    }

    if (row.owner_type === "platform") {
      return hasPlatformPermission({ type: "workspace_member", id: access.id }, "manage_models");
    }
  }

  return false;
}

async function hasModelProfilePermission(
  subject: PermissionSubject,
  profileId: string,
  permission: string,
): Promise<boolean> {
  const groups = await db
    .selectFrom("model_group_profiles")
    .select("group_id")
    .where("profile_id", "=", profileId)
    .execute();
  if (groups.length === 0) {
    return false;
  }

  const mappedPermission =
    permission === "use" || permission === "view"
      ? permission
      : permission === "attach"
        ? "edit"
        : permission;

  for (const group of groups) {
    if (await hasModelGroupPermission(subject, group.group_id, mappedPermission)) {
      return true;
    }
  }

  return false;
}

async function hasMemoryItemPermission(
  subject: PermissionSubject,
  memoryItemId: string,
  permission: string,
): Promise<boolean> {
  const row = await db
    .selectFrom("memory_items as mi")
    .innerJoin("memory_spaces as ms", "ms.id", "mi.memory_space_id")
    .leftJoin("conversation_actor_contexts as cac", "cac.id", "ms.anchor_conversation_actor_context_id")
    .select([
      "mi.workspace_id",
      "ms.space_type",
      "ms.anchor_conversation_id",
      "ms.anchor_actor_id",
      "ms.anchor_workspace_member_id",
      "ms.anchor_conversation_actor_context_id",
      "cac.actor_id as context_actor_id",
      "cac.conversation_id as context_conversation_id",
    ])
    .where("mi.id", "=", memoryItemId)
    .limit(1)
    .executeTakeFirst();
  if (!row) {
    return false;
  }

  switch (row.space_type) {
    case "workspace_shared":
      if (subject.type === "actor") {
        const actor = await loadActorRow(subject.id);
        if (!actor || actor.workspace_id !== row.workspace_id) {
          return false;
        }
        return permission === "read" || permission === "recall" || permission === "edit";
      }
      return hasWorkspacePermission(
        subject,
        row.workspace_id,
        permission === "read" || permission === "recall"
          ? "view"
          : "manage_memories",
      );
    case "conversation_shared":
      if (!row.anchor_conversation_id) {
        return false;
      }
      return hasConversationPermission(
        subject,
        row.anchor_conversation_id,
        permission === "read" || permission === "recall"
          ? "memory_read"
          : permission === "edit"
            ? "memory_edit"
            : permission === "retarget"
              ? "memory_retarget"
              : "memory_delete",
      );
    case "actor_private":
      if (!row.anchor_actor_id) {
        return false;
      }
      return hasActorPermission(
        subject,
        row.anchor_actor_id,
        permission === "read" || permission === "recall"
          ? "memory_read"
          : permission === "edit"
            ? "memory_edit"
            : permission === "retarget"
              ? "memory_retarget"
              : "memory_delete",
      );
    case "participant_private":
      if (!row.anchor_conversation_actor_context_id) {
        return false;
      }
      return hasConversationActorContextPermission(
        subject,
        row.anchor_conversation_actor_context_id,
        permission === "read" || permission === "recall"
          ? "memory_read"
          : permission === "edit"
            ? "memory_edit"
            : permission === "retarget"
              ? "memory_retarget"
              : "memory_delete",
      );
    case "user_private":
      if (subject.type === "workspace_member") {
        if (row.anchor_workspace_member_id === subject.id) {
          return true;
        }
      }
      return hasWorkspacePermission(subject, row.workspace_id, "manage_memories");
    default:
      return false;
  }
}

export async function checkPermissionSql(params: {
  resourceType: AccessResourceType;
  resourceId: string;
  permission: string;
  subject: PermissionSubject;
}) {
  if (!params.resourceId) {
    return false;
  }

  switch (params.resourceType) {
    case "platform":
      return (
        params.resourceId === PLATFORM_RESOURCE_ID &&
        hasPlatformPermission(params.subject, params.permission)
      );
    case "workspace":
      return hasWorkspacePermission(
        params.subject,
        params.resourceId,
        params.permission,
      );
    case "conversation":
      return hasConversationPermission(
        params.subject,
        params.resourceId,
        params.permission,
      );
    case "actor":
      return hasActorPermission(params.subject, params.resourceId, params.permission);
    case "conversation_actor_context":
      return hasConversationActorContextPermission(
        params.subject,
        params.resourceId,
        params.permission,
      );
    case "memory_item":
      return hasMemoryItemPermission(
        params.subject,
        params.resourceId,
        params.permission,
      );
    case "installed_skill":
      return hasInstalledSkillPermission(
        params.subject,
        params.resourceId,
        params.permission,
      );
    case "plugin_installation":
      return hasPluginInstallationPermission(
        params.subject,
        params.resourceId,
        params.permission,
      );
    case "relay_device":
      return hasRelayDevicePermission(
        params.subject,
        params.resourceId,
        params.permission,
      );
    case "relay_exposure":
      return hasRelayExposurePermission(
        params.subject,
        params.resourceId,
        params.permission,
      );
    case "relay_capability":
      return hasRelayCapabilityPermission(
        params.subject,
        params.resourceId,
        params.permission,
      );
    case "model_group":
      return hasModelGroupPermission(
        params.subject,
        params.resourceId,
        params.permission,
      );
    case "model_profile":
      return hasModelProfilePermission(
        params.subject,
        params.resourceId,
        params.permission,
      );
    default:
      return false;
  }
}

export async function lookupResourcesSql(params: {
  resourceType: AccessResourceType;
  permission: string;
  subject: PermissionSubject;
  limit?: number;
}) {
  switch (params.resourceType) {
    case "actor":
      return params.permission === "view" || params.permission === "discover" || params.permission === "invoke"
        ? listActorIds(params.subject, params.limit)
        : [];
    case "model_group":
      return params.permission === "use" || params.permission === "view"
        ? listModelGroupIds(params.subject, params.limit)
        : [];
    case "installed_skill":
      return params.permission === "use" || params.permission === "view"
        ? finalizeResourceIdList(
            [
              await listGrantedResourceIds(
                "installed_skill",
                params.subject,
                params.limit,
              ),
              await listManageableInstalledSkillIds(
                params.subject,
                params.limit,
              ),
            ],
            params.limit,
          )
        : [];
    case "plugin_installation":
      return params.permission === "use" || params.permission === "view"
        ? finalizeResourceIdList(
            [
              await listGrantedResourceIds(
                "plugin_installation",
                params.subject,
                params.limit,
              ),
              await listManageablePluginInstallationIds(
                params.subject,
                params.limit,
              ),
            ],
            params.limit,
          )
        : [];
    case "relay_capability":
      return (
        params.permission === "use" ||
        params.permission === "view" ||
        params.permission === "request_relay_authorization"
      )
        ? finalizeResourceIdList(
            [
              await listGrantedResourceIds(
                "relay_capability",
                params.subject,
                params.limit,
              ),
              await listManageableRelayCapabilityIds(
                params.subject,
                params.limit,
              ),
            ],
            params.limit,
          )
        : [];
    case "automation_event_source":
      return params.permission === "use" || params.permission === "view"
        ? listGrantedResourceIds("automation_event_source", params.subject, params.limit)
        : [];
    default:
      return [];
  }
}

export {
  PLATFORM_RESOURCE_ID,
  type AccessResourceType,
  type PermissionSubject,
};
