"use client"

import type {
  ActorRuntimeState,
  RemoteAgentRuntimeState,
} from "@synapse/shared"
import { useRouter } from "next/navigation"
import { AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar"
import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"
import { PlusIcon } from "lucide-react"
import {
  remoteAgentRuntimeToAvatarStatus,
  runtimeToAvatarStatus,
} from "@/stores/chat-store"
import type { ConversationMember } from "@/stores/chat-store"
import ChatAvatar from "./chat-avatar"
import {
  getActorRuntimePriority,
  getRemoteAgentRuntimePriority,
  getRuntimeDetail,
  getRuntimeLabel,
} from "./runtime-ui"
import ChatParticipantHoverCard from "./chat-participant-hover-card"
import { CONVERSATION_PARTICIPANT_TYPE } from "@synapse/shared"
import { useConnectorMetadata } from "@/lib/im-connector-metadata"
import {
  getConversationMemberContactHref,
  getConversationMemberSubtitle,
} from "./member-utils"

function orderMembers(
  members: ConversationMember[],
  runtimeByActor?: Record<string, ActorRuntimeState>,
  runtimeByRemoteAgent?: Record<string, RemoteAgentRuntimeState>
) {
  return [...members].sort((left, right) => {
    const leftIsAgent =
      left.participantType === CONVERSATION_PARTICIPANT_TYPE.ACTOR ||
      left.participantType === CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT
    const rightIsAgent =
      right.participantType === CONVERSATION_PARTICIPANT_TYPE.ACTOR ||
      right.participantType === CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT
    if (!leftIsAgent || !rightIsAgent) {
      if (leftIsAgent !== rightIsAgent) {
        return leftIsAgent ? -1 : 1
      }
      if (left.participantType === right.participantType) return 0
      return left.participantType.localeCompare(right.participantType)
    }

    const leftPriority =
      left.participantType === CONVERSATION_PARTICIPANT_TYPE.ACTOR
        ? getActorRuntimePriority(runtimeByActor?.[left.id])
        : getRemoteAgentRuntimePriority(runtimeByRemoteAgent?.[left.id])
    const rightPriority =
      right.participantType === CONVERSATION_PARTICIPANT_TYPE.ACTOR
        ? getActorRuntimePriority(runtimeByActor?.[right.id])
        : getRemoteAgentRuntimePriority(runtimeByRemoteAgent?.[right.id])

    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority
    }
    if (left.participantType !== right.participantType) {
      return left.participantType === CONVERSATION_PARTICIPANT_TYPE.ACTOR
        ? -1
        : 1
    }
    return left.name.localeCompare(right.name)
  })
}

interface ChatMemberStripProps {
  members: ConversationMember[]
  runtimeByActor?: Record<string, ActorRuntimeState>
  runtimeByRemoteAgent?: Record<string, RemoteAgentRuntimeState>
  max?: number
  size?: "sm" | "default" | "lg"
  className?: string
  onAdd?: () => void
  onMemberClick?: (member: ConversationMember) => void
  contactBasePath?: string
}

export default function ChatMemberStrip({
  members,
  runtimeByActor,
  runtimeByRemoteAgent,
  max = 5,
  size = "default",
  className,
  onAdd,
  onMemberClick,
  contactBasePath = "/dashboard/contacts",
}: ChatMemberStripProps) {
  const router = useRouter()
  const isMobile = useIsMobile()
  const connectorMetadata = useConnectorMetadata()
  const orderedMembers = orderMembers(
    members,
    runtimeByActor,
    runtimeByRemoteAgent
  )
  const visibleMembers = orderedMembers.slice(0, max)
  const overflowCount = Math.max(
    orderedMembers.length - visibleMembers.length,
    0
  )

  return (
    <AvatarGroup className={cn("items-center", className)}>
      {visibleMembers.map((member) => {
        const runtime =
          member.participantType === CONVERSATION_PARTICIPANT_TYPE.ACTOR
            ? runtimeByActor?.[member.id]
            : member.participantType ===
                CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT
              ? runtimeByRemoteAgent?.[member.id]
              : undefined
        const href = getConversationMemberContactHref(member, contactBasePath)
        const subtitle = getConversationMemberSubtitle(
          member,
          connectorMetadata
        )
        const canOpen = Boolean(onMemberClick || href)
        const avatar = (
          <ChatAvatar
            name={member.name}
            avatarUrl={member.avatarUrl}
            emoji={member.emoji}
            entityType={member.participantType}
            size={size}
            statusState={
              member.participantType ===
              CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT
                ? remoteAgentRuntimeToAvatarStatus(
                    runtime as RemoteAgentRuntimeState | undefined
                  )
                : runtimeToAvatarStatus(
                    runtime as ActorRuntimeState | undefined
                  )
            }
            statusLabel={getRuntimeLabel(runtime)}
            statusDetail={getRuntimeDetail(runtime)}
          />
        )
        const desktopTrigger = (
          <span
            className="block rounded-full transition-opacity hover:opacity-90 focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none"
            tabIndex={0}
            aria-label={`View ${member.name}`}
          >
            {avatar}
          </span>
        )
        return !isMobile ? (
          <ChatParticipantHoverCard
            key={`${member.participantType}-${member.id}`}
            member={member}
            contactBasePath={contactBasePath}
          >
            {desktopTrigger}
          </ChatParticipantHoverCard>
        ) : canOpen ? (
          <button
            key={`${member.participantType}-${member.id}`}
            type="button"
            onClick={() => {
              if (onMemberClick) {
                onMemberClick(member)
                return
              }
              if (href) {
                router.push(href)
              }
            }}
            className="rounded-full transition-opacity hover:opacity-90"
            aria-label={`Open ${member.name}`}
            title={`${member.name} · ${subtitle}`}
          >
            {avatar}
          </button>
        ) : (
          <div
            key={`${member.participantType}-${member.id}`}
            title={`${member.name} · ${subtitle}`}
          >
            {avatar}
          </div>
        )
      })}
      {onAdd ? (
        <AvatarGroupCount
          role="button"
          tabIndex={0}
          onClick={onAdd}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault()
              onAdd()
            }
          }}
          className="cursor-pointer"
          aria-label="Add members"
        >
          <PlusIcon />
        </AvatarGroupCount>
      ) : overflowCount > 0 ? (
        <AvatarGroupCount>+{overflowCount}</AvatarGroupCount>
      ) : null}
    </AvatarGroup>
  )
}
