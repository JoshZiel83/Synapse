/**
 * FE-facing tool presentation strings that are already rendered by the API.
 *
 * Tool presentation descriptors still live with the runtime/API descriptor
 * contract. The app contract only needs this lightweight rendered value and the
 * helper that resolves it to display text.
 */
export interface PresentationString {
  key: string
  params: Record<string, string | number>
  fallback: string
}

export function resolvePresentation(
  value: PresentationString | undefined
): string | undefined {
  return value?.fallback
}
