export function extractRelationshipQrToken(input: string) {
  const trimmed = input.trim()
  if (!trimmed) return null

  try {
    const url = new URL(trimmed)
    const token = url.searchParams.get("token")
    if (token?.trim()) {
      return token.trim()
    }
  } catch {
    // Ignore invalid absolute URLs and try the raw value.
  }

  return /^[A-Za-z0-9_-]{16,255}$/.test(trimmed) ? trimmed : null
}

