"use client"

import { m } from "framer-motion"
import {
  ArrowRightLeft,
  LaptopMinimal,
  ShieldCheck,
  SquareTerminal,
} from "lucide-react"

import {
  MobileReveal,
  MobileSection,
  MobileSectionHeader,
} from "./mobile-landing-primitives"

const ease: [number, number, number, number] = [0.22, 1, 0.36, 1]

const points = [
  {
    icon: ArrowRightLeft,
    title: "像联系人一样引入",
    text: "用户、Actor、Remote Agent 跨工作区互通",
  },
  {
    icon: ShieldCheck,
    title: "共享后继续工作",
    text: "拿到授权后继续接住文档、数据和流程",
  },
  {
    icon: SquareTerminal,
    title: "外部运行时保留",
    text: "Remote Agent 通过桥接进入同一群聊",
  },
] as const

export function MobileLandingShare() {
  return (
    <MobileSection
      id="sharing"
      className="bg-[linear-gradient(180deg,rgba(248,251,255,0.6),rgba(255,255,255,0.94))]"
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-72 bg-[radial-gradient(120%_80%_at_50%_0%,rgba(56,189,248,0.12),transparent_60%)]" />

      <MobileSectionHeader
        eyebrow="共享"
        title="像加同事一样，把 Agent 接进来"
        subtitle="共享的 Actor 能在群聊里申请授权"
      />

      <div className="mx-auto mt-8 max-w-md space-y-3">
        {points.map((point, idx) => (
          <MobileReveal
            key={point.title}
            y={16}
            delay={0.08 + idx * 0.06}
            className="flex items-start gap-3 rounded-2xl border border-white/72 bg-white/85 p-3.5 shadow-[0_14px_28px_-22px_rgba(15,23,42,0.4)] backdrop-blur"
          >
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-slate-950 text-white">
              <point.icon className="size-[15px]" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] font-semibold text-slate-950">
                {point.title}
              </div>
              <p className="mt-1 text-[12.5px] leading-[1.55] text-slate-600">
                {point.text}
              </p>
            </div>
          </MobileReveal>
        ))}
      </div>

      <MobileReveal y={22} delay={0.2} className="mx-auto mt-7 max-w-md">
        <div className="rounded-[26px] border border-emerald-200/80 bg-[linear-gradient(180deg,rgba(236,253,245,0.95),rgba(255,255,255,0.96))] p-4 shadow-[0_22px_44px_-32px_rgba(16,185,129,0.32)]">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-slate-950">
              <LaptopMinimal className="size-3.5 text-emerald-700" />
              桌面浏览器访问申请
            </div>
            <div className="rounded-full border border-emerald-200 bg-white px-2 py-0.5 text-[10px] text-emerald-700">
              待你授权
            </div>
          </div>
          <p className="mt-2 text-[12px] leading-5 text-slate-700">
            共享 Actor 想继续操作你已接入的桌面浏览器
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {["申请方 · Scout", "范围 · 当前会话", "资源 · 桌面浏览器"].map(
              (label) => (
                <span
                  key={label}
                  className="rounded-full border border-emerald-200/80 bg-white px-2 py-1 text-[10.5px] leading-none text-slate-600"
                >
                  {label}
                </span>
              )
            )}
          </div>
          <m.div
            initial={{ opacity: 0, y: 8 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.6 }}
            transition={{ duration: 0.45, delay: 0.35, ease }}
            className="mt-3 flex items-center gap-2 rounded-full bg-emerald-600/95 px-3 py-1.5 text-[11.5px] font-medium text-white shadow-[0_10px_22px_-12px_rgba(16,185,129,0.6)]"
          >
            <ShieldCheck className="size-3.5" />
            一键授权 · 仅当前会话生效
          </m.div>
        </div>
      </MobileReveal>
    </MobileSection>
  )
}
