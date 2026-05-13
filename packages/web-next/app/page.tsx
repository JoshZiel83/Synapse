import type { Metadata } from "next"
import Image from "next/image"
import Link from "next/link"

import { LandingCollaborationSection } from "@/components/landing-collaboration-section"
import { LandingEventDrivenSection } from "@/components/landing-event-driven-section"
import { LandingHeroHeadline } from "@/components/landing-hero-headline"
import { LandingHeroStack } from "@/components/landing-hero-stack"
import { LandingLocalAccessSection } from "@/components/landing-local-access-section"
import { LandingMotionProvider } from "@/components/landing-motion-provider"
import { LandingPluginMarketSection } from "@/components/landing-plugin-market-section"
import { LandingReveal } from "@/components/landing-motion"
import { LandingSnapScrollController } from "@/components/landing-snap-scroll-controller"
import { LandingTalentPoolSection } from "@/components/landing-talent-pool-section"
import { LandingTeamGovernanceSection } from "@/components/landing-team-governance-section"
import { Button } from "@/components/ui/button"

export const metadata: Metadata = {
  title: "让 AI 成为数字员工",
  description:
    "Synapse 是云端数字员工组织运行时，让岗位、记忆、权限、工具和协作关系在同一套中枢里持续运转",
}

export default function HomePage() {
  return (
    <main className="relative min-h-screen overflow-x-hidden bg-[linear-gradient(180deg,#f3f9ff_0%,#f6f8fb_36%,#ffffff_100%)] text-foreground">
      <LandingSnapScrollController />
      <LandingMotionProvider>
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[42rem] bg-[radial-gradient(circle_at_top_left,rgba(45,212,191,0.18),transparent_34%),radial-gradient(circle_at_top_right,rgba(56,189,248,0.2),transparent_32%),linear-gradient(180deg,rgba(15,23,42,0.04),transparent_62%)]" />
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(15,23,42,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(15,23,42,0.03)_1px,transparent_1px)] [mask-image:linear-gradient(180deg,rgba(0,0,0,0.7),transparent_85%)] bg-[size:28px_28px]" />

        <header className="fixed inset-x-0 top-4 z-40 px-4 sm:px-6 lg:px-8">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-6 rounded-full border border-white/70 bg-white/58 px-5 py-3 shadow-[0_24px_70px_-44px_rgba(15,23,42,0.55)] backdrop-blur-2xl lg:px-6">
            <Link href="/" className="flex items-center gap-2.5">
              <Image src="/synapse.svg" alt="Synapse" width={28} height={28} />
              <div className="font-display text-lg font-semibold tracking-tight text-foreground">
                Synapse
              </div>
            </Link>

            <nav className="hidden items-center gap-6 text-sm text-muted-foreground lg:flex">
              <Link
                href="#difference"
                className="transition-colors hover:text-foreground/90"
              >
                定位
              </Link>
              <Link
                href="#capabilities"
                className="transition-colors hover:text-foreground/90"
              >
                人才
              </Link>
              <Link
                href="#plugins"
                className="transition-colors hover:text-foreground/90"
              >
                插件
              </Link>
              <Link
                href="#reach"
                className="transition-colors hover:text-foreground/90"
              >
                接入
              </Link>
              <Link
                href="#events"
                className="transition-colors hover:text-foreground/90"
              >
                事件
              </Link>
              <Link
                href="#trust"
                className="transition-colors hover:text-foreground/90"
              >
                治理
              </Link>
            </nav>
          </div>
        </header>

        <section
          data-landing-snap-section="true"
          className="landing-snap-section relative mx-auto max-w-7xl px-6 pt-28 pb-18 lg:px-8 lg:pt-32 lg:pb-24"
        >
          <div className="landing-priority-frame flex flex-col gap-8 lg:gap-12">
            <div className="landing-priority-copy mx-auto max-w-4xl text-center">
              <div style={{ animationDelay: "80ms" }}>
                <LandingHeroHeadline />
              </div>

              <p
                className="animate-fade-up mx-auto mt-6 max-w-2xl text-base leading-7 text-slate-600 sm:text-lg"
                style={{ animationDelay: "160ms" }}
              >
                把协作、记忆和授权收进同一套数字组织运行时
              </p>

              <div
                className="animate-fade-up mt-8 flex flex-wrap items-center justify-center gap-3"
                style={{ animationDelay: "240ms" }}
              >
                <Button asChild size="lg">
                  <Link href="/register">创建团队</Link>
                </Button>
                <Button
                  asChild
                  size="lg"
                  variant="outline"
                  className="border-border/70 bg-white/70"
                >
                  <Link href="#trust">私有部署</Link>
                </Button>
              </div>
            </div>

            <div className="landing-priority-showcase">
              <LandingHeroStack />
            </div>
          </div>
        </section>

        <LandingCollaborationSection />

        <LandingTalentPoolSection />

        <LandingPluginMarketSection />

        <LandingLocalAccessSection />

        <LandingEventDrivenSection />

        <LandingTeamGovernanceSection />

        <section
          data-landing-tail="true"
          className="relative border-t border-border/50 bg-white/65 py-18 backdrop-blur-sm"
        >
          <LandingReveal
            className="mx-auto max-w-5xl px-6 text-center lg:px-8"
            y={28}
          >
            <h2 className="font-display text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl">
              把 AI 从对话工具，升级为组织能力
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-lg leading-8 text-slate-600">
              你不需要再围着单个聊天框搭流程让岗位、记忆、权限、工具和设备协作关系都进入同一个中枢
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Button asChild size="lg">
                <Link href="/register">创建团队</Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link href="#trust">私有部署</Link>
              </Button>
            </div>
          </LandingReveal>
        </section>
      </LandingMotionProvider>
    </main>
  )
}
