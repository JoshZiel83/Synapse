"use client"

import { useEffect } from "react"

/**
 * Landing section navigation.
 *
 * The former wheel-hijack snap engine has been replaced by native CSS scroll-snap
 * (see `html.landing-snap-root` + `.landing-snap-section` in globals.css), which
 * is accessible, dependency-free, and respects prefers-reduced-motion via CSS.
 *
 * This component now only:
 *  1. toggles the `landing-snap-root` class on <html> while the landing page is
 *     mounted (so scroll-snap is scoped to the landing route), and
 *  2. provides a small keyboard-nav island (ArrowUp/ArrowDown jump between
 *     sections) that CSS scroll-snap doesn't cover.
 */

const SNAP_ROOT_CLASS = "landing-snap-root"

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target.closest("input, textarea, select, [contenteditable='true']") !== null
  )
}

export function LandingSnapScrollController() {
  useEffect(() => {
    const root = document.documentElement
    root.classList.add(SNAP_ROOT_CLASS)

    const isEnabled = () =>
      window.matchMedia(
        "(min-width: 1024px) and (pointer: fine) and (min-height: 1000px)"
      ).matches &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches

    const getSections = () =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          "[data-landing-snap-section='true']"
        )
      )

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isEnabled()) return
      if (event.defaultPrevented) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (isTypingTarget(event.target)) return

      const direction =
        event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : null
      if (direction === null) return

      const sections = getSections()
      if (sections.length === 0) return

      // Find the section closest to the current viewport top, then jump one over.
      const probeY = window.scrollY + window.innerHeight * 0.18
      let currentIndex = 0
      let closest = Number.POSITIVE_INFINITY
      sections.forEach((section, index) => {
        const distance = Math.abs(section.offsetTop - probeY)
        if (distance < closest) {
          closest = distance
          currentIndex = index
        }
      })

      const nextIndex = Math.min(
        sections.length - 1,
        Math.max(0, currentIndex + direction)
      )
      if (nextIndex === currentIndex) return

      event.preventDefault()
      window.scrollTo({
        top: sections[nextIndex].offsetTop,
        behavior: "smooth",
      })
    }

    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      root.classList.remove(SNAP_ROOT_CLASS)
    }
  }, [])

  return null
}
