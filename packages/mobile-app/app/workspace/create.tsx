import Feather from "@expo/vector-icons/Feather"
import { Stack, useLocalSearchParams, useRouter } from "expo-router"
import { useEffect, useMemo, useState } from "react"
import {
  Alert,
  BackHandler,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native"

import { Button, Field, ScreenScroll, SectionBlock } from "@/components/ui"
import { api } from "@/lib/api"
import { useSession } from "@/providers/session-provider"
import { useWorkspace } from "@/providers/workspace-provider"
import { theme } from "@/theme/tokens"

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "创建工作区失败。"
}

export default function CreateWorkspaceScreen() {
  const router = useRouter()
  const params = useLocalSearchParams<{ required?: string }>()
  const { signOut } = useSession()
  const { needsOnboarding, refreshWorkspaces, workspaces } = useWorkspace()
  const [name, setName] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const requiresWorkspaceCreation = useMemo(
    () =>
      params.required === "1" || (needsOnboarding && workspaces.length === 0),
    [needsOnboarding, params.required, workspaces.length]
  )

  async function leaveToLogin() {
    await signOut()
    router.replace("/login")
  }

  function confirmLeaveWithoutWorkspace() {
    Alert.alert(
      "需要先创建工作区",
      "创建工作区后才能继续使用。继续返回会退出当前账号，并回到登录页。",
      [
        {
          text: "继续创建",
          style: "cancel",
        },
        {
          text: "退出登录",
          style: "destructive",
          onPress: () => {
            void leaveToLogin()
          },
        },
      ]
    )
  }

  function handleBackPress() {
    if (requiresWorkspaceCreation) {
      confirmLeaveWithoutWorkspace()
      return
    }

    router.back()
  }

  useEffect(() => {
    if (!requiresWorkspaceCreation) {
      return
    }

    const subscription = BackHandler.addEventListener(
      "hardwareBackPress",
      () => {
        confirmLeaveWithoutWorkspace()
        return true
      }
    )

    return () => subscription.remove()
  }, [requiresWorkspaceCreation])

  async function handleCreateWorkspace() {
    const nextName = name.trim()
    if (!nextName) {
      setError("请输入工作区名称。")
      return
    }

    setSubmitting(true)
    setError(null)

    try {
      const workspace = await api.createWorkspace(nextName)
      await refreshWorkspaces(workspace.id)
      router.replace("/")
    } catch (nextError) {
      setError(getErrorMessage(nextError))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <ScreenScroll topPadding={0} bottomPadding={56}>
      <Stack.Screen
        options={{
          gestureEnabled: !requiresWorkspaceCreation,
        }}
      />

      <View style={styles.header}>
        <Pressable onPress={handleBackPress} style={styles.headerButton}>
          <Feather name="chevron-left" size={20} color={theme.colors.text} />
        </Pressable>
        <Text numberOfLines={1} style={styles.headerTitle}>
          创建工作区
        </Text>
        <View style={styles.headerSpacer} />
      </View>

      <SectionBlock>
        <Text style={styles.introTitle}>开始你的第一个工作区</Text>
        <Text style={styles.introCopy}>
          为团队、项目或个人协作创建一个独立工作区。创建完成后会自动进入首页。
        </Text>
      </SectionBlock>

      <SectionBlock>
        <Field
          label="工作区名称"
          placeholder="例如：产品组 / My Team"
          value={name}
          onChangeText={setName}
          returnKeyType="done"
          onSubmitEditing={() => void handleCreateWorkspace()}
        />
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        <Button
          label={submitting ? "创建中..." : "创建工作区"}
          icon="plus"
          onPress={() => void handleCreateWorkspace()}
          disabled={submitting}
        />
      </SectionBlock>
    </ScreenScroll>
  )
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingTop: 10,
    paddingBottom: 4,
  },
  headerButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  headerTitle: {
    flex: 1,
    fontSize: 20,
    fontWeight: "800",
    color: theme.colors.text,
  },
  headerSpacer: {
    width: 36,
  },
  introTitle: {
    fontSize: 18,
    fontWeight: "800",
    color: theme.colors.text,
  },
  introCopy: {
    fontSize: 14,
    lineHeight: 22,
    color: theme.colors.textMuted,
  },
  errorText: {
    fontSize: 13,
    lineHeight: 18,
    color: theme.colors.danger,
  },
})
