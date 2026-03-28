"use client"

import type { ReactNode } from "react"
import { useRouter } from "next/navigation"
import { ArrowUpRight } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { useIsMobile } from "@/hooks/use-mobile"
import type { ConversationMember } from "@/stores/chat-store"
import ChatAvatar from "./chat-avatar"
import {
  formatTransportKindLabel,
  getConversationMemberContactHref,
  getConversationMemberSubtitle,
  getConversationMemberTypeLabel,
} from "./member-utils"

function DetailItem({
  label,
  value,
}: {
  label: string
  value: ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground/80">
        {label}
      </div>
      <div className="text-sm text-foreground">{value}</div>
    </div>
  )
}

function ParticipantDetailBody({
  member,
  onOpenContact,
  contactHref,
}: {
  member: ConversationMember
  onOpenContact: () => void
  contactHref?: string
}) {
  const subtitle = getConversationMemberSubtitle(member)
  const typeLabel = getConversationMemberTypeLabel(member)
  const transportLabel = formatTransportKindLabel(member.transportKind)
  const actorRole = member.title || member.role || "Actor"

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="border-b border-border/70 px-5 pb-5 pt-[max(1rem,env(safe-area-inset-top))] sm:px-6 sm:py-6">
        <div className="flex items-start gap-4 pr-10">
          <ChatAvatar
            name={member.name}
            avatarUrl={member.avatarUrl}
            emoji={member.emoji}
            entityType={member.type}
            size="lg"
            className="size-16 shrink-0"
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg leading-tight font-medium text-foreground">
                {member.name}
              </h2>
              <Badge variant="outline" className="rounded-full">
                {typeLabel}
              </Badge>
              {transportLabel ? (
                <Badge variant="outline" className="rounded-full">
                  {transportLabel}
                </Badge>
              ) : null}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {member.type === "actor" ? (
                <Badge variant="secondary" className="rounded-full">
                  {actorRole}
                </Badge>
              ) : null}
              {member.type === "external" && member.linkedUserName ? (
                <Badge variant="secondary" className="rounded-full">
                  Linked to {member.linkedUserName}
                </Badge>
              ) : null}
              {member.type === "external" && !member.linkedUserName ? (
                <Badge variant="outline" className="rounded-full">
                  No workspace link
                </Badge>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-5 sm:px-6 sm:pb-6">
        <div className="space-y-4">
          <section className="rounded-3xl border border-border/70 bg-muted/20 p-4">
            <div className="mb-4 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground/80">
              Details
            </div>
            <div className="grid gap-4">
              <DetailItem label="Participant type" value={typeLabel} />
              {member.type === "actor" ? (
                <DetailItem label="Role" value={actorRole} />
              ) : null}
              {member.type === "user" ? (
                <DetailItem
                  label="Workspace identity"
                  value={
                    member.transportKind
                      ? `User account in this workspace, reachable via ${transportLabel || "transport"}`
                      : "User account in this workspace"
                  }
                />
              ) : null}
              {member.type !== "actor" && transportLabel ? (
                <DetailItem
                  label="Transport"
                  value={transportLabel || "Unknown transport"}
                />
              ) : null}
              {member.type === "external" && member.externalUserKey ? (
                <DetailItem
                  label="External user key"
                  value={
                    <span className="break-all rounded-2xl bg-background px-2.5 py-1 font-mono text-xs ring-1 ring-border">
                      {member.externalUserKey}
                    </span>
                  }
                />
              ) : null}
            </div>
          </section>

          {member.type === "external" ? (
            <section className="rounded-3xl border border-border/70 bg-background p-4 shadow-sm">
              <div className="mb-4 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground/80">
                Workspace link
              </div>
              {member.linkedUserId && member.linkedUserName ? (
                <button
                  type="button"
                  onClick={onOpenContact}
                  className="flex w-full items-center gap-3 rounded-2xl border border-border/70 bg-muted/20 px-3 py-3 text-left transition-colors hover:bg-muted/35"
                >
                  <ChatAvatar
                    name={member.linkedUserName}
                    avatarUrl={member.linkedUserAvatarUrl}
                    entityType="user"
                    size="default"
                    className="shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">
                      {member.linkedUserName}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      Open linked workspace user
                    </div>
                  </div>
                  <ArrowUpRight className="size-4 shrink-0 text-muted-foreground" />
                </button>
              ) : (
                <p className="text-sm text-muted-foreground">
                  This external participant has not been linked to a workspace
                  user yet.
                </p>
              )}
            </section>
          ) : null}

          {contactHref ? (
            <div className="flex justify-end">
              <Button
                type="button"
                variant="outline"
                className="rounded-full"
                onClick={onOpenContact}
              >
                Open in contacts
                <ArrowUpRight className="size-4" />
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

interface ChatParticipantDetailDialogProps {
  member: ConversationMember | null
  open: boolean
  onOpenChange: (open: boolean) => void
  contactBasePath?: string
}

export default function ChatParticipantDetailDialog({
  member,
  open,
  onOpenChange,
  contactBasePath = "/dashboard/contacts",
}: ChatParticipantDetailDialogProps) {
  const router = useRouter()
  const isMobile = useIsMobile()

  if (!member) return null

  const subtitle = getConversationMemberSubtitle(member)
  const contactHref = getConversationMemberContactHref(
    member,
    contactBasePath
  )

  function handleOpenContact() {
    if (!contactHref) return
    onOpenChange(false)
    router.push(contactHref)
  }

  if (isMobile) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="inset-0 top-0 start-0 h-[100dvh] max-w-none translate-x-0 rtl:translate-x-0 translate-y-0 gap-0 rounded-none border-0 p-0 ring-0">
          <DialogTitle className="sr-only">{member.name}</DialogTitle>
          <DialogDescription className="sr-only">
            {subtitle}
          </DialogDescription>
          <ParticipantDetailBody
            member={member}
            contactHref={contactHref}
            onOpenContact={handleOpenContact}
          />
        </DialogContent>
      </Dialog>
    )
  }

  return null
}
