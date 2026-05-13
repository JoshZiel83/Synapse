import {
  PLATFORM_RESOURCE_ID,
  checkPermissionSql,
  lookupResourcesSql,
  type AccessResourceType,
  type PermissionSubject,
} from "./sql-evaluator.js"

export { PLATFORM_RESOURCE_ID, type AccessResourceType, type PermissionSubject }

export async function checkPermission(params: {
  resourceType: AccessResourceType
  resourceId: string
  permission: string
  subject: PermissionSubject
}) {
  return checkPermissionSql(params)
}

export async function lookupResources(params: {
  resourceType: AccessResourceType
  permission: string
  subject: PermissionSubject
  limit?: number
}) {
  return lookupResourcesSql(params)
}
