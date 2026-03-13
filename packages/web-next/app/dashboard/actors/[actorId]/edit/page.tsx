import { ActorEditPage } from "@/components/actor-edit-page"

export default async function Page({
  params,
}: {
  params: Promise<{ actorId: string }>
}) {
  const { actorId } = await params
  return <ActorEditPage actorId={actorId} />
}
