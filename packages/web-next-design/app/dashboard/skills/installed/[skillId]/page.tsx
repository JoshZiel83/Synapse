"use client"

import { useParams } from "next/navigation"

import { InstalledSkillConfigurationPage } from "../../skills-client"

export default function InstalledSkillRoutePage() {
  const params = useParams<{ skillId: string }>()

  return <InstalledSkillConfigurationPage skillId={params.skillId} />
}
