"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useForm, Controller } from "react-hook-form"
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema"
import { z } from "zod"

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

const loginSchema = z.object({
  email: z.email("Enter a valid email address"),
  password: z.string().min(1, "Password is required"),
  temporaryLogin: z.boolean(),
})

type LoginFormValues = z.infer<typeof loginSchema>

export function LoginForm({
  className,
  ...props
}: React.ComponentProps<"div">) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const redirect = normalizeRedirectTarget(searchParams.get("redirect"))
  const { login } = useAuthStore()
  const [submitError, setSubmitError] = useState("")

  const {
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormValues>({
    resolver: standardSchemaResolver(loginSchema),
    defaultValues: { email: "", password: "", temporaryLogin: false },
  })

  const onSubmit = handleSubmit(async (values) => {
    setSubmitError("")
    try {
      await login(values.email, values.password, {
        sessionPersistence: values.temporaryLogin ? "temporary" : "persistent",
      })

      if (redirect) {
        router.push(redirect)
        return
      }

      const result = await api.getWorkspaces()
      const workspaces = result?.data ?? result ?? []
      router.push(workspaces.length === 0 ? "/welcome" : "/dashboard")
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Login failed")
    }
  })

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
                <form method="post" onSubmit={onSubmit} noValidate>
                  <FieldGroup>
                    <Field data-invalid={Boolean(errors.email) || undefined}>
                      <FieldLabel htmlFor="email">Email</FieldLabel>
                      <Controller
                        control={control}
                        name="email"
                        render={({ field }) => (
                          <Input
                            {...field}
                            id="email"
                            type="email"
                            placeholder="you@example.com"
                            autoComplete="email"
                            aria-invalid={Boolean(errors.email) || undefined}
                          />
                        )}
                      />
                      <FieldError
                        errors={
                          errors.email
                            ? [{ message: errors.email.message }]
                            : undefined
                        }
                      />
                    </Field>
                    <Field data-invalid={Boolean(errors.password) || undefined}>
                      <div className="flex items-center">
                        <FieldLabel htmlFor="password">Password</FieldLabel>
                        <Link
                          href="/login"
                          className="ms-auto text-sm underline-offset-2 hover:underline"
                        >
                          Forgot your password?
                        </Link>
                      </div>
                      <Controller
                        control={control}
                        name="password"
                        render={({ field }) => (
                          <Input
                            {...field}
                            id="password"
                            type="password"
                            autoComplete="current-password"
                            aria-invalid={Boolean(errors.password) || undefined}
                          />
                        )}
                      />
                      <FieldError
                        errors={
                          errors.password
                            ? [{ message: errors.password.message }]
                            : submitError
                              ? [{ message: submitError }]
                              : undefined
                        }
                      />
                    </Field>
                    <Field>
                      <label className="flex items-center gap-3">
                        <Controller
                          control={control}
                          name="temporaryLogin"
                          render={({ field }) => (
                            <Checkbox
                              checked={field.value}
                              onCheckedChange={(checked) =>
                                field.onChange(checked === true)
                              }
                            />
                          )}
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
