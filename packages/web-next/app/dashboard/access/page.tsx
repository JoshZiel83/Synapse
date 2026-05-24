"use client"

import { useSearchParams } from "next/navigation"
import AccessManagement from "@/app/dashboard/settings/access-management"
import { MODEL_GROUP_GRANT_SCOPE } from "@synapse/shared"

export default function DashboardAccessPage() {
  const searchParams = useSearchParams()
  const scope = searchParams.get("scope")
  const mode =
    scope === MODEL_GROUP_GRANT_SCOPE.WORKSPACE ||
    scope === MODEL_GROUP_GRANT_SCOPE.PLATFORM
      ? scope
      : "all"

  return <AccessManagement mode={mode} showIntro />
}
