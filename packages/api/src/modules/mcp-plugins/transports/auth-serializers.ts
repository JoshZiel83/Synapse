/**
 * Auth-secret serializer registry.
 *
 * Some plugins store an internal credential shape in `secretPayload` that
 * differs from what their remote/sidecar MCP server expects (e.g. Mijia stores
 * the full internal MijiaAuthState but the miot sidecar wants the upstream
 * mijiaAPI canonical dict). When an entryPoint uses `${auth_b64:field}`, the
 * template engine runs the serializer registered for that connection's driver
 * (if any) before base64-encoding. Default behaviour is identity.
 *
 * Keyed by auth-binding driver so it does not depend on per-plugin field names.
 */
export type AuthSecretSerializer = (secret: Record<string, unknown>) => unknown

const serializers = new Map<string, AuthSecretSerializer>()

export function registerAuthSecretSerializer(
  driver: string,
  serializer: AuthSecretSerializer
): void {
  serializers.set(driver, serializer)
}

export function getAuthSecretSerializer(
  driver: string | undefined
): AuthSecretSerializer | undefined {
  if (!driver) return undefined
  return serializers.get(driver)
}
