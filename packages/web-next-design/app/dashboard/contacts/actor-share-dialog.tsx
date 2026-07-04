"use client"

// Actor "分享与访问" — the ownership-scoped Config surface for an owned actor
// (the design's actor-edit Config tab), reachable from the actor contact detail.
// Renders the relationship QR + the sharing/access settings (approval mode,
// searchability, public) editable via updateActorRelationshipProfile. Core
// identity (name/role/specialties/docs) stays on the /actors/:id/edit route.
import { useEffect, useState } from "react"
import QRCode from "qrcode"
import { buildMobileScanUrl } from "@synapse/shared"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogFooter,
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
  const qc = useQueryClient()
  const { data: profile } = useQuery({
    queryKey: ["actor-profile", workspaceId, actorId],
    queryFn: () => api.getActorRelationshipProfile(workspaceId, actorId),
    enabled: open && !!actorId,
  })

  const [qr, setQr] = useState<string | null>(null)
  const [manual, setManual] = useState(true)
  const [searchable, setSearchable] = useState(true)
  const [publicShared, setPublicShared] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open || !profile) return
    setManual(profile.approvalMode === "manual")
    setSearchable(profile.identitySearchEnabled)
    setPublicShared(!!profile.isPublicShared)
    void QRCode.toDataURL(
      buildMobileScanUrl({
        origin: window.location.origin,
        kind: "relationship",
        token: profile.qrToken,
      }),
      { width: 200, margin: 1 }
    ).then(setQr)
  }, [open, profile])

  const dirty =
    !!profile &&
    (manual !== (profile.approvalMode === "manual") ||
      searchable !== profile.identitySearchEnabled ||
      publicShared !== !!profile.isPublicShared)

  const save = async () => {
    setSaving(true)
    try {
      await api.updateActorRelationshipProfile(workspaceId, actorId, {
        approvalMode: manual ? "manual" : "auto",
        identitySearchEnabled: searchable,
        isPublicShared: publicShared,
      })
      qc.invalidateQueries({
        queryKey: ["actor-profile", workspaceId, actorId],
      })
      toast.success("已保存")
    } catch {
      toast.error("保存失败")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>分享与访问 · {actorName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex flex-col items-center gap-2">
            {qr ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={qr}
                alt="二维码"
                width={200}
                height={200}
                className="rounded-lg border"
              />
            ) : (
              <div className="size-[200px] animate-pulse rounded-lg bg-muted" />
            )}
            <p className="text-center text-xs text-muted-foreground">
              扫码添加「{actorName}」· ID {profile?.identityId ?? "…"}
            </p>
          </div>

          <div className="space-y-2">
            <Row
              label="加为联系人需验证"
              hint={manual ? "对方需申请" : "自动通过"}
              checked={manual}
              onChange={setManual}
            />
            <Row
              label="允许被身份 ID 搜索到"
              checked={searchable}
              onChange={setSearchable}
            />
            <Row
              label="公开分享"
              hint="任何人可通过链接添加"
              checked={publicShared}
              onChange={setPublicShared}
            />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={saving || !dirty}>
            {saving && <Loader2 className="mr-1 size-4 animate-spin" />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Row({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string
  hint?: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="flex items-center justify-between rounded-lg border p-3 text-sm">
      <div>
        <div>{label}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  )
}
