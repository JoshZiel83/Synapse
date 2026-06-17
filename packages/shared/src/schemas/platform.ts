import { z } from "zod"
import {
  PLATFORM_ACCESS_KEYS,
  PLATFORM_ACCESS_SOURCES,
} from "../constants/enums.js"
import { IsoInstantStringSchema } from "./datetime.js"

export const PlatformNavigationViewSchema = z.strictObject({
  canAccessPlatformModels: z.boolean(),
  canAccessPlatformAccess: z.boolean(),
  canAccessPlatformSkills: z.boolean(),
})
export type PlatformNavigationView = z.infer<
  typeof PlatformNavigationViewSchema
>

export const PlatformAccessGrantInputSchema = z.strictObject({
  userId: z.uuid(),
  accessKey: z.enum(PLATFORM_ACCESS_KEYS),
})
export type PlatformAccessGrantInput = z.infer<
  typeof PlatformAccessGrantInputSchema
>

export const PlatformAccessBindingViewSchema = z.strictObject({
  userId: z.uuid(),
  accessKey: z.enum(PLATFORM_ACCESS_KEYS),
  source: z.enum(PLATFORM_ACCESS_SOURCES),
  assignedByUserId: z.uuid().nullable(),
  createdAt: IsoInstantStringSchema,
  updatedAt: IsoInstantStringSchema,
  userName: z.string().optional(),
  userEmail: z.email().optional(),
  avatarUrl: z.string().nullable().optional(),
})
export type PlatformAccessSource = (typeof PLATFORM_ACCESS_SOURCES)[number]
export type PlatformAccessBindingView = z.infer<
  typeof PlatformAccessBindingViewSchema
>

export const PlatformAccessBindingListViewSchema = z.array(
  PlatformAccessBindingViewSchema
)
export type PlatformAccessBindingListView = z.infer<
  typeof PlatformAccessBindingListViewSchema
>

export const PlatformNoContentSchema = z.undefined()
