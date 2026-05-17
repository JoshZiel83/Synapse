"use client"

import { m } from "framer-motion"
import { BrainCircuit, MessageSquareMore, UsersRound } from "lucide-react"

import {
  MobileReveal,
  MobileSection,
  MobileSectionHeader,
} from "./mobile-landing-primitives"

const ease: [number, number, number, number] = [0.22, 1, 0.36, 1]

const features = [
  {
    icon: MessageSquareMore,
    title: "同群协作",
    text: "人与 Agent 在同一条线程推进",
  },
  {
    icon: BrainCircuit,
    title: "共享记忆",
    text: "交付沉淀，下一个角色接着做",
  },
  {
    icon: UsersRound,
    title: "过程可见",
    text: "拉人、更新都有系统消息",
  },
] as const

const stream = [
  { kind: "system", text: "Celine 将 Brief Writer 拉入了群聊" },
  {
    kind: "user",
    name: "Celine",
    text: "先起一版董事会摘要，把结论和 blocker 写进共享记忆。",
  },
  {
    kind: "actor",
    name: "Brief Writer",
    tone: "sky",
    text: "初稿已交付，关键结论已写回共享记忆。",
    meta: "共享记忆已更新",
  },
  { kind: "system", text: "Celine 将 Risk Analyst 拉入了群聊" },
  {
    kind: "actor",
    name: "Risk Analyst",
    tone: "amber",
    text: "读取记忆后建议单列移动端 onboarding 风险。",
  },
] as const

export function MobileLandingCollaboration() {
  return (
    <MobileSection id="collab">
      <MobileSectionHeader
        eyebrow="协作"
        title="同一条群聊，就是同一个协作现场"
        subtitle="拉人、分工、交付、沉淀都发生在同一处"
      />

      <div className="mx-auto mt-7 grid max-w-md grid-cols-3 gap-2.5">
        {features.map((feature, idx) => (
          <MobileReveal
            key={feature.title}
            y={14}
            delay={0.08 + idx * 0.06}
            className="rounded-2xl border border-white/72 bg-white/85 p-3 text-center shadow-[0_12px_24px_-20px_rgba(15,23,42,0.4)] backdrop-blur"
          >
            <div className="mx-auto flex size-9 items-center justify-center rounded-xl bg-slate-950 text-white">
              <feature.icon className="size-[15px]" />
            </div>
            <div className="mt-2.5 text-[12.5px] font-semibold text-slate-950">
              {feature.title}
            </div>
            <p className="mt-1 text-[11px] leading-[1.4] text-slate-500">
              {feature.text}
            </p>
          </MobileReveal>
        ))}
      </div>

      <MobileReveal
        y={22}
        delay={0.2}
        className="mx-auto mt-7 max-w-[22rem] overflow-hidden rounded-[28px] border border-white/72 bg-white/92 shadow-[0_28px_60px_-32px_rgba(15,23,42,0.4)] backdrop-blur"
      >
        <div className="border-b border-slate-200/70 px-4 py-3">
          <div className="text-[12px] font-semibold text-slate-950">
            董事会发布摘要
          </div>
          <div className="mt-0.5 text-[10px] text-slate-500">
            系统消息可见，记忆承接上下文
          </div>
        </div>
        <div className="space-y-2.5 px-3 py-4">
          {stream.map((item, idx) => {
            if (item.kind === "system") {
              return (
                <m.div
                  key={`sys-${idx}`}
                  initial={{ opacity: 0, y: 8 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, amount: 0.4 }}
                  transition={{ duration: 0.42, delay: idx * 0.08, ease }}
                  className="px-2 text-center text-[10px] text-slate-400"
                >
                  {item.text}
                </m.div>
              )
            }
            const isUser = item.kind === "user"
            const isSky = "tone" in item && item.tone === "sky"
            return (
              <m.div
                key={`msg-${idx}`}
                initial={{ opacity: 0, y: 12 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, amount: 0.35 }}
                transition={{ duration: 0.48, delay: idx * 0.08, ease }}
                className={`flex gap-2 ${isUser ? "flex-row-reverse" : ""}`}
              >
                <div className="space-y-1">
                  <div
                    className={`text-[9.5px] font-medium text-slate-400 ${isUser ? "text-right" : ""}`}
                  >
                    {item.name}
                  </div>
                  <div
                    className={`max-w-[16rem] rounded-2xl px-3 py-2 text-[12px] leading-[1.55] shadow-[0_8px_22px_-18px_rgba(15,23,42,0.4)] ${
                      isUser
                        ? "rounded-tr-md bg-slate-950 text-white"
                        : isSky
                          ? "rounded-tl-md border border-sky-200/80 bg-sky-50 text-slate-800"
                          : "rounded-tl-md border border-amber-200/80 bg-amber-50 text-slate-800"
                    }`}
                  >
                    {item.text}
                  </div>
                  {"meta" in item && item.meta ? (
                    <div className="inline-flex rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[9.5px] leading-none text-emerald-700">
                      {item.meta}
                    </div>
                  ) : null}
                </div>
              </m.div>
            )
          })}
        </div>
      </MobileReveal>
    </MobileSection>
  )
}
