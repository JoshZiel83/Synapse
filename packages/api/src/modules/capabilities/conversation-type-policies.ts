import type pg from "pg";
import {
  CAPABILITY_CONVERSATION_TYPE_POLICY_RESOURCE_FAMILIES,
  DEFAULT_CONVERSATION_TYPE_MASK,
  normalizeConversationTypeMask,
} from "@synapse/shared";
import type {
  CapabilityConversationTypePolicyResourceFamily,
  WorkspaceCapabilityConversationTypePoliciesView,
  WorkspaceCapabilityConversationTypePolicy,
} from "@synapse/shared/types";
import { executeSql, executeSqlOn } from "../../infrastructure/database/kysely.js";

type Queryable = Pick<pg.PoolClient, "query">;

type WorkspaceCapabilityConversationTypePolicyRow = {
  workspace_id: string;
  resource_family: CapabilityConversationTypePolicyResourceFamily;
  default_conversation_type_mask: number;
};

function normalizeWorkspacePolicyRow(
  workspaceId: string,
  resourceFamily: CapabilityConversationTypePolicyResourceFamily,
  row?: WorkspaceCapabilityConversationTypePolicyRow,
): WorkspaceCapabilityConversationTypePolicy {
  return {
    workspaceId,
    resourceFamily,
    defaultConversationTypeMask: normalizeConversationTypeMask(
      row?.default_conversation_type_mask,
      DEFAULT_CONVERSATION_TYPE_MASK,
    ),
  };
}

function buildWorkspacePoliciesView(
  workspaceId: string,
  rows: WorkspaceCapabilityConversationTypePolicyRow[],
): WorkspaceCapabilityConversationTypePoliciesView {
  const rowsByFamily = new Map(
    rows.map((row) => [row.resource_family, row] as const),
  );
  return {
    workspaceId,
    policies: CAPABILITY_CONVERSATION_TYPE_POLICY_RESOURCE_FAMILIES.map(
      (resourceFamily) =>
        normalizeWorkspacePolicyRow(
          workspaceId,
          resourceFamily,
          rowsByFamily.get(resourceFamily),
        ),
    ),
  };
}

export async function seedWorkspaceCapabilityConversationTypePolicies(
  run: Queryable,
  workspaceId: string,
) {
  for (const resourceFamily of CAPABILITY_CONVERSATION_TYPE_POLICY_RESOURCE_FAMILIES) {
    await executeSqlOn(
      run,
      `INSERT INTO workspace_capability_conversation_type_policies (
         workspace_id,
         resource_family,
         default_conversation_type_mask
       )
       VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, resource_family) DO NOTHING`,
      [workspaceId, resourceFamily, DEFAULT_CONVERSATION_TYPE_MASK],
    );
  }
}

export async function listWorkspaceCapabilityConversationTypePolicies(
  workspaceId: string,
) {
  const result = await executeSql<WorkspaceCapabilityConversationTypePolicyRow>(
    `SELECT
       workspace_id,
       resource_family,
       default_conversation_type_mask
     FROM workspace_capability_conversation_type_policies
     WHERE workspace_id = $1
     ORDER BY resource_family ASC`,
    [workspaceId],
  );
  return buildWorkspacePoliciesView(workspaceId, result.rows);
}

export async function updateWorkspaceCapabilityConversationTypePolicies(input: {
  workspaceId: string;
  policies: Partial<
    Record<CapabilityConversationTypePolicyResourceFamily, number>
  >;
}) {
  const entries = Object.entries(input.policies).filter(
    ([, mask]) => mask !== undefined,
  ) as Array<[CapabilityConversationTypePolicyResourceFamily, number]>;

  for (const [resourceFamily, defaultMask] of entries) {
    await executeSql(
      `INSERT INTO workspace_capability_conversation_type_policies (
         workspace_id,
         resource_family,
         default_conversation_type_mask
       )
       VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, resource_family) DO UPDATE
         SET default_conversation_type_mask = EXCLUDED.default_conversation_type_mask,
             updated_at = NOW()`,
      [
        input.workspaceId,
        resourceFamily,
        normalizeConversationTypeMask(
          defaultMask,
          DEFAULT_CONVERSATION_TYPE_MASK,
        ),
      ],
    );
  }

  return listWorkspaceCapabilityConversationTypePolicies(input.workspaceId);
}

export async function getWorkspaceCapabilityConversationTypePolicyMap(
  workspaceIds: string[],
) {
  const uniqueWorkspaceIds = Array.from(new Set(workspaceIds.filter(Boolean)));
  const map = new Map<
    string,
    Record<CapabilityConversationTypePolicyResourceFamily, number>
  >();

  if (uniqueWorkspaceIds.length === 0) {
    return map;
  }

  const result = await executeSql<WorkspaceCapabilityConversationTypePolicyRow>(
    `SELECT
       workspace_id,
       resource_family,
       default_conversation_type_mask
     FROM workspace_capability_conversation_type_policies
     WHERE workspace_id = ANY($1::uuid[])`,
    [uniqueWorkspaceIds],
  );

  for (const workspaceId of uniqueWorkspaceIds) {
    map.set(workspaceId, {
      plugin_installation: DEFAULT_CONVERSATION_TYPE_MASK,
      installed_skill: DEFAULT_CONVERSATION_TYPE_MASK,
      relay_exposure: DEFAULT_CONVERSATION_TYPE_MASK,
    });
  }

  for (const row of result.rows) {
    const current = map.get(row.workspace_id);
    if (!current) continue;
    current[row.resource_family] = normalizeConversationTypeMask(
      row.default_conversation_type_mask,
      DEFAULT_CONVERSATION_TYPE_MASK,
    );
  }

  return map;
}

export async function getWorkspaceCapabilityConversationTypeMask(
  workspaceId: string,
  resourceFamily: CapabilityConversationTypePolicyResourceFamily,
) {
  const policies = await getWorkspaceCapabilityConversationTypePolicyMap([
    workspaceId,
  ]);
  return (
    policies.get(workspaceId)?.[resourceFamily] ||
    DEFAULT_CONVERSATION_TYPE_MASK
  );
}
