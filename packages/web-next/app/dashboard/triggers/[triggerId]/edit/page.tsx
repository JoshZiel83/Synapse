import { AutomationTriggerEditPage } from "@/components/automation-trigger-edit-page"

export default async function Page({
  params,
}: {
  params: Promise<{ triggerId: string }>
}) {
  const { triggerId } = await params
  return <AutomationTriggerEditPage triggerId={triggerId} />
}
