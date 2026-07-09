import {
  CAPABILITY_CONVERSATION_TYPE_POLICY_RESOURCE_FAMILIES,
  DEFAULT_CONVERSATION_TYPE_MASK,
  normalizeConversationTypeMask,
} from "@synapse/shared"
import type {
  CapabilityConversationTypePolicyResourceFamily,
  WorkspaceCapabilityConversationTypePoliciesView,
  WorkspaceCapabilityConversationTypePolicy,
} from "@synapse/shared/types"
import type { Executor } from "../../infrastructure/database/kysely.js"
import {
  insertWorkspacePolicyDefault,
  selectWorkspacePolicyRows,
  selectWorkspacePolicyRowsForIds,
  upsertWorkspacePolicy,
  upsertWorkspaceSubjectId,
  type WorkspaceCapabilityConversationTypePolicyRow,
} from "./repo.js"

function presentWorkspacePolicy(
  workspaceId: string,
  resourceFamily: CapabilityConversationTypePolicyResourceFamily,
  row?: WorkspaceCapabilityConversationTypePolicyRow
): WorkspaceCapabilityConversationTypePolicy {
  return {
    workspaceId,
    resourceFamily,
    defaultConversationTypeMask: normalizeConversationTypeMask(
      row?.defaultConversationTypeMask,
      DEFAULT_CONVERSATION_TYPE_MASK
    ),
  }
}

function buildWorkspacePoliciesView(
  workspaceId: string,
  rows: WorkspaceCapabilityConversationTypePolicyRow[]
): WorkspaceCapabilityConversationTypePoliciesView {
  const rowsByFamily = new Map(
    rows.map((row) => [row.resourceFamily, row] as const)
  )
  return {
    workspaceId,
    policies: CAPABILITY_CONVERSATION_TYPE_POLICY_RESOURCE_FAMILIES.map(
      (resourceFamily) =>
        presentWorkspacePolicy(
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
  const workspaceSubjectId = await upsertWorkspaceSubjectId(run, workspaceId)
  for (const resourceFamily of CAPABILITY_CONVERSATION_TYPE_POLICY_RESOURCE_FAMILIES) {
    await insertWorkspacePolicyDefault(run, workspaceSubjectId, resourceFamily)
  }
}

export async function listWorkspaceCapabilityConversationTypePolicies(
  workspaceId: string
) {
  const rows = await selectWorkspacePolicyRows(workspaceId)
  return buildWorkspacePoliciesView(workspaceId, rows)
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

  for (const [resourceFamily, defaultMask] of entries) {
    await upsertWorkspacePolicy(
      input.workspaceId,
      resourceFamily,
      normalizeConversationTypeMask(defaultMask, DEFAULT_CONVERSATION_TYPE_MASK)
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

  const rows = await selectWorkspacePolicyRowsForIds(uniqueWorkspaceIds)

  for (const workspaceId of uniqueWorkspaceIds) {
    map.set(workspaceId, {
      plugin_installation: DEFAULT_CONVERSATION_TYPE_MASK,
      installed_skill: DEFAULT_CONVERSATION_TYPE_MASK,
      runtime_capability: DEFAULT_CONVERSATION_TYPE_MASK,
    })
  }

  for (const row of rows) {
    const current = map.get(row.workspaceId)
    if (!current) continue
    current[row.resourceFamily] = normalizeConversationTypeMask(
      row.defaultConversationTypeMask,
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
