import { Redirect } from "expo-router"

export default function ContactScanRedirect() {
  return <Redirect href="/scan?intent=relationship" />
}
