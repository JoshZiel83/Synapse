import { redirect } from "next/navigation"

export default async function MobileContactScanRedirectPage() {
  redirect("/m/scan?intent=relationship")
}
