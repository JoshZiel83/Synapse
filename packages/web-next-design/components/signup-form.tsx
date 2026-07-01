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
    name: z.string().min(1, "请输入姓名"),
    email: z.email("请输入有效的邮箱地址"),
    password: z.string().min(8, "密码至少需要 8 个字符"),
    confirmPassword: z.string().min(1, "请再次输入密码"),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "两次输入的密码不一致",
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
      setSubmitError(getAuthErrorMessage(err, "注册"))
    }
  })

  return (
    <AuthShell>
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl">注册</CardTitle>
          <CardDescription>创建 Synapse 账号</CardDescription>
        </CardHeader>
        <CardContent>
          <form method="post" onSubmit={onSubmit} noValidate>
            <FieldGroup>
              <Field>
                <FeishuSignInButton
                  actionLabel="注册"
                  redirect={redirect}
                  disabled={isSubmitting}
                  onError={setSubmitError}
                />
              </Field>
              <FieldSeparator>或使用邮箱注册</FieldSeparator>
              <Field data-invalid={Boolean(errors.name) || undefined}>
                <FieldLabel htmlFor="name">姓名</FieldLabel>
                <Controller
                  control={control}
                  name="name"
                  render={({ field }) => (
                    <Input
                      {...field}
                      id="name"
                      type="text"
                      placeholder="例如：张三"
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
                <FieldLabel htmlFor="email">邮箱</FieldLabel>
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
                    <FieldLabel htmlFor="password">密码</FieldLabel>
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
                    <FieldLabel htmlFor="confirm-password">确认密码</FieldLabel>
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
                      正在创建账号
                    </>
                  ) : (
                    "创建账号"
                  )}
                </Button>
              </Field>
              <FieldDescription className="text-center">
                已有账号？{" "}
                <Link
                  href={
                    redirect
                      ? `/login?redirect=${encodeURIComponent(redirect)}`
                      : "/login"
                  }
                  className="underline-offset-2 hover:underline"
                >
                  去登录
                </Link>
              </FieldDescription>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </AuthShell>
  )
}
