import type { ToolDefinition } from "@synapse/shared"
import type { RelayAccessDenialDescriptor } from "@synapse/shared/types"

export const RELAY_REQUEST_AUTHORIZATION_PARAM = "request_authorization"
export const RELAY_REQUEST_AUTHORIZATION_MODES = [
  "none",
  "background",
  "blocking",
] as const

export type RelayBuiltinAuthorizationKind =
  | "filesystem"
  | "cua"
  | "browser"
  | "commandline"

export type RelayRequestAuthorizationMode =
  (typeof RELAY_REQUEST_AUTHORIZATION_MODES)[number]

export interface RelayServerInvokeOptions {
  requestAuthorization: RelayRequestAuthorizationMode
}

export interface ParsedRelayServerInvokeOptions {
  clientToolArgs: Record<string, unknown>
  serverInvokeOptions: RelayServerInvokeOptions
  validationError?: string
}

export interface RelayAuthorizableLocalDenial {
  code: string
  message?: string
  structuredContent: Record<string, unknown>
  denial: RelayAccessDenialDescriptor
}
const RELAY_ACCESS_DENIAL_KINDS = new Set([
  "permission_denied",
  "runtime_constraint",
  "invalid_request",
])
const RELAY_ACCESS_DENIAL_RESOLUTIONS = new Set([
  "server_grant",
  "local_setting",
  "unresolvable",
])

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function normalizeRelayBuiltinAuthorizationKind(
  value: unknown
): RelayBuiltinAuthorizationKind | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : ""
  if (
    normalized === "filesystem" ||
    normalized === "cua" ||
    normalized === "browser" ||
    normalized === "commandline"
  ) {
    return normalized
  }
  return null
}

export function supportsRelayAuthorizationRequestParameter(
  exposureMetadata?: Record<string, unknown>
) {
  return Boolean(
    normalizeRelayBuiltinAuthorizationKind(exposureMetadata?.builtinKind)
  )
}

export function normalizeRelayRequestAuthorizationMode(
  value: unknown
): RelayRequestAuthorizationMode | null {
  if (typeof value !== "string") {
    return null
  }
  const normalized = value.trim().toLowerCase()
  if (
    normalized === "none" ||
    normalized === "background" ||
    normalized === "blocking"
  ) {
    return normalized
  }
  return null
}

export function injectRelayAuthorizationToolParameter(
  definition: ToolDefinition,
  exposureMetadata?: Record<string, unknown>
): ToolDefinition {
  if (!supportsRelayAuthorizationRequestParameter(exposureMetadata)) {
    return definition
  }

  return {
    ...definition,
    parameters: {
      ...definition.parameters,
      properties: {
        ...definition.parameters.properties,
        [RELAY_REQUEST_AUTHORIZATION_PARAM]: {
          type: "string",
          description:
            "Synapse server-only option. This is handled by Synapse and is not sent to the relay client. Use `background` to create a user authorization request if the relay client locally denies the action. Use `blocking` only for synchronous calls when Synapse should wait for approval and retry automatically.",
          enum: [...RELAY_REQUEST_AUTHORIZATION_MODES],
        },
      },
      required: definition.parameters.required.filter(
        (value) => value !== RELAY_REQUEST_AUTHORIZATION_PARAM
      ),
    },
  }
}

export function parseRelayServerInvokeOptions(
  input: Record<string, unknown>,
  exposureMetadata?: Record<string, unknown>
): ParsedRelayServerInvokeOptions {
  if (!supportsRelayAuthorizationRequestParameter(exposureMetadata)) {
    return {
      clientToolArgs: input,
      serverInvokeOptions: {
        requestAuthorization: "none",
      },
    }
  }

  const clientToolArgs = { ...input }
  const rawMode = clientToolArgs[RELAY_REQUEST_AUTHORIZATION_PARAM]
  delete clientToolArgs[RELAY_REQUEST_AUTHORIZATION_PARAM]

  if (rawMode === undefined) {
    return {
      clientToolArgs,
      serverInvokeOptions: {
        requestAuthorization: "none",
      },
    }
  }

  const requestAuthorization = normalizeRelayRequestAuthorizationMode(rawMode)
  if (!requestAuthorization) {
    return {
      clientToolArgs,
      serverInvokeOptions: {
        requestAuthorization: "none",
      },
      validationError:
        "`request_authorization` must be one of `none`, `background`, or `blocking`.",
    }
  }

  return {
    clientToolArgs,
    serverInvokeOptions: {
      requestAuthorization,
    },
  }
}

export function classifyRelayLocalPermissionDenial(
  rawResult: unknown
): RelayAuthorizableLocalDenial | null {
  const result = asRecord(rawResult)
  if (!result || result.isError !== true) {
    return null
  }

  const structuredContent = asRecord(result.structuredContent)
  if (!structuredContent) {
    return null
  }
  const denialRecord = asRecord(structuredContent.relay_access_denial)
  if (!denialRecord) {
    return null
  }
  const kind =
    typeof denialRecord.kind === "string" ? denialRecord.kind.trim() : ""
  const resolution =
    typeof denialRecord.resolution === "string"
      ? denialRecord.resolution.trim()
      : ""
  if (
    !RELAY_ACCESS_DENIAL_KINDS.has(kind) ||
    !RELAY_ACCESS_DENIAL_RESOLUTIONS.has(resolution)
  ) {
    return null
  }
  if (kind !== "permission_denied" || resolution !== "server_grant") {
    return null
  }

  const code =
    typeof structuredContent.code === "string"
      ? structuredContent.code.trim()
      : ""

  return {
    code,
    message:
      typeof structuredContent.message === "string"
        ? structuredContent.message
        : typeof result.content === "string"
          ? result.content
          : undefined,
    structuredContent,
    denial: {
      kind: kind as RelayAccessDenialDescriptor["kind"],
      resolution: resolution as RelayAccessDenialDescriptor["resolution"],
    },
  }
}
