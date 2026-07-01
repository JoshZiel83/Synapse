"use client"

import { CONVERSATION_PARTICIPANT_TYPE } from "@synapse/shared"
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
import { useConnectorMetadata } from "@/lib/im-connector-metadata"
import type {
  ActorAvatarStatus,
  ConversationMember,
  RemoteAgentAvatarStatus,
} from "@/stores/chat-store"
import ChatAvatar from "./chat-avatar"
import {
  formatTransportKindLabel,
  getConversationMemberContactHref,
  getConversationMemberSubtitle,
  getConversationMemberTypeLabel,
  type ConnectorMetadataMap,
} from "./member-utils"
import TransportKindIcon from "./transport-kind-icon"

function CompactDetail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
      <span className="shrink-0 font-medium text-foreground/80">{label}</span>
      <span className="min-w-0 truncate">{value}</span>
    </div>
  )
}

function getCompactNote(
  member: ConversationMember,
  metadata?: ConnectorMetadataMap
) {
  if (member.participantType === CONVERSATION_PARTICIPANT_TYPE.ACTOR) {
    return member.title || member.role || "Actor"
  }
  if (member.participantType === CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT) {
    return member.title || member.role || "Remote agent"
  }
  if (member.participantType === CONVERSATION_PARTICIPANT_TYPE.EXTERNAL) {
    if (member.linkedWorkspaceMemberName) {
      return `Linked to ${member.linkedWorkspaceMemberName}`
    }
    if (member.externalUserKey) {
      return member.externalUserKey
    }
    return "No workspace link"
  }
  if (member.transportKind) {
    return `Reachable via ${formatTransportKindLabel(
      member.transportKind,
      metadata
    )}`
  }
  return "Workspace user"
}

interface ChatParticipantHoverCardProps {
  member?: ConversationMember | null
  children: ReactNode
  contactBasePath?: string
  side?: ComponentProps<typeof HoverCardContent>["side"]
  align?: ComponentProps<typeof HoverCardContent>["align"]
  // Presence, folded in from the avatar's old status tooltip so there is one
  // merged card instead of two overlapping popups.
  statusState?: ActorAvatarStatus | RemoteAgentAvatarStatus
  statusLabel?: string
  statusDetail?: string
}

export default function ChatParticipantHoverCard({
  member,
  children,
  contactBasePath = "/dashboard/contacts",
  side = "top",
  align = "center",
  statusState,
  statusLabel,
  statusDetail,
}: ChatParticipantHoverCardProps) {
  const router = useRouter()
  const isMobile = useIsMobile()
  const metadata = useConnectorMetadata()

  if (!member || isMobile) {
    return <>{children}</>
  }

  const subtitle = getConversationMemberSubtitle(member, metadata)
  const typeLabel = getConversationMemberTypeLabel(member)
  const transportLabel = formatTransportKindLabel(
    member.transportKind,
    metadata
  )
  const contactHref = getConversationMemberContactHref(member, contactBasePath)
  const compactNote = getCompactNote(member, metadata)

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
                entityType={member.participantType}
                statusState={statusState}
                suppressStatusTooltip
                size="lg"
                className="size-12"
              />
              <TransportKindIcon
                kind={member.transportKind}
                size={12}
                className="absolute -right-1 -bottom-1 size-4 p-px"
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
              {statusLabel || statusDetail ? (
                <p className="mt-1 text-xs text-foreground/80">
                  {statusLabel}
                  {statusLabel && statusDetail ? (
                    <span className="text-muted-foreground">
                      {" · "}
                      {statusDetail}
                    </span>
                  ) : (
                    statusDetail
                  )}
                </p>
              ) : null}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {transportLabel ? (
                  <Badge variant="secondary" className="rounded-full">
                    {transportLabel}
                  </Badge>
                ) : null}
                {member.participantType ===
                  CONVERSATION_PARTICIPANT_TYPE.EXTERNAL &&
                member.linkedWorkspaceMemberName ? (
                  <Badge variant="secondary" className="rounded-full">
                    <Link2 data-icon="inline-start" />
                    {member.linkedWorkspaceMemberName}
                  </Badge>
                ) : null}
              </div>
            </div>
          </div>

          <div className="space-y-1.5 rounded-lg bg-muted/40 px-3 py-2.5">
            <CompactDetail label="Info" value={compactNote} />
            {member.participantType ===
              CONVERSATION_PARTICIPANT_TYPE.EXTERNAL &&
            member.externalUserKey ? (
              <div className="truncate font-mono text-[11px] text-muted-foreground">
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
