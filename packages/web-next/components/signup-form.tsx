"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useForm, Controller } from "react-hook-form"
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema"
import { z } from "zod"
import { Loader2 } from "lucide-react"

import { getAuthErrorMessage } from "@/lib/auth-errors"
import { normalizeRedirectTarget } from "@/lib/auth"
import { useAuthStore } from "@/stores/auth-store"
import { AuthShell } from "@/components/auth-shell"
import { FeishuSignInButton } from "@/components/feishu-sign-in-button"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@/components/ui/field"
import { EmailInput } from "@/components/ui/email-input"
import { Input } from "@/components/ui/input"
import { PasswordInput } from "@/components/ui/password-input"

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

export function SignupForm() {
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
      setSubmitError(getAuthErrorMessage(err))
    }
  })

  return (
    <AuthShell>
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl">Create your account</CardTitle>
          <CardDescription>
            Start collaborating in your Synapse workspace
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form method="post" onSubmit={onSubmit} noValidate>
            <FieldGroup>
              <Field>
                <FeishuSignInButton
                  redirect={redirect}
                  disabled={isSubmitting}
                  onError={setSubmitError}
                />
              </Field>
              <FieldSeparator>Or sign up with email</FieldSeparator>
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
                      autoFocus
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
                    <EmailInput
                      {...field}
                      id="email"
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
                        <PasswordInput
                          {...field}
                          id="password"
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
                        <PasswordInput
                          {...field}
                          id="confirm-password"
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
                  {isSubmitting ? (
                    <>
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                      Creating account...
                    </>
                  ) : (
                    "Create account"
                  )}
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
        </CardContent>
      </Card>
    </AuthShell>
  )
}
