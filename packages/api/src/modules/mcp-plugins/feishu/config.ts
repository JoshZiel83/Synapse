export interface FeishuAuthConnectionRef {
  __kind: "auth_connection_ref"
  connectionId: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

export function parseFeishuAuthConnectionRef(
  value: unknown
): FeishuAuthConnectionRef | null {
  if (!isRecord(value)) return null
  if (
    value.__kind !== "auth_connection_ref" ||
    typeof value.connectionId !== "string"
  ) {
    return null
  }
  return {
    __kind: "auth_connection_ref",
    connectionId: value.connectionId,
  }
}
