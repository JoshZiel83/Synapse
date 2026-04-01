"use client"

import { startTransition, useEffect, useRef, useState } from "react"
import { parseSynapseQrPayload, type ParsedSynapseQrPayload } from "@synapse/shared"
import { Camera, LoaderCircle, RefreshCcw } from "lucide-react"
import { useRouter } from "next/navigation"

import { api, ApiError } from "@/lib/api"
import { Button } from "@/components/ui/button"

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message
  }
  return "Unable to process this QR code."
}

function selectWorkspaceId(
  workspaces: Array<{ id: string; name: string }>,
  savedWorkspaceId: string | null
) {
  const saved = savedWorkspaceId
    ? workspaces.find((workspace) => workspace.id === savedWorkspaceId)
    : null
  return saved?.id || workspaces[0]?.id || null
}

export function MobileUnifiedScanClient({
  initialKind,
  initialToken,
  intent,
}: {
  initialKind?: string
  initialToken?: string
  intent?: string
}) {
  const router = useRouter()
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const initialProcessedRef = useRef(false)

  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [workspaceName, setWorkspaceName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [isStarting, setIsStarting] = useState(true)
  const [isLoadingWorkspace, setIsLoadingWorkspace] = useState(true)
  const [scannerKey, setScannerKey] = useState(0)

  useEffect(() => {
    let active = true

    async function loadWorkspaces() {
      setIsLoadingWorkspace(true)
      try {
        const response = await api.getWorkspaces()
        if (!active) return
        const workspaces = response?.data ?? []
        const savedWorkspaceId =
          typeof window !== "undefined"
            ? window.localStorage.getItem("workspaceId")
            : null
        const nextWorkspaceId = selectWorkspaceId(workspaces, savedWorkspaceId)
        const nextWorkspace =
          workspaces.find((workspace) => workspace.id === nextWorkspaceId) || null
        setWorkspaceId(nextWorkspaceId)
        setWorkspaceName(nextWorkspace?.name ?? null)
      } catch (nextError) {
        if (!active) return
        setError(getErrorMessage(nextError))
      } finally {
        if (active) {
          setIsLoadingWorkspace(false)
        }
      }
    }

    void loadWorkspaces()

    return () => {
      active = false
    }
  }, [])

  async function handleRelationshipToken(token: string) {
    if (!workspaceId) {
      throw new Error("Select a workspace before scanning a relationship QR.")
    }

    const scanResult = await api.scanRelationshipQr(workspaceId, token)
    if (
      scanResult.contact &&
      (scanResult.outcome === "same_workspace_member" ||
        scanResult.outcome === "friend_active" ||
        scanResult.outcome === "actor_access_granted")
    ) {
      const opened = await api.openDirectConversation(workspaceId, {
        contactKind: scanResult.contact.kind,
        contactId: scanResult.contact.id,
      })
      if (opened.conversationId) {
        startTransition(() => {
          router.replace(`/m/chat/${opened.conversationId}`)
        })
        return
      }
    }

    setHint(
      scanResult.outcome === "friend_request_created"
        ? "Friend request created."
        : scanResult.outcome === "friend_request_pending"
          ? "Friend request is already pending."
          : scanResult.outcome === "actor_access_request_created"
            ? "Actor access request submitted."
            : scanResult.outcome === "actor_access_pending"
              ? "Actor access request is already pending."
              : scanResult.outcome === "self_scan"
                ? "You cannot scan your own QR."
                : "QR processed."
    )
  }

  async function routeLoginToken(token: string) {
    startTransition(() => {
      router.replace(`/m/qr-login?token=${encodeURIComponent(token)}`)
    })
  }

  async function processParsedPayload(parsed: ParsedSynapseQrPayload) {
    setError(null)
    setHint(null)

    try {
      if (parsed.kind === "login") {
        await routeLoginToken(parsed.token)
        return
      }

      if (parsed.kind === "relationship") {
        await handleRelationshipToken(parsed.token)
        return
      }

      try {
        await api.resolveQrLogin(parsed.token)
        await routeLoginToken(parsed.token)
        return
      } catch (loginError) {
        if (
          loginError instanceof ApiError &&
          loginError.status !== 400 &&
          loginError.status !== 404
        ) {
          throw loginError
        }
      }

      await handleRelationshipToken(parsed.token)
    } catch (nextError) {
      setError(getErrorMessage(nextError))
    }
  }

  useEffect(() => {
    const token = typeof initialToken === "string" ? initialToken.trim() : ""
    const kind = typeof initialKind === "string" ? initialKind.trim().toLowerCase() : ""
    if (!token || initialProcessedRef.current || isLoadingWorkspace) {
      return
    }

    initialProcessedRef.current = true
    if (kind === "login" || kind === "relationship") {
      void processParsedPayload({
        kind,
        token,
      } as ParsedSynapseQrPayload)
      return
    }

    void processParsedPayload({ kind: "token", token })
  }, [initialKind, initialToken, isLoadingWorkspace, workspaceId])

  useEffect(() => {
    if (initialToken) {
      setIsStarting(false)
      return
    }

    let active = true
    let scannerControls: { stop: () => void } | null = null

    async function startScanner() {
      setIsStarting(true)
      setError(null)
      setHint(null)

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

            const parsed = parseSynapseQrPayload(result.getText())
            if (!parsed) {
              setError("This QR code is not a Synapse login or relationship QR.")
              return
            }

            scannerControls?.stop()
            void processParsedPayload(parsed)
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
  }, [initialToken, scannerKey, workspaceId])

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-border/70 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
        {workspaceName
          ? `Active workspace: ${workspaceName}. This single scanner handles Web login and relationship QR codes.`
          : intent === "relationship"
            ? "Load a workspace first if you want to use relationship QR codes."
            : "This single scanner handles Web login and relationship QR codes."}
      </div>

      {!initialToken ? (
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
            {isStarting || isLoadingWorkspace ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/55 text-white">
                <LoaderCircle className="size-5 animate-spin" />
                <span className="text-sm">
                  {isLoadingWorkspace ? "Loading workspace..." : "Starting camera..."}
                </span>
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-border/70 bg-muted/20 px-4 py-4 text-sm text-muted-foreground">
          Processing the QR link...
        </div>
      )}

      {error ? (
        <div className="rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {hint ? (
        <div className="rounded-2xl border border-border/70 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
          {hint}
        </div>
      ) : null}

      {!initialToken ? (
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
      ) : null}
    </div>
  )
}
