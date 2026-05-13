"use client"

import Image from "next/image"
import QRCode from "qrcode"
import { startTransition, useEffect, useRef, useState } from "react"
import {
  buildMobileScanUrl,
  type AuthQrLoginCreateResponse,
  type AuthQrLoginStatus,
} from "@synapse/shared"
import { LoaderCircle, RefreshCcw } from "lucide-react"
import { useRouter } from "next/navigation"

import { api, ApiError } from "@/lib/api"
import { Button } from "@/components/ui/button"

function getErrorMessage(error: unknown) {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return "Something went wrong."
}

async function resolveDestination(redirect: string | null) {
  if (redirect) return redirect

  const result = await api.getWorkspaces()
  const workspaces = result?.data ?? result ?? []
  return workspaces.length === 0 ? "/welcome" : "/dashboard"
}

function isPendingStatus(status: AuthQrLoginStatus) {
  return status === "pending_scan" || status === "pending_confirm"
}

export function WebQrLoginPanel({ redirect }: { redirect: string | null }) {
  const router = useRouter()
  const finalizeStartedRef = useRef(false)

  const [qrRequest, setQrRequest] = useState<AuthQrLoginCreateResponse | null>(
    null
  )
  const [qrCodeUrl, setQrCodeUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(true)
  const [isFinalizing, setIsFinalizing] = useState(false)

  async function initializeQrLogin() {
    setIsCreating(true)
    setIsFinalizing(false)
    setError(null)
    setQrCodeUrl(null)
    setQrRequest(null)
    finalizeStartedRef.current = false

    try {
      const created = await api.createQrLoginRequest()
      const qrTarget = buildMobileScanUrl({
        origin: window.location.origin,
        kind: "login",
        token: created.scanToken,
      })

      const imageUrl = await QRCode.toDataURL(qrTarget, {
        width: 220,
        margin: 1,
        color: {
          dark: "#0f172a",
          light: "#ffffff",
        },
      })

      setQrRequest(created)
      setQrCodeUrl(imageUrl)
    } catch (nextError) {
      setError(getErrorMessage(nextError))
    } finally {
      setIsCreating(false)
    }
  }

  async function finalizeQrLogin(requestId: string, browserToken: string) {
    setIsFinalizing(true)
    setError(null)

    try {
      await api.finalizeQrLogin(requestId, browserToken)
      const destination = await resolveDestination(redirect)
      startTransition(() => {
        router.replace(destination)
      })
    } catch (nextError) {
      finalizeStartedRef.current = false
      setError(getErrorMessage(nextError))
      setIsFinalizing(false)
    }
  }

  useEffect(() => {
    void initializeQrLogin()
  }, [])

  useEffect(() => {
    if (!qrRequest || !isPendingStatus(qrRequest.request.status)) {
      return
    }

    let cancelled = false
    let timeoutId: number | undefined

    const poll = async () => {
      try {
        const next = await api.getQrLoginRequestStatus(
          qrRequest.request.id,
          qrRequest.browserToken
        )
        if (cancelled) return

        setQrRequest((current: AuthQrLoginCreateResponse | null) =>
          current ? { ...current, request: next.request } : current
        )
        setError(null)

        if (isPendingStatus(next.request.status)) {
          timeoutId = window.setTimeout(
            poll,
            next.request.status === "pending_confirm" ? 1200 : 2000
          )
        }
      } catch (nextError) {
        if (cancelled) return
        setError(getErrorMessage(nextError))
        timeoutId = window.setTimeout(poll, 2500)
      }
    }

    timeoutId = window.setTimeout(poll, 1500)

    return () => {
      cancelled = true
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId)
      }
    }
  }, [qrRequest])

  useEffect(() => {
    if (
      !qrRequest ||
      qrRequest.request.status !== "approved" ||
      finalizeStartedRef.current
    ) {
      return
    }

    finalizeStartedRef.current = true
    void finalizeQrLogin(qrRequest.request.id, qrRequest.browserToken)
  }, [qrRequest, redirect, router])

  const status = qrRequest?.request.status
  const showRefresh =
    Boolean(error) ||
    status === "rejected" ||
    status === "expired" ||
    status === "consumed"

  return (
    <div className="space-y-4">
      <div className="flex min-h-64 flex-col items-center justify-center gap-4 rounded-3xl border border-border/70 bg-white p-6 shadow-sm">
        {isCreating ? (
          <div className="flex flex-col items-center gap-3 text-sm text-slate-500">
            <LoaderCircle className="size-5 animate-spin" />
            <span>Generating secure QR code...</span>
          </div>
        ) : status === "pending_scan" && qrCodeUrl ? (
          <>
            <Image
              src={qrCodeUrl}
              alt="Login QR code"
              width={220}
              height={220}
              unoptimized
              className="size-[220px] rounded-[20px]"
            />
            <p className="text-sm font-medium text-slate-500">
              Mobile &gt; Scan
            </p>
          </>
        ) : (
          <div className="space-y-2 px-4 text-center">
            <p className="text-sm font-medium text-slate-900">
              {status === "pending_confirm" &&
                "Waiting for mobile confirmation"}
              {status === "approved" && "Confirmation received"}
              {status === "rejected" && "Login request rejected"}
              {status === "expired" && "QR code expired"}
              {status === "consumed" && "This QR code has already been used"}
              {!status && "Unable to generate QR code"}
            </p>
            <p className="text-sm text-slate-500">
              {status === "pending_confirm" &&
                "Keep this window open while you confirm on your phone."}
              {status === "approved" &&
                "One moment while we finish signing you in."}
              {status === "rejected" &&
                "Create a new code and try again if you still want to sign in."}
              {status === "expired" && "Generate a fresh code to continue."}
              {status === "consumed" &&
                "Refresh to start a new QR login request."}
              {!status && "Refresh to generate a fresh QR code."}
            </p>
          </div>
        )}
      </div>

      {error ? (
        <div className="rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {showRefresh ? (
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={() => void initializeQrLogin()}
        >
          <RefreshCcw className="mr-2 size-4" />
          Generate new code
        </Button>
      ) : null}
    </div>
  )
}
