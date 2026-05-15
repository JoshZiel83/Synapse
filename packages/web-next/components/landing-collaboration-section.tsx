import { BrainCircuit, MessageSquareMore, UsersRound } from "lucide-react"

import { cn } from "@/lib/utils"
import {
  Avatar,
  AvatarBadge,
  AvatarFallback,
  AvatarGroup,
} from "@/components/ui/avatar"
import {
  LandingReveal,
  LandingStagger,
  LandingStaggerItem,
} from "@/components/landing-motion"
import { Card, CardContent } from "@/components/ui/card"

const collaborationFeatures = [
  {
    icon: MessageSquareMore,
    title: "同群协作",
    description: "人和 Agent 在同一条线程里一起推进事情",
  },
  {
    icon: BrainCircuit,
    title: "共享记忆",
    description: "交付结果写回记忆，后续角色进来就能接着做",
  },
  {
    icon: UsersRound,
    title: "过程可见",
    description: "谁被拉入、谁更新了什么，系统消息都看得清楚",
  },
] as const

const collaborationParticipants = [
  { name: "Celine", initials: "CE", tone: "bg-slate-950 text-white" },
  { name: "Brief Writer", initials: "BW", tone: "bg-sky-100 text-sky-950" },
  { name: "Risk Analyst", initials: "RA", tone: "bg-amber-100 text-amber-950" },
] as const

type CollaborationMessage =
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
      meta?: string
    }

const collaborationMessages: CollaborationMessage[] = [
  {
    kind: "system",
    content: "Celine 将 Brief Writer 拉入了群聊",
  },
  {
    kind: "user",
    name: "Celine",
    initials: "CE",
    tone: "bg-slate-950 text-white",
    content: "先起一版董事会发布摘要，把结论和 blocker 一起写进共享记忆。",
  },
  {
    kind: "actor",
    name: "Brief Writer",
    initials: "BW",
    tone: "bg-sky-100 text-sky-950",
    content:
      "初稿已提交，核心结论和当前 blocker 已写回共享记忆，后续角色可以直接接着补。",
    meta: "已交付 · 共享记忆已更新",
  },
  {
    kind: "system",
    content: "Brief Writer 更新了共享记忆",
  },
  {
    kind: "system",
    content: "Celine 将 Risk Analyst 拉入了群聊",
  },
  {
    kind: "user",
    name: "Celine",
    initials: "CE",
    tone: "bg-slate-950 text-white",
    content: "@Risk Analyst 基于当前共享记忆补一段风险判断。",
  },
  {
    kind: "actor",
    name: "Risk Analyst",
    initials: "RA",
    tone: "bg-amber-100 text-amber-950",
    content:
      "我已读取共享记忆：当前主要风险是移动 onboarding 回落，建议单列风险栏并保留 ETA 备注。",
  },
]

function DemoAvatar({
  initials,
  tone,
  active = false,
}: {
  initials: string
  tone: string
  active?: boolean
}) {
  return (
    <Avatar className="size-8 ring-2 ring-white">
      <AvatarFallback className={cn("text-[11px] font-semibold", tone)}>
        {initials}
      </AvatarFallback>
      {active ? <AvatarBadge className="bg-emerald-400 ring-white" /> : null}
    </Avatar>
  )
}

export function LandingCollaborationSection() {
  return (
    <section
      id="difference"
      data-landing-snap-section="true"
      className="landing-snap-section relative border-y border-border/50 bg-white/68 py-18 backdrop-blur-sm"
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.14),transparent_30%),radial-gradient(circle_at_bottom_right,rgba(45,212,191,0.12),transparent_34%)]" />

      <div className="relative mx-auto max-w-7xl px-6 lg:px-8">
        <div className="grid gap-12 lg:grid-cols-[0.88fr_1.12fr] lg:items-center lg:gap-14">
          <LandingReveal className="max-w-xl" x={-24}>
            <h2 className="font-display text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
              同一条群聊，就是同一个协作现场
            </h2>
            <p className="mt-4 text-base leading-7 text-slate-600 sm:text-lg">
              拉人、分工、交付、沉淀记忆都发生在同一处，不用在多个 Bot
              和文档之间来回切换
            </p>

            <LandingStagger className="mt-7 space-y-4" delay={0.08}>
              {collaborationFeatures.map((feature) => (
                <LandingStaggerItem key={feature.title} className="flex gap-4">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-slate-950 text-white shadow-lg shadow-slate-950/10">
                    <feature.icon className="size-[18px]" />
                  </div>
                  <div>
                    <div className="text-[15px] font-semibold text-slate-950">
                      {feature.title}
                    </div>
                    <p className="mt-1.5 text-sm leading-6 text-slate-600">
                      {feature.description}
                    </p>
                  </div>
                </LandingStaggerItem>
              ))}
            </LandingStagger>
          </LandingReveal>

          <LandingReveal
            className="relative"
            delay={0.08}
            x={28}
            y={26}
            scale={0.985}
          >
            <div className="absolute top-10 -left-10 size-36 rounded-full bg-sky-200/38 blur-3xl" />
            <div className="absolute -right-4 bottom-8 size-36 rounded-full bg-emerald-200/36 blur-3xl" />

            <Card className="relative gap-0 rounded-[34px] border border-white/72 bg-white/92 py-0 shadow-[0_40px_110px_-58px_rgba(15,23,42,0.48)]">
              <div className="border-b border-border/50 px-5 pt-4 pb-3 lg:px-6">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-semibold text-slate-950">
                      董事会发布摘要
                    </div>
                    <div className="mt-1 text-[11px] text-slate-500">
                      系统消息可见，共享记忆负责承接上下文
                    </div>
                  </div>
                  <AvatarGroup>
                    {collaborationParticipants.map((participant) => (
                      <DemoAvatar
                        key={participant.name}
                        initials={participant.initials}
                        tone={participant.tone}
                      />
                    ))}
                  </AvatarGroup>
                </div>
              </div>

              <CardContent className="px-5 pt-3 pb-5 lg:px-6 lg:pt-3 lg:pb-6">
                <LandingStagger
                  className="space-y-3.5"
                  delay={0.16}
                  stagger={0.08}
                >
                  {collaborationMessages.map((message, index) => {
                    if (message.kind === "system") {
                      return (
                        <LandingStaggerItem
                          key={`system-${index}`}
                          className="px-3 text-center text-[11px] leading-5 text-slate-400"
                        >
                          {message.content}
                        </LandingStaggerItem>
                      )
                    }

                    const isUser = message.kind === "user"

                    return (
                      <LandingStaggerItem
                        key={`${message.name}-${index}`}
                        className={cn(
                          "flex gap-3",
                          isUser && "flex-row-reverse"
                        )}
                      >
                        <div className="pt-1">
                          <DemoAvatar
                            initials={message.initials}
                            tone={message.tone}
                            active={!isUser}
                          />
                        </div>

                        <div
                          className={cn(
                            "max-w-[84%] space-y-1.5",
                            isUser && "text-right"
                          )}
                        >
                          <div className="text-[11px] font-medium text-slate-500">
                            {message.name}
                          </div>
                          <div
                            className={cn(
                              "rounded-[22px] border px-3.5 py-3 text-[13px] leading-6 shadow-[0_16px_30px_-24px_rgba(15,23,42,0.32)]",
                              isUser
                                ? "rounded-tr-sm border-slate-950/0 bg-slate-950 text-white"
                                : "rounded-tl-sm border-slate-200 bg-slate-50 text-slate-800"
                            )}
                          >
                            {message.content}
                          </div>

                          {message.meta ? (
                            <div
                              className={cn(
                                "inline-flex rounded-full border px-2.5 py-1 text-[11px] leading-none",
                                isUser
                                  ? "border-slate-300 bg-white text-slate-500"
                                  : "border-emerald-200 bg-emerald-50 text-emerald-700"
                              )}
                            >
                              {message.meta}
                            </div>
                          ) : null}
                        </div>
                      </LandingStaggerItem>
                    )
                  })}
                </LandingStagger>
              </CardContent>
            </Card>
          </LandingReveal>
        </div>
      </div>
    </section>
  )
}
