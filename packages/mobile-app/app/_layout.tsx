import Feather from "@expo/vector-icons/Feather"
import { ThemeProvider, type Theme } from "@react-navigation/native"
import { useFonts } from "expo-font"
import { ErrorBoundary, Stack, useRouter, useSegments } from "expo-router"
import Head from "expo-router/head"
import * as SplashScreen from "expo-splash-screen"
import { StatusBar } from "expo-status-bar"
import { useEffect } from "react"
import "react-native-reanimated"
import "react-native-url-polyfill/auto"

import "@/lib/chat-background-task"
import { AppProviders } from "@/providers/app-providers"
import { useSession } from "@/providers/session-provider"
import { useWorkspace } from "@/providers/workspace-provider"
import { theme } from "@/theme/tokens"

SplashScreen.preventAutoHideAsync().catch(() => undefined)

const navigationTheme: Theme = {
  dark: false,
  colors: {
    primary: theme.colors.primary,
    background: theme.colors.background,
    card: theme.colors.surface,
    text: theme.colors.text,
    border: theme.colors.border,
    notification: theme.colors.accent,
  },
  fonts: {
    regular: {
      fontFamily: "System",
      fontWeight: "400",
    },
    medium: {
      fontFamily: "System",
      fontWeight: "500",
    },
    bold: {
      fontFamily: "System",
      fontWeight: "700",
    },
    heavy: {
      fontFamily: theme.fonts.display,
      fontWeight: "700",
    },
  },
}

export { ErrorBoundary }

export const unstable_settings = {
  initialRouteName: "login",
}

export default function RootLayout() {
  const [loaded, error] = useFonts({
    ...Feather.font,
  })

  useEffect(() => {
    if (error) throw error
  }, [error])

  useEffect(() => {
    if (loaded) {
      void SplashScreen.hideAsync()
    }
  }, [loaded])

  if (!loaded) {
    return null
  }

  return (
    <>
      <Head>
        <title>Synapse Mobile</title>
        <meta property="og:title" content="Synapse Mobile" />
      </Head>
      <AppProviders>
        <ThemeProvider value={navigationTheme}>
          <StatusBar style="dark" />
          <ProtectedNavigation />
        </ThemeProvider>
      </AppProviders>
    </>
  )
}

function ProtectedNavigation() {
  const router = useRouter()
  const segments = useSegments()
  const { status } = useSession()
  const { loading: workspaceLoading, needsOnboarding } = useWorkspace()
  const defaultAnimation =
    process.env.EXPO_OS === "web"
      ? "none"
      : process.env.EXPO_OS === "ios"
        ? "default"
        : "slide_from_right"

  useEffect(() => {
    if (status === "loading") return

    // useSegments() narrows to a tuple sized by the current route depth.
    // Widen to a sparse string[] so checking depth-2 segments on a depth-1
    // route doesn't error at compile time.
    const segmentPath = segments as readonly string[]
    const first = segmentPath[0]
    const second = segmentPath[1]
    const isAuthRoute = first === "login" || first === "register"
    const isWorkspaceCreateRoute = first === "workspace" && second === "create"

    if (status === "unauthenticated" && !isAuthRoute) {
      router.replace("/login")
      return
    }

    if (status !== "authenticated") {
      return
    }

    if (workspaceLoading) {
      return
    }

    if (needsOnboarding && !isWorkspaceCreateRoute) {
      router.replace("/workspace/create?required=1")
      return
    }

    if (!needsOnboarding && isAuthRoute) {
      router.replace("/")
    }
  }, [needsOnboarding, router, segments, status, workspaceLoading])

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        animation: defaultAnimation,
        animationMatchesGesture: process.env.EXPO_OS === "ios",
        contentStyle: {
          backgroundColor: theme.colors.background,
        },
        title: "Synapse Mobile",
        fullScreenGestureEnabled: process.env.EXPO_OS === "ios",
        gestureEnabled: true,
      }}
    >
      <Stack.Screen
        name="(tabs)"
        options={{
          animation: "none",
          gestureEnabled: false,
        }}
      />
      <Stack.Screen
        name="login"
        options={{
          animation: process.env.EXPO_OS === "web" ? "none" : "fade",
          gestureEnabled: false,
        }}
      />
      <Stack.Screen
        name="register"
        options={{
          animation: defaultAnimation,
        }}
      />
      <Stack.Screen
        name="workspace/create"
        options={{
          animation: defaultAnimation,
        }}
      />
    </Stack>
  )
}
