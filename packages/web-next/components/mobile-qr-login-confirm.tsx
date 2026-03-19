"use client"

import { startTransition, useEffect, useState } from "react"
import type {
  AuthQrLoginResolveResponse,
  AuthSessionPersistence,
} from "@synapse/shared"
import {
  CheckCircle2,
  Laptop2,
  LoaderCircle,
  ShieldCheck,
  ShieldX,
} from "lucide-react"
import { useRouter } from "next/navigation"

import { api, ApiError } from "@/lib/api"
import { Button } from "@/components/ui/button"

function getErrorMessage(error: unknown) {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return "Unable to load this login request."
}

function formatTimestamp(timestamp: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp))
}

function getSessionPersistenceLabel(
  sessionPersistence: AuthSessionPersistence | undefined
) {
  return sessionPersistence === "temporary"
    ? "Temporary login"
    : "Keep signed in"
}

export function MobileQrLoginConfirm({
  token,
  userName,
}: {
  token: string
  userName?: string
}) {
  const router = useRouter()

  const [data, setData] = useState<AuthQrLoginResolveResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [pendingAction, setPendingAction] = useState<
    "persistent" | "temporary" | "reject" | null
  >(null)

  useEffect(() => {
    let cancelled = false

    async function loadRequest() {
      setIsLoading(true)
      setError(null)

      try {
        const next = await api.resolveQrLogin(token)
        if (!cancelled) {
          setData(next)
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(getErrorMessage(nextError))
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false)
        }
      }
    }

    void loadRequest()

    return () => {
      cancelled = true
    }
  }, [token])

  async function handleApprove(sessionPersistence: AuthSessionPersistence) {
    setPendingAction(sessionPersistence)
    setError(null)

    try {
      const result = await api.approveQrLogin(token, sessionPersistence)
      setData((current: AuthQrLoginResolveResponse | null) => ({
        request: result.request,
        confirmation: current?.confirmation ?? {
          browserLabel: result.request.browserLabel,
          requestedAt: result.request.createdAt,
          expiresAt: result.request.expiresAt,
        },
      }))
    } catch (nextError) {
      setError(getErrorMessage(nextError))
    } finally {
      setPendingAction(null)
    }
  }

  async function handleReject() {
    setPendingAction("reject")
    setError(null)

    try {
      const result = await api.rejectQrLogin(token)
      setData((current: AuthQrLoginResolveResponse | null) => ({
        request: result.request,
        confirmation: current?.confirmation ?? {
          browserLabel: result.request.browserLabel,
          requestedAt: result.request.createdAt,
          expiresAt: result.request.expiresAt,
        },
      }))
    } catch (nextError) {
      setError(getErrorMessage(nextError))
    } finally {
      setPendingAction(null)
    }
  }

  const request = data?.request
  const confirmation = data?.confirmation

  return (
    <div className="space-y-5">
      <div className="rounded-[28px] border border-border/70 bg-background px-5 py-6 shadow-sm">
        {isLoading ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <LoaderCircle className="size-5 animate-spin text-primary" />
            <div>
              <p className="text-sm font-medium text-foreground">
                Checking login request
              </p>
              <p className="text-sm text-muted-foreground">
                Confirming the QR code you just scanned.
              </p>
            </div>
          </div>
        ) : request ? (
          <div className="space-y-5">
            <div className="flex items-start gap-3">
              <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                {request.status === "approved" || request.status === "consumed" ? (
                  <CheckCircle2 className="size-5" />
                ) : request.status === "rejected" ? (
                  <ShieldX className="size-5" />
                ) : (
                  <Laptop2 className="size-5" />
                )}
              </div>
              <div className="space-y-1">
                <h2 className="text-base font-semibold text-foreground">
                  {request.status === "approved" || request.status === "consumed"
                    ? "Web login confirmed"
                    : request.status === "rejected"
                      ? "Login request rejected"
                      : "Confirm Web login"}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {request.status === "approved" || request.status === "consumed"
                    ? `The computer can finish signing in now with ${getSessionPersistenceLabel(request.approvedSessionPersistence).toLowerCase()}.`
                    : request.status === "rejected"
                      ? "The QR login request has been denied."
                      : `Approve the browser session waiting for ${confirmation?.browserLabel ?? request.browserLabel}.`}
                </p>
              </div>
            </div>

            <div className="space-y-3 rounded-2xl border border-border/70 bg-muted/20 px-4 py-4">
              <div className="flex items-center justify-between gap-4">
                <span className="text-sm text-muted-foreground">Device</span>
                <span className="text-sm font-medium text-foreground">
                  {confirmation?.browserLabel ?? request.browserLabel}
                </span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-sm text-muted-foreground">Requested</span>
                <span className="text-sm font-medium text-foreground">
                  {formatTimestamp(confirmation?.requestedAt ?? request.createdAt)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-sm text-muted-foreground">Signed in as</span>
                <span className="text-sm font-medium text-foreground">
                  {userName || "Current account"}
                </span>
              </div>
              {request.approvedSessionPersistence ? (
                <div className="flex items-center justify-between gap-4">
                  <span className="text-sm text-muted-foreground">Mode</span>
                  <span className="text-sm font-medium text-foreground">
                    {getSessionPersistenceLabel(request.approvedSessionPersistence)}
                  </span>
                </div>
              ) : null}
            </div>

            {request.status === "pending_confirm" ? (
              <div className="grid grid-cols-1 gap-3">
                <Button
                  type="button"
                  className="h-12 rounded-full"
                  onClick={() => void handleApprove("persistent")}
                  disabled={pendingAction !== null}
                >
                  {pendingAction === "persistent" ? (
                    <>
                      <LoaderCircle className="mr-2 size-4 animate-spin" />
                      Confirming...
                    </>
                  ) : (
                    <>
                      <ShieldCheck className="mr-2 size-4" />
                      Keep signed in
                    </>
                  )}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="h-12 rounded-full"
                  onClick={() => void handleApprove("temporary")}
                  disabled={pendingAction !== null}
                >
                  {pendingAction === "temporary" ? (
                    <>
                      <LoaderCircle className="mr-2 size-4 animate-spin" />
                      Confirming...
                    </>
                  ) : (
                    "Temporary login"
                  )}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="h-12 rounded-full"
                  onClick={() => void handleReject()}
                  disabled={pendingAction !== null}
                >
                  {pendingAction === "reject" ? (
                    <>
                      <LoaderCircle className="mr-2 size-4 animate-spin" />
                      Rejecting...
                    </>
                  ) : (
                    <>
                      <ShieldX className="mr-2 size-4" />
                      Reject
                    </>
                  )}
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                className="h-12 w-full rounded-full"
                onClick={() =>
                  startTransition(() => {
                    router.replace("/m")
                  })
                }
              >
                Back to home
              </Button>
            )}
          </div>
        ) : (
          <div className="py-8 text-center">
            <p className="text-sm text-muted-foreground">
              Unable to load this login request.
            </p>
          </div>
        )}
      </div>

      {error ? (
        <div className="rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}
    </div>
  )
}
