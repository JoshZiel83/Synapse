"use client"

// Right-pane contact detail — ONE component for all 6 kinds, varying only by
// slots: identity block, a single dominant Message CTA (label adapts to
// directState), shared groups, and a per-kind metadata slot. Owned actors get an
// Edit affordance (the inline edit sheet is Phase 2; here it links to the route).
import { useState } from "react"
import Link from "next/link"
import { MessageSquare, Pencil, QrCode, Star, Users } from "lucide-react"
import type { ConversationSummaryView } from "@synapse/shared"
import { Button } from "@/components/ui/button"
import {
  cn,
  ContactAvatar,
  isFriend,
  messageCtaLabel,
  targetBadge,
  type Entry,
} from "./contact-shared"
import { ActorShareDialog } from "./actor-share-dialog"

export function ContactDetail({
  entry,
  groups,
  starred,
  workspaceId,
  onMessage,
  onToggleStar,
}: {
  entry: Entry
  groups: ConversationSummaryView[]
  starred: boolean
  workspaceId: string
  onMessage: (e: Entry) => void
  onToggleStar: (e: Entry) => void
}) {
  const badge = targetBadge(entry.targetType)
  const cta = messageCtaLabel(entry.directState.status)
  const [shareOpen, setShareOpen] = useState(false)
  const isActor = entry.kind === "workspace-actor" && !!entry.actorId

  return (
    <div className="mx-auto max-w-2xl p-6">
      {/* identity */}
      <div className="flex items-start gap-4">
        <ContactAvatar entry={entry} size={72} />
        <div className="min-w-0 flex-1 pt-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-xl font-semibold">{entry.title}</h2>
            {badge && (
              <span
                className={cn(
                  "shrink-0 rounded-md border px-1.5 py-0.5 text-[11px]",
                  badge.className
                )}
              >
                {badge.label}
              </span>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-sm text-muted-foreground">
            <span
              className={cn(
                "size-1.5 rounded-full",
                isFriend(entry) ? "bg-amber-400" : "bg-primary/60"
              )}
            />
            {entry.relationLabel}
            <span className="text-muted-foreground/50">·</span>
            {entry.workspace.name}
          </div>
        </div>
        <button
          type="button"
          onClick={() => onToggleStar(entry)}
          aria-label={starred ? "取消星标" : "星标"}
          className="shrink-0 rounded-lg p-1.5 hover:bg-accent"
        >
          <Star
            className={cn(
              "size-4",
              starred
                ? "fill-amber-400 text-amber-400"
                : "text-muted-foreground/50"
            )}
          />
        </button>
      </div>

      {/* primary actions */}
      <div className="mt-4 flex gap-2">
        <Button onClick={() => onMessage(entry)} disabled={cta.disabled}>
          <MessageSquare className="mr-1.5 size-4" />
          {cta.label}
        </Button>
        {isActor && (
          <>
            <Button variant="outline" onClick={() => setShareOpen(true)}>
              <QrCode className="mr-1.5 size-4" />
              分享
            </Button>
            <Button variant="outline" asChild>
              <Link href={`/dashboard/actors/${entry.actorId}/edit`}>
                <Pencil className="mr-1.5 size-4" />
                编辑 Actor
              </Link>
            </Button>
          </>
        )}
      </div>

      {isActor && (
        <ActorShareDialog
          open={shareOpen}
          onOpenChange={setShareOpen}
          workspaceId={workspaceId}
          actorId={entry.actorId!}
          actorName={entry.title}
        />
      )}

      {/* per-kind metadata */}
      <div className="mt-6 space-y-4">
        <Field label="类型">
          {entry.targetType === "actor"
            ? "工作区 Actor（AI 智能体）"
            : entry.targetType === "remote_agent"
              ? "远程 Agent（外部智能体）"
              : "成员（真人）"}
          {isFriend(entry) && (
            <span className="ml-1 text-muted-foreground">· 跨工作区好友</span>
          )}
        </Field>
        {entry.subtitle && <Field label="简介">{entry.subtitle}</Field>}
        <Field label="所属工作区">{entry.workspace.name}</Field>

        {/* shared groups */}
        <div>
          <div className="mb-1.5 flex items-center gap-1 text-xs font-medium text-muted-foreground">
            <Users className="size-3.5" />
            共同群组（{groups.length}）
          </div>
          {groups.length === 0 ? (
            <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
              暂无共同群组
            </p>
          ) : (
            <div className="divide-y rounded-lg border">
              {groups.map((g) => (
                <div key={g.id} className="px-3 py-2 text-sm">
                  {g.title}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex gap-3 text-sm">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  )
}
