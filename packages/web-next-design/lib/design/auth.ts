import type { ServerAuthState } from "@/lib/server-auth"
import { AuthMeViewSchema } from "@synapse/shared/schemas"
import { mock } from "./faker-setup"
import { designUserId, designUserName } from "./fixtures/identity"

// A stable fake identity so the design sandbox's protected routes render with no
// backend. `AuthMeViewSchema` is the exact `{ user, session }` contract of
// GET /api/v1/auth/me; we take a mock for the incidental fields and pin the
// visible identity (id/name) to the same 林墨 the workspace + chat use, so the
// current user is consistent everywhere. avatarUrl is cleared so nav-user shows
// initials instead of a lorem string.
export function designServerAuthState(): ServerAuthState {
  const me = mock(AuthMeViewSchema)
  return {
    status: "authenticated",
    user: {
      ...me.user,
      id: designUserId,
      name: designUserName,
      avatarUrl: undefined,
    },
    session: me.session,
  }
}
