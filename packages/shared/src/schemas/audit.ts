import { z } from "zod"
import { IsoInstantStringSchema } from "./datetime.js"

export const AuditLogListQuerySchema = z.object({
  action: z.string().optional(),
  resourceType: z.string().optional(),
  resourceId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
})
export type AuditLogListQuery = z.infer<typeof AuditLogListQuerySchema>

export const AuditLogViewSchema = z.strictObject({
  id: z.uuid(),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.uuid().nullable(),
  userId: z.uuid().nullable(),
  actorId: z.uuid().nullable(),
  details: z.record(z.string(), z.unknown()),
  ipAddress: z.string().nullable(),
  createdAt: IsoInstantStringSchema,
  userName: z.string().nullable(),
  actorName: z.string().nullable(),
})
export type AuditLogView = z.infer<typeof AuditLogViewSchema>

export const AuditLogListViewSchema = z.strictObject({
  items: z.array(AuditLogViewSchema),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
})
export type AuditLogListView = z.infer<typeof AuditLogListViewSchema>
