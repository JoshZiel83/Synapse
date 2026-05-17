"use client"

import Image from "next/image"
import { m } from "framer-motion"
import {
  AppWindow,
  Database,
  Github,
  HardDrive,
  LaptopMinimal,
  Mail,
  Network,
  Server,
  ShieldCheck,
  Smartphone,
} from "lucide-react"

import {
  MobileReveal,
  MobileSection,
  MobileSectionHeader,
} from "./mobile-landing-primitives"

const orbits = [
  {
    radiusPct: 46,
    speed: 38,
    direction: 1,
    items: [
      { icon: Mail, label: "邮箱", angle: 0 },
      { icon: Smartphone, label: "手机", angle: 120 },
      { icon: Github, label: "GitHub", angle: 240 },
    ],
  },
  {
    radiusPct: 34,
    speed: 30,
    direction: -1,
    items: [
      { icon: Server, label: "服务器", angle: 60 },
      { icon: HardDrive, label: "共享盘", angle: 180 },
      { icon: AppWindow, label: "浏览器", angle: 300 },
    ],
  },
  {
    radiusPct: 22,
    speed: 24,
    direction: 1,
    items: [
      { icon: Database, label: "数据库", angle: 30 },
      { icon: LaptopMinimal, label: "电脑", angle: 150 },
      { icon: Network, label: "内部 API", angle: 270 },
    ],
  },
] as const

const benefits = [
  {
    icon: LaptopMinimal,
    title: "云上协作，本地执行",
    text: "任务在云端被分工讨论，执行落回设备与浏览器",
  },
  {
    icon: Server,
    title: "设备和内网都能接入",
    text: "文件系统、数据库、内网 API 进入同一工作链",
  },
  {
    icon: ShieldCheck,
    title: "连接之后仍然受控",
    text: "访问范围、调用动作、轨迹持续被治理审计",
  },
] as const

export function MobileLandingReach() {
  return (
    <MobileSection
      id="reach"
      className="bg-[linear-gradient(180deg,rgba(246,250,255,0.6),rgba(255,255,255,0.96))]"
    >
      <MobileSectionHeader
        eyebrow="执行"
        title="云端协作，执行继续落到设备"
        subtitle="浏览器、文件、数据库都可以在边界清楚下继续接进来"
      />

      <MobileReveal
        y={22}
        delay={0.18}
        className="relative mx-auto mt-6 aspect-square w-full max-w-[20rem]"
      >
        <div className="pointer-events-none absolute inset-[12%] rounded-full bg-[radial-gradient(circle_at_center,rgba(125,211,252,0.16),rgba(255,255,255,0.04)_48%,transparent_66%)]" />

        {orbits.map((orbit) => (
          <div
            key={orbit.radiusPct}
            className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
            style={{
              width: `${orbit.radiusPct * 2}%`,
              height: `${orbit.radiusPct * 2}%`,
            }}
          >
            <div className="size-full rounded-full border border-dashed border-sky-300/60" />
          </div>
        ))}

        {orbits.map((orbit, orbitIndex) => (
          <m.div
            key={`orbit-${orbit.radiusPct}`}
            className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
            style={{
              width: `${orbit.radiusPct * 2}%`,
              height: `${orbit.radiusPct * 2}%`,
            }}
            animate={{ rotate: orbit.direction * 360 }}
            transition={{
              repeat: Infinity,
              ease: "linear",
              duration: orbit.speed,
            }}
          >
            {orbit.items.map((node) => (
              <div
                key={node.label}
                className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
                style={{
                  width: "100%",
                  height: "100%",
                  transform: `rotate(${node.angle}deg)`,
                }}
              >
                <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2">
                  <m.div
                    initial={{ scale: 0.6, opacity: 0 }}
                    whileInView={{ scale: 1, opacity: 1 }}
                    viewport={{ once: true, amount: 0.4 }}
                    transition={{
                      duration: 0.45,
                      delay: 0.4 + orbitIndex * 0.12 + (node.angle / 360) * 0.2,
                      ease: [0.22, 1, 0.36, 1],
                    }}
                    style={{ transform: `rotate(${-node.angle}deg)` }}
                  >
                    <m.div
                      animate={{ rotate: -orbit.direction * 360 }}
                      transition={{
                        repeat: Infinity,
                        ease: "linear",
                        duration: orbit.speed,
                      }}
                      className="relative flex size-9 items-center justify-center rounded-full border border-white/95 bg-[radial-gradient(circle_at_30%_28%,rgba(255,255,255,0.98),rgba(248,250,252,0.96)_58%,rgba(226,232,240,0.98))] shadow-[0_14px_30px_-22px_rgba(56,189,248,0.42)]"
                    >
                      <node.icon className="size-[14px] text-slate-950" />
                    </m.div>
                  </m.div>
                </div>
              </div>
            ))}
          </m.div>
        ))}

        <div className="absolute top-1/2 left-1/2 z-20 -translate-x-1/2 -translate-y-1/2">
          <m.div
            initial={{ scale: 0.6, opacity: 0 }}
            whileInView={{ scale: 1, opacity: 1 }}
            viewport={{ once: true, amount: 0.4 }}
            transition={{
              duration: 0.6,
              delay: 0.25,
              ease: [0.22, 1, 0.36, 1],
            }}
            className="relative"
          >
            <div className="absolute inset-0 rounded-full bg-sky-200/35 blur-2xl" />
            <div className="relative flex size-16 items-center justify-center rounded-full border border-white/95 bg-[radial-gradient(circle_at_30%_28%,rgba(255,255,255,0.98),rgba(241,245,249,0.96)_58%,rgba(226,232,240,0.98))] shadow-[0_18px_36px_-22px_rgba(148,163,184,0.45)] ring-1 ring-slate-200/70">
              <Image
                src="/synapse.svg"
                alt="Synapse"
                width={28}
                height={28}
                className="size-7"
              />
            </div>
          </m.div>
        </div>
      </MobileReveal>

      <div className="mx-auto mt-6 max-w-md space-y-2.5">
        {benefits.map((benefit, idx) => (
          <MobileReveal
            key={benefit.title}
            y={14}
            delay={0.1 + idx * 0.07}
            className="flex items-start gap-3 rounded-2xl border border-white/72 bg-white/82 p-3 shadow-[0_14px_28px_-22px_rgba(15,23,42,0.36)] backdrop-blur"
          >
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-slate-950 text-white">
              <benefit.icon className="size-[15px]" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-slate-950">
                {benefit.title}
              </div>
              <p className="mt-0.5 text-[12px] leading-[1.55] text-slate-600">
                {benefit.text}
              </p>
            </div>
          </MobileReveal>
        ))}
      </div>
    </MobileSection>
  )
}
