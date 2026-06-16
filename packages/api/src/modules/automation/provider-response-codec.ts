export function parseAutomationProviderJsonObjectText(
  text: string,
  label: string
): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${(error as Error).message}`)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return parsed as Record<string, unknown>
}

export async function readAutomationProviderJsonObjectResponse<
  T extends Record<string, unknown>,
>(response: Response, label: string): Promise<T> {
  return parseAutomationProviderJsonObjectText(
    await response.text(),
    label
  ) as T
}
