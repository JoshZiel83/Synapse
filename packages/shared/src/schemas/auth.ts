import { z } from "zod"
import { IsoInstantStringSchema } from "./datetime.js"

/**
 * App-facing contracts for the custom auth profile endpoints (/api/v1/auth/me).
 * These are app-facing (NOT better-auth wildcard passthrough), so per master
 * plan §5.2 they return `{ data: ... }` and the response shape is a shared
 * schema. camelCase end-to-end; the presenter (auth/service presentUser) builds
 * UserProfileView from the DB row.
 */

/** A user's own profile as surfaced by GET/PUT /auth/me. */
export const UserProfileViewSchema = z.strictObject({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  avatarUrl: z.string().optional(),
  createdAt: IsoInstantStringSchema,
  updatedAt: IsoInstantStringSchema,
})
export type UserProfileView = z.infer<typeof UserProfileViewSchema>

/** Minimal session summary returned alongside the profile (BA session id). */
export const AuthSessionSummaryViewSchema = z.strictObject({
  id: z.string(),
})
export type AuthSessionSummaryView = z.infer<
  typeof AuthSessionSummaryViewSchema
>

/** The `{ user, session }` payload of GET/PUT /api/v1/auth/me. */
export const AuthMeViewSchema = z.strictObject({
  user: UserProfileViewSchema,
  session: AuthSessionSummaryViewSchema,
})
export type AuthMeView = z.infer<typeof AuthMeViewSchema>

// ───────────────────────────── request DTOs (§5.1.1) ─────────────────────────
// App-facing request bodies for the custom auth endpoints. Single-sourced here
// so the API parser and the web/mobile clients share one definition instead of
// hand-writing the input shape on each side.

/** Body for PUT /api/v1/auth/me. At least one field must be present. */
export const UpdateMeInputSchema = z
  .strictObject({
    name: z.string().min(1).max(100).optional(),
    avatarFileId: z.uuid().nullable().optional(),
  })
  .refine(
    (body) => body.name !== undefined || body.avatarFileId !== undefined,
    { message: "At least one field is required" }
  )
export type UpdateMeInput = z.infer<typeof UpdateMeInputSchema>

/**
 * Body for DELETE /api/v1/auth/me/accounts — identifies the account to unlink
 * by its (providerId, accountId) pair (the same key Better Auth uses).
 */
export const UnlinkAccountInputSchema = z.strictObject({
  providerId: z.string().min(1).max(100),
  accountId: z.string().min(1).max(255),
})
export type UnlinkAccountInput = z.infer<typeof UnlinkAccountInputSchema>
