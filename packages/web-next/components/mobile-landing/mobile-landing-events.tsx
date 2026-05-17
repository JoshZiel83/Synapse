"use client"

import { m } from "framer-motion"
import {
  AlarmClockCheck,
  ArrowDown,
  BellRing,
  MessageSquareText,
  ServerCog,
  Workflow,
} from "lucide-react"

import { cn } from "@/lib/utils"
import {
  MobileReveal,
  MobileSection,
  MobileSectionHeader,
} from "./mobile-landing-primitives"

const sources = [
  {
    icon: ServerCog,
    title: "服务器推送",
    text: "异常事件直接推入运行时",
    status: "已触发",
    active: true,
  },
  {
    icon: MessageSquareText,
    title: "飞书 IM",
    text: "群消息、@ 提及、机器人指令",
    status: "等待中",
    active: false,
  },
  {
    icon: AlarmClockCheck,
    title: "定时触发",
    text: "巡检、日报、周期任务",
    status: "已配置",
    active: false,
  },
] as const

const steps = [
  { title: "创建 incident 群聊", state: "done" },
  { title: "拉入值班 SRE", state: "done" },
  { title: "调用内网日志服务", state: "active" },
  { title: "拉入诊断角色", state: "pending" },
  { title: "更新共享记忆", state: "pending" },
] as const

const ease: [number, number, number, number] = [0.22, 1, 0.36, 1]

export function MobileLandingEvents() {
  return (
    <MobileSection id="events">
      <MobileSectionHeader
        eyebrow="事件"
        title="工作不一定从你开口开始"
        subtitle="Webhook、IM、定时与系统信号都能直接叫醒团队"
      />

      <div className="mx-auto mt-7 max-w-md space-y-2.5">
        {[BellRing, Workflow, AlarmClockCheck].map((Icon, idx) => (
          <MobileReveal
            key={idx}
            y={14}
            delay={0.08 + idx * 0.05}
            className="flex items-center gap-3 rounded-2xl border border-white/72 bg-white/82 px-3 py-2.5 backdrop-blur"
          >
            <div className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-slate-950 text-white">
              <Icon className="size-[14px]" />
            </div>
            <div className="text-[12.5px] leading-5 text-slate-700">
              {idx === 0 && "人、服务、消息、系统信号都能成为入口"}
              {idx === 1 && "事件进来后，群聊、角色、资源自动就位"}
              {idx === 2 && "定时、Webhook、状态变化都能长期值守"}
            </div>
          </MobileReveal>
        ))}
      </div>

      <MobileReveal
        y={22}
        delay={0.2}
        className="mx-auto mt-7 max-w-md space-y-2.5"
      >
        {sources.map((source, idx) => (
          <m.div
            key={source.title}
            initial={{ opacity: 0, x: -10, y: 12 }}
            whileInView={{ opacity: 1, x: 0, y: 0 }}
            viewport={{ once: true, amount: 0.4 }}
            transition={{ duration: 0.5, delay: idx * 0.08, ease }}
            className={cn(
              "flex items-start gap-3 rounded-2xl border p-3 shadow-[0_14px_28px_-24px_rgba(15,23,42,0.32)]",
              source.active
                ? "border-sky-200 bg-sky-50/72"
                : "border-slate-200 bg-slate-50/85"
            )}
          >
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-white text-slate-950 ring-1 ring-slate-200/70">
              <source.icon className="size-[15px]" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[12.5px] font-semibold text-slate-950">
                  {source.title}
                </div>
                <span
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[10px] leading-none",
                    source.active
                      ? "border-sky-200 bg-sky-100 text-sky-700"
                      : "border-slate-200 bg-white text-slate-500"
                  )}
                >
                  {source.status}
                </span>
              </div>
              <p className="mt-1 text-[11.5px] leading-5 text-slate-600">
                {source.text}
              </p>
            </div>
          </m.div>
        ))}
      </MobileReveal>

      <MobileReveal y={14} delay={0.34} className="my-3 flex justify-center">
        <m.div
          animate={{ y: [0, 4, 0] }}
          transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
          className="flex size-8 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-400 shadow-[0_8px_18px_-12px_rgba(15,23,42,0.22)]"
        >
          <ArrowDown className="size-4" />
        </m.div>
      </MobileReveal>

      <MobileReveal
        y={20}
        delay={0.42}
        className="mx-auto max-w-md rounded-[26px] border border-slate-200 bg-[linear-gradient(180deg,rgba(248,251,255,0.96),rgba(240,247,255,0.88))] p-4 shadow-[0_22px_44px_-32px_rgba(15,23,42,0.32)]"
      >
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[13px] font-semibold text-slate-950">
              自动工作流
            </div>
            <div className="mt-0.5 text-[10px] text-slate-500">
              当前由服务器推送触发
            </div>
          </div>
          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] leading-none text-emerald-700">
            运行中
          </span>
        </div>
        <div className="mt-3 rounded-[20px] border border-slate-200 bg-white/88 p-3">
          <div className="flex items-center gap-2 text-[11px] font-medium text-slate-500">
            <ServerCog className="size-3.5 text-slate-700" />
            PROD API / CPU 持续异常
          </div>
          <div className="mt-3 space-y-2.5">
            {steps.map((step, idx) => (
              <m.div
                key={step.title}
                initial={{ opacity: 0, x: -8 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true, amount: 0.5 }}
                transition={{ duration: 0.42, delay: idx * 0.08, ease }}
                className="flex items-center gap-2.5"
              >
                <div
                  className={cn(
                    "size-2.5 shrink-0 rounded-full",
                    step.state === "done" && "bg-slate-950",
                    step.state === "active" &&
                      "bg-emerald-500 ring-4 ring-emerald-100",
                    step.state === "pending" && "bg-slate-200"
                  )}
                />
                <span className="text-[12px] font-medium text-slate-950">
                  {step.title}
                </span>
              </m.div>
            ))}
          </div>
        </div>
      </MobileReveal>
    </MobileSection>
  )
}
