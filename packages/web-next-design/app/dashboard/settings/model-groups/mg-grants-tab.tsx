"use client"

// Grants = "shared with" (distinct from the list's "owned in"). Rows resolve the
// target to a name, show granted-by/when + status, and history is first-class (a
// Show-revoked toggle folds soft-revoked grants back in). Revoke is inline with
// an undo toast + a blast-radius line. apiKey never appears here.
import { useState } from "react"
import { Bot, Building2, Globe2, Plus, UserRound } from "lucide-react"
import { toast } from "sonner"
import type {
  ModelGroupDetailView,
  ModelGroupGrantScope,
  ModelGroupGrantView,
  ModelGroupOwnerType,
} from "@synapse/shared"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { formatInstant } from "@/lib/automation/describe"

// design-local name resolution for grant targets
const ACTOR_NAMES: Record<string, string> = {
  "act-aria": "研究助理 Aria",
  "act-atlas": "运维 Atlas",
  "act-nova": "数据 Nova",
}
const GRANT_ICON: Record<
  string,
  React.ComponentType<{ className?: string }>
> = {
  platform: Globe2,
  workspace: Building2,
  workspace_member: UserRound,
  actor: Bot,
}
function targetLabel(g: ModelGroupGrantView): string {
  switch (g.grantScope) {
    case "platform":
      return "所有平台"
    case "workspace":
      return "本工作区"
    case "workspace_member":
      return "工作区成员"
    case "actor":
      return g.actorId ? (ACTOR_NAMES[g.actorId] ?? g.actorId) : "Actor"
    default:
      return g.grantScope
  }
}

export function GrantsTab({
  group,
  onRevoke,
  onIssue,
}: {
  group: ModelGroupDetailView
  onRevoke: (grantId: string) => Promise<void>
  onIssue: (scope: ModelGroupGrantScope, actorId?: string) => Promise<void>
}) {
  const [showRevoked, setShowRevoked] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const grants = group.grants.filter(
    (g) => showRevoked || g.status === "active"
  )
  const ownScope = group.ownerType as ModelGroupOwnerType

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">谁可以使用这个组</p>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={showRevoked}
              onChange={(e) => setShowRevoked(e.target.checked)}
              className="size-3.5 accent-primary"
            />
            显示已撤销
          </label>
          <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="mr-1 size-3.5" />
            分享
          </Button>
        </div>
      </div>

      {ownScope === "workspace" && (
        <div className="rounded-lg border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          本工作区无需授权即可使用（在此拥有）。授权仅用于扩大跨作用域可见性。
        </div>
      )}

      {grants.length === 0 ? (
        <div className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
          还没有额外分享
        </div>
      ) : (
        <div className="divide-y rounded-lg border">
          {grants.map((g) => {
            const Icon = GRANT_ICON[g.grantScope] ?? Globe2
            const revoked = g.status === "revoked"
            return (
              <div
                key={g.id}
                className={cn(
                  "flex items-center gap-3 p-3",
                  revoked && "opacity-55"
                )}
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {targetLabel(g)}
                    {revoked && (
                      <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">
                        已撤销
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-muted-foreground/70">
                    {g.reason && <>{g.reason} · </>}
                    {revoked && g.revokedAt
                      ? `撤销于 ${formatInstant(g.revokedAt)}`
                      : `分享于 ${formatInstant(g.createdAt ?? undefined)}`}
                  </div>
                </div>
                {!revoked && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-red-600"
                    onClick={async () => {
                      await onRevoke(g.id)
                      toast.success("已撤销", {
                        description: `此组已从 ${targetLabel(g)} 移除。如是密钥泄露，请轮换密钥。`,
                      })
                    }}
                  >
                    撤销
                  </Button>
                )}
              </div>
            )
          })}
        </div>
      )}

      <AddGrantDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onIssue={onIssue}
      />
    </div>
  )
}

function AddGrantDialog({
  open,
  onOpenChange,
  onIssue,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onIssue: (scope: ModelGroupGrantScope, actorId?: string) => Promise<void>
}) {
  const [scope, setScope] = useState<ModelGroupGrantScope>("actor")
  const [actorId, setActorId] = useState("act-aria")
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>分享给</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Select
            value={scope}
            onValueChange={(v) => setScope(v as ModelGroupGrantScope)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="actor">某个 Actor</SelectItem>
              <SelectItem value="workspace_member">工作区成员</SelectItem>
              <SelectItem value="workspace">整个工作区</SelectItem>
              <SelectItem value="platform">整个平台</SelectItem>
            </SelectContent>
          </Select>
          {scope === "actor" && (
            <Select value={actorId} onValueChange={setActorId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(ACTOR_NAMES).map(([id, name]) => (
                  <SelectItem key={id} value={id}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            onClick={async () => {
              await onIssue(scope, scope === "actor" ? actorId : undefined)
              toast.success("已分享")
              onOpenChange(false)
            }}
          >
            分享
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
