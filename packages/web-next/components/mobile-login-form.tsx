"use client"

import { useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"

import { api } from "@/lib/api"
import { normalizeRedirectTarget } from "@/lib/auth"
import { useAuthStore } from "@/stores/auth-store"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export function MobileLoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const redirect = normalizeRedirectTarget(searchParams.get("redirect"))
  const { login } = useAuthStore()

  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError("")
    setIsSubmitting(true)

    try {
      await login(email, password)

      if (redirect) {
        router.push(redirect)
        return
      }

      const result = await api.getWorkspaces()
      const workspaces = result?.data ?? result ?? []
      router.push(workspaces.length === 0 ? "/m/welcome" : "/m")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed")
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <form className="space-y-5" onSubmit={handleSubmit}>
      <div className="space-y-2">
        <label htmlFor="mobile-login-email" className="text-sm font-medium text-foreground">
          Email
        </label>
        <Input
          id="mobile-login-email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
          required
          className="h-12 rounded-2xl bg-background"
        />
      </div>

      <div className="space-y-2">
        <label htmlFor="mobile-login-password" className="text-sm font-medium text-foreground">
          Password
        </label>
        <Input
          id="mobile-login-password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          required
          className="h-12 rounded-2xl bg-background"
        />
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <Button type="submit" className="h-12 w-full rounded-full" disabled={isSubmitting}>
        {isSubmitting ? "Signing in..." : "Sign in"}
      </Button>
    </form>
  )
}
