import { AuthStoreProvider } from "@/stores/auth-store"
import { getServerAuthState } from "@/lib/server-auth"
import InviteClient from "./invite-client"

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const [{ token }, { user }] = await Promise.all([
    params,
    getServerAuthState(),
  ])

  return (
    <AuthStoreProvider initialUser={user}>
      <InviteClient token={token} />
    </AuthStoreProvider>
  )
}
