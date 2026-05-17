"use client"

import { useState, useEffect } from "react"
import Image from "next/image"
import Link from "next/link"
import { Menu, X, MonitorSmartphone } from "lucide-react"
import { AnimatePresence, m } from "framer-motion"

const navItems = [
  { href: "#collab", label: "协作" },
  { href: "#sharing", label: "共享" },
  { href: "#roles", label: "角色" },
  { href: "#plugins", label: "插件" },
  { href: "#reach", label: "执行" },
  { href: "#events", label: "事件" },
  { href: "#trust", label: "治理" },
] as const

export function MobileLandingNav() {
  const [open, setOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => window.removeEventListener("scroll", onScroll)
  }, [])

  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  return (
    <>
      <header
        className={`fixed inset-x-0 top-0 z-40 px-3 pt-[max(0.5rem,env(safe-area-inset-top))] transition-all duration-300 ${
          scrolled ? "pb-2" : "pb-3"
        }`}
      >
        <div
          className={`relative mx-auto flex items-center justify-between gap-3 rounded-full border px-3 py-2 backdrop-blur-2xl transition-all duration-300 ${
            scrolled
              ? "border-white/70 bg-white/82 shadow-[0_18px_38px_-24px_rgba(15,23,42,0.32)]"
              : "border-white/60 bg-white/55 shadow-[0_14px_30px_-26px_rgba(15,23,42,0.18)]"
          }`}
        >
          <Link href="/m" className="flex items-center gap-2 pl-1">
            <Image src="/synapse.svg" alt="Synapse" width={22} height={22} />
            <span className="font-display text-[15px] font-semibold tracking-tight text-foreground">
              Synapse
            </span>
          </Link>

          <div className="flex items-center gap-1.5">
            <Link
              href="/"
              className="flex items-center gap-1 rounded-full border border-slate-200/80 bg-white/70 px-2.5 py-1 text-[11px] text-slate-500 transition-colors active:bg-white"
              title="访问桌面版"
            >
              <MonitorSmartphone className="size-3.5" />
              桌面版
            </Link>
            <button
              type="button"
              aria-expanded={open}
              aria-label="打开菜单"
              onClick={() => setOpen((value) => !value)}
              className="flex size-9 items-center justify-center rounded-full border border-slate-200/80 bg-white/85 text-slate-700 transition-colors active:bg-white"
            >
              {open ? <X className="size-4" /> : <Menu className="size-4" />}
            </button>
          </div>
        </div>
      </header>

      <AnimatePresence>
        {open ? (
          <m.div
            key="overlay"
            className="fixed inset-0 z-30 bg-slate-950/30 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => setOpen(false)}
          />
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {open ? (
          <m.nav
            key="drawer"
            initial={{ y: -16, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -16, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="fixed inset-x-3 top-[calc(env(safe-area-inset-top)+3.5rem)] z-40 overflow-hidden rounded-3xl border border-white/72 bg-white/96 p-2 shadow-[0_28px_60px_-30px_rgba(15,23,42,0.36)] backdrop-blur-2xl"
          >
            <ul className="grid grid-cols-2 gap-1">
              {navItems.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={() => setOpen(false)}
                    className="block rounded-2xl px-3.5 py-3 text-sm font-medium text-slate-700 transition-colors active:bg-slate-100"
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex gap-2 px-2 pt-1 pb-2">
              <Link
                href="/register"
                onClick={() => setOpen(false)}
                className="flex-1 rounded-full bg-slate-950 px-4 py-2.5 text-center text-sm font-medium text-white"
              >
                创建团队
              </Link>
              <Link
                href="/login"
                onClick={() => setOpen(false)}
                className="flex-1 rounded-full border border-slate-200 bg-white px-4 py-2.5 text-center text-sm font-medium text-slate-700"
              >
                登录
              </Link>
            </div>
          </m.nav>
        ) : null}
      </AnimatePresence>
    </>
  )
}
