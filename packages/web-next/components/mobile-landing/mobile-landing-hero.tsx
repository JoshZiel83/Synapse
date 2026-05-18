"use client"

import { useCallback, useEffect, useState } from "react"
import useEmblaCarousel from "embla-carousel-react"
import { m } from "framer-motion"
import Link from "next/link"
import {
  BookOpenText,
  ChevronRight,
  Database,
  Globe,
  LockKeyhole,
  ShieldCheck,
  Sparkles,
  Wrench,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { LandingHeroHeadline } from "@/components/landing-hero-headline"

const ease: [number, number, number, number] = [0.22, 1, 0.36, 1]

const chatMessages = [
  {
    role: "user",
    name: "Celine",
    initials: "CE",
    tone: "bg-slate-950 text-white",
    text: "把董事会摘要的结论和 blocker 写进共享记忆。",
  },
  {
    role: "actor",
    name: "Brief Writer",
    initials: "BW",
    tone: "bg-sky-100 text-sky-950",
    text: "初稿已交付，结论和 blocker 已写回共享记忆。",
    meta: "已交付 · 共享记忆已更新",
  },
  {
    role: "actor",
    name: "Risk Analyst",
    initials: "RA",
    tone: "bg-amber-100 text-amber-950",
    text: "读取共享记忆后，建议单列移动端 onboarding 风险。",
  },
] as const

const memoryItems = [
  "董事会版本先给结论，再解释风险和下一步",
  "Q2 叙事已挂进群，后续角色可直接接力",
  "移动端 onboarding 是本轮重点观察项",
] as const

const memoryTags = ["Q2 叙事 v4", "发布检查表", "上轮复盘摘要"] as const

const toolRows = [
  {
    icon: Globe,
    name: "联网检索",
    scope: "工作区",
    status: "已授权",
    statusTone: "bg-sky-500/12 text-sky-700",
  },
  {
    icon: Database,
    name: "共享记忆",
    scope: "当前会话",
    status: "已挂载",
    statusTone: "bg-violet-500/12 text-violet-700",
  },
  {
    icon: Wrench,
    name: "桌面 Relay",
    scope: "设备",
    status: "待批准",
    statusTone: "bg-amber-500/14 text-amber-700",
  },
] as const

const heroSlides = [
  { id: "chat", title: "群聊", node: <ChatSlide /> },
  { id: "memory", title: "记忆", node: <MemorySlide /> },
  { id: "tools", title: "授权", node: <ToolsSlide /> },
] as const

export function MobileLandingHero() {
  const [emblaRef, emblaApi] = useEmblaCarousel({
    loop: true,
    align: "center",
    containScroll: "trimSnaps",
  })
  const [selected, setSelected] = useState(0)

  useEffect(() => {
    if (!emblaApi) return
    const onSelect = () => setSelected(emblaApi.selectedScrollSnap())
    onSelect()
    emblaApi.on("select", onSelect)
    emblaApi.on("reInit", onSelect)
    return () => {
      emblaApi.off("select", onSelect)
      emblaApi.off("reInit", onSelect)
    }
  }, [emblaApi])

  useEffect(() => {
    if (!emblaApi) return
    let userActive = false
    const onPointer = () => {
      userActive = true
    }
    const onSettle = () => {
      window.setTimeout(() => {
        userActive = false
      }, 1800)
    }
    emblaApi.on("pointerDown", onPointer)
    emblaApi.on("settle", onSettle)
    const id = window.setInterval(() => {
      if (document.hidden) return
      if (userActive) return
      emblaApi.scrollNext()
    }, 5200)
    return () => {
      emblaApi.off("pointerDown", onPointer)
      emblaApi.off("settle", onSettle)
      window.clearInterval(id)
    }
  }, [emblaApi])

  const scrollTo = useCallback(
    (index: number) => emblaApi?.scrollTo(index),
    [emblaApi]
  )

  return (
    <section className="relative px-5 pt-[calc(env(safe-area-inset-top)+5.25rem)] pr-8 pb-12">
      <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[28rem] bg-[radial-gradient(120%_85%_at_50%_0%,rgba(56,189,248,0.22),transparent_60%),radial-gradient(120%_60%_at_20%_28%,rgba(45,212,191,0.18),transparent_55%)]" />

      <div className="mx-auto max-w-md text-center">
        <m.div
          initial={{ opacity: 0, y: 16, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.6, ease }}
          className="inline-flex items-center gap-1.5 rounded-full border border-white/72 bg-white/72 px-3 py-1 text-[11px] font-medium text-slate-600 shadow-[0_8px_18px_-10px_rgba(15,23,42,0.18)] backdrop-blur"
        >
          <Sparkles className="size-3.5 text-primary" />
          AI 协作运行时
        </m.div>

        <div className="mt-4 [&>div]:!mt-0 [&>div]:!text-[clamp(1.25rem,6.8vw,2.4rem)]">
          <LandingHeroHeadline />
        </div>

        <m.p
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, delay: 0.18, ease }}
          className="mx-auto mt-4 max-w-[22rem] text-[14.5px] leading-7 text-slate-600"
        >
          不是再多一个聊天框，把角色、群聊、记忆、授权和执行装进同一个组织运行时
        </m.p>

        <m.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, delay: 0.28, ease }}
          className="mt-6 flex flex-col items-stretch gap-2"
        >
          <Link
            href="/register"
            className="rounded-full bg-slate-950 px-5 py-3.5 text-[15px] font-semibold text-white shadow-[0_18px_32px_-16px_rgba(15,23,42,0.55)] transition-transform active:scale-[0.98]"
          >
            创建团队
          </Link>
          <Link
            href="#trust"
            className="rounded-full border border-slate-200/90 bg-white/85 px-5 py-3.5 text-[15px] font-semibold text-slate-800 backdrop-blur transition-colors active:bg-white"
          >
            了解私有部署
          </Link>
        </m.div>
      </div>

      <div className="relative mx-auto mt-10 max-w-[22rem]">
        <m.div
          aria-hidden="true"
          className="absolute -top-6 -left-4 size-28 rounded-full bg-sky-300/35 blur-3xl"
          animate={{ x: [0, 8, 0], y: [0, -6, 0] }}
          transition={{ duration: 7, repeat: Infinity, ease: "easeInOut" }}
        />
        <m.div
          aria-hidden="true"
          className="absolute -right-6 bottom-12 size-32 rounded-full bg-emerald-300/30 blur-3xl"
          animate={{ x: [0, -6, 0], y: [0, 8, 0] }}
          transition={{ duration: 8, repeat: Infinity, ease: "easeInOut" }}
        />

        <div className="relative -mx-4">
          <div className="overflow-x-clip py-2" ref={emblaRef}>
            <div className="flex">
              {heroSlides.map((slide, idx) => (
                <div
                  key={slide.id}
                  className="min-w-0 shrink-0 grow-0 basis-[88%] px-2"
                >
                  <m.div
                    animate={{
                      scale: selected === idx ? 1 : 0.94,
                      opacity: selected === idx ? 1 : 0.55,
                    }}
                    transition={{ duration: 0.42, ease }}
                  >
                    <PhoneFrame title={slide.title} index={idx}>
                      {slide.node}
                    </PhoneFrame>
                  </m.div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-center gap-2">
          {heroSlides.map((slide, idx) => (
            <button
              key={slide.id}
              type="button"
              aria-label={`查看 ${slide.title} 卡片`}
              onClick={() => scrollTo(idx)}
              className="group/dot flex items-center gap-1"
            >
              <span
                className={cn(
                  "h-1.5 rounded-full transition-all",
                  idx === selected
                    ? "w-7 bg-slate-950"
                    : "w-1.5 bg-slate-300/80 active:bg-slate-400"
                )}
              />
              <span
                className={cn(
                  "text-[11px] font-medium transition-all",
                  idx === selected ? "text-slate-950" : "text-slate-400"
                )}
              >
                {slide.title}
              </span>
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}

function PhoneFrame({
  title,
  index,
  children,
}: {
  title: string
  index: number
  children: React.ReactNode
}) {
  return (
    <m.div
      initial={{ opacity: 0, y: 22, rotate: -2, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, rotate: -1.5, scale: 1 }}
      transition={{ duration: 0.7, delay: 0.3 + index * 0.05, ease }}
      className="relative mx-auto"
    >
      <div className="absolute -inset-2 -z-10 rounded-[42px] bg-[linear-gradient(140deg,rgba(56,189,248,0.18),rgba(45,212,191,0.18)_55%,rgba(15,23,42,0.04))] blur-md" />
      <div className="relative rounded-[36px] border border-white/85 bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(245,250,255,0.96))] shadow-[0_38px_70px_-32px_rgba(15,23,42,0.55)]">
        <div className="absolute inset-x-0 top-0 z-10 flex h-6 items-center justify-center">
          <div className="h-1.5 w-16 rounded-full bg-slate-300/70" />
        </div>
        <div className="absolute inset-x-0 top-6 z-10 flex justify-center">
          <span className="rounded-full bg-slate-100/80 px-2 py-0.5 text-[10px] font-medium tracking-wider text-slate-500">
            {title}
          </span>
        </div>
        <div className="pt-12">{children}</div>
      </div>
    </m.div>
  )
}

function ChatSlide() {
  return (
    <div className="px-4 pt-2 pb-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-full bg-slate-950/90 text-[10px] font-semibold tracking-tight text-white">
            S
          </div>
          <div>
            <div className="text-[12.5px] font-semibold text-slate-950">
              发布战情群
            </div>
            <div className="text-[10px] text-emerald-600">· 3 个角色在线</div>
          </div>
        </div>
        <div className="flex items-center gap-1 rounded-full border border-emerald-200/80 bg-emerald-50/80 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
          <ShieldCheck className="size-3" />
          已授权
        </div>
      </div>

      <div className="mt-4 space-y-2.5">
        {chatMessages.map((msg, index) => {
          const isUser = msg.role === "user"
          return (
            <m.div
              key={msg.name}
              initial={{ opacity: 0, y: 14, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{
                duration: 0.5,
                delay: 0.45 + index * 0.18,
                ease,
              }}
              className={`flex gap-2 ${isUser ? "flex-row-reverse" : ""}`}
            >
              <div
                className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-[9.5px] font-semibold ${msg.tone}`}
              >
                {msg.initials}
              </div>
              <div
                className={`max-w-[78%] space-y-1 ${isUser ? "text-right" : ""}`}
              >
                <div className="text-[10px] font-medium text-slate-400">
                  {msg.name}
                </div>
                <div
                  className={`rounded-2xl px-3 py-2 text-[12px] leading-[1.55] shadow-[0_10px_22px_-16px_rgba(15,23,42,0.4)] ${
                    isUser
                      ? "rounded-tr-md bg-slate-950 text-white"
                      : msg.tone === "bg-sky-100 text-sky-950"
                        ? "rounded-tl-md border border-sky-200/80 bg-sky-50 text-slate-800"
                        : "rounded-tl-md border border-amber-200/80 bg-amber-50 text-slate-800"
                  }`}
                >
                  {msg.text}
                </div>
                {"meta" in msg && msg.meta ? (
                  <div className="inline-flex rounded-full border border-emerald-200 bg-emerald-50/90 px-2 py-0.5 text-[9.5px] leading-none text-emerald-700">
                    {msg.meta}
                  </div>
                ) : null}
              </div>
            </m.div>
          )
        })}
      </div>

      <m.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 1.1, ease }}
        className="mt-4 flex items-center gap-2 rounded-2xl border border-slate-200/80 bg-slate-50/80 px-3 py-2.5 text-[11px] text-slate-500"
      >
        <BookOpenText className="size-3.5 text-slate-500" />
        <span className="flex-1">共享记忆已更新 · 后续角色可接力</span>
        <div className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
      </m.div>
    </div>
  )
}

function MemorySlide() {
  return (
    <div className="px-4 pt-2 pb-5">
      <div className="flex items-center gap-2 text-[12.5px] font-semibold text-slate-950">
        <BookOpenText className="size-4 text-slate-600" />
        群聊记忆
      </div>
      <p className="mt-1 text-[11px] leading-5 text-slate-500">
        上下文沉淀成结构化记忆，而不是散落在历史消息里
      </p>

      <div className="mt-4">
        <div className="text-[11px] font-semibold text-slate-950">
          共享记忆 / 发布摘要
        </div>
        <div className="mt-2 space-y-1.5">
          {memoryItems.map((item, idx) => (
            <m.div
              key={item}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{
                duration: 0.5,
                delay: 0.35 + idx * 0.12,
                ease,
              }}
              className="rounded-xl border border-slate-200 bg-white/85 px-3 py-2 text-[12px] leading-5 text-slate-700 shadow-sm"
            >
              {item}
            </m.div>
          ))}
        </div>
      </div>

      <div className="mt-4">
        <div className="text-[11px] font-semibold text-slate-600">
          已挂载资料
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {memoryTags.map((tag, idx) => (
            <m.span
              key={tag}
              initial={{ opacity: 0, scale: 0.92 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{
                duration: 0.4,
                delay: 0.55 + idx * 0.07,
                ease,
              }}
              className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[10.5px] leading-none text-slate-600"
            >
              {tag}
            </m.span>
          ))}
        </div>
      </div>
    </div>
  )
}

function ToolsSlide() {
  return (
    <div className="px-4 pt-2 pb-5">
      <div className="flex items-center gap-2 text-[12.5px] font-semibold text-slate-950">
        <ShieldCheck className="size-4 text-emerald-600" />
        资源授权
      </div>
      <p className="mt-1 text-[11px] leading-5 text-slate-500">
        资源先进入工作区，再按规则交给合适的角色调用
      </p>

      <div className="mt-3 space-y-2">
        {toolRows.map((tool, idx) => (
          <m.div
            key={tool.name}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
              duration: 0.45,
              delay: 0.35 + idx * 0.1,
              ease,
            }}
            className="rounded-2xl border border-slate-200 bg-white/82 px-3 py-2.5"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className="flex size-8 items-center justify-center rounded-xl bg-slate-100 text-slate-950">
                  <tool.icon className="size-[14px]" />
                </div>
                <div>
                  <div className="text-[12px] font-semibold text-slate-950">
                    {tool.name}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1 text-[10px] text-slate-500">
                    <LockKeyhole className="size-2.5" />
                    {tool.scope}
                  </div>
                </div>
              </div>
              <span
                className={cn(
                  "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
                  tool.statusTone
                )}
              >
                {tool.status}
              </span>
            </div>
          </m.div>
        ))}

        <m.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, delay: 0.7, ease }}
          className="flex items-center justify-between rounded-2xl border border-emerald-200 bg-emerald-50/85 px-3 py-2.5"
        >
          <div>
            <div className="text-[12px] font-semibold text-slate-950">
              授权链路
            </div>
            <div className="mt-0.5 text-[10.5px] leading-4 text-slate-600">
              角色请求 · Scope 校验 · 审计执行
            </div>
          </div>
          <ChevronRight className="size-4 text-emerald-600" />
        </m.div>
      </div>
    </div>
  )
}
