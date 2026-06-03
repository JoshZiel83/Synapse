import { createAuthClient } from "better-auth/react"
import { expoClient } from "@better-auth/expo/client"
import {
  genericOAuthClient,
  deviceAuthorizationClient,
} from "better-auth/client/plugins"
import * as SecureStore from "expo-secure-store"
import { Platform } from "react-native"

import { AUTH_ORIGIN } from "@/lib/config"

/**
 * Platform-aware synchronous storage for the Expo cookie-jar.
 *
 * `@better-auth/expo`'s expoClient persists the Better Auth session cookie via
 * `storage.getItem`/`setItem`. On native we back it with expo-secure-store; on
 * web (`Platform.OS === "web"`) expo-secure-store's native module is empty and
 * `SecureStore.getItem` THROWS, so we fall back to `localStorage` (and the
 * browser cookie jar is used anyway).
 */
const authStorage =
  Platform.OS === "web"
    ? {
        getItem: (key: string): string | null =>
          typeof window !== "undefined"
            ? window.localStorage.getItem(key)
            : null,
        setItem: (key: string, value: string): void => {
          if (typeof window !== "undefined") {
            window.localStorage.setItem(key, value)
          }
        },
      }
    : {
        getItem: (key: string) => SecureStore.getItem(key),
        setItem: (key: string, value: string) =>
          SecureStore.setItem(key, value),
      }

export const authClient = createAuthClient({
  // Public origin Better Auth is mounted on; basePath rides the same /api/v1
  // path the rest of the app uses (the BA client default is /api/auth).
  baseURL: AUTH_ORIGIN,
  basePath: "/api/v1/auth",
  plugins: [
    expoClient({
      scheme: "synapse",
      storagePrefix: "synapse",
      storage: authStorage,
    }),
    genericOAuthClient(),
    deviceAuthorizationClient(),
  ],
})

export const { signIn, signUp, signOut, useSession, getCookie } = authClient

/**
 * Extract the single Better Auth session-cookie VALUE from the cookie-jar's
 * `Cookie` header string, for the contexts that must use `Authorization:
 * Bearer <token>` instead of a Cookie header (DOM/WebView, service worker,
 * media `<img>`/fetch, and the WS auth frame — `Cookie` is a forbidden header
 * there). The signed value (which contains a `.`) is what the server's bearer
 * plugin verifies; we never send the whole `a=b; c=d` cookie string as a token.
 *
 * Returns null on web (the cookie-jar is empty there; web uses the browser
 * cookie store) or when no session cookie is present.
 */
export function getSessionBearerToken(): string | null {
  const header = getCookie()
  if (!header) return null
  for (const part of header.split(";")) {
    const eq = part.indexOf("=")
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    // Match the session cookie regardless of the production __Secure- prefix.
    if (name === "synapse_session" || name === "__Secure-synapse_session") {
      return value || null
    }
  }
  return null
}
