"use client"

import { cn } from "@/lib/utils"
import { Avatar, AvatarBadge, AvatarFallback, AvatarGroup } from "@/components/ui/avatar"

type PreviewParticipant = {
  name: string
  initials: string
  tone: string
}

type PreviewMessage =
  | {
      kind: "system"
      content: string
    }
  | {
      kind: "user" | "actor"
      name: string
      initials: string
      tone: string
      content: string
    }

const PREVIEW_PARTICIPANTS: PreviewParticipant[] = [
  { name: "You", initials: "YU", tone: "bg-white text-slate-900" },
  { name: "Secretary", initials: "SE", tone: "bg-emerald-200 text-emerald-950" },
  { name: "Market Analyst", initials: "MA", tone: "bg-sky-200 text-sky-950" },
  { name: "Ops Lead", initials: "OL", tone: "bg-amber-200 text-amber-950" },
]

const PREVIEW_MESSAGES: PreviewMessage[] = [
  {
    kind: "user",
    name: "You",
    initials: "YU",
    tone: "bg-white text-slate-900",
    content: "Need a board-ready launch brief for tomorrow. Pull live metrics, flag blockers, and draft the announcement.",
  },
  {
    kind: "system",
    content: "Secretary routed the request to Market Analyst and Ops Lead. Two plugin calls started and shared memory was attached.",
  },
  {
    kind: "actor",
    name: "Market Analyst",
    initials: "MA",
    tone: "bg-sky-200 text-sky-950",
    content: "Latest numbers are in: signups are up 18%, paid conversion is stable, and support sentiment only dipped on mobile onboarding.",
  },
  {
    kind: "actor",
    name: "Ops Lead",
    initials: "OL",
    tone: "bg-amber-200 text-amber-950",
    content: "The only launch blocker is a mobile feature flag. I assigned the owner and locked an ETA for tonight.",
  },
  {
    kind: "actor",
    name: "Secretary",
    initials: "SE",
    tone: "bg-emerald-200 text-emerald-950",
    content: "I merged both updates with the Q2 narrative from shared memory. The brief now has a summary, citations, and next actions ready to send.",
  },
]

function PreviewAvatar({
  initials,
  tone,
  active = false,
}: {
  initials: string
  tone: string
  active?: boolean
}) {
  return (
    <Avatar className="size-8 ring-2 ring-white/[0.12]">
      <AvatarFallback className={cn("text-[11px] font-semibold", tone)}>
        {initials}
      </AvatarFallback>
      {active ? (
        <AvatarBadge className="bg-emerald-300 ring-slate-950/70" />
      ) : null}
    </Avatar>
  )
}

export function AuthConversationPreview() {
  return (
    <div className="absolute inset-0 overflow-hidden bg-[radial-gradient(circle_at_top_left,rgba(125,211,252,0.24),transparent_28%),radial-gradient(circle_at_bottom_right,rgba(45,212,191,0.18),transparent_32%),linear-gradient(160deg,#0f172a_0%,#10243b_46%,#123336_100%)]">
      <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.05)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.04)_1px,transparent_1px)] bg-[size:22px_22px] opacity-20" />
      <div className="relative h-full px-6 py-8 text-white md:px-8">
        <div className="relative z-10 max-w-xs">
          <div className="text-[11px] font-medium uppercase tracking-[0.28em] text-cyan-200/80">
            Synapse
          </div>
          <h2 className="mt-3 max-w-xs text-3xl font-semibold tracking-tight text-white">
            One chat. Real work.
          </h2>
        </div>

        <div className="absolute left-6 right-6 top-[7.75rem] md:left-8 md:right-8 md:top-[9.5rem]">
          <div className="relative mx-auto w-full max-w-lg [perspective:1800px]">
            <div className="absolute inset-x-10 bottom-0 h-16 rounded-full bg-cyan-300/20 blur-3xl" />
            <div className="relative rounded-[30px] border border-white/[0.14] bg-white/10 p-4 shadow-2xl shadow-black/35 backdrop-blur-xl [transform-style:preserve-3d] md:[transform:rotateX(15deg)_rotateY(-18deg)_rotateZ(2deg)] md:will-change-transform">
              <div className="flex items-center justify-between border-b border-white/10 pb-4">
                <div>
                  <div className="text-sm font-semibold text-white">Launch Review</div>
                  <div className="mt-1 text-[11px] text-slate-300">One conversation, multiple actors</div>
                </div>
                <AvatarGroup>
                  {PREVIEW_PARTICIPANTS.map((participant) => (
                    <PreviewAvatar
                      key={participant.name}
                      initials={participant.initials}
                      tone={participant.tone}
                    />
                  ))}
                </AvatarGroup>
              </div>

              <div className="space-y-3 pt-5">
                {PREVIEW_MESSAGES.map((message, index) => {
                  if (message.kind === "system") {
                    return (
                      <div
                        key={`system-${index}`}
                        className="px-3 text-center text-[11px] leading-5 text-slate-300"
                      >
                        {message.content}
                      </div>
                    )
                  }

                  const isUser = message.kind === "user"

                  return (
                    <div
                      key={`${message.name}-${index}`}
                      className={cn("flex gap-3", isUser && "flex-row-reverse")}
                    >
                      <div className="pt-1">
                        <PreviewAvatar initials={message.initials} tone={message.tone} active={!isUser} />
                      </div>
                      <div className={cn("max-w-[82%] space-y-1.5", isUser && "items-end text-right")}>
                        <div className={cn("text-[11px] font-medium text-white", isUser && "text-right")}>
                          {message.name}
                        </div>
                        <div
                          className={cn(
                            "rounded-[22px] border px-3.5 py-3 text-[13px] leading-5 shadow-lg shadow-black/10",
                            isUser
                              ? "rounded-tr-sm border-white/0 bg-white text-slate-900"
                              : "rounded-tl-sm border-white/10 bg-slate-950/[0.28] text-slate-50"
                          )}
                        >
                          {message.content}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
