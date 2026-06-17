import "server-only"

import { cache } from "react"
import { cookies, headers } from "next/headers"
import type { AuthSessionSummary, User } from "@synapse/shared"
import { buildApiProxyUrl } from "@/lib/api-origin"

export interface ServerAuthState {
  status: "authenticated" | "unauthenticated" | "unavailable"
  user: User | null
  session: AuthSessionSummary | null
}

export const getServerAuthState = cache(async (): Promise<ServerAuthState> => {
  const cookieStore = await cookies()
  // No cheap cookie-name precheck: Better Auth's session cookie carries an
  // environment-dependent `__Secure-` prefix. If there are no cookies at all we
  // can still short-circuit, otherwise ask the backend.
  if (cookieStore.getAll().length === 0) {
    return { status: "unauthenticated", user: null, session: null }
  }

  const requestHeaders = await headers()

  try {
    const response = await fetch(buildApiProxyUrl("/auth/me"), {
      method: "GET",
      headers: {
        cookie: cookieStore.toString(),
        "user-agent": requestHeaders.get("user-agent") ?? "",
        "x-forwarded-for": requestHeaders.get("x-forwarded-for") ?? "",
        "x-forwarded-proto": requestHeaders.get("x-forwarded-proto") ?? "",
        "x-forwarded-host":
          requestHeaders.get("x-forwarded-host") ??
          requestHeaders.get("host") ??
          "",
      },
      cache: "no-store",
    })

    if (response.status === 401) {
      return { status: "unauthenticated", user: null, session: null }
    }

    if (!response.ok) {
      return { status: "unavailable", user: null, session: null }
    }

    const payload = (await response.json()) as {
      data?: {
        user?: User
        session?: AuthSessionSummary
      }
    }

    return {
      status: "authenticated",
      user: payload.data?.user ?? null,
      session: payload.data?.session ?? null,
    }
  } catch {
    return { status: "unavailable", user: null, session: null }
  }
})
