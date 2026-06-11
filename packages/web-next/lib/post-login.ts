import { api } from "@/lib/api"

/**
 * Where to send a user after a successful sign-in. Honor an explicit redirect
 * target if present; otherwise route by workspace membership: a brand-new user
 * with no workspaces goes to onboarding, everyone else to the dashboard.
 *
 * Shared by every sign-in path (password, QR, OAuth popup) so the post-login
 * routing decision lives in one place.
 */
export async function resolveDestination(redirect: string | null) {
  if (redirect) return redirect

  const result = await api.getWorkspaces()
  const workspaces = result.data ?? []
  return workspaces.length === 0 ? "/welcome" : "/dashboard"
}
