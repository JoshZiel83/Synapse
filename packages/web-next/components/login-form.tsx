"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"

import { api } from "@/lib/api"
import { normalizeRedirectTarget } from "@/lib/auth"
import { cn } from "@/lib/utils"
import { useAuthStore } from "@/stores/auth-store"
import { AuthConversationPreview } from "@/components/auth-conversation-preview"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { WebQrLoginPanel } from "@/components/web-qr-login-panel"

export function LoginForm({
  className,
  ...props
}: React.ComponentProps<"div">) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const redirect = normalizeRedirectTarget(searchParams.get("redirect"))
  const { login } = useAuthStore()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [temporaryLogin, setTemporaryLogin] = useState(false)
  const [error, setError] = useState("")
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError("")
    setIsSubmitting(true)

    try {
      await login(email, password, {
        sessionPersistence: temporaryLogin ? "temporary" : "persistent",
      })

      if (redirect) {
        router.push(redirect)
        return
      }

      const result = await api.getWorkspaces()
      const workspaces = result?.data ?? result ?? []
      router.push(workspaces.length === 0 ? "/welcome" : "/dashboard")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed")
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <Card className="overflow-hidden p-0">
        <CardContent className="grid p-0 md:grid-cols-2">
          <div className="p-6 md:p-8">
            <Tabs defaultValue="password" className="flex flex-col gap-6">
              <div className="flex flex-col items-center text-center">
                <h1 className="text-2xl font-bold">Welcome back</h1>
              </div>

              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="password">Password</TabsTrigger>
                <TabsTrigger value="qr">Scan QR</TabsTrigger>
              </TabsList>

              <TabsContent value="password" className="mt-0">
                <form method="post" onSubmit={handleSubmit}>
                  <FieldGroup>
                    <Field data-invalid={Boolean(error) || undefined}>
                      <FieldLabel htmlFor="email">Email</FieldLabel>
                      <Input
                        id="email"
                        name="email"
                        type="email"
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        placeholder="you@example.com"
                        autoComplete="email"
                        aria-invalid={Boolean(error) || undefined}
                        required
                      />
                    </Field>
                    <Field data-invalid={Boolean(error) || undefined}>
                      <div className="flex items-center">
                        <FieldLabel htmlFor="password">Password</FieldLabel>
                        <Link
                          href="/login"
                          className="ms-auto text-sm underline-offset-2 hover:underline"
                        >
                          Forgot your password?
                        </Link>
                      </div>
                      <Input
                        id="password"
                        name="password"
                        type="password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        autoComplete="current-password"
                        aria-invalid={Boolean(error) || undefined}
                        required
                      />
                      <FieldError>{error}</FieldError>
                    </Field>
                    <Field>
                      <label className="flex items-center gap-3">
                        <Checkbox
                          checked={temporaryLogin}
                          onCheckedChange={(checked) =>
                            setTemporaryLogin(checked === true)
                          }
                        />
                        <span className="text-sm font-medium text-foreground">
                          Temporary login
                        </span>
                      </label>
                    </Field>
                    <Field>
                      <Button
                        type="submit"
                        disabled={isSubmitting}
                        className="w-full"
                      >
                        {isSubmitting ? "Signing in..." : "Sign in"}
                      </Button>
                    </Field>
                    <FieldDescription className="text-center">
                      Don&apos;t have an account?{" "}
                      <Link
                        href={
                          redirect
                            ? `/register?redirect=${encodeURIComponent(redirect)}`
                            : "/register"
                        }
                        className="underline-offset-2 hover:underline"
                      >
                        Sign up
                      </Link>
                    </FieldDescription>
                  </FieldGroup>
                </form>
              </TabsContent>

              <TabsContent value="qr" className="mt-0">
                <WebQrLoginPanel redirect={redirect} />
              </TabsContent>
            </Tabs>
          </div>
          <div className="relative hidden bg-muted md:block">
            <AuthConversationPreview />
          </div>
        </CardContent>
      </Card>
      <FieldDescription className="px-6 text-center">
        By clicking continue, you agree to our{" "}
        <Link href="/login" className="underline-offset-2 hover:underline">
          Terms of Service
        </Link>{" "}
        and{" "}
        <Link href="/login" className="underline-offset-2 hover:underline">
          Privacy Policy
        </Link>
        .
      </FieldDescription>
    </div>
  )
}
