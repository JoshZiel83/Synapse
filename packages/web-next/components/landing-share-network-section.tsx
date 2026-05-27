import {
  ArrowRightLeft,
  LaptopMinimal,
  ShieldCheck,
  SquareTerminal,
} from "lucide-react"

import { cn } from "@/lib/utils"
import {
  LandingReveal,
  LandingStagger,
  LandingStaggerItem,
} from "@/components/landing-motion"
import {
  Avatar,
  AvatarBadge,
  AvatarFallback,
  AvatarGroup,
} from "@/components/ui/avatar"
import { Card, CardContent } from "@/components/ui/card"

const shareHighlights = [
  {
    icon: ArrowRightLeft,
    title: "像联系人一样引入",
    description:
      "用户、Actor、Remote Agent 都能跨工作区建立关系，再被带进当前团队。",
  },
  {
    icon: ShieldCheck,
    title: "共享后继续工作",
    description:
      "共享来的用户和 Actor 不只聊天，拿到授权后还能继续接住文档、数据和流程。",
  },
  {
    icon: SquareTerminal,
    title: "Remote Agent 保留外部栈",
    description:
      "Remote Agent 通过桥接进入同一条群聊，但继续保留自己的运行时和工具链。",
  },
] as const

const shareParticipants = [
  { name: "Ava", initials: "AV", tone: "bg-slate-950 text-white" },
  { name: "Scout", initials: "SC", tone: "bg-sky-100 text-sky-950" },
  { name: "Code", initials: "CD", tone: "bg-amber-100 text-amber-950" },
] as const

type ShareConversationMessage =
  | {
      kind: "system"
      content: string
    }
  | {
      kind: "user" | "actor" | "remote"
      name: string
      initials: string
      tone: string
      content: string
      meta?: string
    }
  | {
      kind: "request"
      title: string
      content: string
      items: readonly string[]
      status: string
    }

const shareConversationMessages: ShareConversationMessage[] = [
  {
    kind: "system",
    content: "Scout（共享 Actor）加入了群聊",
  },
  {
    kind: "system",
    content: "Code Runner（Remote Agent）通过桥接接入",
  },
  {
    kind: "user",
    name: "Ava",
    initials: "AV",
    tone: "bg-slate-950 text-white",
    content: "帮我把官网首页文案收尾，再顺手检查一遍桌面端提交流程。",
  },
  {
    kind: "actor",
    name: "Scout · 共享 Actor",
    initials: "SC",
    tone: "bg-sky-100 text-sky-950",
    content:
      "文案我先改。如果还要继续替你检查提交流程，我需要申请使用你已接入的桌面浏览器。",
    meta: "可发起当前会话授权申请",
  },
  {
    kind: "request",
    title: "桌面浏览器访问申请",
    content:
      "共享 Actor 想继续操作你已接入的桌面浏览器，检查提交流程是否正常。",
    items: ["申请方：Scout", "范围：当前会话", "资源：桌面设备 / 浏览器"],
    status: "待你授权",
  },
  {
    kind: "system",
    content: "Ava 已批准本次申请，仅当前会话生效",
  },
  {
    kind: "remote",
    name: "Code Runner · Remote Agent",
    initials: "CD",
    tone: "bg-amber-100 text-amber-950",
    content:
      "我会在自己的外部 runtime 里同步改官网首页文案，完成后直接把 diff 发回群里。",
    meta: "外部运行时持续在线",
  },
] as const

function ShareAvatar({
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

export function LandingShareNetworkSection() {
  return (
    <section
      id="sharing"
      data-landing-snap-section="true"
      className="landing-snap-section relative border-y border-border/50 bg-[linear-gradient(180deg,rgba(248,251,255,0.9),rgba(255,255,255,0.98))] py-18"
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.14),transparent_30%),radial-gradient(circle_at_bottom_right,rgba(45,212,191,0.12),transparent_34%)]" />

      <div className="relative mx-auto max-w-7xl px-6 lg:px-8">
        <div className="grid gap-12 lg:grid-cols-[0.84fr_1.16fr] lg:items-center lg:gap-14">
          <LandingReveal className="max-w-xl" x={-24}>
            <h2 className="font-display text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
              像加同事一样，把 Agent 接进来
            </h2>
            <p className="mt-4 text-base leading-7 text-slate-600 sm:text-lg">
              共享来的 Agent 能在会话里申请授权，Remote Agent
              也能带着自己的运行时一起协作。
            </p>

            <LandingStagger className="mt-8 space-y-4" delay={0.08}>
              {shareHighlights.map((item) => (
                <LandingStaggerItem key={item.title} className="flex gap-4">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-slate-950 text-white shadow-lg shadow-slate-950/10">
                    <item.icon className="size-[18px]" />
                  </div>
                  <div>
                    <div className="text-[15px] font-semibold text-slate-950">
                      {item.title}
                    </div>
                    <p className="mt-1.5 text-sm leading-6 text-slate-600">
                      {item.description}
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
            y={24}
            scale={0.985}
          >
            <div className="absolute top-10 -left-8 size-36 rounded-full bg-sky-200/34 blur-3xl" />
            <div className="absolute -right-4 bottom-8 size-40 rounded-full bg-emerald-200/28 blur-3xl" />

            <Card className="relative gap-0 rounded-[34px] border border-white/72 bg-white/92 py-0 shadow-[0_40px_110px_-58px_rgba(15,23,42,0.48)]">
              <div className="border-b border-border/50 px-5 pt-4 pb-3 lg:px-6">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-semibold text-slate-950">
                      官网首页迭代群
                    </div>
                    <div className="mt-1 text-[11px] text-slate-500">
                      共享 Actor 申请桌面授权，Remote Agent 同群协作
                    </div>
                  </div>
                  <AvatarGroup>
                    {shareParticipants.map((participant) => (
                      <ShareAvatar
                        key={participant.name}
                        initials={participant.initials}
                        tone={participant.tone}
                        active={participant.name !== "Ava"}
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
                  {shareConversationMessages.map((message, index) => {
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

                    if (message.kind === "request") {
                      return (
                        <LandingStaggerItem key={`${message.title}-${index}`}>
                          <div className="mx-auto max-w-[92%] rounded-[24px] border border-emerald-200 bg-[linear-gradient(180deg,rgba(236,253,245,0.95),rgba(255,255,255,0.92))] p-4 shadow-[0_18px_34px_-28px_rgba(16,185,129,0.28)]">
                            <div className="flex items-start justify-between gap-3">
                              <div className="flex items-center gap-2 text-sm font-semibold text-slate-950">
                                <LaptopMinimal className="size-4 text-emerald-700" />
                                {message.title}
                              </div>
                              <div className="rounded-full border border-emerald-200 bg-white px-2.5 py-1 text-[11px] leading-none text-emerald-700">
                                {message.status}
                              </div>
                            </div>
                            <p className="mt-2 text-[13px] leading-6 text-slate-700">
                              {message.content}
                            </p>
                            <div className="mt-3 flex flex-wrap gap-2">
                              {message.items.map((item) => (
                                <span
                                  key={item}
                                  className="rounded-full border border-emerald-200/80 bg-white px-3 py-1 text-[11px] leading-none text-slate-600"
                                >
                                  {item}
                                </span>
                              ))}
                            </div>
                          </div>
                        </LandingStaggerItem>
                      )
                    }

                    const isUser = message.kind === "user"
                    const isRemote = message.kind === "remote"

                    return (
                      <LandingStaggerItem
                        key={`${message.name}-${index}`}
                        className={cn(
                          "flex gap-3",
                          isUser && "flex-row-reverse"
                        )}
                      >
                        <div className="pt-1">
                          <ShareAvatar
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
                                : isRemote
                                  ? "rounded-tl-sm border-amber-200 bg-amber-50 text-slate-800"
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
                                  : isRemote
                                    ? "border-amber-200 bg-amber-50 text-amber-700"
                                    : "border-sky-200 bg-sky-50 text-sky-700"
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
