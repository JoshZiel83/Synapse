import type { ReactNode } from "react"

type MobileAuthShellProps = {
  title: string
  description: string
  footer?: ReactNode
  children: ReactNode
}

export function MobileAuthShell({
  title,
  description,
  footer,
  children,
}: MobileAuthShellProps) {
  return (
    <div className="min-h-svh bg-[linear-gradient(180deg,color-mix(in_oklab,var(--color-muted)_72%,white)_0%,var(--color-background)_34%)] px-5 py-[calc(env(safe-area-inset-top)+2rem)]">
      <div className="mx-auto flex min-h-[calc(100svh-4rem)] w-full max-w-sm flex-col justify-between">
        <div>
          <div className="mb-10 space-y-2">
            <h1 className="text-3xl font-semibold tracking-tight text-foreground">
              {title}
            </h1>
            <p className="text-sm leading-6 text-muted-foreground">
              {description}
            </p>
          </div>
          {children}
        </div>
        {footer ? (
          <div className="pb-[calc(env(safe-area-inset-bottom)+0.5rem)] pt-8 text-center text-sm text-muted-foreground">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  )
}
