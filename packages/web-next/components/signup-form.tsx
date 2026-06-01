"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useForm, Controller } from "react-hook-form"
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema"
import { z } from "zod"

import { normalizeRedirectTarget } from "@/lib/auth"
import { cn } from "@/lib/utils"
import { useAuthStore } from "@/stores/auth-store"
import { AuthConversationPreview } from "@/components/auth-conversation-preview"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"

const signupSchema = z
  .object({
    name: z.string().min(1, "Full name is required"),
    email: z.email("Enter a valid email address"),
    password: z.string().min(8, "Password must be at least 8 characters"),
    confirmPassword: z.string().min(1, "Please confirm your password"),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  })

type SignupFormValues = z.infer<typeof signupSchema>

export function SignupForm({
  className,
  ...props
}: React.ComponentProps<"div">) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const redirect = normalizeRedirectTarget(searchParams.get("redirect"))
  const { register } = useAuthStore()
  const [submitError, setSubmitError] = useState("")

  const {
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignupFormValues>({
    resolver: standardSchemaResolver(signupSchema),
    defaultValues: {
      name: "",
      email: "",
      password: "",
      confirmPassword: "",
    },
  })

  const onSubmit = handleSubmit(async (values) => {
    setSubmitError("")
    try {
      await register(values.email, values.password, values.name)
      router.push(redirect ?? "/welcome")
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Registration failed")
    }
  })

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <Card className="overflow-hidden p-0">
        <CardContent className="grid p-0 md:grid-cols-2">
          <form
            className="p-6 md:p-8"
            method="post"
            onSubmit={onSubmit}
            noValidate
          >
            <FieldGroup>
              <div className="flex flex-col items-center text-center">
                <h1 className="text-2xl font-bold">Create your account</h1>
              </div>
              <Field data-invalid={Boolean(errors.name) || undefined}>
                <FieldLabel htmlFor="name">Full name</FieldLabel>
                <Controller
                  control={control}
                  name="name"
                  render={({ field }) => (
                    <Input
                      {...field}
                      id="name"
                      type="text"
                      placeholder="Jane Doe"
                      autoComplete="name"
                      aria-invalid={Boolean(errors.name) || undefined}
                    />
                  )}
                />
                <FieldError
                  errors={
                    errors.name ? [{ message: errors.name.message }] : undefined
                  }
                />
              </Field>
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
              <Field>
                <Field className="grid grid-cols-2 gap-4">
                  <Field data-invalid={Boolean(errors.password) || undefined}>
                    <FieldLabel htmlFor="password">Password</FieldLabel>
                    <Controller
                      control={control}
                      name="password"
                      render={({ field }) => (
                        <Input
                          {...field}
                          id="password"
                          type="password"
                          autoComplete="new-password"
                          aria-invalid={Boolean(errors.password) || undefined}
                        />
                      )}
                    />
                  </Field>
                  <Field
                    data-invalid={Boolean(errors.confirmPassword) || undefined}
                  >
                    <FieldLabel htmlFor="confirm-password">
                      Confirm Password
                    </FieldLabel>
                    <Controller
                      control={control}
                      name="confirmPassword"
                      render={({ field }) => (
                        <Input
                          {...field}
                          id="confirm-password"
                          type="password"
                          autoComplete="new-password"
                          aria-invalid={
                            Boolean(errors.confirmPassword) || undefined
                          }
                        />
                      )}
                    />
                  </Field>
                </Field>
                <FieldError
                  errors={
                    errors.password
                      ? [{ message: errors.password.message }]
                      : errors.confirmPassword
                        ? [{ message: errors.confirmPassword.message }]
                        : submitError
                          ? [{ message: submitError }]
                          : undefined
                  }
                />
              </Field>
              <Field>
                <Button
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full"
                >
                  {isSubmitting ? "Creating account..." : "Create account"}
                </Button>
              </Field>
              <FieldDescription className="text-center">
                Already have an account?{" "}
                <Link
                  href={
                    redirect
                      ? `/login?redirect=${encodeURIComponent(redirect)}`
                      : "/login"
                  }
                  className="underline-offset-2 hover:underline"
                >
                  Sign in
                </Link>
              </FieldDescription>
            </FieldGroup>
          </form>
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
