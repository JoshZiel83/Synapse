import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { AUTH_SESSION_COOKIE_NAME, buildLoginRedirect } from "./lib/auth"
import { buildApiProxyUrl } from "./lib/api-origin"

const PROTECTED_PREFIXES = [
  "/dashboard",
  "/settings",
  "/roles",
  "/platform",
  "/workspace",
  "/user",
  "/models",
  "/welcome",
  "/platfrom",
]

const MOBILE_UA_REGEX =
  /Android|webOS|iPhone|iPod|BlackBerry|IEMobile|Opera Mini|Mobile Safari|Mobile\/[\d.]+ Safari/i
const TABLET_UA_REGEX = /iPad|Tablet/i

function isMobileUA(userAgent: string) {
  if (!userAgent) return false
  if (TABLET_UA_REGEX.test(userAgent)) return false
  return MOBILE_UA_REGEX.test(userAgent)
}

function shouldRedirectToMobile(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl
  if (pathname !== "/") return false
  if (searchParams.has("desktop")) return false
  return isMobileUA(request.headers.get("user-agent") || "")
}

function shouldRedirectToDesktop(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl
  if (pathname !== "/m") return false
  if (searchParams.has("mobile")) return false
  return !isMobileUA(request.headers.get("user-agent") || "")
}

function isProtectedPath(pathname: string) {
  return PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  )
}

async function hasValidSession(request: NextRequest) {
  const response = await fetch(buildApiProxyUrl("/auth/me"), {
    method: "GET",
    headers: {
      cookie: request.headers.get("cookie") ?? "",
      "user-agent": request.headers.get("user-agent") ?? "",
      "x-forwarded-for": request.headers.get("x-forwarded-for") ?? "",
      "x-forwarded-proto": request.headers.get("x-forwarded-proto") ?? "",
      "x-forwarded-host":
        request.headers.get("x-forwarded-host") ??
        request.headers.get("host") ??
        "",
    },
    cache: "no-store",
  })

  return response
}

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl

  if (shouldRedirectToMobile(request)) {
    const redirectUrl = request.nextUrl.clone()
    redirectUrl.pathname = "/m"
    return NextResponse.redirect(redirectUrl)
  }

  if (shouldRedirectToDesktop(request)) {
    const redirectUrl = request.nextUrl.clone()
    redirectUrl.pathname = "/"
    return NextResponse.redirect(redirectUrl)
  }

  if (!isProtectedPath(pathname)) {
    return NextResponse.next()
  }

  const sessionCookie = request.cookies.get(AUTH_SESSION_COOKIE_NAME)?.value
  if (sessionCookie) {
    try {
      const authResponse = await hasValidSession(request)
      if (authResponse.ok) {
        return NextResponse.next()
      }

      if (authResponse.status !== 401) {
        return NextResponse.next()
      }
    } catch {
      return NextResponse.next()
    }
  }

  const redirectUrl = buildLoginRedirect(`${pathname}${search}`)
  const response = NextResponse.redirect(new URL(redirectUrl, request.url))
  response.cookies.set(AUTH_SESSION_COOKIE_NAME, "", {
    path: "/",
    maxAge: 0,
  })
  return response
}

export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|apple-touch-icon.png|synapse.svg|synapse.png).*)",
  ],
}
