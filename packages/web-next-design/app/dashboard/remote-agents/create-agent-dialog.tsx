"use client"

// 新建 Agent — pick a runtime (Claude Code / Codex, shown with brand marks), name
// it, optionally share it. Binding to a machine + working dir is the next step
// (the 改绑定 sheet), matching the pair → create → bind onboarding order.
import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import type { RemoteAgentRuntimeKind } from "@synapse/shared"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import { RuntimeKindIcon } from "@/components/runtime-kind-icon"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

export function CreateAgentDialog({
  open,
  onOpenChange,
  workspaceId,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  workspaceId: string
}) {
  const qc = useQueryClient()
  const [runtimeKind, setRuntimeKind] =
    useState<RemoteAgentRuntimeKind>("claude_code")
  const [displayName, setDisplayName] = useState("")
  const [title, setTitle] = useState("")
  const [emoji, setEmoji] = useState("")
  const [publicShared, setPublicShared] = useState(false)
  const [saving, setSaving] = useState(false)

  const reset = () => {
    setRuntimeKind("claude_code")
    setDisplayName("")
    setTitle("")
    setEmoji("")
    setPublicShared(false)
  }

  const create = async () => {
    if (!displayName.trim()) return toast.error("请填写名称")
    setSaving(true)
    try {
      await api.createRemoteAgent(workspaceId, {
        displayName: displayName.trim(),
        title: title.trim() || displayName.trim(),
        runtimeKind,
        avatarEmoji: emoji || undefined,
        isPublicShared: publicShared,
      } as Parameters<typeof api.createRemoteAgent>[1])
      qc.invalidateQueries({ queryKey: ["remote-agents", workspaceId] })
      toast.success("已创建 · 接下来去绑定一台主机")
      onOpenChange(false)
      reset()
    } catch {
      toast.error("创建失败")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>新建 Agent</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">运行时</Label>
            <div className="grid grid-cols-2 gap-2">
              {(["claude_code", "codex"] as RemoteAgentRuntimeKind[]).map(
                (k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setRuntimeKind(k)}
                    className={cn(
                      "flex items-center gap-2 rounded-lg border p-2.5 text-sm transition",
                      runtimeKind === k
                        ? "border-primary/50 bg-accent/40"
                        : "hover:border-foreground/20"
                    )}
                  >
                    <RuntimeKindIcon kind={k} className="size-4" />
                    {k === "claude_code" ? "Claude Code" : "Codex"}
                  </button>
                )
              )}
            </div>
          </div>

          <div className="flex gap-2">
            <div className="w-16 space-y-1.5">
              <Label className="text-xs text-muted-foreground">图标</Label>
              <Input
                value={emoji}
                onChange={(e) => setEmoji(e.target.value)}
                placeholder="🤖"
                maxLength={2}
                className="text-center"
              />
            </div>
            <div className="flex-1 space-y-1.5">
              <Label className="text-xs text-muted-foreground">名称</Label>
              <Input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="例如：前端修复 Bot"
                autoFocus
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">
              职责（可选）
            </Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例如：自动修 UI bug"
            />
          </div>

          <label className="flex items-center justify-between rounded-lg border p-3 text-sm">
            <div>
              <div>公开分享</div>
              <div className="text-xs text-muted-foreground">
                允许其他工作区通过身份发现
              </div>
            </div>
            <Switch checked={publicShared} onCheckedChange={setPublicShared} />
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={create} disabled={saving}>
            {saving && <Loader2 className="mr-1 size-4 animate-spin" />}
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
