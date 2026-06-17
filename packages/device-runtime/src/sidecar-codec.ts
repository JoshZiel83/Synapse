export interface SidecarResponseFrame {
  id: string
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export function parseSidecarResponseFrame(
  line: string
): SidecarResponseFrame | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null
  }
  const frame = parsed as {
    id?: unknown
    result?: unknown
    error?: unknown
  }
  if (typeof frame.id !== "string" && typeof frame.id !== "number") {
    return null
  }
  if (frame.error !== undefined) {
    if (!frame.error || typeof frame.error !== "object") {
      return null
    }
    const error = frame.error as {
      code?: unknown
      message?: unknown
      data?: unknown
    }
    if (typeof error.code !== "number" || typeof error.message !== "string") {
      return null
    }
    return {
      id: String(frame.id),
      error: {
        code: error.code,
        message: error.message,
        data: error.data,
      },
    }
  }
  return { id: String(frame.id), result: frame.result }
}
