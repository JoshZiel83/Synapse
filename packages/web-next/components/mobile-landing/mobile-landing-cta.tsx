"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { AnimatePresence, m } from "framer-motion"
import { ArrowRight } from "lucide-react"

const ease: [number, number, number, number] = [0.22, 1, 0.36, 1]

export function MobileLandingStickyCta() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const onScroll = () => {
      const past = window.scrollY > 520
      const nearEnd =
        window.innerHeight + window.scrollY >=
        document.documentElement.scrollHeight - 240
      setVisible(past && !nearEnd)
    }
    onScroll()
    window.addEventListener("scroll", onScroll, { passive: true })
    window.addEventListener("resize", onScroll)
    return () => {
      window.removeEventListener("scroll", onScroll)
      window.removeEventListener("resize", onScroll)
    }
  }, [])

  return (
    <AnimatePresence>
      {visible ? (
        <m.div
          key="sticky"
          initial={{ y: 80, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 80, opacity: 0 }}
          transition={{ duration: 0.36, ease }}
          className="fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-30"
        >
          <div className="flex items-center gap-2 rounded-full border border-white/72 bg-white/90 p-1.5 pl-4 shadow-[0_22px_44px_-22px_rgba(15,23,42,0.4)] backdrop-blur-xl">
            <div className="flex flex-1 flex-col">
              <span className="text-[11px] font-medium text-slate-500">
                把 AI 组织成团队
              </span>
              <span className="text-[12.5px] font-semibold text-slate-950">
                现在开始搭建你的数字组织
              </span>
            </div>
            <Link
              href="/register"
              className="flex items-center gap-1.5 rounded-full bg-slate-950 px-3.5 py-2.5 text-[12.5px] font-semibold text-white transition-transform active:scale-[0.97]"
            >
              创建团队
              <ArrowRight className="size-3.5" />
            </Link>
          </div>
        </m.div>
      ) : null}
    </AnimatePresence>
  )
}

export function MobileLandingTail() {
  return (
    <section className="relative border-t border-border/50 bg-white/72 px-5 py-14 backdrop-blur-sm">
      <m.div
        initial={{ opacity: 0, y: 22 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.4 }}
        transition={{ duration: 0.56, ease }}
        className="mx-auto max-w-md text-center"
      >
        <h2 className="font-display text-[22px] leading-[1.2] font-semibold tracking-tight text-slate-950">
          把 AI 从聊天窗口，升级成团队能力
        </h2>
        <p className="mx-auto mt-3 max-w-[20rem] text-[13px] leading-6 text-slate-600">
          角色、记忆、授权、事件唤醒和执行环境都进入同一个中枢
        </p>
        <div className="mt-6 flex flex-col items-stretch gap-2">
          <Link
            href="/register"
            className="rounded-full bg-slate-950 px-5 py-3.5 text-[15px] font-semibold text-white shadow-[0_18px_32px_-16px_rgba(15,23,42,0.55)] transition-transform active:scale-[0.98]"
          >
            创建团队
          </Link>
          <Link
            href="#trust"
            className="rounded-full border border-slate-200/90 bg-white/85 px-5 py-3.5 text-[15px] font-semibold text-slate-800 backdrop-blur transition-colors active:bg-white"
          >
            了解私有部署
          </Link>
        </div>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-1.5 text-[10.5px] tracking-[0.18em] text-slate-400 uppercase">
          <span>Synapse</span>
          <span>·</span>
          <span>AI 协作运行时</span>
        </div>
      </m.div>
    </section>
  )
}
