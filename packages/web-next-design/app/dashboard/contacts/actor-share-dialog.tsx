"use client"

// Actor QR share — an ownership-scoped sharing card reachable from the actor's
// contact detail (in the full design this folds into the actor edit sheet's
// Config tab; surfaced here so it stays findable). Renders the relationship QR
// from the actor's profile token, plus its identity ID + approval mode.
import { useEffect, useState } from "react"
import QRCode from "qrcode"
import { buildMobileScanUrl } from "@synapse/shared"
import { useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

export function ActorShareDialog({
  open,
  onOpenChange,
  workspaceId,
  actorId,
  actorName,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  workspaceId: string
  actorId: string
  actorName: string
}) {
  const { data: profile } = useQuery({
    queryKey: ["actor-profile", workspaceId, actorId],
    queryFn: () => api.getActorRelationshipProfile(workspaceId, actorId),
    enabled: open && !!actorId,
  })

  const [qr, setQr] = useState<string | null>(null)
  useEffect(() => {
    if (!open || !profile?.qrToken) {
      setQr(null)
      return
    }
    void QRCode.toDataURL(
      buildMobileScanUrl({
        origin: window.location.origin,
        kind: "relationship",
        token: profile.qrToken,
      }),
      { width: 220, margin: 1 }
    ).then(setQr)
  }, [open, profile?.qrToken])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xs">
        <DialogHeader>
          <DialogTitle>分享 {actorName}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3">
          {qr ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={qr}
              alt="二维码"
              width={220}
              height={220}
              className="rounded-lg border"
            />
          ) : (
            <div className="size-[220px] animate-pulse rounded-lg bg-muted" />
          )}
          <p className="text-center text-xs text-muted-foreground">
            扫码添加「{actorName}」为联系人
          </p>
          {profile && (
            <div className="w-full space-y-1 rounded-lg border bg-muted/20 px-3 py-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">身份 ID</span>
                <code className="font-mono">{profile.identityId}</code>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">加为联系人需验证</span>
                <span>{profile.approvalMode === "manual" ? "开" : "关"}</span>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
