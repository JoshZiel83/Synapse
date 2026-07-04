"use client"

// The header "+" surface: ONE sheet with two tabs so identity / QR / add-contact
// / searchability / approval-mode never crowd the roster (WeChat "+", WhatsApp
// "My code / Scan"). Tab 1 adds a contact by identity ID; tab 2 is "my identity"
// (ID + QR + searchability + approval mode) — the co-located settings that a LINE
// user otherwise hunts for across two pages.
import { useEffect, useState } from "react"
import QRCode from "qrcode"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { buildMobileScanUrl } from "@synapse/shared"
import { Copy, Loader2, ScanLine, Search } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ContactAvatar } from "./contact-shared"

const matchAction = (
  state: string
): { label: string; disabled: boolean; kind: "message" | "request" } => {
  if (["existing", "friend", "same_workspace_member"].includes(state))
    return { label: "发消息", disabled: false, kind: "message" }
  if (["pending_request", "pending_approval"].includes(state))
    return { label: "待处理", disabled: true, kind: "request" }
  return { label: "申请添加", disabled: false, kind: "request" }
}

export function IdentitySheet({
  open,
  onOpenChange,
  workspaceId,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  workspaceId: string
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-md"
      >
        <SheetHeader className="border-b px-5 py-4">
          <SheetTitle>添加 / 我的身份</SheetTitle>
        </SheetHeader>
        <Tabs defaultValue="add" className="flex min-h-0 flex-1 flex-col">
          <TabsList className="mx-5 mt-4 self-start">
            <TabsTrigger value="add">加联系人</TabsTrigger>
            <TabsTrigger value="me">我的身份</TabsTrigger>
          </TabsList>
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            <TabsContent value="add" className="mt-0">
              <AddTab workspaceId={workspaceId} />
            </TabsContent>
            <TabsContent value="me" className="mt-0">
              <MyIdentityTab workspaceId={workspaceId} />
            </TabsContent>
          </div>
        </Tabs>
      </SheetContent>
    </Sheet>
  )
}

function AddTab({ workspaceId }: { workspaceId: string }) {
  const [q, setQ] = useState("")
  const search = useQuery({
    queryKey: ["identity-search", workspaceId, q.trim()],
    queryFn: () => api.searchIdentity(workspaceId, q.trim()),
    enabled: q.trim().length >= 2,
  })
  const matches = search.data?.matches ?? []

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground/50" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="输入对方的身份 ID…"
          className="pl-8"
        />
      </div>
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-lg border border-dashed px-3 py-2.5 text-sm text-muted-foreground hover:border-foreground/20"
      >
        <ScanLine className="size-4" />
        扫描二维码添加
      </button>

      {q.trim().length < 2 ? (
        <p className="py-8 text-center text-xs text-muted-foreground">
          输入至少 2 个字符搜索
        </p>
      ) : search.isFetching ? (
        <div className="flex justify-center py-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : matches.length === 0 ? (
        <p className="py-8 text-center text-xs text-muted-foreground">
          没有找到匹配的身份
        </p>
      ) : (
        <div className="space-y-2">
          {matches.map((m) => {
            const act = matchAction(m.state)
            return (
              <div
                key={m.profileId}
                className="flex items-center gap-3 rounded-xl border p-3"
              >
                <ContactAvatar entry={m} size={40} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{m.title}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {m.subtitle ?? m.workspace.name}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant={act.kind === "message" ? "default" : "outline"}
                  disabled={act.disabled}
                  onClick={async () => {
                    if (act.kind === "message")
                      return toast.success(`打开与「${m.title}」的对话`)
                    await api.requestRelationshipByIdentityProfile(
                      workspaceId,
                      m.profileId
                    )
                    toast.success("已发送申请")
                  }}
                >
                  {act.label}
                </Button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function MyIdentityTab({ workspaceId }: { workspaceId: string }) {
  const qc = useQueryClient()
  const { data: profile } = useQuery({
    queryKey: ["my-profile", workspaceId],
    queryFn: () => api.getMyRelationshipProfile(workspaceId),
  })
  const [qr, setQr] = useState<string | null>(null)
  const [identityId, setIdentityId] = useState("")
  const [searchable, setSearchable] = useState(true)
  const [manual, setManual] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!profile) return
    setIdentityId(profile.identityId)
    setSearchable(profile.identitySearchEnabled)
    setManual(profile.approvalMode === "manual")
    void QRCode.toDataURL(
      buildMobileScanUrl({
        origin: window.location.origin,
        kind: "relationship",
        token: profile.qrToken,
      }),
      { width: 200, margin: 1 }
    ).then(setQr)
  }, [profile])

  const dirty =
    !!profile &&
    (identityId !== profile.identityId ||
      searchable !== profile.identitySearchEnabled ||
      manual !== (profile.approvalMode === "manual"))

  const save = async () => {
    setSaving(true)
    try {
      await api.updateMyRelationshipProfile(workspaceId, {
        approvalMode: manual ? "manual" : "auto",
        identityId,
        identitySearchEnabled: searchable,
      })
      qc.invalidateQueries({ queryKey: ["my-profile", workspaceId] })
      toast.success("已保存")
    } catch {
      toast.error("保存失败")
    } finally {
      setSaving(false)
    }
  }

  if (!profile)
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )

  return (
    <div className="space-y-4">
      <div className="flex flex-col items-center gap-2">
        {qr ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={qr}
            alt="我的二维码"
            width={200}
            height={200}
            className="rounded-lg border"
          />
        ) : (
          <div className="size-[200px] animate-pulse rounded-lg bg-muted" />
        )}
        <button
          type="button"
          onClick={() => {
            navigator.clipboard?.writeText(profile.qrUrl)
            toast.success("已复制链接")
          }}
          className="flex items-center gap-1 text-xs text-primary hover:underline"
        >
          <Copy className="size-3" /> 复制我的名片链接
        </button>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">
          身份 ID（4–32 字符）
        </Label>
        <Input
          value={identityId}
          onChange={(e) => setIdentityId(e.target.value)}
          minLength={4}
          maxLength={32}
        />
      </div>

      <label className="flex items-center justify-between rounded-lg border p-3 text-sm">
        <span>允许通过身份 ID 搜索到我</span>
        <Switch checked={searchable} onCheckedChange={setSearchable} />
      </label>
      <label className="flex items-center justify-between rounded-lg border p-3 text-sm">
        <div>
          <div>加我为联系人需验证</div>
          <div className="text-xs text-muted-foreground">
            {manual ? "对方需申请，你确认后添加" : "自动通过"}
          </div>
        </div>
        <Switch checked={manual} onCheckedChange={setManual} />
      </label>

      <div className="flex justify-end">
        <Button
          onClick={save}
          disabled={saving || !dirty}
          className={cn(!dirty && "opacity-60")}
        >
          {saving && <Loader2 className="mr-1 size-4 animate-spin" />}
          保存
        </Button>
      </div>
    </div>
  )
}
