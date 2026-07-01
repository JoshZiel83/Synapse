"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useForm, Controller } from "react-hook-form"
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema"
import { z } from "zod"
import { Loader2, Monitor, QrCode } from "lucide-react"

import { getAuthErrorMessage, getOAuthErrorMessage } from "@/lib/auth-errors"
import { normalizeRedirectTarget } from "@/lib/auth"
import { resolveDestination } from "@/lib/post-login"
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
import { Checkbox } from "@/components/ui/checkbox"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@/components/ui/field"
import { EmailInput } from "@/components/ui/email-input"
import { PasswordInput } from "@/components/ui/password-input"
import { WebQrLoginPanel } from "@/components/web-qr-login-panel"

const loginSchema = z.object({
  email: z.email("请输入有效的邮箱地址"),
  password: z.string().min(1, "请输入密码"),
  temporaryLogin: z.boolean(),
})

type LoginFormValues = z.infer<typeof loginSchema>

/**
 * Folded-corner toggle in the card's top-right, the Alipay/WeChat affordance:
 * a tinted triangle peeling back the corner with a QR glyph. Clicking flips the
 * card between password and QR sign-in; the glyph swaps to a monitor to go back.
 */
function CornerSwitch({
  showingQr,
  onToggle,
}: {
  showingQr: boolean
  onToggle: () => void
}) {
  const Icon = showingQr ? Monitor : QrCode
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={showingQr ? "切换为密码登录" : "切换为扫码登录"}
      title={showingQr ? "密码登录" : "扫码登录"}
      className="group/corner absolute end-0 top-0 z-10 size-14 outline-none"
    >
      <span
        aria-hidden
        className="absolute inset-0 bg-primary/10 transition-colors [clip-path:polygon(100%_0,0_0,100%_100%)] group-hover/corner:bg-primary/20 group-focus-visible/corner:bg-primary/20 rtl:[clip-path:polygon(0_0,100%_0,0_100%)]"
      />
      <Icon className="absolute end-2.5 top-2.5 size-4 text-primary" />
    </button>
  )
}

export function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const redirect = normalizeRedirectTarget(searchParams.get("redirect"))
  const { login } = useAuthStore()
  // Surface an OAuth failure relayed via /auth/callback -> /login?error=<code>
  // (the full-page fallback path; the popup path reports inline instead).
  const [submitError, setSubmitError] = useState(() => {
    const oauthError = searchParams.get("error")
    return oauthError ? getOAuthErrorMessage(oauthError, "登录") : ""
  })
  const [showingQr, setShowingQr] = useState(false)

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
        temporary: values.temporaryLogin,
      })

      router.push(await resolveDestination(redirect))
    } catch (err) {
      setSubmitError(getAuthErrorMessage(err, "登录"))
    }
  })

  return (
    <AuthShell>
      <Card className="relative">
        <CornerSwitch
          showingQr={showingQr}
          onToggle={() => setShowingQr((value) => !value)}
        />
        <CardHeader className="text-center">
          <CardTitle className="text-xl">登录</CardTitle>
          <CardDescription>
            {showingQr
              ? "请使用 Synapse App 扫码登录"
              : "使用飞书、邮箱或扫码登录"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {showingQr ? (
            <WebQrLoginPanel redirect={redirect} />
          ) : (
            <form method="post" onSubmit={onSubmit} noValidate>
              <FieldGroup>
                <Field>
                  <FeishuSignInButton
                    actionLabel="登录"
                    redirect={redirect}
                    disabled={isSubmitting}
                    onError={setSubmitError}
                  />
                </Field>
                <FieldSeparator>或使用邮箱登录</FieldSeparator>
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
                        autoFocus
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
                  <FieldLabel htmlFor="password">密码</FieldLabel>
                  <Controller
                    control={control}
                    name="password"
                    render={({ field }) => (
                      <PasswordInput
                        {...field}
                        id="password"
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
                      仅在当前设备临时登录
                    </span>
                  </label>
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
                        正在登录
                      </>
                    ) : (
                      "登录"
                    )}
                  </Button>
                </Field>
                <FieldDescription className="text-center">
                  还没有账号？{" "}
                  <Link
                    href={
                      redirect
                        ? `/register?redirect=${encodeURIComponent(redirect)}`
                        : "/register"
                    }
                    className="underline-offset-2 hover:underline"
                  >
                    去注册
                  </Link>
                </FieldDescription>
              </FieldGroup>
            </form>
          )}
        </CardContent>
      </Card>
    </AuthShell>
  )
}
