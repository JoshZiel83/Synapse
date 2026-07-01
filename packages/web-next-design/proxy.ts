import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { buildLoginRedirect } from "./lib/auth"
import { buildApiProxyUrl } from "./lib/api-origin"
import { isMobileUserAgent } from "./lib/is-mobile-user-agent"

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

function shouldRedirectToMobile(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl
  if (pathname !== "/") return false
  if (searchParams.has("desktop")) return false
  return isMobileUserAgent(request.headers.get("user-agent") || "")
}

function shouldRedirectToDesktop(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl
  if (pathname !== "/m") return false
  if (searchParams.has("mobile")) return false
  return !isMobileUserAgent(request.headers.get("user-agent") || "")
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

  // Design sandbox: there is no backend to validate sessions against, so treat
  // every protected route as accessible. Set NEXT_PUBLIC_DESIGN_MOCK=0 to
  // restore the real /auth/me probe below.
  if (process.env.NEXT_PUBLIC_DESIGN_MOCK !== "0") {
    return NextResponse.next()
  }

  // We can't cheaply pre-check a session cookie by name: Better Auth's session
  // cookie carries an environment-dependent `__Secure-` prefix, so just ask the
  // backend. /auth/me returns 401 when there is no valid session; on a non-401
  // (e.g. backend hiccup) or transport error we fail OPEN to avoid bouncing a
  // logged-in user — server layouts still enforce auth authoritatively.
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

  const redirectUrl = buildLoginRedirect(`${pathname}${search}`)
  return NextResponse.redirect(new URL(redirectUrl, request.url))
}

export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|apple-touch-icon.png|synapse.svg|synapse.png).*)",
  ],
}
