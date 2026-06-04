import Feather from "@expo/vector-icons/Feather"
import { Image } from "expo-image"
import { Link, useRouter } from "expo-router"
import { useState } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"

import { Button, Field, ScreenScroll } from "@/components/ui"
import { EmailField } from "@/components/email-field"
import { getAuthErrorMessage } from "@/lib/auth-errors"
import { useSession } from "@/providers/session-provider"
import { theme } from "@/theme/tokens"
import { APP_NAME } from "@shared"

export default function RegisterScreen() {
  const router = useRouter()
  const { signUp } = useSession()
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [acceptedPolicy, setAcceptedPolicy] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleRegister() {
    if (!name.trim() || !email.trim() || !password) {
      setError("请完整填写昵称、邮箱和密码。")
      return
    }

    if (password.length < 8) {
      setError("密码至少需要 8 位。")
      return
    }

    if (!acceptedPolicy) {
      setError("请先勾选隐私政策与用户协议。")
      return
    }

    setSubmitting(true)
    setError(null)

    try {
      await signUp(name.trim(), email.trim(), password)
      router.replace("/")
    } catch (nextError) {
      setError(getAuthErrorMessage(nextError, "注册失败，请检查填写信息。"))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <ScreenScroll
      topPadding={0}
      bottomPadding={40}
      contentContainerStyle={styles.content}
    >
      <View style={styles.shell}>
        <View style={styles.logoWrap}>
          <Image
            source={require("../assets/images/synapse.svg")}
            style={styles.logoImage}
            contentFit="contain"
          />
          <Text style={styles.appName}>注册 {APP_NAME}</Text>
        </View>

        <View style={styles.formSection}>
          <Field
            label="昵称"
            placeholder="请输入你的名字"
            autoCorrect={false}
            value={name}
            onChangeText={setName}
          />
          <EmailField
            label="邮箱"
            placeholder="请输入邮箱"
            autoCapitalize="none"
            keyboardType="email-address"
            autoCorrect={false}
            autoComplete="email"
            textContentType="emailAddress"
            value={email}
            onChangeText={setEmail}
          />
          <Field
            label="密码"
            placeholder="至少 8 位密码"
            secureTextEntry
            autoComplete="password-new"
            textContentType="newPassword"
            returnKeyType="go"
            value={password}
            onChangeText={setPassword}
            onSubmitEditing={() => void handleRegister()}
          />

          <Pressable
            onPress={() => setAcceptedPolicy((current) => !current)}
            style={({ pressed }) => [
              styles.policyRow,
              pressed && styles.policyRowPressed,
            ]}
          >
            <View
              style={[
                styles.checkbox,
                acceptedPolicy && styles.checkboxChecked,
              ]}
            >
              {acceptedPolicy ? (
                <Feather name="check" size={14} color={theme.colors.white} />
              ) : null}
            </View>
            <Text style={styles.policyText}>
              我已阅读并同意
              <Text style={styles.policyLink}>《用户协议》</Text>和
              <Text style={styles.policyLink}>《隐私政策》</Text>
            </Text>
          </Pressable>

          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          <Button
            label={submitting ? "注册中..." : "注册"}
            onPress={() => void handleRegister()}
            disabled={submitting}
          />

          <View style={styles.footerRow}>
            <Text style={styles.footerLabel}>已有账号？</Text>
            <Link href="/login" asChild>
              <Pressable>
                <Text style={styles.footerLink}>去登录</Text>
              </Pressable>
            </Link>
          </View>
        </View>
      </View>
    </ScreenScroll>
  )
}

const styles = StyleSheet.create({
  content: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: 24,
    paddingVertical: 32,
  },
  shell: {
    gap: 28,
  },
  logoWrap: {
    alignItems: "center",
    gap: 10,
    paddingTop: 28,
    paddingBottom: 8,
  },
  logoImage: {
    width: 84,
    height: 84,
  },
  appName: {
    fontSize: 28,
    fontWeight: "800",
    color: theme.colors.text,
  },
  formSection: {
    gap: 16,
    paddingTop: 8,
  },
  policyRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  policyRowPressed: {
    opacity: 0.8,
  },
  checkbox: {
    width: 20,
    height: 20,
    marginTop: 1,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: theme.colors.borderStrong,
    backgroundColor: theme.colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxChecked: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.primary,
  },
  policyText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 20,
    color: theme.colors.textMuted,
  },
  policyLink: {
    color: theme.colors.primary,
    fontWeight: "700",
  },
  errorText: {
    fontSize: 13,
    lineHeight: 18,
    color: theme.colors.danger,
  },
  footerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  footerLabel: {
    fontSize: 13,
    color: theme.colors.textMuted,
  },
  footerLink: {
    fontSize: 13,
    fontWeight: "700",
    color: theme.colors.primary,
  },
})
