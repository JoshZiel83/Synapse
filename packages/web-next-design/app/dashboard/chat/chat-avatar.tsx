"use client"

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  Avatar,
  AvatarBadge,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar"
import { resolveFileUrl } from "@/lib/utils"
import { getTwemojiUrl } from "@/lib/twemoji"
import { cn } from "@/lib/utils"
import type {
  ActorAvatarStatus,
  RemoteAgentAvatarStatus,
  ThinkingPhase,
} from "@/stores/chat-store"

const ACTOR_STATUS_DOT_CLASS: Record<ActorAvatarStatus, string> = {
  idle: "bg-muted-foreground/50",
  thinking: "bg-sky-500",
  tool: "bg-amber-500",
  responding: "bg-emerald-500",
  error: "bg-destructive",
}

const REMOTE_AGENT_STATUS_DOT_CLASS: Record<RemoteAgentAvatarStatus, string> = {
  offline: "bg-muted-foreground/40",
  idle: "bg-muted-foreground/60",
  running: "bg-emerald-500",
  waiting_user_input: "bg-amber-500",
  plan_drafting: "bg-sky-500",
  waiting_plan_approval: "bg-orange-500",
  error: "bg-destructive",
}

function getInitial(name: string | undefined) {
  const value = name?.trim()
  return value ? value.charAt(0).toUpperCase() : "?"
}

interface ChatAvatarProps {
  name?: string
  avatarUrl?: string
  emoji?: string
  entityType?:
    | "conversation"
    | "workspace_member"
    | "actor"
    | "remote_agent"
    | "external"
  size?: "sm" | "default" | "lg"
  statusState?: ActorAvatarStatus | RemoteAgentAvatarStatus
  statusPhase?: ThinkingPhase
  statusLabel?: string
  statusDetail?: string
  // When the avatar already lives inside a richer popover (the participant
  // hover card), suppress its own status tooltip so hovering shows ONE card,
  // not two overlapping ones. The status dot on the avatar stays.
  suppressStatusTooltip?: boolean
  className?: string
}

export default function ChatAvatar({
  name,
  avatarUrl,
  emoji,
  entityType = "actor",
  size = "default",
  statusState,
  statusPhase,
  statusLabel,
  statusDetail,
  suppressStatusTooltip,
  className,
}: ChatAvatarProps) {
  const resolvedAvatarUrl = resolveFileUrl(avatarUrl)
  const emojiUrl =
    !resolvedAvatarUrl &&
    (entityType === "actor" || entityType === "remote_agent")
      ? getTwemojiUrl(emoji)
      : null
  const badgeState = statusState || statusPhase
  const badgeClass =
    badgeState && entityType === "remote_agent"
      ? REMOTE_AGENT_STATUS_DOT_CLASS[badgeState as RemoteAgentAvatarStatus]
      : badgeState
        ? ACTOR_STATUS_DOT_CLASS[badgeState as ActorAvatarStatus]
        : null
  const avatar = (
    <Avatar size={size} className={cn(className)}>
      {resolvedAvatarUrl ? (
        <AvatarImage src={resolvedAvatarUrl} alt={name || entityType} />
      ) : emojiUrl ? (
        <AvatarImage
          src={emojiUrl}
          alt={name || entityType}
          className="bg-muted p-1"
        />
      ) : null}
      <AvatarFallback>{getInitial(name)}</AvatarFallback>
      {(entityType === "actor" || entityType === "remote_agent") &&
      badgeState &&
      badgeClass ? (
        <AvatarBadge
          className={cn("shadow-sm ring-2 ring-background", badgeClass)}
        />
      ) : null}
    </Avatar>
  )

  if (
    suppressStatusTooltip ||
    (entityType !== "actor" && entityType !== "remote_agent") ||
    !badgeState ||
    (!statusLabel && !statusDetail && !name)
  ) {
    return avatar
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{avatar}</TooltipTrigger>
      <TooltipContent
        side="top"
        className="flex max-w-60 flex-col items-start gap-0.5"
      >
        <span className="font-medium">{name || "Actor"}</span>
        {statusLabel ? <span>{statusLabel}</span> : null}
        {statusDetail ? (
          <span className="text-background/80">{statusDetail}</span>
        ) : null}
      </TooltipContent>
    </Tooltip>
  )
}
