"use client"

import { useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"

import { normalizeRedirectTarget } from "@/lib/auth"
import { getMobileWebAuthOptions } from "@/lib/client-device"
import { useAuthStore } from "@/stores/auth-store"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export function MobileSignupForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const redirect = normalizeRedirectTarget(searchParams.get("redirect"))
  const { register } = useAuthStore()

  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [error, setError] = useState("")
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError("")

    if (password !== confirmPassword) {
      setError("Passwords do not match")
      return
    }

    if (password.length < 8) {
      setError("Password must be at least 8 characters")
      return
    }

    setIsSubmitting(true)

    try {
      await register(email, password, name, getMobileWebAuthOptions())
      router.push(redirect ?? "/m/welcome")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed")
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <form className="space-y-5" onSubmit={handleSubmit}>
      <div className="space-y-2">
        <label htmlFor="mobile-signup-name" className="text-sm font-medium text-foreground">
          Name
        </label>
        <Input
          id="mobile-signup-name"
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Jane Doe"
          autoComplete="name"
          required
          className="h-12 rounded-2xl bg-background"
        />
      </div>

      <div className="space-y-2">
        <label htmlFor="mobile-signup-email" className="text-sm font-medium text-foreground">
          Email
        </label>
        <Input
          id="mobile-signup-email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
          required
          className="h-12 rounded-2xl bg-background"
        />
      </div>

      <div className="grid grid-cols-1 gap-5">
        <div className="space-y-2">
          <label htmlFor="mobile-signup-password" className="text-sm font-medium text-foreground">
            Password
          </label>
          <Input
            id="mobile-signup-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            required
            className="h-12 rounded-2xl bg-background"
          />
        </div>

        <div className="space-y-2">
          <label htmlFor="mobile-signup-confirm-password" className="text-sm font-medium text-foreground">
            Confirm password
          </label>
          <Input
            id="mobile-signup-confirm-password"
            type="password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            autoComplete="new-password"
            required
            className="h-12 rounded-2xl bg-background"
          />
        </div>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <Button type="submit" className="h-12 w-full rounded-full" disabled={isSubmitting}>
        {isSubmitting ? "Creating account..." : "Create account"}
      </Button>
    </form>
  )
}
