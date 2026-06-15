import type {
  PlatformAccessBindingView,
  PlatformNavigationView,
  PlatformAccessSource,
} from "@synapse/shared/schemas"
import { serializeInstant } from "../../infrastructure/datetime.js"
import type { PlatformAccessKey } from "./admin-service.js"

export type PlatformAccessBindingRecord = {
  userId: string
  accessKey: PlatformAccessKey
  source: PlatformAccessSource
  assignedByUserId: string | null
  createdAt: Date
  updatedAt: Date
  userName?: string
  userEmail?: string
  avatarUrl?: string | null
}

export function presentPlatformNavigation(input: {
  canManagePlatform: boolean
}): PlatformNavigationView {
  return {
    canAccessPlatformModels: input.canManagePlatform,
    canAccessPlatformAccess: input.canManagePlatform,
    canAccessPlatformSkills: input.canManagePlatform,
  }
}

export function presentPlatformAccessBinding(
  record: PlatformAccessBindingRecord
): PlatformAccessBindingView {
  return {
    userId: record.userId,
    accessKey: record.accessKey,
    source: record.source,
    assignedByUserId: record.assignedByUserId,
    createdAt: serializeInstant(record.createdAt),
    updatedAt: serializeInstant(record.updatedAt),
    userName: record.userName,
    userEmail: record.userEmail,
    avatarUrl: record.avatarUrl,
  }
}
