"use client"

import * as React from "react"
import { Eye, EyeOff } from "lucide-react"

import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"

/**
 * Password field with a reveal toggle and a Caps Lock warning. Click the eye to
 * peek at the value; click again to hide. The plaintext is auto-hidden on blur
 * so a revealed password never lingers on screen after the user moves on. When
 * Caps Lock is detected while typing, a hint appears below the field, the single
 * most common cause of a "wrong password" that isn't.
 */
function PasswordInput({
  className,
  onBlur,
  onKeyDown,
  onKeyUp,
  ...props
}: Omit<React.ComponentProps<typeof Input>, "type">) {
  const [visible, setVisible] = React.useState(false)
  const [capsLock, setCapsLock] = React.useState(false)

  const syncCapsLock = (event: React.KeyboardEvent<HTMLInputElement>) => {
    setCapsLock(event.getModifierState?.("CapsLock") ?? false)
  }

  return (
    <div className="relative">
      <Input
        {...props}
        type={visible ? "text" : "password"}
        className={cn("pe-9", className)}
        onKeyDown={(event) => {
          syncCapsLock(event)
          onKeyDown?.(event)
        }}
        onKeyUp={(event) => {
          syncCapsLock(event)
          onKeyUp?.(event)
        }}
        onBlur={(event) => {
          setVisible(false)
          setCapsLock(false)
          onBlur?.(event)
        }}
      />
      <button
        type="button"
        // Keep focus in the input so toggling doesn't blur (which would
        // immediately re-hide via onBlur) and doesn't break tab flow.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setVisible((value) => !value)}
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        tabIndex={-1}
        className="absolute end-0 top-0 flex h-9 w-9 items-center justify-center rounded-e-4xl text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none"
      >
        {visible ? (
          <EyeOff className="size-4" aria-hidden />
        ) : (
          <Eye className="size-4" aria-hidden />
        )}
      </button>
      {capsLock ? (
        <p
          role="status"
          className="mt-1.5 text-xs text-amber-600 dark:text-amber-500"
        >
          Caps Lock is on
        </p>
      ) : null}
    </div>
  )
}

export { PasswordInput }
