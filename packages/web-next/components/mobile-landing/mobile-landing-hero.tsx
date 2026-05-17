"use client"

import { m } from "framer-motion"
import Link from "next/link"
import { Sparkles, BookOpenText, ShieldCheck } from "lucide-react"

import { LandingHeroHeadline } from "@/components/landing-hero-headline"

const messages = [
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

const ease: [number, number, number, number] = [0.22, 1, 0.36, 1]

export function MobileLandingHero() {
  return (
    <section className="relative px-5 pt-[calc(env(safe-area-inset-top)+5.25rem)] pb-12">
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

        <div className="mt-4">
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

        <PhoneFrame>
          <div className="px-4 pt-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="flex size-7 items-center justify-center rounded-full bg-slate-950/90 text-[10px] font-semibold tracking-tight text-white">
                  S
                </div>
                <div>
                  <div className="text-[12.5px] font-semibold text-slate-950">
                    发布战情群
                  </div>
                  <div className="text-[10px] text-emerald-600">
                    · 3 个角色在线
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1 rounded-full border border-emerald-200/80 bg-emerald-50/80 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                <ShieldCheck className="size-3" />
                已授权
              </div>
            </div>

            <div className="mt-4 space-y-2.5">
              {messages.map((msg, index) => {
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

          <div className="mt-4 px-4 pt-2 pb-5">
            <div className="flex items-center gap-2 rounded-full border border-slate-200/80 bg-white px-3 py-2 text-[11px] text-slate-400">
              <span className="flex-1">@角色 · 发消息推进协作</span>
              <div className="size-6 rounded-full bg-slate-950" />
            </div>
          </div>
        </PhoneFrame>
      </div>
    </section>
  )
}

function PhoneFrame({ children }: { children: React.ReactNode }) {
  return (
    <m.div
      initial={{ opacity: 0, y: 22, rotate: -2, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, rotate: -1.5, scale: 1 }}
      transition={{ duration: 0.7, delay: 0.35, ease }}
      className="relative mx-auto"
    >
      <div className="absolute -inset-2 -z-10 rounded-[42px] bg-[linear-gradient(140deg,rgba(56,189,248,0.18),rgba(45,212,191,0.18)_55%,rgba(15,23,42,0.04))] blur-md" />
      <div className="relative rounded-[36px] border border-white/85 bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(245,250,255,0.96))] shadow-[0_38px_70px_-32px_rgba(15,23,42,0.55)]">
        <div className="absolute inset-x-0 top-0 z-10 flex h-6 items-center justify-center">
          <div className="h-1.5 w-16 rounded-full bg-slate-300/70" />
        </div>
        <div className="pt-3">{children}</div>
      </div>
    </m.div>
  )
}
