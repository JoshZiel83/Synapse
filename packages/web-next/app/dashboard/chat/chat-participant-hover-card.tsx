"use client"

import type { ComponentProps, ReactNode } from "react"
import { useRouter } from "next/navigation"
import { ArrowUpRight, Link2 } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card"
import { useIsMobile } from "@/hooks/use-mobile"
import type { ConversationMember } from "@/stores/chat-store"
import ChatAvatar from "./chat-avatar"
import {
  formatTransportKindLabel,
  getConversationMemberContactHref,
  getConversationMemberSubtitle,
  getConversationMemberTypeLabel,
} from "./member-utils"
import TransportKindIcon from "./transport-kind-icon"

function CompactDetail({
  label,
  value,
}: {
  label: string
  value: string
}) {
  return (
    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
      <span className="shrink-0 font-medium text-foreground/80">{label}</span>
      <span className="min-w-0 truncate">{value}</span>
    </div>
  )
}

function getCompactNote(member: ConversationMember) {
  if (member.type === "actor") {
    return member.title || member.role || "Actor"
  }
  if (member.type === "external") {
    if (member.linkedUserName) {
      return `Linked to ${member.linkedUserName}`
    }
    if (member.externalUserKey) {
      return member.externalUserKey
    }
    return "No workspace link"
  }
  if (member.transportKind) {
    return `Reachable via ${formatTransportKindLabel(member.transportKind)}`
  }
  return "Workspace user"
}

interface ChatParticipantHoverCardProps {
  member?: ConversationMember | null
  children: ReactNode
  contactBasePath?: string
  side?: ComponentProps<typeof HoverCardContent>["side"]
  align?: ComponentProps<typeof HoverCardContent>["align"]
}

export default function ChatParticipantHoverCard({
  member,
  children,
  contactBasePath = "/dashboard/contacts",
  side = "top",
  align = "center",
}: ChatParticipantHoverCardProps) {
  const router = useRouter()
  const isMobile = useIsMobile()

  if (!member || isMobile) {
    return <>{children}</>
  }

  const subtitle = getConversationMemberSubtitle(member)
  const typeLabel = getConversationMemberTypeLabel(member)
  const transportLabel = formatTransportKindLabel(member.transportKind)
  const contactHref = getConversationMemberContactHref(
    member,
    contactBasePath
  )
  const compactNote = getCompactNote(member)

  return (
    <HoverCard>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent side={side} align={align} className="w-80">
        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-3">
            <div className="relative shrink-0">
              <ChatAvatar
                name={member.name}
                avatarUrl={member.avatarUrl}
                emoji={member.emoji}
                entityType={member.type}
                size="lg"
                className="size-12"
              />
              <TransportKindIcon
                kind={member.transportKind}
                size={12}
                className="absolute -bottom-1 -right-1 size-4 p-px"
              />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <div className="truncate text-sm font-medium text-foreground">
                  {member.name}
                </div>
                <Badge variant="outline" className="rounded-full">
                  {typeLabel}
                </Badge>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {subtitle}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {transportLabel ? (
                  <Badge variant="secondary" className="rounded-full">
                    {transportLabel}
                  </Badge>
                ) : null}
                {member.type === "external" && member.linkedUserName ? (
                  <Badge variant="secondary" className="rounded-full">
                    <Link2 data-icon="inline-start" />
                    {member.linkedUserName}
                  </Badge>
                ) : null}
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-border/70 bg-muted/20 p-3">
            <CompactDetail label="Info" value={compactNote} />
            {member.type === "external" && member.externalUserKey ? (
              <div className="mt-2 rounded-xl bg-background px-2.5 py-2 font-mono text-[11px] text-muted-foreground ring-1 ring-border/70">
                {member.externalUserKey}
              </div>
            ) : null}
          </div>

          {contactHref ? (
            <div className="flex justify-end">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="rounded-full"
                onClick={() => router.push(contactHref)}
              >
                Open in contacts
                <ArrowUpRight data-icon="inline-end" />
              </Button>
            </div>
          ) : null}
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}
