import {
  BookOpenText,
  BrainCircuit,
  ChevronRight,
  Globe,
  LockKeyhole,
  MessageSquareMore,
  ShieldCheck,
  Wrench,
} from "lucide-react"

import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
} from "@/components/ui/avatar"
import { LandingReveal } from "@/components/landing-motion"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"

const participants = [
  { name: "Lin", tone: "bg-slate-950 text-white" },
  { name: "Mira", tone: "bg-sky-100 text-sky-900" },
  { name: "Orian", tone: "bg-amber-100 text-amber-900" },
  { name: "Sec", tone: "bg-emerald-100 text-emerald-900" },
]

const chatPreview = [
  {
    sender: "Lin · 发起人",
    avatar: "LI",
    avatarTone: "bg-slate-950 text-white",
    content: "明早董事会要一版发布摘要，把结论、指标和风险一次拉齐。",
    style:
      "ml-auto max-w-[80%] rounded-[24px] rounded-br-md bg-slate-950 px-4 py-3 text-white shadow-[0_16px_36px_-26px_rgba(15,23,42,0.95)]",
    align: "end",
  },
  {
    sender: "调度秘书",
    avatar: "SE",
    avatarTone: "bg-emerald-100 text-emerald-900",
    content: "已接单，研究、协调和审阅角色已进入同一条线程。",
    style:
      "max-w-[78%] rounded-[24px] rounded-bl-md border border-emerald-200/80 bg-emerald-50 px-4 py-3 text-slate-800",
    align: "start",
  },
  {
    sender: "Mira · 研究角色",
    avatar: "MI",
    avatarTone: "bg-sky-100 text-sky-900",
    content: "最新转化已补齐，移动端 onboarding 下滑建议在摘要里单列提示。",
    style:
      "max-w-[78%] rounded-[24px] rounded-bl-md border border-sky-200/80 bg-sky-50 px-4 py-3 text-slate-800",
    align: "start",
  },
  {
    sender: "Orian · 协调角色",
    avatar: "OR",
    avatarTone: "bg-amber-100 text-amber-900",
    content: "阻塞项已同步给 owner，预计今晚 22:30 前给出明确 ETA。",
    style:
      "max-w-[78%] rounded-[24px] rounded-bl-md border border-amber-200/80 bg-amber-50 px-4 py-3 text-slate-800",
    align: "start",
  },
]

const memorySections = [
  {
    label: "共享记忆 / 发布摘要",
    tone: "text-slate-950",
    items: [
      "董事会版本先给结论，再解释风险和下一步。",
      "Q2 叙事已经挂进该群，后续角色进来可以直接接力。",
      "移动端 onboarding 是本轮重点观察项，摘要里保留原始依据。",
    ],
  },
  {
    label: "已挂载资料",
    tone: "text-slate-600",
    items: ["Q2 叙事 v4", "发布检查表", "上轮复盘摘要"],
  },
]

const toolRows = [
  {
    icon: Globe,
    name: "联网检索",
    scope: "工作区",
    access: "已授权",
    tone: "bg-sky-500/12 text-sky-700",
  },
  {
    icon: BrainCircuit,
    name: "共享记忆",
    scope: "当前会话",
    access: "已挂载",
    tone: "bg-violet-500/12 text-violet-700",
  },
  {
    icon: Wrench,
    name: "桌面 Relay",
    scope: "设备",
    access: "待批准",
    tone: "bg-amber-500/14 text-amber-700",
  },
]

function Participant({ name, tone }: { name: string; tone: string }) {
  return (
    <Avatar className="size-9 ring-2 ring-white">
      <AvatarFallback className={tone}>
        {name.slice(0, 2).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  )
}

function ChatSurface() {
  return (
    <Card className="rounded-[32px] border border-white/75 bg-white/94 py-0 shadow-[0_42px_110px_-62px_rgba(15,23,42,0.62)]">
      <div className="border-b border-border/50 px-5 py-4 lg:px-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-950">
              <MessageSquareMore className="size-4 text-slate-500" />
              发布战情群
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              多个成员和多个角色在同一条线程里推进
            </p>
          </div>
          <div className="flex items-center gap-3">
            <AvatarGroup>
              {participants.map((participant) => (
                <Participant
                  key={participant.name}
                  name={participant.name}
                  tone={participant.tone}
                />
              ))}
              <AvatarGroupCount>+2</AvatarGroupCount>
            </AvatarGroup>
            <Badge
              variant="outline"
              className="border-border/60 bg-background/80"
            >
              6 人在线
            </Badge>
          </div>
        </div>
      </div>
      <CardContent className="flex flex-col gap-4 p-5 lg:p-6">
        {chatPreview.map((message) => (
          <div
            key={`${message.sender}-${message.content}`}
            className={`flex ${message.align === "end" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`flex max-w-full items-end gap-3 ${
                message.align === "end" ? "flex-row-reverse" : "flex-row"
              }`}
            >
              <Avatar className="size-9 shrink-0 ring-2 ring-white">
                <AvatarFallback className={message.avatarTone}>
                  {message.avatar}
                </AvatarFallback>
              </Avatar>
              <div className="max-w-full">
                <div
                  className={`mb-1 text-[11px] font-medium tracking-[0.16em] text-slate-500 uppercase ${
                    message.align === "end" ? "text-right" : "text-left"
                  }`}
                >
                  {message.sender}
                </div>
                <div className={message.style}>
                  <p className="text-sm leading-6">{message.content}</p>
                </div>
              </div>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function MemorySurface() {
  return (
    <Card className="rounded-[30px] border border-slate-200 bg-[linear-gradient(180deg,rgba(245,247,250,0.96),rgba(238,242,247,0.94))] py-0 shadow-[0_28px_70px_-52px_rgba(15,23,42,0.22)]">
      <div className="border-b border-slate-200 px-5 py-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-950">
          <BookOpenText className="size-4 text-slate-600" />
          群聊记忆
        </div>
        <p className="mt-1 text-sm text-slate-600">
          上下文沉淀成结构化记忆，而不是散落在历史消息里
        </p>
      </div>
      <CardContent className="space-y-5 p-5">
        {memorySections.map((section) => (
          <div key={section.label}>
            <div className={`text-sm font-semibold ${section.tone}`}>
              {section.label}
            </div>
            <div className="mt-3 space-y-2">
              {section.items.map((item) => (
                <div
                  key={item}
                  className="rounded-2xl border border-white/80 bg-white/85 px-3 py-3 text-sm leading-6 text-slate-700 shadow-sm"
                >
                  {item}
                </div>
              ))}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function ToolSurface() {
  return (
    <Card className="rounded-[30px] border border-slate-200 bg-[linear-gradient(180deg,rgba(245,247,250,0.96),rgba(237,241,246,0.94))] py-0 text-slate-950 shadow-[0_28px_70px_-52px_rgba(15,23,42,0.22)]">
      <div className="border-b border-slate-200 px-5 py-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-950">
          <ShieldCheck className="size-4 text-emerald-600" />
          资源授权
        </div>
        <p className="mt-1 text-sm text-slate-600">
          资源先进入工作区，再按规则交给合适的角色调用
        </p>
      </div>
      <CardContent className="space-y-4 p-5">
        {toolRows.map((tool) => (
          <div
            key={tool.name}
            className="rounded-[22px] border border-slate-200 bg-white/82 px-4 py-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="flex size-10 items-center justify-center rounded-2xl bg-slate-100 text-slate-950">
                  <tool.icon className="size-4" />
                </div>
                <div>
                  <div className="text-sm font-semibold text-slate-950">
                    {tool.name}
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                    <LockKeyhole className="size-3" />
                    {tool.scope}
                  </div>
                </div>
              </div>
              <div
                className={`rounded-2xl px-3 py-1 text-xs font-medium ${tool.tone}`}
              >
                {tool.access}
              </div>
            </div>
          </div>
        ))}

        <div className="rounded-[22px] border border-emerald-200 bg-emerald-50/78 px-4 py-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-slate-950">
                授权链路
              </div>
              <p className="mt-1 text-sm text-slate-600">
                角色请求 · Scope 校验 · 审计执行
              </p>
            </div>
            <ChevronRight className="size-4 text-emerald-600" />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

export function LandingHeroStack() {
  return (
    <div className="relative h-full">
      <div className="animate-float-slow absolute top-10 left-10 size-36 rounded-full bg-sky-300/22 blur-3xl" />
      <div className="animate-float-slow absolute top-18 right-12 size-40 rounded-full bg-emerald-200/28 blur-3xl [animation-delay:1.1s]" />

      <div className="relative mx-auto h-full max-w-6xl [perspective:2400px]">
        <div className="relative h-full min-h-[520px] sm:min-h-[620px] lg:min-h-[640px]">
          <div className="relative z-30 mx-auto max-w-4xl lg:absolute lg:top-8 lg:left-1/2 lg:mt-0 lg:w-[44%] lg:[transform:translate3d(-50%,0,90px)]">
            <LandingReveal delay={0.12} y={28} scale={0.985}>
              <ChatSurface />
            </LandingReveal>
          </div>

          <div className="relative z-20 mx-auto mt-[-30px] max-w-2xl lg:absolute lg:top-20 lg:left-[2%] lg:mt-0 lg:w-[31%] lg:[transform:rotate(-6deg)_translate3d(0,16px,10px)]">
            <LandingReveal delay={0.24} x={-24} y={22} scale={0.98}>
              <MemorySurface />
            </LandingReveal>
          </div>

          <div className="relative z-10 mx-auto mt-[-30px] max-w-2xl lg:absolute lg:top-24 lg:right-[2%] lg:mt-0 lg:w-[31%] lg:[transform:rotate(6deg)_translate3d(0,24px,0)]">
            <LandingReveal delay={0.3} x={24} y={24} scale={0.98}>
              <ToolSurface />
            </LandingReveal>
          </div>
        </div>
      </div>
    </div>
  )
}
