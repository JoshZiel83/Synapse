"use client"

import { useState } from "react"
import { AnimatePresence, m } from "framer-motion"
import {
  ArrowRightLeft,
  BadgeCheck,
  Building2,
  LaptopMinimal,
  LockKeyhole,
  ScrollText,
  UsersRound,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { MobileSection, MobileSectionHeader } from "./mobile-landing-primitives"

const tabs = [
  { id: "env", icon: UsersRound, label: "环境" },
  { id: "roles", icon: LockKeyhole, label: "权限" },
  { id: "audit", icon: ScrollText, label: "审计" },
] as const

const ease: [number, number, number, number] = [0.22, 1, 0.36, 1]

const roleRows = [
  {
    role: "平台管理员",
    summary: "管理成员、模型组与平台配置",
    tone: "bg-slate-950 text-white",
  },
  {
    role: "工作区管理员",
    summary: "安装插件、分配角色、配置资源",
    tone: "bg-sky-100 text-sky-950",
  },
  {
    role: "成员",
    summary: "发起任务、查看结果、使用授权能力",
    tone: "bg-slate-100 text-slate-700",
  },
] as const

const auditItems = [
  {
    time: "09:42",
    action: "Browser Operator 装入团队环境",
    detail: "由工作区管理员发起",
  },
  {
    time: "09:45",
    action: "Risk Analyst 获得 SQL Access",
    detail: "权限范围限制为只读查询",
  },
  {
    time: "09:52",
    action: "凌晨巡检触发并写入共享记忆",
    detail: "事件链路完整记录",
  },
] as const

export function MobileLandingGovernance() {
  const [active, setActive] = useState<(typeof tabs)[number]["id"]>("env")

  return (
    <MobileSection
      id="trust"
      className="bg-[linear-gradient(180deg,rgba(247,250,255,0.55),rgba(255,255,255,0.96))]"
    >
      <MobileSectionHeader
        eyebrow="治理"
        title="管理数字团队，像管理真实团队一样清楚"
        subtitle="个人 / 团队并行 · 权限可见 · 关键动作可追溯"
      />

      <div className="mx-auto mt-7 flex max-w-md rounded-full border border-white/72 bg-white/72 p-1 backdrop-blur">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActive(tab.id)}
            className="relative flex-1 rounded-full px-2 py-2 text-[12.5px] font-medium transition-colors"
          >
            {active === tab.id ? (
              <m.span
                layoutId="trust-tab-indicator"
                className="absolute inset-0 -z-10 rounded-full bg-slate-950 shadow-[0_10px_24px_-18px_rgba(15,23,42,0.65)]"
                transition={{ duration: 0.36, ease }}
              />
            ) : null}
            <span
              className={cn(
                "relative flex items-center justify-center gap-1.5",
                active === tab.id ? "text-white" : "text-slate-600"
              )}
            >
              <tab.icon className="size-[13px]" />
              {tab.label}
            </span>
          </button>
        ))}
      </div>

      <div className="mx-auto mt-5 max-w-md">
        <AnimatePresence mode="wait">
          {active === "env" ? (
            <m.div
              key="env"
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.32, ease }}
              className="space-y-3"
            >
              <div className="rounded-2xl border border-slate-200 bg-[linear-gradient(180deg,rgba(248,250,252,0.96),rgba(241,245,249,0.88))] p-3.5">
                <div className="flex items-center gap-2.5">
                  <div className="flex size-9 items-center justify-center rounded-xl bg-white text-slate-950 ring-1 ring-slate-200/70">
                    <LaptopMinimal className="size-[15px]" />
                  </div>
                  <div>
                    <div className="text-[13px] font-semibold text-slate-950">
                      个人环境
                    </div>
                    <div className="text-[11px] text-slate-500">
                      给自己配工具，也可以共享
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {["个人工具", "个人记忆", "本地设备"].map((label) => (
                    <span
                      key={label}
                      className="rounded-full border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-600"
                    >
                      {label}
                    </span>
                  ))}
                </div>
              </div>

              <div className="flex justify-center">
                <m.div
                  animate={{ y: [0, -3, 0] }}
                  transition={{
                    duration: 1.6,
                    repeat: Infinity,
                    ease: "easeInOut",
                  }}
                  className="flex size-8 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 shadow-[0_8px_18px_-12px_rgba(15,23,42,0.22)]"
                >
                  <ArrowRightLeft className="size-3.5" />
                </m.div>
              </div>

              <div className="rounded-2xl border border-sky-200 bg-[linear-gradient(180deg,rgba(240,249,255,0.96),rgba(236,253,245,0.82))] p-3.5">
                <div className="flex items-center gap-2.5">
                  <div className="flex size-9 items-center justify-center rounded-xl bg-white text-slate-950 ring-1 ring-sky-200/70">
                    <Building2 className="size-[15px]" />
                  </div>
                  <div>
                    <div className="text-[13px] font-semibold text-slate-950">
                      团队环境
                    </div>
                    <div className="text-[11px] text-slate-500">
                      统一配置公共能力，供多人复用
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {["团队工具", "共享角色", "统一权限"].map((label) => (
                    <span
                      key={label}
                      className="rounded-full border border-sky-200/70 bg-white px-2 py-1 text-[11px] text-slate-600"
                    >
                      {label}
                    </span>
                  ))}
                </div>
              </div>
            </m.div>
          ) : null}

          {active === "roles" ? (
            <m.div
              key="roles"
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.32, ease }}
              className="space-y-2.5"
            >
              {roleRows.map((row, idx) => (
                <m.div
                  key={row.role}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.4, delay: idx * 0.06, ease }}
                  className="rounded-2xl border border-slate-200 bg-white/92 p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[13px] font-semibold text-slate-950">
                        {row.role}
                      </div>
                      <div className="mt-1 text-[11.5px] leading-5 text-slate-500">
                        {row.summary}
                      </div>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2.5 py-0.5 text-[10px] leading-none ${row.tone}`}
                    >
                      生效中
                    </span>
                  </div>
                </m.div>
              ))}
            </m.div>
          ) : null}

          {active === "audit" ? (
            <m.div
              key="audit"
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.32, ease }}
              className="space-y-2.5"
            >
              {auditItems.map((item, idx) => (
                <m.div
                  key={item.time}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.4, delay: idx * 0.06, ease }}
                  className="flex gap-2.5"
                >
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500">
                    <BadgeCheck className="size-3.5" />
                  </div>
                  <div className="min-w-0 flex-1 rounded-2xl border border-slate-200 bg-slate-50/85 p-3">
                    <div className="text-[10px] font-medium text-slate-400">
                      {item.time}
                    </div>
                    <div className="mt-1 text-[12.5px] font-semibold text-slate-950">
                      {item.action}
                    </div>
                    <div className="mt-1 text-[11px] leading-5 text-slate-500">
                      {item.detail}
                    </div>
                  </div>
                </m.div>
              ))}
            </m.div>
          ) : null}
        </AnimatePresence>
      </div>
    </MobileSection>
  )
}
