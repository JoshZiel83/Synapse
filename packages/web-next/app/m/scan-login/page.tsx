import { redirect } from "next/navigation"

export default async function MobileScanLoginRedirectPage() {
  redirect("/m/scan?intent=login")
}
