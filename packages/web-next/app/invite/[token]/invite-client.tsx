"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import Image from "next/image"
import Link from "next/link"
import { api } from "@/lib/api"
import { useAuthStore } from "@/stores/auth-store"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"

export default function InviteClient({ token }: { token: string }) {
  const router = useRouter()
  const user = useAuthStore((state) => state.user)

  const [invite, setInvite] = useState<{
    token: string
    workspaceName: string
    trustLevel: string
  } | null>(null)
  const [error, setError] = useState("")
  const [loadingInvite, setLoadingInvite] = useState(true)
  const [joining, setJoining] = useState(false)

  useEffect(() => {
    if (!token) return
    api
      .getInviteInfo(token)
      .then((data: any) => setInvite(data))
      .catch((err: any) => setError(err.message || "Invalid or expired invite"))
      .finally(() => setLoadingInvite(false))
  }, [token])

  const handleJoin = async () => {
    setJoining(true)
    setError("")
    try {
      const result = await api.redeemInvite(token)
      if (result?.workspaceId) {
        localStorage.setItem("workspaceId", result.workspaceId)
        router.push("/dashboard")
      }
    } catch (err: any) {
      setError(err.message || "Failed to join workspace")
    } finally {
      setJoining(false)
    }
  }

  const encodedRedirect = encodeURIComponent(`/invite/${token}`)

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 dark:bg-gray-950">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mb-4 flex justify-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary p-2">
              <Image
                src="/synapse.svg"
                alt="Synapse"
                width={32}
                height={32}
                className="invert"
              />
            </div>
          </div>

          {loadingInvite ? (
            <>
              <CardTitle>Loading invite...</CardTitle>
              <CardDescription>
                <span className="mt-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              </CardDescription>
            </>
          ) : error && !invite ? (
            <>
              <CardTitle>Invalid Invite</CardTitle>
              <CardDescription>{error}</CardDescription>
            </>
          ) : invite ? (
            <>
              <CardTitle>Join {invite.workspaceName}</CardTitle>
              <CardDescription>
                You&apos;ve been invited to join as{" "}
                <span className="font-medium text-foreground">
                  {invite.trustLevel}
                </span>
              </CardDescription>
            </>
          ) : null}
        </CardHeader>

        <CardContent>
          {error && invite ? (
            <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 dark:border-red-500/20 dark:bg-red-500/10">
              <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
            </div>
          ) : null}

          {loadingInvite ? null : !invite ? (
            <div className="text-center">
              <Button asChild variant="outline">
                <Link href="/login">Go to Login</Link>
              </Button>
            </div>
          ) : user ? (
            <div className="space-y-3">
              <p className="text-center text-sm text-muted-foreground">
                Signed in as{" "}
                <span className="font-medium text-foreground">{user.name}</span>
              </p>
              <Button
                onClick={handleJoin}
                disabled={joining}
                className="w-full"
              >
                {joining ? "Joining..." : `Join ${invite.workspaceName}`}
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <Button asChild className="w-full">
                <Link href={`/login?redirect=${encodedRedirect}`}>
                  Sign in to join
                </Link>
              </Button>
              <Button asChild variant="outline" className="w-full">
                <Link href={`/register?redirect=${encodedRedirect}`}>
                  Create account
                </Link>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
