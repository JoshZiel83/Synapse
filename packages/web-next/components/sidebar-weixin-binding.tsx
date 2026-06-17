"use client"

import * as React from "react"
import Image from "next/image"
import type {
  CurrentUserWeixinBindingSummary,
  WeixinQrLoginSessionSummary,
  WeixinQrLoginStatus,
} from "@synapse/shared"
import { WEIXIN_QR_LOGIN_STATUS } from "@synapse/shared"
import { Loader2 } from "lucide-react"

import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { ApiError, api } from "@/lib/api"
import { useAuthStore } from "@/stores/auth-store"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { toast } from "sonner"

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

const WEIXIN_QR_POLLING_STATUSES = new Set<WeixinQrLoginStatus>([
  WEIXIN_QR_LOGIN_STATUS.WAITING,
  WEIXIN_QR_LOGIN_STATUS.SCANNED,
  WEIXIN_QR_LOGIN_STATUS.NEED_VERIFYCODE,
])

function isWeixinQrPollingStatus(
  status: WeixinQrLoginStatus | null | undefined
) {
  return status != null && WEIXIN_QR_POLLING_STATUSES.has(status)
}

function WechatIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={className}
      fill="currentColor"
    >
      <path d="M8.27 4.28c-3.64 0-6.6 2.54-6.6 5.65 0 1.8.99 3.42 2.54 4.46l-.64 2.34 2.53-1.31c.58.11 1.17.17 1.76.17.2 0 .4-.01.6-.03a5.64 5.64 0 0 1-.45-2.17c0-3.11 2.96-5.65 6.6-5.65.16 0 .31.01.47.02-.82-2.02-3.15-3.48-5.81-3.48Zm-2.28 4.3c.48 0 .87.39.87.88s-.39.88-.87.88a.88.88 0 0 1 0-1.76Zm4.56 0c.48 0 .87.39.87.88s-.39.88-.87.88a.88.88 0 0 1 0-1.76Z" />
      <path d="M15.83 8.75c-3.1 0-5.63 2.13-5.63 4.75 0 1.42.73 2.73 2 3.64l-.5 1.87 2.01-1.04c.35.06.71.1 1.08.1 3.11 0 5.63-2.13 5.63-4.76 0-2.62-2.52-4.56-5.63-4.56Zm-1.95 3.64a.73.73 0 1 1 0 1.46.73.73 0 0 1 0-1.46Zm3.9 0a.73.73 0 1 1 0 1.46.73.73 0 0 1 0-1.46Z" />
    </svg>
  )
}

export function SidebarWeixinBinding() {
  const { workspaceId, currentWorkspaceMemberId } = useWorkspace()
  const currentUser = useAuthStore((state) => state.user)
  const currentUserId = currentUser?.id || null
  const currentUserName = currentUser?.name || "自己"

  const [loadingBinding, setLoadingBinding] = React.useState(true)
  const [binding, setBinding] =
    React.useState<CurrentUserWeixinBindingSummary | null>(null)
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [session, setSession] =
    React.useState<WeixinQrLoginSessionSummary | null>(null)
  const [selectedUsage, setSelectedUsage] = React.useState<"self" | "visitor">(
    "self"
  )
  const [qrImageUrl, setQrImageUrl] = React.useState<string | null>(null)
  const [starting, setStarting] = React.useState(false)
  const [savingBindingTarget, setSavingBindingTarget] = React.useState(false)
  const [verifyCode, setVerifyCode] = React.useState("")
  const [submittingVerifyCode, setSubmittingVerifyCode] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false

    async function loadBinding() {
      if (!workspaceId || !currentUserId) {
        if (!cancelled) {
          setBinding(null)
          setLoadingBinding(false)
        }
        return
      }

      setLoadingBinding(true)
      try {
        const result = await api.getCurrentUserWeixinBinding(workspaceId)
        if (!cancelled) {
          setBinding(result?.binding || null)
        }
      } catch (loadError) {
        if (!cancelled) {
          console.error("Failed to load current WeChat binding:", loadError)
          setBinding(null)
        }
      } finally {
        if (!cancelled) {
          setLoadingBinding(false)
        }
      }
    }

    void loadBinding()

    return () => {
      cancelled = true
    }
  }, [currentUserId, workspaceId])

  React.useEffect(() => {
    if (!dialogOpen) {
      return
    }

    setSelectedUsage(
      binding?.pendingAutoLinkWorkspaceMemberId &&
        currentWorkspaceMemberId &&
        binding.pendingAutoLinkWorkspaceMemberId === currentWorkspaceMemberId
        ? "self"
        : "visitor"
    )
  }, [
    binding?.pendingAutoLinkWorkspaceMemberId,
    currentWorkspaceMemberId,
    dialogOpen,
  ])

  React.useEffect(() => {
    let cancelled = false

    async function renderQrImage() {
      const qrTarget = session?.qrCodeUrl?.trim()
      if (!qrTarget) {
        setQrImageUrl(null)
        return
      }

      try {
        const QRCode = await import("qrcode")
        const imageUrl = await QRCode.toDataURL(qrTarget, {
          width: 288,
          margin: 1,
          errorCorrectionLevel: "H",
          color: {
            dark: "#111827",
            light: "#ffffff",
          },
        })
        if (!cancelled) {
          setQrImageUrl(imageUrl)
        }
      } catch (qrError) {
        console.error("Failed to render WeChat QR image:", qrError)
        if (!cancelled) {
          setQrImageUrl(null)
        }
      }
    }

    void renderQrImage()

    return () => {
      cancelled = true
    }
  }, [session?.qrCodeUrl])

  React.useEffect(() => {
    if (
      !dialogOpen ||
      !workspaceId ||
      !session ||
      !isWeixinQrPollingStatus(session.status)
    ) {
      return
    }

    const activeWorkspaceId = workspaceId
    const activeSessionId = session.sessionId
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    async function poll() {
      try {
        const result = await api.getCurrentUserWeixinBindingQr(
          activeWorkspaceId,
          activeSessionId
        )
        if (cancelled) {
          return
        }

        const nextSession = result?.session || null
        setSession(nextSession)

        if (nextSession?.status === WEIXIN_QR_LOGIN_STATUS.CONFIRMED) {
          const bindingResult =
            await api.getCurrentUserWeixinBinding(activeWorkspaceId)
          if (!cancelled) {
            setBinding(bindingResult?.binding || null)
            toast.success("绑定成功", { position: "top-center" })
          }
          return
        }

        if (
          nextSession?.status === WEIXIN_QR_LOGIN_STATUS.EXPIRED ||
          nextSession?.status === WEIXIN_QR_LOGIN_STATUS.ERROR
        ) {
          return
        }
      } catch (pollError) {
        if (cancelled) {
          return
        }
        console.error("Failed to poll current WeChat binding:", pollError)
        setError(errorMessage(pollError, "Failed to check WeChat status"))
        return
      }

      timer = setTimeout(() => {
        void poll()
      }, 1500)
    }

    void poll()

    return () => {
      cancelled = true
      if (timer) {
        clearTimeout(timer)
      }
    }
  }, [dialogOpen, session, workspaceId])
  async function refreshBinding(activeWorkspaceId: string) {
    const result = await api.getCurrentUserWeixinBinding(activeWorkspaceId)
    setBinding(result?.binding || null)
    return result?.binding || null
  }

  function closeDialog() {
    setDialogOpen(false)
    setSession(null)
    setQrImageUrl(null)
    setError(null)
    setSelectedUsage(
      binding?.pendingAutoLinkWorkspaceMemberId &&
        currentWorkspaceMemberId &&
        binding.pendingAutoLinkWorkspaceMemberId === currentWorkspaceMemberId
        ? "self"
        : "visitor"
    )
  }

  async function handleStartBinding() {
    if (!workspaceId) {
      return
    }

    setDialogOpen(true)
    setSession(null)
    setQrImageUrl(null)
    setError(null)
    setStarting(true)

    try {
      const result = await api.startCurrentUserWeixinBindingQr(workspaceId)
      setSession(result?.session || null)
    } catch (startError) {
      console.error("Failed to start current WeChat binding:", startError)
      if (startError instanceof ApiError && startError.status === 409) {
        await refreshBinding(workspaceId).catch((loadError) => {
          console.error("Failed to refresh existing WeChat binding:", loadError)
        })
        closeDialog()
        return
      }
      setError(errorMessage(startError, "Failed to start WeChat binding"))
    } finally {
      setStarting(false)
    }
  }

  async function handleSaveBindingTarget() {
    if (!workspaceId) {
      return
    }

    setSavingBindingTarget(true)
    setError(null)
    try {
      const activeBinding = binding || (await refreshBinding(workspaceId))
      if (!activeBinding) {
        throw new Error("WeChat binding is not ready yet")
      }
      const result = await api.setCurrentUserWeixinBindingAutoLink(
        workspaceId,
        selectedUsage === "self" ? currentWorkspaceMemberId || null : null
      )
      setBinding(result?.binding || null)
      toast.success("已保存", { position: "top-center" })
      closeDialog()
    } catch (saveError) {
      console.error("Failed to save WeChat binding target:", saveError)
      setError(errorMessage(saveError, "Failed to save WeChat binding"))
    } finally {
      setSavingBindingTarget(false)
    }
  }

  async function handleSubmitVerifyCode() {
    if (!workspaceId || !session || !verifyCode.trim()) {
      return
    }
    setSubmittingVerifyCode(true)
    setError(null)
    try {
      const result = await api.submitCurrentUserWeixinBindingVerifyCode(
        workspaceId,
        session.sessionId,
        verifyCode.trim()
      )
      setSession(result.session)
      setVerifyCode("")
    } catch (submitError) {
      setError(errorMessage(submitError, "Failed to submit verification code"))
    } finally {
      setSubmittingVerifyCode(false)
    }
  }

  const canShowLauncher =
    Boolean(workspaceId) &&
    Boolean(currentWorkspaceMemberId) &&
    !loadingBinding &&
    !binding

  const showDialogContent = dialogOpen

  if (!showDialogContent && !canShowLauncher) {
    return null
  }

  return (
    <>
      {canShowLauncher ? (
        <div className="mx-2 mb-2">
          <Button
            className="w-full justify-start gap-2"
            variant="outline"
            size="sm"
            onClick={() => void handleStartBinding()}
            disabled={starting}
          >
            {starting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Preparing...
              </>
            ) : (
              <>
                <WechatIcon className="size-4" />
                Connect Wechat
              </>
            )}
          </Button>
        </div>
      ) : null}

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            if (starting || savingBindingTarget) {
              return
            }
            closeDialog()
            return
          }
          setDialogOpen(true)
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Connect Wechat</DialogTitle>
            {starting ||
            session?.status === WEIXIN_QR_LOGIN_STATUS.SCANNED ||
            session?.status === WEIXIN_QR_LOGIN_STATUS.CONFIRMED ||
            session?.status === WEIXIN_QR_LOGIN_STATUS.EXPIRED ||
            session?.status === WEIXIN_QR_LOGIN_STATUS.ERROR ? (
              <DialogDescription>
                {starting
                  ? "Preparing QR..."
                  : session?.status === WEIXIN_QR_LOGIN_STATUS.SCANNED
                    ? "Confirm on your phone."
                    : session?.status === WEIXIN_QR_LOGIN_STATUS.CONFIRMED
                      ? "Choose how to use it."
                      : session?.status === WEIXIN_QR_LOGIN_STATUS.EXPIRED
                        ? "QR expired."
                        : "Connect failed."}
              </DialogDescription>
            ) : null}
          </DialogHeader>

          {starting ? (
            <div className="flex h-72 items-center justify-center rounded-3xl border bg-muted/20">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : null}

          {!starting && session && isWeixinQrPollingStatus(session.status) ? (
            <div className="space-y-3">
              {qrImageUrl ? (
                <div className="relative mx-auto w-full max-w-72">
                  <Image
                    src={qrImageUrl}
                    alt="WeChat QR"
                    width={288}
                    height={288}
                    unoptimized
                    className="h-auto w-full object-contain"
                  />
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <div className="flex h-11 w-11 items-center justify-center rounded-full bg-white shadow-sm ring-1 ring-black/8">
                      <WechatIcon className="h-7 w-7 text-[#07c160]" />
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex h-72 items-center justify-center rounded-3xl border bg-muted/20">
                  <Loader2 className="size-5 animate-spin text-muted-foreground" />
                </div>
              )}

              {session.status === WEIXIN_QR_LOGIN_STATUS.NEED_VERIFYCODE ? (
                <div className="space-y-2 rounded-2xl border bg-muted/20 px-3 py-3">
                  <p className="text-xs text-muted-foreground">
                    {session.message ||
                      "Enter the number shown in WeChat on your phone."}
                  </p>
                  <div className="flex gap-2">
                    <Input
                      value={verifyCode}
                      onChange={(event) => setVerifyCode(event.target.value)}
                      placeholder="Verification code"
                      inputMode="numeric"
                      autoFocus
                      disabled={submittingVerifyCode}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          void handleSubmitVerifyCode()
                        }
                      }}
                    />
                    <Button
                      onClick={() => void handleSubmitVerifyCode()}
                      disabled={submittingVerifyCode || !verifyCode.trim()}
                    >
                      {submittingVerifyCode ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        "Submit"
                      )}
                    </Button>
                  </div>
                </div>
              ) : session.status === WEIXIN_QR_LOGIN_STATUS.SCANNED ? (
                <div className="rounded-2xl border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                  Confirm on your phone.
                </div>
              ) : null}
            </div>
          ) : null}

          {session?.status === WEIXIN_QR_LOGIN_STATUS.CONFIRMED ? (
            <RadioGroup
              value={selectedUsage}
              onValueChange={(value) =>
                setSelectedUsage(value === "visitor" ? "visitor" : "self")
              }
              className="gap-2"
            >
              <FieldLabel htmlFor="weixin-usage-self">
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldTitle>自己使用</FieldTitle>
                    <FieldDescription>
                      {`首条消息自动绑定到 ${currentUserName}`}
                    </FieldDescription>
                  </FieldContent>
                  <RadioGroupItem
                    value="self"
                    id="weixin-usage-self"
                    disabled={savingBindingTarget}
                  />
                </Field>
              </FieldLabel>
              <FieldLabel htmlFor="weixin-usage-visitor">
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldTitle>访客使用</FieldTitle>
                    <FieldDescription>首条消息保持访客身份</FieldDescription>
                  </FieldContent>
                  <RadioGroupItem
                    value="visitor"
                    id="weixin-usage-visitor"
                    disabled={savingBindingTarget}
                  />
                </Field>
              </FieldLabel>
            </RadioGroup>
          ) : null}

          {error ? (
            <div className="rounded-2xl border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          ) : null}

          <DialogFooter>
            {session?.status === WEIXIN_QR_LOGIN_STATUS.CONFIRMED ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={closeDialog}
                  disabled={savingBindingTarget}
                >
                  Close
                </Button>
                <Button
                  type="button"
                  onClick={() => void handleSaveBindingTarget()}
                  disabled={
                    savingBindingTarget ||
                    (selectedUsage === "self" && !currentWorkspaceMemberId)
                  }
                >
                  {savingBindingTarget ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    "Done"
                  )}
                </Button>
              </>
            ) : session?.status === WEIXIN_QR_LOGIN_STATUS.EXPIRED ||
              session?.status === WEIXIN_QR_LOGIN_STATUS.ERROR ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={closeDialog}
                  disabled={starting}
                >
                  Close
                </Button>
                <Button
                  type="button"
                  onClick={() => void handleStartBinding()}
                  disabled={starting}
                >
                  {starting ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      Preparing...
                    </>
                  ) : (
                    "New QR"
                  )}
                </Button>
              </>
            ) : (
              <Button
                type="button"
                variant="outline"
                onClick={closeDialog}
                disabled={starting}
              >
                Close
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
