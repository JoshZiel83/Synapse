import Feather from "@expo/vector-icons/Feather";
import { ThemeProvider, type Theme } from "@react-navigation/native";
import { useFonts } from "expo-font";
import { ErrorBoundary, Stack, useRouter, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import "react-native-reanimated";
import "react-native-url-polyfill/auto";

import { AppProviders } from "@/providers/app-providers";
import { useSession } from "@/providers/session-provider";
import { theme } from "@/theme/tokens";

SplashScreen.preventAutoHideAsync().catch(() => undefined);

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
};

export { ErrorBoundary };

export const unstable_settings = {
  initialRouteName: "login",
};

export default function RootLayout() {
  const [loaded, error] = useFonts({
    ...Feather.font,
  });

  useEffect(() => {
    if (error) throw error;
  }, [error]);

  useEffect(() => {
    if (loaded) {
      void SplashScreen.hideAsync();
    }
  }, [loaded]);

  if (!loaded) {
    return null;
  }

  return (
    <AppProviders>
      <ThemeProvider value={navigationTheme}>
        <StatusBar style="dark" />
        <ProtectedNavigation />
      </ThemeProvider>
    </AppProviders>
  );
}

function ProtectedNavigation() {
  const router = useRouter();
  const segments = useSegments();
  const { status } = useSession();

  useEffect(() => {
    if (status === "loading") return;

    const first = segments[0];
    const isLoginRoute = first === "login";

    if (status === "unauthenticated" && !isLoginRoute) {
      router.replace("/login");
      return;
    }

    if (status === "authenticated" && isLoginRoute) {
      router.replace("/");
    }
  }, [router, segments, status]);

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: {
          backgroundColor: theme.colors.background,
        },
      }}
    >
      <Stack.Screen name="login" />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="search" />
      <Stack.Screen name="scan" />
      <Stack.Screen name="scan-login" />
      <Stack.Screen name="qr-login" />
      <Stack.Screen name="chat/[conversationId]" />
    </Stack>
  );
}
