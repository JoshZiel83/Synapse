import Feather from "@expo/vector-icons/Feather"
import { ThemeProvider, type Theme } from "@react-navigation/native"
import { useFonts } from "expo-font"
import {
  ErrorBoundary,
  Stack,
  useNavigationContainerRef,
  useRouter,
  useSegments,
} from "expo-router"
import Head from "expo-router/head"
import * as SplashScreen from "expo-splash-screen"
import { StatusBar } from "expo-status-bar"
import { useEffect } from "react"
import "react-native-reanimated"
import "react-native-url-polyfill/auto"
import "../global.css"

import "@/lib/chat-background-task"
import { AppProviders } from "@/providers/app-providers"
import { useSession } from "@/providers/session-provider"
import { useWorkspace } from "@/providers/workspace-provider"
import { theme } from "@/theme/tokens"
import * as Sentry from "@sentry/react-native"
import { isRunningInExpoGo } from "expo"

SplashScreen.preventAutoHideAsync().catch(() => undefined)

// Sentry crash + performance tracing. ENV-DRIVEN + DSN-gated; NO Session Replay
// (chat content privacy). Native source-map symbolication is wired via the
// @sentry/react-native/expo config plugin (app.json) + getSentryExpoConfig
// (metro.config.js), uploaded at EAS build time with SENTRY_* env.
const sentryDsn = process.env.EXPO_PUBLIC_SENTRY_DSN
// Module scope: referenced both in Sentry.init AND to register the navigation
// container in RootLayout. Both are REQUIRED to produce expo-router navigation/
// route spans (TTID/TTFD) — Sentry.wrap alone does not instrument routing.
const sentryNavigationIntegration = Sentry.reactNavigationIntegration({
  enableTimeToInitialDisplay: !isRunningInExpoGo(),
})
if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    environment:
      process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT ||
      (__DEV__ ? "development" : "production"),
    tracesSampleRate: Number(
      process.env.EXPO_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? "0.1"
    ),
    integrations: [sentryNavigationIntegration],
    enableNativeFramesTracking: !isRunningInExpoGo(),
    sendDefaultPii: false,
  })
}

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

function RootLayout() {
  const [loaded, error] = useFonts({
    ...Feather.font,
  })

  // Register the navigation container so Sentry produces expo-router route /
  // navigation spans (no-op when Sentry isn't configured).
  const navigationRef = useNavigationContainerRef()
  useEffect(() => {
    if (sentryDsn && navigationRef) {
      sentryNavigationIntegration.registerNavigationContainer(navigationRef)
    }
  }, [navigationRef])

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

// Wrap the root for Sentry (navigation/touch instrumentation + error capture).
// Safe no-op when Sentry isn't initialized (EXPO_PUBLIC_SENTRY_DSN unset).
export default Sentry.wrap(RootLayout)
