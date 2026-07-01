import { AuthMeViewSchema } from "@synapse/shared/schemas"
import { mock } from "../faker-setup"
import type { DesignHandlers } from "./_types"

// Auth: only the profile endpoints (/auth/me) return a shared, schema-backed
// view. The Better Auth passthrough routes (sign-in/out, sessions, device flow,
// OAuth) return better-auth or inline-literal shapes with no exported *Schema,
// so they fall through to the Proxy catch-all.
export const authHandlers = {
  getMe: async () => mock(AuthMeViewSchema),
  updateMe: async () => mock(AuthMeViewSchema),
} satisfies DesignHandlers
