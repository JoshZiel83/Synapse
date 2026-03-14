import MemoryEditorPage from "@/components/memory-editor-page"

export default async function MemoryDetailPage({
  params,
}: {
  params: Promise<{ memoryId: string }>
}) {
  const { memoryId } = await params

  return <MemoryEditorPage memoryId={memoryId} />
}
