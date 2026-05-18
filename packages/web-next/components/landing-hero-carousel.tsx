"use client"

import { type ReactNode, useCallback, useEffect, useState } from "react"
import useEmblaCarousel from "embla-carousel-react"
import { m } from "framer-motion"

import { cn } from "@/lib/utils"

type HeroSlide = { id: string; node: ReactNode }

const ease: [number, number, number, number] = [0.22, 1, 0.36, 1]

export function LandingHeroCarousel({ slides }: { slides: HeroSlide[] }) {
  const [emblaRef, emblaApi] = useEmblaCarousel({
    loop: true,
    align: "center",
    skipSnaps: false,
    containScroll: "trimSnaps",
  })
  const [selected, setSelected] = useState(0)

  useEffect(() => {
    if (!emblaApi) return
    const onSelect = () => setSelected(emblaApi.selectedScrollSnap())
    onSelect()
    emblaApi.on("select", onSelect)
    emblaApi.on("reInit", onSelect)
    return () => {
      emblaApi.off("select", onSelect)
      emblaApi.off("reInit", onSelect)
    }
  }, [emblaApi])

  // Pause autoplay while the user is interacting; resume on a settled state.
  useEffect(() => {
    if (!emblaApi) return
    let userActive = false
    const onPointer = () => {
      userActive = true
    }
    const onSettled = () => {
      window.setTimeout(() => {
        userActive = false
      }, 1500)
    }
    emblaApi.on("pointerDown", onPointer)
    emblaApi.on("settle", onSettled)

    const id = window.setInterval(() => {
      if (document.hidden) return
      if (userActive) return
      emblaApi.scrollNext()
    }, 4800)

    return () => {
      emblaApi.off("pointerDown", onPointer)
      emblaApi.off("settle", onSettled)
      window.clearInterval(id)
    }
  }, [emblaApi])

  const scrollTo = useCallback(
    (index: number) => emblaApi?.scrollTo(index),
    [emblaApi]
  )

  return (
    <div className="relative -mx-4 mx-auto max-w-3xl">
      <div className="overflow-x-clip py-6" ref={emblaRef}>
        <div className="flex">
          {slides.map((slide, idx) => (
            <div
              key={slide.id}
              className="min-w-0 shrink-0 grow-0 basis-[88%] px-2 sm:basis-[76%] md:basis-[70%]"
            >
              <m.div
                animate={{
                  scale: selected === idx ? 1 : 0.94,
                  opacity: selected === idx ? 1 : 0.65,
                  y: selected === idx ? 0 : 6,
                }}
                transition={{ duration: 0.4, ease }}
              >
                {slide.node}
              </m.div>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-4 flex items-center justify-center gap-1.5">
        {slides.map((slide, idx) => (
          <button
            key={slide.id}
            type="button"
            aria-label={`查看第 ${idx + 1} 张卡片`}
            onClick={() => scrollTo(idx)}
            className={cn(
              "h-1.5 rounded-full transition-all",
              idx === selected
                ? "w-7 bg-slate-950"
                : "w-1.5 bg-slate-300/80 hover:bg-slate-400"
            )}
          />
        ))}
      </div>
    </div>
  )
}
