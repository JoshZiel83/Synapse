import isMobile from "is-mobile"

export function isMobileUserAgent(userAgent: string) {
  return isMobile({ ua: userAgent })
}
