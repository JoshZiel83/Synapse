import { redirect } from "next/navigation"

// Chat is the home surface: /dashboard lands straight in Chat. Keeps every
// post-login `router.push("/dashboard")` working (it forwards to chat).
export default function DashboardPage() {
  redirect("/dashboard/chat")
}
