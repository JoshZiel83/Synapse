"use client"

import { useParams } from "next/navigation"

import { InstalledSkillEditorPage } from "../../../skills-client"

export default function InstalledSkillEditorRoutePage() {
  const params = useParams<{ skillId: string }>()

  return <InstalledSkillEditorPage skillId={params.skillId} />
}
