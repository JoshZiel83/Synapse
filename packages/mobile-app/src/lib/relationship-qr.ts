export function extractRelationshipQrToken(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    const token = url.searchParams.get("token");
    if (token?.trim()) {
      return token.trim();
    }
  } catch {
    // Ignore malformed URLs and fallback to the raw token.
  }

  return /^[A-Za-z0-9_-]{16,255}$/.test(trimmed) ? trimmed : null;
}

