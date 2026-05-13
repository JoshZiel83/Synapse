const MOCK_TRANSCRIPTION_CHUNKS = [
  "帮我整理一下今天的重点任务",
  "先按照优先级",
  "再补充需要我跟进的人",
  "最后输出一个简短执行建议",
] as const

export function startMockRealtimeTranscriptionSession({
  onChunk,
  intervalMs = 700,
}: {
  onChunk: (chunk: string) => void
  intervalMs?: number
}) {
  let index = 0

  const timer = setInterval(() => {
    if (index >= MOCK_TRANSCRIPTION_CHUNKS.length) {
      clearInterval(timer)
      return
    }

    const chunk = MOCK_TRANSCRIPTION_CHUNKS[index]!
    index += 1
    onChunk(chunk)
  }, intervalMs)

  return {
    stop() {
      clearInterval(timer)
    },
  }
}
