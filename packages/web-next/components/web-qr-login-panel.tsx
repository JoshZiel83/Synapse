"use client"

import Image from "next/image"
import QRCode from "qrcode"
import { startTransition, useEffect, useRef, useState } from "react"
import { LoaderCircle, RefreshCcw } from "lucide-react"
import { useRouter } from "next/navigation"

import { api, ApiError } from "@/lib/api"
import { resolveDestination } from "@/lib/post-login"
import { Button } from "@/components/ui/button"

function getErrorMessage(error: unknown) {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return "Something went wrong."
}

type DeviceState = "loading" | "pending" | "approved" | "error" | "expired"

/**
 * Cross-device QR login on the web (desktop) side, built on Better Auth's
 * deviceAuthorization plugin (RFC 8628):
 *   1. request a device code; render `verification_uri_complete` as a QR;
 *   2. an already-signed-in mobile app scans it, claims + approves it;
 *   3. we poll /device/token until it returns an access_token (= a real BA
 *      session token), then exchange it for the session cookie and redirect.
 */
export function WebQrLoginPanel({ redirect }: { redirect: string | null }) {
  const router = useRouter()
  const finalizeStartedRef = useRef(false)

  const [qrCodeUrl, setQrCodeUrl] = useState<string | null>(null)
  const [deviceState, setDeviceState] = useState<DeviceState>("loading")
  const [error, setError] = useState<string | null>(null)

  async function finalize(accessToken: string) {
    if (finalizeStartedRef.current) return
    finalizeStartedRef.current = true
    setDeviceState("approved")
    try {
      await api.exchangeDeviceSession(accessToken)
      const destination = await resolveDestination(redirect)
      startTransition(() => {
        router.replace(destination)
      })
    } catch (nextError) {
      finalizeStartedRef.current = false
      setDeviceState("error")
      setError(getErrorMessage(nextError))
    }
  }

  async function initialize(signal: { cancelled: boolean }) {
    setDeviceState("loading")
    setError(null)
    setQrCodeUrl(null)
    finalizeStartedRef.current = false

    try {
      const code = await api.requestDeviceCode()
      if (signal.cancelled) return

      const imageUrl = await QRCode.toDataURL(code.verification_uri_complete, {
        width: 220,
        margin: 1,
        color: { dark: "#0f172a", light: "#ffffff" },
      })
      if (signal.cancelled) return

      setQrCodeUrl(imageUrl)
      setDeviceState("pending")

      // Poll for approval. interval is in seconds; back off on slow_down.
      let intervalMs = Math.max(1, code.interval) * 1000
      const deadline = Date.now() + Math.max(1, code.expires_in) * 1000

      const poll = async () => {
        if (signal.cancelled) return
        if (Date.now() > deadline) {
          setDeviceState("expired")
          return
        }
        try {
          const res = await api.pollDeviceToken(code.device_code)
          if (signal.cancelled) return
          if (res.access_token) {
            await finalize(res.access_token)
            return
          }
          if (res.error === "slow_down") {
            intervalMs += 5000
          } else if (res.error && res.error !== "authorization_pending") {
            // access_denied / expired_token / invalid_grant -> terminal.
            setDeviceState("expired")
            return
          }
          window.setTimeout(poll, intervalMs)
        } catch (nextError) {
          if (signal.cancelled) return
          setError(getErrorMessage(nextError))
          window.setTimeout(poll, intervalMs)
        }
      }
      window.setTimeout(poll, intervalMs)
    } catch (nextError) {
      if (signal.cancelled) return
      setError(getErrorMessage(nextError))
      setDeviceState("error")
    }
  }

  useEffect(() => {
    const signal = { cancelled: false }
    void initialize(signal)
    return () => {
      signal.cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const showRefresh =
    deviceState === "error" || deviceState === "expired" || Boolean(error)

  return (
    <div className="space-y-4">
      <div className="flex min-h-64 flex-col items-center justify-center gap-4 p-2">
        {deviceState === "loading" ? (
          <div className="flex flex-col items-center gap-3 text-sm text-muted-foreground">
            <LoaderCircle className="size-5 animate-spin" />
            <span>Generating secure QR code...</span>
          </div>
        ) : deviceState === "pending" && qrCodeUrl ? (
          <>
            <Image
              src={qrCodeUrl}
              alt="Login QR code"
              width={220}
              height={220}
              unoptimized
              className="size-[220px]"
            />
            <p className="text-sm font-medium text-muted-foreground">
              Scan with the Synapse app, then approve
            </p>
          </>
        ) : (
          <div className="space-y-2 px-4 text-center">
            <p className="text-sm font-medium text-foreground">
              {deviceState === "approved" && "Confirmation received"}
              {deviceState === "expired" && "QR code expired"}
              {deviceState === "error" && "Unable to generate QR code"}
            </p>
            <p className="text-sm text-muted-foreground">
              {deviceState === "approved" &&
                "One moment while we finish signing you in."}
              {deviceState === "expired" &&
                "Generate a fresh code to continue."}
              {deviceState === "error" && "Refresh to generate a fresh code."}
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
          onClick={() => {
            const signal = { cancelled: false }
            void initialize(signal)
          }}
        >
          <RefreshCcw className="mr-2 size-4" />
          Generate new code
        </Button>
      ) : null}
    </div>
  )
}
