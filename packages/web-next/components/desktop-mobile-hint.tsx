"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { AnimatePresence, m } from "framer-motion"
import { Smartphone, X } from "lucide-react"

const STORAGE_KEY = "synapse:mobile-hint-dismissed"
const MAX_WIDTH = 720
const ease: [number, number, number, number] = [0.22, 1, 0.36, 1]

export function DesktopMobileHint() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (typeof window === "undefined") return
    if (sessionStorage.getItem(STORAGE_KEY) === "1") return

    const mq = window.matchMedia(`(max-width: ${MAX_WIDTH}px)`)
    const evaluate = () => {
      setVisible(mq.matches)
    }
    evaluate()
    if (mq.addEventListener) {
      mq.addEventListener("change", evaluate)
      return () => mq.removeEventListener("change", evaluate)
    }
    mq.addListener(evaluate)
    return () => mq.removeListener(evaluate)
  }, [])

  const dismiss = () => {
    sessionStorage.setItem(STORAGE_KEY, "1")
    setVisible(false)
  }

  return (
    <AnimatePresence>
      {visible ? (
        <m.div
          key="mobile-hint"
          initial={{ y: 80, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 80, opacity: 0 }}
          transition={{ duration: 0.36, ease }}
          className="fixed inset-x-3 bottom-3 z-30"
        >
          <div className="mx-auto flex max-w-md items-center gap-3 rounded-full border border-white/72 bg-white/95 px-3 py-2.5 shadow-[0_22px_44px_-22px_rgba(15,23,42,0.45)] backdrop-blur-xl">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-slate-950 text-white">
              <Smartphone className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] font-semibold text-slate-950">
                屏幕较窄？
              </div>
              <div className="mt-0.5 text-[11px] leading-4 text-slate-500">
                我们为窄屏专门设计了移动版页面
              </div>
            </div>
            <Link
              href="/m?mobile=1"
              onClick={dismiss}
              className="rounded-full bg-slate-950 px-3.5 py-2 text-[12px] font-semibold text-white transition-transform active:scale-[0.97]"
            >
              切换
            </Link>
            <button
              type="button"
              aria-label="忽略"
              onClick={dismiss}
              className="flex size-7 shrink-0 items-center justify-center rounded-full text-slate-400 transition-colors active:bg-slate-100"
            >
              <X className="size-4" />
            </button>
          </div>
        </m.div>
      ) : null}
    </AnimatePresence>
  )
}
