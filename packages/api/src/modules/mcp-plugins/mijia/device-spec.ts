import type {
  MijiaDeviceActionSpec,
  MijiaDevicePropertySpec,
  MijiaDeviceSpec,
  MijiaPropertyValueOption,
} from "./types.js"

const DEVICE_SPEC_URL = "https://home.miot-spec.com/spec/"
const specCache = new Map<string, Promise<MijiaDeviceSpec>>()

function decodeHtmlJsonPayload(payload: string) {
  return payload
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
}

export function normalizeMijiaCapabilityName(value: string) {
  return value.trim().toLowerCase().replace(/_/g, "-").replace(/\s+/g, "-")
}

function buildAliases(value: string) {
  const normalized = normalizeMijiaCapabilityName(value)
  const aliases = new Set<string>([
    value,
    normalized,
    normalized.replace(/-/g, "_"),
  ])
  return Array.from(aliases)
}

function readString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function readStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : []
}

function readValueList(value: unknown): MijiaPropertyValueOption[] | undefined {
  if (!Array.isArray(value)) return undefined
  const options = value
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null
      const record = item as Record<string, unknown>
      const rawValue = record.value
      if (typeof rawValue !== "string" && typeof rawValue !== "number") {
        return null
      }
      return {
        value: rawValue,
        description:
          readString(record.description) ||
          readString(record.desc_zh_cn) ||
          String(rawValue),
      } satisfies MijiaPropertyValueOption
    })
    .filter((item): item is MijiaPropertyValueOption => Boolean(item))

  return options.length > 0 ? options : undefined
}

function readRange(value: unknown) {
  if (!Array.isArray(value) || value.length < 2) return undefined
  const numeric = value
    .map((item) => readNumber(item))
    .filter((item): item is number => item !== undefined)
  if (numeric.length < 2) return undefined
  return numeric.slice(0, 3) as [number, number, number?]
}

function createPropertySpec(input: {
  serviceName: string
  property: Record<string, unknown>
  serviceId: string
  propertyId: string
  collisions: Set<string>
}): MijiaDevicePropertySpec {
  const propertyName = readString(input.property.name, "property")
  const resolvedName = input.collisions.has(propertyName)
    ? `${input.serviceName}-${propertyName}`
    : propertyName
  input.collisions.add(propertyName)

  const access = readStringArray(input.property.access)
  const rawFormat = readString(input.property.format, "string")
  const type = rawFormat.startsWith("int")
    ? "int"
    : rawFormat.startsWith("uint")
      ? "uint"
      : rawFormat === "float" || rawFormat === "bool" || rawFormat === "string"
        ? rawFormat
        : "string"

  return {
    name: resolvedName,
    description:
      [
        readString(input.property.description),
        readString(input.property.desc_zh_cn),
      ]
        .filter(Boolean)
        .join(" / ") || resolvedName,
    type,
    readable: access.includes("read"),
    writable: access.includes("write"),
    unit: readString(input.property.unit) || undefined,
    range: readRange(input.property["value-range"]),
    valueList: readValueList(input.property["value-list"]),
    method: {
      siid: Number(input.serviceId),
      piid: Number(input.propertyId),
    },
    aliases: buildAliases(resolvedName),
  }
}

function createActionSpec(input: {
  serviceName: string
  action: Record<string, unknown>
  serviceId: string
  actionId: string
  collisions: Set<string>
}): MijiaDeviceActionSpec {
  const actionName = readString(input.action.name, "action")
  const resolvedName = input.collisions.has(actionName)
    ? `${input.serviceName}-${actionName}`
    : actionName
  input.collisions.add(actionName)

  return {
    name: resolvedName,
    description:
      [
        readString(input.action.description),
        readString(input.action.desc_zh_cn),
      ]
        .filter(Boolean)
        .join(" / ") || resolvedName,
    method: {
      siid: Number(input.serviceId),
      aiid: Number(input.actionId),
    },
    aliases: buildAliases(resolvedName),
  }
}

async function fetchDeviceSpec(model: string): Promise<MijiaDeviceSpec> {
  const response = await fetch(`${DEVICE_SPEC_URL}${model}`, {
    headers: {
      "User-Agent": "Synapse-Mijia/1.0",
    },
  })

  if (!response.ok) {
    throw new Error(`Failed to fetch Mijia device spec for ${model}`)
  }

  const html = await response.text()
  const match = html.match(/data-page="(.*?)">/)
  if (!match?.[1]) {
    throw new Error(`Failed to parse Mijia device spec for ${model}`)
  }

  const pageData = JSON.parse(decodeHtmlJsonPayload(match[1])) as Record<
    string,
    any
  >
  const product = pageData.props?.product
  const spec = pageData.props?.spec
  const services = spec?.services || {}

  const properties: MijiaDevicePropertySpec[] = []
  const actions: MijiaDeviceActionSpec[] = []
  const propertyCollisions = new Set<string>()
  const actionCollisions = new Set<string>()

  for (const [serviceId, serviceValue] of Object.entries<Record<string, any>>(
    services
  )) {
    const serviceName = readString(serviceValue?.name, "service")
    for (const [propertyId, propertyValue] of Object.entries<
      Record<string, unknown>
    >(serviceValue?.properties || {})) {
      properties.push(
        createPropertySpec({
          serviceName,
          property: propertyValue,
          serviceId,
          propertyId,
          collisions: propertyCollisions,
        })
      )
    }

    for (const [actionId, actionValue] of Object.entries<
      Record<string, unknown>
    >(serviceValue?.actions || {})) {
      actions.push(
        createActionSpec({
          serviceName,
          action: actionValue,
          serviceId,
          actionId,
          collisions: actionCollisions,
        })
      )
    }
  }

  const propertyMap = new Map<string, MijiaDevicePropertySpec>()
  for (const property of properties) {
    for (const alias of property.aliases) {
      propertyMap.set(normalizeMijiaCapabilityName(alias), property)
    }
  }

  const actionMap = new Map<string, MijiaDeviceActionSpec>()
  for (const action of actions) {
    for (const alias of action.aliases) {
      actionMap.set(normalizeMijiaCapabilityName(alias), action)
    }
  }

  return {
    name: readString(product?.name) || readString(spec?.name) || model,
    model: readString(product?.model) || model,
    properties,
    actions,
    propertyMap,
    actionMap,
  }
}

export function getMijiaDeviceSpec(model: string) {
  const cacheKey = model.trim()
  let cached = specCache.get(cacheKey)
  if (!cached) {
    cached = fetchDeviceSpec(cacheKey)
    specCache.set(cacheKey, cached)
  }
  return cached
}

export const DEFAULT_STATUS_PROPERTY_NAMES = [
  "on",
  "status",
  "mode",
  "brightness",
  "fan-level",
  "target-temperature",
  "temperature",
  "relative-humidity",
  "humidity",
  "battery-level",
  "charging-state",
  "pm2_5-density",
  "filter-life-level",
  "color-temperature",
]
