"use client"

import { startTransition, useEffect, useRef, useState } from "react"
import { Camera, LoaderCircle, RefreshCcw } from "lucide-react"
import { useRouter } from "next/navigation"

import { extractQrLoginToken } from "@/lib/qr-login"
import { Button } from "@/components/ui/button"

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message
  }
  return "Unable to start the camera."
}

export function MobileScanLoginClient() {
  const router = useRouter()
  const videoRef = useRef<HTMLVideoElement | null>(null)

  const [error, setError] = useState<string | null>(null)
  const [isStarting, setIsStarting] = useState(true)
  const [scannerKey, setScannerKey] = useState(0)

  useEffect(() => {
    let active = true
    let scannerControls: { stop: () => void } | null = null

    async function startScanner() {
      setIsStarting(true)
      setError(null)

      try {
        const { BrowserQRCodeReader } = await import("@zxing/browser")
        if (!active || !videoRef.current) return

        const reader = new BrowserQRCodeReader()
        scannerControls = await reader.decodeFromConstraints(
          {
            video: {
              facingMode: { ideal: "environment" },
            },
          },
          videoRef.current,
          (result) => {
            if (!active || !result) return

            const token = extractQrLoginToken(result.getText())
            if (!token) {
              setError("This QR code is not a Synapse login request.")
              return
            }

            scannerControls?.stop()
            startTransition(() => {
              router.replace(`/m/qr-login?token=${encodeURIComponent(token)}`)
            })
          }
        )

        if (!active) {
          scannerControls.stop()
          return
        }
      } catch (nextError) {
        if (!active) return
        setError(getErrorMessage(nextError))
      } finally {
        if (active) {
          setIsStarting(false)
        }
      }
    }

    void startScanner()

    return () => {
      active = false
      scannerControls?.stop()
    }
  }, [router, scannerKey])

  return (
    <div className="space-y-5">
      <div className="overflow-hidden rounded-[28px] border border-border/70 bg-black">
        <div className="relative aspect-[3/4] w-full">
          <video
            ref={videoRef}
            className="h-full w-full object-cover"
            autoPlay
            muted
            playsInline
          />
          <div className="pointer-events-none absolute inset-0 border-[24px] border-black/45" />
          <div className="pointer-events-none absolute inset-8 rounded-[28px] border border-white/70" />
          {isStarting ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/55 text-white">
              <LoaderCircle className="size-5 animate-spin" />
              <span className="text-sm">Starting camera...</span>
            </div>
          ) : null}
        </div>
      </div>

      {error ? (
        <div className="rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <Button
        type="button"
        variant="outline"
        className="w-full rounded-full"
        onClick={() => setScannerKey((current) => current + 1)}
      >
        {isStarting ? (
          <>
            <LoaderCircle className="mr-2 size-4 animate-spin" />
            Starting camera...
          </>
        ) : (
          <>
            {error ? (
              <RefreshCcw className="mr-2 size-4" />
            ) : (
              <Camera className="mr-2 size-4" />
            )}
            {error ? "Try again" : "Restart scanner"}
          </>
        )}
      </Button>
    </div>
  )
}
