import {
  ArrowRightLeft,
  BadgeCheck,
  Building2,
  LaptopMinimal,
  LockKeyhole,
  ScrollText,
  UsersRound,
} from "lucide-react"

import {
  LandingReveal,
  LandingStagger,
  LandingStaggerItem,
} from "@/components/landing-motion"
import { Card, CardContent } from "@/components/ui/card"

const personalEnvironment = ["个人工具", "个人记忆", "本地设备"] as const

const teamEnvironment = ["团队工具", "共享角色", "统一权限"] as const

const roleRows = [
  {
    role: "平台管理员",
    summary: "管理成员、模型组和平台级配置。",
    tone: "bg-slate-950 text-white",
  },
  {
    role: "工作区管理员",
    summary: "安装插件、分配角色、配置设备和资源。",
    tone: "bg-sky-100 text-sky-950",
  },
  {
    role: "成员",
    summary: "发起任务、查看结果、使用被授权能力。",
    tone: "bg-slate-100 text-slate-700",
  },
] as const

const auditItems = [
  {
    time: "09:42",
    action: "Browser Operator 装入团队环境",
    detail: "由工作区管理员发起。",
  },
  {
    time: "09:45",
    action: "Risk Analyst 获得 SQL Access",
    detail: "权限范围限制为只读查询。",
  },
  {
    time: "09:47",
    action: "Celine 在个人环境启用 Docs Connector",
    detail: "仅个人可见，不影响团队环境。",
  },
  {
    time: "09:52",
    action: "凌晨巡检任务触发并写入共享记忆",
    detail: "事件链路完整记录。",
  },
] as const

export function LandingTeamGovernanceSection() {
  return (
    <section
      id="trust"
      data-landing-snap-section="true"
      className="landing-snap-section relative w-full bg-[linear-gradient(180deg,rgba(247,250,255,0.8),rgba(255,255,255,0.96))] py-18"
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-full bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.12),transparent_28%),radial-gradient(circle_at_bottom_right,rgba(45,212,191,0.1),transparent_32%)]" />

      <div className="landing-priority-frame relative mx-auto flex max-w-7xl flex-col px-6 lg:px-8">
        <LandingReveal className="landing-priority-copy mx-auto max-w-3xl text-center">
          <h2 className="font-display text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
            管理数字团队，也该像管理真实团队一样清楚
          </h2>
          <p className="mt-4 text-base leading-7 text-slate-600 sm:text-lg">
            个人环境和团队环境并行，角色权限、资源归属和关键动作都能看清、回收、追溯
          </p>
        </LandingReveal>

        <div className="landing-priority-showcase relative mt-8 lg:mt-12">
          <div className="absolute top-10 -left-10 size-36 rounded-full bg-sky-200/35 blur-3xl" />
          <div className="absolute -right-2 bottom-10 size-40 rounded-full bg-emerald-200/30 blur-3xl" />

          <LandingStagger
            className="grid gap-4 xl:grid-cols-[1.12fr_0.94fr_0.94fr]"
            delay={0.12}
            stagger={0.1}
          >
            <LandingStaggerItem>
              <Card className="relative gap-0 rounded-[34px] border border-white/72 bg-white/92 py-0 shadow-[0_40px_110px_-58px_rgba(15,23,42,0.48)]">
                <CardContent className="p-5 lg:p-6">
                  <div className="flex items-center gap-3">
                    <div className="flex size-10 items-center justify-center rounded-2xl bg-slate-950 text-white">
                      <UsersRound className="size-[18px]" />
                    </div>
                    <div>
                      <div className="text-sm font-semibold text-slate-950">
                        个人和团队并行
                      </div>
                      <div className="mt-1 text-[11px] text-slate-500">
                        个人可以保留自己的工具和记忆，团队也能统一配置公共能力
                      </div>
                    </div>
                  </div>

                  <LandingStagger
                    className="mt-5 space-y-3"
                    delay={0.08}
                    stagger={0.08}
                  >
                    <LandingStaggerItem className="rounded-[28px] border border-slate-200 bg-[linear-gradient(180deg,rgba(248,250,252,0.96),rgba(241,245,249,0.88))] p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <div className="flex size-10 items-center justify-center rounded-2xl bg-white text-slate-950 ring-1 ring-slate-200/70">
                            <LaptopMinimal className="size-[18px]" />
                          </div>
                          <div>
                            <div className="text-sm font-semibold text-slate-950">
                              个人环境
                            </div>
                            <div className="mt-1 text-[11px] text-slate-500">
                              给自己配工具，也可以选择共享给团队
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="mt-4 flex flex-wrap gap-2">
                        {personalEnvironment.map((item) => (
                          <span
                            key={item}
                            className="rounded-full border border-slate-200 bg-white px-3 py-1 text-[12px] text-slate-600"
                          >
                            {item}
                          </span>
                        ))}
                      </div>
                    </LandingStaggerItem>

                    <LandingStaggerItem className="flex items-center justify-center">
                      <div className="flex flex-col items-center gap-2 py-1">
                        <div className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-400 shadow-[0_12px_24px_-18px_rgba(15,23,42,0.2)]">
                          <ArrowRightLeft className="size-4" />
                        </div>
                        <div className="rounded-full border border-slate-200 bg-white px-3 py-1 text-[11px] leading-none text-slate-500">
                          可共享
                        </div>
                      </div>
                    </LandingStaggerItem>

                    <LandingStaggerItem className="rounded-[28px] border border-sky-200 bg-[linear-gradient(180deg,rgba(240,249,255,0.96),rgba(236,253,245,0.82))] p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <div className="flex size-10 items-center justify-center rounded-2xl bg-white text-slate-950 ring-1 ring-sky-200/70">
                            <Building2 className="size-[18px]" />
                          </div>
                          <div>
                            <div className="text-sm font-semibold text-slate-950">
                              团队环境
                            </div>
                            <div className="mt-1 text-[11px] text-slate-500">
                              统一配置公共能力，供多人复用
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="mt-4 flex flex-wrap gap-2">
                        {teamEnvironment.map((item) => (
                          <span
                            key={item}
                            className="rounded-full border border-sky-200/70 bg-white px-3 py-1 text-[12px] text-slate-600"
                          >
                            {item}
                          </span>
                        ))}
                      </div>
                    </LandingStaggerItem>
                  </LandingStagger>
                </CardContent>
              </Card>
            </LandingStaggerItem>

            <LandingStaggerItem>
              <Card className="relative gap-0 rounded-[34px] border border-white/72 bg-white/92 py-0 shadow-[0_40px_110px_-58px_rgba(15,23,42,0.48)]">
                <CardContent className="p-5 lg:p-6">
                  <div className="flex items-center gap-3">
                    <div className="flex size-10 items-center justify-center rounded-2xl bg-slate-950 text-white">
                      <LockKeyhole className="size-[18px]" />
                    </div>
                    <div>
                      <div className="text-sm font-semibold text-slate-950">
                        权限分层
                      </div>
                      <div className="mt-1 text-[11px] text-slate-500">
                        谁能装、谁能用、谁能改，一眼看清
                      </div>
                    </div>
                  </div>

                  <LandingStagger
                    className="mt-5 space-y-3"
                    delay={0.08}
                    stagger={0.08}
                  >
                    {roleRows.map((item) => (
                      <LandingStaggerItem
                        key={item.role}
                        className="rounded-[22px] border border-slate-200 bg-slate-50/88 p-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-sm font-semibold text-slate-950">
                              {item.role}
                            </div>
                            <div className="mt-1 text-[12px] leading-5 text-slate-500">
                              {item.summary}
                            </div>
                          </div>
                          <div
                            className={`rounded-full px-2.5 py-1 text-[11px] leading-none ${item.tone}`}
                          >
                            生效中
                          </div>
                        </div>
                      </LandingStaggerItem>
                    ))}
                  </LandingStagger>
                </CardContent>
              </Card>
            </LandingStaggerItem>

            <LandingStaggerItem>
              <Card className="relative gap-0 rounded-[34px] border border-white/72 bg-white/92 py-0 shadow-[0_40px_110px_-58px_rgba(15,23,42,0.48)]">
                <CardContent className="p-5 lg:p-6">
                  <div className="flex items-center gap-3">
                    <div className="flex size-10 items-center justify-center rounded-2xl bg-slate-950 text-white">
                      <ScrollText className="size-[18px]" />
                    </div>
                    <div>
                      <div className="text-sm font-semibold text-slate-950">
                        审计留痕
                      </div>
                      <div className="mt-1 text-[11px] text-slate-500">
                        关键动作和环境变化都有记录
                      </div>
                    </div>
                  </div>

                  <LandingStagger
                    className="mt-5 space-y-3"
                    delay={0.08}
                    stagger={0.08}
                  >
                    {auditItems.map((item) => (
                      <LandingStaggerItem
                        key={`${item.time}-${item.action}`}
                        className="flex gap-3"
                      >
                        <div className="pt-1">
                          <div className="flex size-6 items-center justify-center rounded-full bg-slate-100 text-slate-500">
                            <BadgeCheck className="size-3.5" />
                          </div>
                        </div>
                        <div className="rounded-[22px] border border-slate-200 bg-slate-50/88 px-3.5 py-3">
                          <div className="text-[11px] font-medium text-slate-400">
                            {item.time}
                          </div>
                          <div className="mt-1 text-[13px] font-semibold text-slate-950">
                            {item.action}
                          </div>
                          <div className="mt-1 text-[12px] leading-5 text-slate-500">
                            {item.detail}
                          </div>
                        </div>
                      </LandingStaggerItem>
                    ))}
                  </LandingStagger>
                </CardContent>
              </Card>
            </LandingStaggerItem>
          </LandingStagger>
        </div>
      </div>
    </section>
  )
}
