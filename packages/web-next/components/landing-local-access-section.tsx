import Image from "next/image"
import {
  AppWindow,
  BookText,
  CalendarDays,
  Database,
  Github,
  Gitlab,
  HardDrive,
  LaptopMinimal,
  Mail,
  Network,
  Server,
  ShieldCheck,
  Smartphone,
} from "lucide-react"

import { LandingReveal, LandingStagger, LandingStaggerItem } from "@/components/landing-motion"

const accessHighlights = [
  {
    icon: LaptopMinimal,
    title: "云端发起，本地执行",
    description: "任务在云端协作，执行可以继续落到你的电脑和浏览器",
  },
  {
    icon: Server,
    title: "继续接入公司内部服务",
    description: "内网系统、共享服务和内部 API 也能进入同一套工作链",
  },
  {
    icon: ShieldCheck,
    title: "连接之后仍然受控",
    description: "访问范围、调用动作和执行轨迹都可以继续被治理",
  },
] as const

const orbitTracks = [
  {
    sizeClass: "size-[92%]",
    className:
      "border-sky-300/70 bg-[radial-gradient(circle_at_center,transparent_70%,rgba(255,255,255,0.58)_77%,transparent_84%)] shadow-[0_0_56px_-22px_rgba(56,189,248,0.24)]",
  },
  {
    sizeClass: "size-[74%]",
    className:
      "border-sky-300/64 bg-[radial-gradient(circle_at_center,transparent_69%,rgba(255,255,255,0.48)_78%,transparent_85%)] shadow-[0_0_44px_-22px_rgba(56,189,248,0.2)]",
  },
  {
    sizeClass: "size-[56%]",
    className:
      "border-sky-300/58 bg-[radial-gradient(circle_at_center,transparent_68%,rgba(255,255,255,0.4)_79%,transparent_86%)] shadow-[0_0_34px_-18px_rgba(56,189,248,0.16)]",
  },
  {
    sizeClass: "size-[40%]",
    className:
      "border-sky-300/52 bg-[radial-gradient(circle_at_center,transparent_67%,rgba(255,255,255,0.34)_80%,transparent_87%)] shadow-[0_0_26px_-16px_rgba(56,189,248,0.12)]",
  },
] as const

const orbitNodes = [
  { icon: Mail, label: "邮箱", orbitSize: "size-[92%]", angle: 18 },
  { icon: Gitlab, label: "GitLab", orbitSize: "size-[92%]", angle: 138 },
  { icon: Github, label: "GitHub", orbitSize: "size-[92%]", angle: 258 },
  { icon: Smartphone, label: "手机", orbitSize: "size-[74%]", angle: 62 },
  { icon: Server, label: "服务器", orbitSize: "size-[74%]", angle: 182 },
  { icon: HardDrive, label: "共享盘", orbitSize: "size-[74%]", angle: 302 },
  { icon: LaptopMinimal, label: "电脑", orbitSize: "size-[56%]", angle: 106 },
  { icon: Database, label: "数据库", orbitSize: "size-[56%]", angle: 226 },
  { icon: BookText, label: "内网 Wiki", orbitSize: "size-[56%]", angle: 346 },
  { icon: AppWindow, label: "浏览器", orbitSize: "size-[40%]", angle: 26 },
  { icon: CalendarDays, label: "日历", orbitSize: "size-[40%]", angle: 146 },
  { icon: Network, label: "内部 API", orbitSize: "size-[40%]", angle: 266 },
] as const

const orbitBaseDelay = {
  "size-[40%]": 0.34,
  "size-[56%]": 0.42,
  "size-[74%]": 0.5,
  "size-[92%]": 0.58,
} as const

function getNodeDelay(orbitSize: keyof typeof orbitBaseDelay, angle: number) {
  return orbitBaseDelay[orbitSize] + (angle / 360) * 0.1
}

export function LandingLocalAccessSection() {
  return (
    <section
      id="reach"
      data-landing-snap-section="true"
      className="landing-snap-section relative border-y border-border/50 bg-[linear-gradient(180deg,rgba(246,250,255,0.9),rgba(255,255,255,0.98))] py-18"
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.14),transparent_30%),radial-gradient(circle_at_bottom_right,rgba(45,212,191,0.1),transparent_34%)]" />

      <div className="relative mx-auto max-w-7xl px-6 lg:px-8">
        <div className="grid gap-12 lg:grid-cols-[0.84fr_1.16fr] lg:items-center lg:gap-14">
          <LandingReveal className="max-w-xl" x={-24}>
            <h2 className="font-display text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
              云端本地双协同
            </h2>
            <p className="mt-4 text-base leading-7 text-slate-600 sm:text-lg">
              云端里的数字团队不只停留在网页上需要时，它可以继续触达你的设备、浏览器和公司内部服务，把真实执行接进来
            </p>

            <LandingStagger className="mt-8 space-y-4" delay={0.08}>
              {accessHighlights.map((item) => (
                <LandingStaggerItem key={item.title} className="flex gap-4">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-slate-950 text-white shadow-lg shadow-slate-950/10">
                    <item.icon className="size-[18px]" />
                  </div>
                  <div>
                    <div className="text-[15px] font-semibold text-slate-950">{item.title}</div>
                    <p className="mt-1.5 text-sm leading-6 text-slate-600">{item.description}</p>
                  </div>
                </LandingStaggerItem>
              ))}
            </LandingStagger>
          </LandingReveal>

          <LandingReveal className="relative" delay={0.08} x={30} y={24} scale={0.985}>
            <div className="absolute left-2 top-12 size-36 rounded-full bg-sky-200/35 blur-3xl" />
            <div className="absolute right-3 bottom-12 size-44 rounded-full bg-emerald-200/30 blur-3xl" />

            <div className="relative mx-auto aspect-square w-full max-w-[720px]">
              <div className="pointer-events-none absolute inset-[18%] rounded-full bg-[radial-gradient(circle_at_center,rgba(125,211,252,0.13),rgba(255,255,255,0.04)_48%,transparent_66%)]" />

              {orbitTracks.map((track, index) => {
                const delay = 0.16 + (orbitTracks.length - index - 1) * 0.06

                return (
                  <div
                    key={track.sizeClass}
                    className={`pointer-events-none absolute left-1/2 top-1/2 ${track.sizeClass} -translate-x-1/2 -translate-y-1/2`}
                  >
                    <LandingReveal className="size-full" delay={delay} scale={0.9} y={0} duration={0.72}>
                      <div className={`size-full rounded-full border border-dashed ${track.className}`} />
                    </LandingReveal>
                  </div>
                )
              })}

              <div className="absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2">
                <LandingReveal className="relative" delay={0.1} y={0} scale={0.86} duration={0.7}>
                  <div className="absolute inset-0 rounded-full bg-sky-200/25 blur-3xl" />
                  <div className="relative flex size-20 items-center justify-center rounded-full border border-white/95 bg-[radial-gradient(circle_at_30%_28%,rgba(255,255,255,0.98),rgba(241,245,249,0.96)_58%,rgba(226,232,240,0.98))] shadow-[0_24px_54px_-26px_rgba(148,163,184,0.42)] ring-1 ring-slate-200/70 sm:size-24">
                    <div className="absolute inset-[10%] rounded-full border border-white/70" />
                    <Image src="/synapse.svg" alt="Synapse" width={72} height={72} className="relative size-8 sm:size-9" />
                  </div>
                </LandingReveal>
              </div>

              {orbitNodes.map((node) => (
                <div
                  key={node.label}
                  className={`absolute left-1/2 top-1/2 ${node.orbitSize} -translate-x-1/2 -translate-y-1/2`}
                >
                  <LandingReveal
                    className="size-full"
                    delay={getNodeDelay(node.orbitSize, node.angle)}
                    y={0}
                    scale={0.9}
                    duration={0.54}
                  >
                    <div className="relative size-full" style={{ transform: `rotate(${node.angle}deg)` }}>
                      <div className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2">
                        <div
                          className="relative drop-shadow-[0_12px_28px_rgba(148,163,184,0.18)]"
                          style={{ transform: `rotate(${-node.angle}deg)` }}
                        >
                          <div className="relative flex size-11 items-center justify-center rounded-full border border-white/95 bg-[radial-gradient(circle_at_30%_28%,rgba(255,255,255,0.98),rgba(248,250,252,0.96)_58%,rgba(226,232,240,0.98))] shadow-[0_18px_34px_-22px_rgba(56,189,248,0.28)] ring-1 ring-slate-200/70 sm:size-12">
                            <div className="absolute inset-[11%] rounded-full border border-white/12" />
                            <node.icon className="relative size-[16px] shrink-0 text-slate-950 sm:size-[18px]" />
                          </div>
                          <span className="absolute left-1/2 top-full mt-1.5 -translate-x-1/2 whitespace-nowrap text-[11px] font-medium tracking-tight text-slate-600 sm:text-xs">
                            {node.label}
                          </span>
                        </div>
                      </div>
                    </div>
                  </LandingReveal>
                </div>
              ))}
            </div>
          </LandingReveal>
        </div>
      </div>
    </section>
  )
}
