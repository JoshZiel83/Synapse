"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Image from "next/image"
import { AnimatePresence, m } from "framer-motion"
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
  type LucideIcon,
} from "lucide-react"

import { cn } from "@/lib/utils"
import {
  MobileReveal,
  MobileSection,
  MobileSectionHeader,
} from "./mobile-landing-primitives"

type OrbitNode = {
  icon: LucideIcon
  label: string
  angle: number
}

type Orbit = {
  radiusPct: number
  speed: number
  direction: "cw" | "ccw"
  items: OrbitNode[]
}

const orbits: Orbit[] = [
  {
    radiusPct: 46,
    speed: 38,
    direction: "cw",
    items: [
      { icon: Mail, label: "邮箱", angle: 0 },
      { icon: Smartphone, label: "手机", angle: 120 },
      { icon: Github, label: "GitHub", angle: 240 },
    ],
  },
  {
    radiusPct: 34,
    speed: 30,
    direction: "ccw",
    items: [
      { icon: Server, label: "服务器", angle: 60 },
      { icon: HardDrive, label: "共享盘", angle: 180 },
      { icon: AppWindow, label: "浏览器", angle: 300 },
    ],
  },
  {
    radiusPct: 22,
    speed: 24,
    direction: "cw",
    items: [
      { icon: Database, label: "数据库", angle: 30 },
      { icon: LaptopMinimal, label: "电脑", angle: 150 },
      { icon: Network, label: "内部 API", angle: 270 },
    ],
  },
]

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
        title="云端协作，执行继续落到设备"
        subtitle="浏览器、文件、数据库都可以在边界清楚下继续接进来"
      />

      <MobileReveal
        y={22}
        delay={0.18}
        className="relative mx-auto mt-6 aspect-square w-full max-w-[20rem]"
      >
        <OrbitField />
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

function OrbitField() {
  const [activeLabel, setActiveLabel] = useState<string | null>(null)
  const hideTimerRef = useRef<number | null>(null)

  const showLabel = useCallback((label: string) => {
    setActiveLabel(label)
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current)
    hideTimerRef.current = window.setTimeout(() => setActiveLabel(null), 1600)
  }, [])

  useEffect(() => {
    return () => {
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current)
    }
  }, [])

  return (
    <div className="relative size-full">
      <div className="pointer-events-none absolute inset-[12%] rounded-full bg-[radial-gradient(circle_at_center,rgba(125,211,252,0.16),rgba(255,255,255,0.04)_48%,transparent_66%)]" />

      {orbits.map((orbit) => (
        <div
          key={`ring-${orbit.radiusPct}`}
          className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
          style={{
            width: `${orbit.radiusPct * 2}%`,
            height: `${orbit.radiusPct * 2}%`,
          }}
        >
          <div className="size-full rounded-full border border-dashed border-sky-300/60" />
        </div>
      ))}

      {orbits.map((orbit) => (
        <OrbitRing
          key={`orbit-${orbit.radiusPct}`}
          orbit={orbit}
          onNodeTap={showLabel}
          activeLabel={activeLabel}
        />
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
    </div>
  )
}

function OrbitRing({
  orbit,
  onNodeTap,
  activeLabel,
}: {
  orbit: Orbit
  onNodeTap: (label: string) => void
  activeLabel: string | null
}) {
  const animationName =
    orbit.direction === "cw" ? "orbit-spin-cw" : "orbit-spin-ccw"
  const counterAnimationName =
    orbit.direction === "cw" ? "orbit-spin-ccw" : "orbit-spin-cw"

  return (
    <div
      className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
      style={{
        width: `${orbit.radiusPct * 2}%`,
        height: `${orbit.radiusPct * 2}%`,
      }}
    >
      <div
        className="relative size-full"
        style={{
          animation: `${animationName} ${orbit.speed}s linear infinite`,
        }}
      >
        {orbit.items.map((node) => (
          <div
            key={node.label}
            className="absolute inset-0"
            style={{ transform: `rotate(${node.angle}deg)` }}
          >
            <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2">
              <div style={{ transform: `rotate(${-node.angle}deg)` }}>
                <div
                  style={{
                    animation: `${counterAnimationName} ${orbit.speed}s linear infinite`,
                  }}
                >
                  <OrbitNodeButton
                    node={node}
                    onTap={() => onNodeTap(node.label)}
                    isActive={activeLabel === node.label}
                  />
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function OrbitNodeButton({
  node,
  onTap,
  isActive,
}: {
  node: OrbitNode
  onTap: () => void
  isActive: boolean
}) {
  return (
    <m.button
      type="button"
      aria-label={node.label}
      onClick={onTap}
      whileTap={{ scale: 0.92 }}
      className={cn(
        "relative flex size-9 items-center justify-center rounded-full border border-white/95 bg-[radial-gradient(circle_at_30%_28%,rgba(255,255,255,0.98),rgba(248,250,252,0.96)_58%,rgba(226,232,240,0.98))] shadow-[0_14px_30px_-22px_rgba(56,189,248,0.42)] transition-shadow outline-none",
        isActive &&
          "shadow-[0_18px_36px_-18px_rgba(56,189,248,0.6)] ring-2 ring-sky-400/60"
      )}
    >
      <node.icon className="size-[14px] text-slate-950" />
      <AnimatePresence>
        {isActive ? (
          <m.span
            key="label"
            initial={{ opacity: 0, y: 6, scale: 0.92 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.94 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="pointer-events-none absolute top-[110%] left-1/2 z-30 -translate-x-1/2 rounded-full bg-slate-950 px-2 py-0.5 text-[10px] leading-none font-medium whitespace-nowrap text-white shadow-[0_8px_20px_-8px_rgba(15,23,42,0.55)]"
          >
            {node.label}
          </m.span>
        ) : null}
      </AnimatePresence>
    </m.button>
  )
}
