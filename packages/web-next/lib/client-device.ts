import type { AuthClientType } from "@synapse/shared"

import type { AuthMutationOptions } from "@/lib/api"

function getBrowserName(userAgent: string) {
  if (userAgent.includes("edg/")) return "Edge"
  if (userAgent.includes("opr/") || userAgent.includes("opera")) return "Opera"
  if (userAgent.includes("firefox/") || userAgent.includes("fxios/")) {
    return "Firefox"
  }
  if (userAgent.includes("chrome/") || userAgent.includes("crios/")) {
    return "Chrome"
  }
  if (
    userAgent.includes("safari/") &&
    !userAgent.includes("chrome/") &&
    !userAgent.includes("crios/")
  ) {
    return "Safari"
  }

  return undefined
}

function getOperatingSystemName(userAgent: string) {
  if (
    userAgent.includes("iphone") ||
    userAgent.includes("ipad") ||
    userAgent.includes("ipod")
  ) {
    return "iOS"
  }
  if (userAgent.includes("android")) return "Android"
  if (userAgent.includes("windows")) return "Windows"
  if (userAgent.includes("mac os x") || userAgent.includes("macintosh")) {
    return "macOS"
  }
  if (userAgent.includes("linux")) return "Linux"

  return undefined
}

function getMobileClientType(userAgent: string): AuthClientType {
  if (userAgent.includes("android")) return "android"
  if (
    userAgent.includes("iphone") ||
    userAgent.includes("ipad") ||
    userAgent.includes("ipod")
  ) {
    return "ios"
  }

  return "web"
}

export function getMobileWebAuthOptions(): AuthMutationOptions {
  if (typeof navigator === "undefined") {
    return {
      clientType: "web",
      transport: "cookie",
      deviceName: "Synapse Mobile Web",
    }
  }

  const userAgent = navigator.userAgent.toLowerCase()
  const browser = getBrowserName(userAgent)
  const operatingSystem = getOperatingSystemName(userAgent)

  return {
    clientType: getMobileClientType(userAgent),
    transport: "cookie",
    deviceName: "Synapse Mobile Web",
    platform:
      browser && operatingSystem
        ? `${browser} on ${operatingSystem}`
        : browser || operatingSystem || "Mobile Web",
  }
}
