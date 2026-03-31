import type { Metadata } from "next"
import { Manrope, Space_Grotesk } from "next/font/google"

import "./globals.css"

import { ThemeProvider } from "@/components/theme-provider"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AuthStoreProvider } from "@/stores/auth-store"

function resolveMetadataBase() {
  const candidates = [
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.NEXT_PUBLIC_SITE_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : undefined,
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined,
    "http://localhost:3000",
  ]

  for (const candidate of candidates) {
    if (!candidate) {
      continue
    }

    try {
      return new URL(candidate)
    } catch {
      continue
    }
  }

  return new URL("http://localhost:3000")
}

const sans = Manrope({
  subsets: ["latin"],
  variable: "--font-sans",
})

const display = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-display",
})

const metadataBase = resolveMetadataBase()

export const metadata: Metadata = {
  metadataBase,
  title: {
    default: "Synapse",
    template: "%s | Synapse",
  },
  description: "让 AI 成为拥有岗位、记忆、权限与协作关系的数字员工组织。",
  icons: {
    icon: "/favicon.ico",
    apple: "/apple-touch-icon.png",
  },
  openGraph: {
    title: "Synapse",
    description: "云端数字员工组织运行时。",
    images: ["/synapse.png"],
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="zh-CN"
      suppressHydrationWarning
      className={`${sans.variable} ${display.variable} font-sans antialiased`}
    >
      <body className="min-h-screen bg-background text-foreground">
        <AuthStoreProvider>
          <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
            <TooltipProvider>
              {children}
              <Toaster />
            </TooltipProvider>
          </ThemeProvider>
        </AuthStoreProvider>
      </body>
    </html>
  )
}
