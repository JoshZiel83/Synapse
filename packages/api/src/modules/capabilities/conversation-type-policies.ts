import { sql } from "kysely"
import {
  CAPABILITY_CONVERSATION_TYPE_POLICY_RESOURCE_FAMILIES,
  DEFAULT_CONVERSATION_TYPE_MASK,
  SUBJECT_KIND,
  normalizeConversationTypeMask,
} from "@synapse/shared"
import type {
  CapabilityConversationTypePolicyResourceFamily,
  WorkspaceCapabilityConversationTypePoliciesView,
  WorkspaceCapabilityConversationTypePolicy,
} from "@synapse/shared/types"
import { db, type Executor } from "../../infrastructure/database/kysely.js"
import { upsertAccessSubject } from "../access/subject-registry.js"

type WorkspaceCapabilityConversationTypePolicyRow = {
  workspace_id: string
  resource_family: CapabilityConversationTypePolicyResourceFamily
  default_conversation_type_mask: number
}

function normalizeWorkspacePolicyRow(
  workspaceId: string,
  resourceFamily: CapabilityConversationTypePolicyResourceFamily,
  row?: WorkspaceCapabilityConversationTypePolicyRow
): WorkspaceCapabilityConversationTypePolicy {
  return {
    workspaceId,
    resourceFamily,
    defaultConversationTypeMask: normalizeConversationTypeMask(
      row?.default_conversation_type_mask,
      DEFAULT_CONVERSATION_TYPE_MASK
    ),
  }
}

function buildWorkspacePoliciesView(
  workspaceId: string,
  rows: WorkspaceCapabilityConversationTypePolicyRow[]
): WorkspaceCapabilityConversationTypePoliciesView {
  const rowsByFamily = new Map(
    rows.map((row) => [row.resource_family, row] as const)
  )
  return {
    workspaceId,
    policies: CAPABILITY_CONVERSATION_TYPE_POLICY_RESOURCE_FAMILIES.map(
      (resourceFamily) =>
        normalizeWorkspacePolicyRow(
          workspaceId,
          resourceFamily,
          rowsByFamily.get(resourceFamily)
        )
    ),
  }
}

export async function seedWorkspaceCapabilityConversationTypePolicies(
  run: Executor,
  workspaceId: string
) {
  const workspaceSubjectId = await upsertAccessSubject(run, {
    kind: SUBJECT_KIND.WORKSPACE,
    workspaceId,
  })
  for (const resourceFamily of CAPABILITY_CONVERSATION_TYPE_POLICY_RESOURCE_FAMILIES) {
    await sql`
      INSERT INTO workspace_capability_conversation_type_policies (
        subject_id,
        resource_family,
        default_conversation_type_mask
      )
      VALUES (${workspaceSubjectId}, ${resourceFamily}, ${DEFAULT_CONVERSATION_TYPE_MASK})
      ON CONFLICT (subject_id, resource_family) DO NOTHING`.execute(run)
  }
}

export async function listWorkspaceCapabilityConversationTypePolicies(
  workspaceId: string
) {
  const result = await sql<WorkspaceCapabilityConversationTypePolicyRow>`
    SELECT
      subj.workspace_id,
      policy.resource_family,
      policy.default_conversation_type_mask
    FROM workspace_capability_conversation_type_policies policy
    INNER JOIN access_subjects subj ON subj.id = policy.subject_id
    WHERE subj.workspace_id = ${workspaceId}
      AND subj.kind = 'workspace'
    ORDER BY policy.resource_family ASC`.execute(db)
  return buildWorkspacePoliciesView(workspaceId, result.rows)
}

export async function updateWorkspaceCapabilityConversationTypePolicies(input: {
  workspaceId: string
  policies: Partial<
    Record<CapabilityConversationTypePolicyResourceFamily, number>
  >
}) {
  const entries = Object.entries(input.policies).filter(
    ([, mask]) => mask !== undefined
  ) as Array<[CapabilityConversationTypePolicyResourceFamily, number]>

  const workspaceSubjectId = await upsertAccessSubject(db, {
    kind: SUBJECT_KIND.WORKSPACE,
    workspaceId: input.workspaceId,
  })

  for (const [resourceFamily, defaultMask] of entries) {
    await sql`
      INSERT INTO workspace_capability_conversation_type_policies (
        subject_id,
        resource_family,
        default_conversation_type_mask
      )
      VALUES (
        ${workspaceSubjectId},
        ${resourceFamily},
        ${normalizeConversationTypeMask(defaultMask, DEFAULT_CONVERSATION_TYPE_MASK)}
      )
      ON CONFLICT (subject_id, resource_family) DO UPDATE
        SET default_conversation_type_mask = EXCLUDED.default_conversation_type_mask`.execute(
      db
    )
  }

  return listWorkspaceCapabilityConversationTypePolicies(input.workspaceId)
}

export async function getWorkspaceCapabilityConversationTypePolicyMap(
  workspaceIds: string[]
) {
  const uniqueWorkspaceIds = Array.from(new Set(workspaceIds.filter(Boolean)))
  const map = new Map<
    string,
    Record<CapabilityConversationTypePolicyResourceFamily, number>
  >()

  if (uniqueWorkspaceIds.length === 0) {
    return map
  }

  const result = await sql<WorkspaceCapabilityConversationTypePolicyRow>`
    SELECT
      subj.workspace_id,
      policy.resource_family,
      policy.default_conversation_type_mask
    FROM workspace_capability_conversation_type_policies policy
    INNER JOIN access_subjects subj ON subj.id = policy.subject_id
    WHERE subj.workspace_id = ANY(${uniqueWorkspaceIds}::uuid[])
      AND subj.kind = 'workspace'`.execute(db)

  for (const workspaceId of uniqueWorkspaceIds) {
    map.set(workspaceId, {
      plugin_installation: DEFAULT_CONVERSATION_TYPE_MASK,
      installed_skill: DEFAULT_CONVERSATION_TYPE_MASK,
      device_capability: DEFAULT_CONVERSATION_TYPE_MASK,
    })
  }

  for (const row of result.rows) {
    const current = map.get(row.workspace_id)
    if (!current) continue
    current[row.resource_family] = normalizeConversationTypeMask(
      row.default_conversation_type_mask,
      DEFAULT_CONVERSATION_TYPE_MASK
    )
  }

  return map
}

export async function getWorkspaceCapabilityConversationTypeMask(
  workspaceId: string,
  resourceFamily: CapabilityConversationTypePolicyResourceFamily
) {
  const policies = await getWorkspaceCapabilityConversationTypePolicyMap([
    workspaceId,
  ])
  return (
    policies.get(workspaceId)?.[resourceFamily] ||
    DEFAULT_CONVERSATION_TYPE_MASK
  )
}
