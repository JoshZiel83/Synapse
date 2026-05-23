/**
 * Pure helpers used by the inbound ingest path. Tested in
 * `ingest-metadata.test.ts`.
 */

export interface BuiltInTransport {
  direction: "inbound"
  transportKind: string
  transportAccountId: string
  endpointType: string
  endpointExternalId: string
  externalMessageId: string
  transportAddressId: string
  senderExternalId: string
}

/**
 * Merge connector-supplied metadata into the runtime-built transport
 * descriptor without losing required fields. Connector keys (e.g.
 * canonicalParts, externalReplyToId) extend; runtime-required keys
 * (direction, transportKind, ...) always win because runtime is the
 * source of truth for them.
 */
export function mergeInboundMetadata(
  built: BuiltInTransport,
  incomingMetadata: Record<string, unknown> | undefined
): Record<string, unknown> {
  const incoming = incomingMetadata || {}
  const incomingTransport =
    incoming.transport &&
    typeof incoming.transport === "object" &&
    !Array.isArray(incoming.transport)
      ? (incoming.transport as Record<string, unknown>)
      : {}
  const incomingRest = { ...incoming }
  delete incomingRest.transport
  return {
    ...incomingRest,
    transport: {
      ...incomingTransport,
      ...built,
    },
  }
}
