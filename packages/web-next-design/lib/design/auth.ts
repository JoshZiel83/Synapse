import type { ServerAuthState } from "@/lib/server-auth"
import { AuthMeViewSchema } from "@synapse/shared/schemas"
import { mock } from "./faker-setup"

// A stable fake identity so the design sandbox's protected routes render with no
// backend. `AuthMeViewSchema` is the exact `{ user, session }` contract of
// GET /api/v1/auth/me, and `UserProfileView` is field-identical to `User`, so
// nothing is hand-declared here.
export function designServerAuthState(): ServerAuthState {
  const me = mock(AuthMeViewSchema)
  return { status: "authenticated", user: me.user, session: me.session }
}
