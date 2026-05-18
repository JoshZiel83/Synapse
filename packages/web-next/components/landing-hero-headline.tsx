"use client"

import { useCallback, useEffect, useMemo, useState } from "react"

const headlineSteps = [
  { lead: "像", tail: "一样思考" },
  { lead: "像", tail: "一样管理" },
  { lead: "像", tail: "一样记忆" },
  { lead: "与", tail: "一起协作" },
  { lead: "与", tail: "一起交互" },
] as const

const IDLE_MS = 2100
const TRANSITION_MS = 480
const TRANSITION_EASING = "cubic-bezier(0.77, 0, 0.18, 1)"
const CHAR_HEIGHT = "1.12em"

function HumanMark() {
  return (
    <span className="mx-0.5 inline-flex items-center justify-center rounded-[0.38em] bg-primary/12 px-[0.24em] py-[0.08em] text-primary shadow-[inset_0_0_0_1px_rgba(59,130,246,0.08)] sm:mx-1 sm:px-[0.3em]">
      人类
    </span>
  )
}

function StaticChar({ char }: { char: string }) {
  return (
    <span
      className="inline-flex items-center justify-center"
      style={{ height: CHAR_HEIGHT, lineHeight: CHAR_HEIGHT }}
    >
      {char}
    </span>
  )
}

function RollingChar({
  currentChar,
  nextChar,
  isAnimating,
}: {
  currentChar: string
  nextChar: string
  isAnimating: boolean
}) {
  const offset = isAnimating ? `-${CHAR_HEIGHT}` : "0px"

  return (
    <span
      className="relative inline-block overflow-hidden align-baseline"
      style={{
        height: CHAR_HEIGHT,
        lineHeight: CHAR_HEIGHT,
        minWidth: "1em",
      }}
    >
      <span
        className="flex flex-col will-change-transform"
        style={{
          transform: `translate3d(0, ${offset}, 0)`,
          transition: isAnimating
            ? `transform ${TRANSITION_MS}ms ${TRANSITION_EASING}`
            : "none",
        }}
      >
        <span
          className="flex items-center justify-center"
          style={{ height: CHAR_HEIGHT, lineHeight: CHAR_HEIGHT }}
        >
          {currentChar}
        </span>
        <span
          className="flex items-center justify-center"
          style={{ height: CHAR_HEIGHT, lineHeight: CHAR_HEIGHT }}
        >
          {nextChar}
        </span>
      </span>
    </span>
  )
}

function HeadlineChar({
  currentChar,
  nextChar,
  isAnimating,
}: {
  currentChar: string
  nextChar: string
  isAnimating: boolean
}) {
  if (currentChar === nextChar) {
    return <StaticChar char={currentChar} />
  }
  return (
    <RollingChar
      currentChar={currentChar}
      nextChar={nextChar}
      isAnimating={isAnimating}
    />
  )
}

function getStepChars(stepIndex: number) {
  const step = headlineSteps[stepIndex]
  return [step.lead, ...Array.from(step.tail)]
}

export function LandingHeroHeadline() {
  const [currentIndex, setCurrentIndex] = useState(0)
  const [nextIndex, setNextIndex] = useState(headlineSteps.length > 1 ? 1 : 0)
  const [isAnimating, setIsAnimating] = useState(false)

  useEffect(() => {
    if (headlineSteps.length < 2 || isAnimating) return
    const timer = window.setTimeout(() => setIsAnimating(true), IDLE_MS)
    return () => window.clearTimeout(timer)
  }, [currentIndex, isAnimating])

  useEffect(() => {
    if (!isAnimating) return
    const timer = window.setTimeout(() => {
      setCurrentIndex(nextIndex)
      setNextIndex((nextIndex + 1) % headlineSteps.length)
      setIsAnimating(false)
    }, TRANSITION_MS + 40)
    return () => window.clearTimeout(timer)
  }, [isAnimating, nextIndex])

  const currentChars = useMemo(() => getStepChars(currentIndex), [currentIndex])
  const nextChars = useMemo(() => getStepChars(nextIndex), [nextIndex])

  const renderChar = useCallback(
    (i: number) => (
      <HeadlineChar
        key={`${i}-${currentChars[i]}-${nextChars[i]}`}
        currentChar={currentChars[i]}
        nextChar={nextChars[i]}
        isAnimating={isAnimating}
      />
    ),
    [currentChars, nextChars, isAnimating]
  )

  return (
    <div className="font-display animate-fade-up mt-6 text-[clamp(2rem,7vw,5rem)] leading-[0.96] font-semibold tracking-tight text-slate-950">
      <div className="inline-flex max-w-full flex-nowrap items-center justify-center gap-x-1 leading-none whitespace-nowrap sm:gap-x-1.5">
        <span>让 AI</span>
        <span className="inline-flex items-center text-primary">
          {renderChar(0)}
        </span>
        <HumanMark />
        <span className="inline-flex items-center text-primary">
          {currentChars.slice(1).map((_, idx) => renderChar(idx + 1))}
        </span>
      </div>
    </div>
  )
}
