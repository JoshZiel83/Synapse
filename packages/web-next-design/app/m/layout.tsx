import type { Metadata, Viewport } from "next"

export const metadata: Metadata = {
  title: "把 AI 组织成团队",
  description:
    "Synapse 移动版 · 把可共享的同事、记忆、授权、插件、本地执行与远端 Agent 装进一个 AI 组织运行时。",
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#f3f9ff",
  viewportFit: "cover",
}

export default function MobileLandingLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return children
}
