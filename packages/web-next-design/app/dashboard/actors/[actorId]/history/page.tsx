import { ActorVersionHistoryPage } from "@/components/actor-version-history-page"

export default async function Page({
  params,
}: {
  params: Promise<{ actorId: string }>
}) {
  const { actorId } = await params
  return <ActorVersionHistoryPage actorId={actorId} />
}
