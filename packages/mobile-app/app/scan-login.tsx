import { Redirect } from "expo-router";

export default function ScanLoginRedirect() {
  return <Redirect href="/scan?intent=login" />;
}
