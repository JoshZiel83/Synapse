"use client"

import {
  AppWindow,
  Database,
  FileText,
  LockKeyhole,
  PlugZap,
  Search,
  ShieldCheck,
} from "lucide-react"

import {
  MobileReveal,
  MobileSection,
  MobileSectionHeader,
} from "./mobile-landing-primitives"

const highlights = [
  {
    icon: ShieldCheck,
    title: "官方维护",
    text: "内置能力可直接使用",
  },
  {
    icon: PlugZap,
    title: "装到工作区",
    text: "按角色或会话发放",
  },
  {
    icon: LockKeyhole,
    title: "统一授权",
    text: "谁能装谁能用一处管理",
  },
] as const

const plugins = [
  {
    name: "Zhipu Toolkit",
    summary: "网页搜索、文档读取、OCR",
    accent: "bg-sky-100 text-sky-900",
    meta: "官方维护",
    icon: Search,
  },
  {
    name: "Browser Operator",
    summary: "让数字员工操作真实浏览器",
    accent: "bg-emerald-100 text-emerald-900",
    meta: "官方维护",
    icon: AppWindow,
  },
  {
    name: "Docs Connector",
    summary: "文档、知识库、附件接入",
    accent: "bg-amber-100 text-amber-900",
    meta: "工作区常用",
    icon: FileText,
  },
  {
    name: "SQL Access",
    summary: "受控读取结构化数据",
    accent: "bg-violet-100 text-violet-900",
    meta: "受控访问",
    icon: Database,
  },
] as const

export function MobileLandingPlugins() {
  return (
    <MobileSection
      id="plugins"
      className="bg-[linear-gradient(180deg,rgba(247,250,255,0.45),rgba(255,255,255,0.96))]"
    >
      <MobileSectionHeader
        title="插件先进入工作区，再交给角色"
        subtitle="搜索、安装、分配、授权同一个后台搞定"
      />

      <div className="mx-auto mt-7 grid max-w-md grid-cols-3 gap-2">
        {highlights.map((item, idx) => (
          <MobileReveal
            key={item.title}
            y={14}
            delay={0.08 + idx * 0.06}
            className="rounded-2xl border border-white/72 bg-white/85 p-2.5 text-center shadow-[0_12px_24px_-22px_rgba(15,23,42,0.4)] backdrop-blur"
          >
            <div className="mx-auto flex size-8 items-center justify-center rounded-xl bg-slate-950 text-white">
              <item.icon className="size-[14px]" />
            </div>
            <div className="mt-2 text-[12px] font-semibold text-slate-950">
              {item.title}
            </div>
            <p className="mt-0.5 text-[10.5px] leading-[1.4] text-slate-500">
              {item.text}
            </p>
          </MobileReveal>
        ))}
      </div>

      <MobileReveal y={20} delay={0.22} className="mx-auto mt-6 max-w-md">
        <div className="rounded-[26px] border border-white/72 bg-white/92 p-3.5 shadow-[0_24px_50px_-32px_rgba(15,23,42,0.42)] backdrop-blur">
          <div className="flex items-center justify-between">
            <div className="text-[12.5px] font-semibold text-slate-950">
              官方插件市场
            </div>
            <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] text-slate-500">
              4 类 · 持续上新
            </span>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2.5">
            {plugins.map((plugin, idx) => (
              <MobileReveal
                key={plugin.name}
                y={12}
                delay={0.08 + idx * 0.05}
                className="rounded-2xl border border-slate-200 bg-slate-50/85 p-2.5"
              >
                <div className="flex items-center justify-between">
                  <div
                    className={`flex size-8 items-center justify-center rounded-xl ${plugin.accent}`}
                  >
                    <plugin.icon className="size-[14px]" />
                  </div>
                  <span className="rounded-full border border-slate-200 bg-white px-1.5 py-0.5 text-[9px] leading-none text-slate-500">
                    {plugin.meta}
                  </span>
                </div>
                <div className="mt-2 text-[12.5px] font-semibold text-slate-950">
                  {plugin.name}
                </div>
                <p className="mt-1 text-[10.5px] leading-[1.45] text-slate-600">
                  {plugin.summary}
                </p>
              </MobileReveal>
            ))}
          </div>
        </div>
      </MobileReveal>
    </MobileSection>
  )
}
