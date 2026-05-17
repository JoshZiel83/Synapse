"use client"

import type { ReactNode } from "react"
import { m, useReducedMotion } from "framer-motion"

import { cn } from "@/lib/utils"

const ease: [number, number, number, number] = [0.22, 1, 0.36, 1]

export function MobileReveal({
  children,
  className,
  delay = 0,
  y = 18,
  x = 0,
  scale = 1,
  duration = 0.55,
  amount = 0.25,
}: {
  children?: ReactNode
  className?: string
  delay?: number
  y?: number
  x?: number
  scale?: number
  duration?: number
  amount?: number
}) {
  const shouldReduceMotion = useReducedMotion()

  if (shouldReduceMotion) {
    return <div className={className}>{children}</div>
  }

  return (
    <m.div
      className={className}
      initial={{ opacity: 0, x, y, scale }}
      whileInView={{ opacity: 1, x: 0, y: 0, scale: 1 }}
      viewport={{ once: true, amount }}
      transition={{ duration, delay, ease }}
    >
      {children}
    </m.div>
  )
}

export function MobileSectionHeader({
  eyebrow,
  title,
  subtitle,
  className,
}: {
  eyebrow?: string
  title: string
  subtitle?: string
  className?: string
}) {
  return (
    <div className={cn("mx-auto max-w-md text-center", className)}>
      {eyebrow ? (
        <MobileReveal y={10}>
          <span className="inline-flex rounded-full border border-slate-200/80 bg-white/70 px-2.5 py-1 text-[10.5px] font-medium tracking-[0.18em] text-slate-500 uppercase backdrop-blur">
            {eyebrow}
          </span>
        </MobileReveal>
      ) : null}
      <MobileReveal y={16} delay={0.06}>
        <h2 className="font-display mt-3 text-[26px] leading-[1.18] font-semibold tracking-tight text-slate-950">
          {title}
        </h2>
      </MobileReveal>
      {subtitle ? (
        <MobileReveal y={14} delay={0.12}>
          <p className="mx-auto mt-3 max-w-[20rem] text-[13.5px] leading-6 text-slate-600">
            {subtitle}
          </p>
        </MobileReveal>
      ) : null}
    </div>
  )
}

export function MobileSection({
  id,
  className,
  children,
}: {
  id?: string
  className?: string
  children: ReactNode
}) {
  return (
    <section
      id={id}
      className={cn(
        "relative scroll-mt-[calc(env(safe-area-inset-top)+4rem)] px-5 py-14",
        className
      )}
    >
      {children}
    </section>
  )
}
