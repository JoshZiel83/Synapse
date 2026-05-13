import { ToolDefinition } from "@synapse/shared"

type JsonObject = Record<string, unknown>
type QueryEntry = [string, string]
type ToolParamType = "string" | "integer" | "boolean" | "string_array"

interface ToolParamSpec {
  name: string
  type: ToolParamType
  description: string
  required?: boolean
  enum?: Array<string | number>
  minimum?: number
  maximum?: number
}

interface AmapToolSpec {
  name: string
  description: string
  path: string
  params: ToolParamSpec[]
  buildQuery: (input: JsonObject) => QueryEntry[]
  formatResult: (result: JsonObject) => string
}

class AmapApiError extends Error {
  infocode?: string

  constructor(message: string, options?: { infocode?: string }) {
    super(message)
    this.name = "AmapApiError"
    this.infocode = options?.infocode
  }
}

const AMAP_API_BASE = "https://restapi.amap.com"
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_ROUTE_STEP_LIMIT = 8
const MAX_POI_PAGE_SIZE = 25

function buildToolDefinition(spec: AmapToolSpec): ToolDefinition {
  const properties: Record<string, unknown> = {}
  const required: string[] = []

  for (const param of spec.params) {
    const property: Record<string, unknown> = {
      description: param.description,
    }

    switch (param.type) {
      case "string":
        property.type = "string"
        break
      case "integer":
        property.type = "integer"
        break
      case "boolean":
        property.type = "boolean"
        break
      case "string_array":
        property.type = "array"
        property.items = { type: "string" }
        break
      default:
        property.type = "string"
        break
    }

    if (param.enum?.length) property.enum = param.enum
    if (param.minimum !== undefined) property.minimum = param.minimum
    if (param.maximum !== undefined) property.maximum = param.maximum

    properties[param.name] = property
    if (param.required) required.push(param.name)
  }

  return {
    name: spec.name,
    description: spec.description,
    parameters: {
      type: "object",
      properties: properties as ToolDefinition["parameters"]["properties"],
      required,
    },
  }
}

function compactWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

function stringifyClipped(value: unknown, maxChars = 2500) {
  const text = JSON.stringify(value, null, 2)
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n...truncated...`
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {}
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

function firstNonEmpty(...values: Array<unknown>) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
    if (typeof value === "number" && Number.isFinite(value))
      return String(value)
    if (Array.isArray(value)) {
      const items = value
        .map((item) => {
          if (typeof item === "string" && item.trim()) return item.trim()
          if (typeof item === "number" && Number.isFinite(item))
            return String(item)
          return undefined
        })
        .filter((item): item is string => Boolean(item))
      if (items.length > 0) return items.join(" / ")
    }
  }
  return undefined
}

function joinNonEmpty(values: Array<unknown>, separator = " / ") {
  const items = values
    .map((value) => firstNonEmpty(value))
    .filter((value): value is string => Boolean(value))
  return items.length > 0 ? items.join(separator) : undefined
}

function readOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function readRequiredString(input: JsonObject, key: string, label: string) {
  const value = readOptionalString(input[key])
  if (!value) {
    throw new Error(`${label} is required.`)
  }
  return value
}

function readOptionalNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function readInteger(
  value: unknown,
  options?: {
    defaultValue?: number
    min?: number
    max?: number
  }
) {
  const parsed = readOptionalNumber(value)
  const base = parsed === undefined ? options?.defaultValue : Math.trunc(parsed)
  if (base === undefined) return undefined

  let next = base
  if (options?.min !== undefined) next = Math.max(options.min, next)
  if (options?.max !== undefined) next = Math.min(options.max, next)
  return next
}

function readOptionalBoolean(value: unknown) {
  if (typeof value === "boolean") return value
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase()
    if (["true", "1", "yes", "y"].includes(normalized)) return true
    if (["false", "0", "no", "n"].includes(normalized)) return false
  }
  return undefined
}

function readStringArray(value: unknown) {
  if (Array.isArray(value)) {
    return value
      .map((item) => readOptionalString(item))
      .filter((item): item is string => Boolean(item))
  }
  const single = readOptionalString(value)
  return single ? [single] : []
}

function dedupe(values: string[]) {
  return [...new Set(values)]
}

function requireAtLeastOne(values: Array<unknown>, message: string) {
  const ok = values.some((value) => {
    if (typeof value === "string") return value.trim().length > 0
    if (typeof value === "number") return Number.isFinite(value)
    if (typeof value === "boolean") return true
    if (Array.isArray(value)) return value.length > 0
    if (value && typeof value === "object") return Object.keys(value).length > 0
    return false
  })
  if (!ok) throw new Error(message)
}

function parseJsonMaybe(text: string): JsonObject | undefined {
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : undefined
  } catch {
    return undefined
  }
}

function formatBlock(title: string, lines: Array<string | undefined>) {
  const body = lines.filter((line): line is string => Boolean(line))
  if (body.length === 0) return title
  return `${title}\n${body.map((line) => `- ${line}`).join("\n")}`
}

function formatBlockList(title: string, blocks: string[]) {
  if (blocks.length === 0) {
    return `${title}\n- No data returned.`
  }
  return [title, ...blocks].join("\n\n")
}

function formatDistance(value: unknown) {
  const meters = readOptionalNumber(value)
  if (meters === undefined) return undefined
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`
  return `${Math.round(meters)} m`
}

function formatDurationSeconds(value: unknown) {
  const seconds = readOptionalNumber(value)
  if (seconds === undefined) return undefined
  if (seconds < 60) return `${Math.round(seconds)} sec`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const remainMinutes = minutes % 60
  return remainMinutes > 0 ? `${hours} h ${remainMinutes} min` : `${hours} h`
}

function normalizeCoordinatePair(value: string, label: string) {
  const normalized = compactWhitespace(value).replace(/\s+/g, "")
  const [lngRaw, latRaw] = normalized.split(",")
  if (!lngRaw || !latRaw) {
    throw new Error(`${label} must be in "longitude,latitude" format.`)
  }
  const lng = Number(lngRaw)
  const lat = Number(latRaw)
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    throw new Error(
      `${label} must contain valid longitude and latitude numbers.`
    )
  }
  return `${lng},${lat}`
}

function normalizeCoordinateSequence(
  value: unknown,
  label: string,
  separator: "|" | ";",
  minPairs: number
) {
  const rawValues = readStringArray(value)
  const normalizedValues =
    rawValues.length > 0
      ? rawValues
      : (() => {
          const single = readOptionalString(value)
          return single ? single.split(separator) : []
        })()

  const pairs = normalizedValues
    .map((item) => readOptionalString(item))
    .filter((item): item is string => Boolean(item))
    .map((item) => normalizeCoordinatePair(item, label))

  if (pairs.length < minPairs) {
    throw new Error(
      `${label} must include at least ${minPairs} coordinate pair(s).`
    )
  }

  return pairs.join(separator)
}

function readJoinedStrings(value: unknown, delimiter: string) {
  const items = dedupe(readStringArray(value))
  return items.length > 0 ? items.join(delimiter) : undefined
}

function buildCommonQuery(config: JsonObject) {
  const apiKey =
    readOptionalString(config.apiKey) ||
    readOptionalString(config.key) ||
    readOptionalString(config.accessKey)

  if (!apiKey) {
    throw new Error(
      "AMap credentials not configured. Set apiKey in the plugin config."
    )
  }

  const query = new URLSearchParams()
  query.set("key", apiKey)
  query.set("output", "JSON")

  const sig =
    readOptionalString(config.sig) || readOptionalString(config.signature)
  if (sig) {
    query.set("sig", sig)
  }

  return query
}

async function fetchAmap(
  spec: AmapToolSpec,
  input: JsonObject,
  config: JsonObject
): Promise<JsonObject> {
  const timeoutMs =
    readInteger(config.timeoutMs, {
      defaultValue: DEFAULT_TIMEOUT_MS,
      min: 5_000,
      max: 180_000,
    }) || DEFAULT_TIMEOUT_MS
  const query = buildCommonQuery(config)

  for (const [key, value] of spec.buildQuery(input)) {
    query.append(key, value)
  }

  const url = `${AMAP_API_BASE}${spec.path}?${query.toString()}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    })
    const text = await response.text()
    const parsed = parseJsonMaybe(text)

    if (!response.ok) {
      const message =
        firstNonEmpty(parsed?.info, parsed?.errmsg, parsed?.message) ||
        text ||
        `HTTP ${response.status}`
      throw new AmapApiError(
        `AMap ${spec.name} failed with HTTP ${response.status}: ${message}`,
        {
          infocode: firstNonEmpty(parsed?.infocode, parsed?.errcode),
        }
      )
    }

    if (!parsed) {
      throw new Error(`AMap ${spec.name} returned a non-JSON response.`)
    }

    if (
      (parsed.status !== undefined && String(parsed.status) !== "1") ||
      (parsed.errcode !== undefined && String(parsed.errcode) !== "0")
    ) {
      const message =
        firstNonEmpty(parsed.info, parsed.errmsg, parsed.message) ||
        "Unknown error"
      throw new AmapApiError(
        `AMap ${spec.name} failed (${firstNonEmpty(parsed.infocode, parsed.errcode) || "unknown"}): ${message}`,
        {
          infocode: firstNonEmpty(parsed.infocode, parsed.errcode),
        }
      )
    }

    return parsed
  } catch (error) {
    if (error instanceof Error && controller.signal.aborted) {
      throw new Error(`AMap ${spec.name} timed out after ${timeoutMs} ms.`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

function renderGeocodeItem(item: JsonObject, index: number) {
  const neighborhood = asObject(item.neighborhood)
  const building = asObject(item.building)
  return formatBlock(
    `${index + 1}. ${firstNonEmpty(item.formatted_address, item.address, item.location) || "Geocode result"}`,
    [
      joinNonEmpty(
        [
          firstNonEmpty(item.country),
          firstNonEmpty(item.province),
          firstNonEmpty(item.city),
          firstNonEmpty(item.district),
          firstNonEmpty(item.township),
        ],
        " / "
      ) &&
        `area: ${joinNonEmpty(
          [
            firstNonEmpty(item.country),
            firstNonEmpty(item.province),
            firstNonEmpty(item.city),
            firstNonEmpty(item.district),
            firstNonEmpty(item.township),
          ],
          " / "
        )}`,
      firstNonEmpty(item.location) &&
        `location: ${firstNonEmpty(item.location)}`,
      firstNonEmpty(item.adcode) && `adcode: ${firstNonEmpty(item.adcode)}`,
      firstNonEmpty(item.level) && `level: ${firstNonEmpty(item.level)}`,
      firstNonEmpty(neighborhood.name) &&
        `neighborhood: ${firstNonEmpty(neighborhood.name)}`,
      firstNonEmpty(building.name) &&
        `building: ${firstNonEmpty(building.name)}`,
    ]
  )
}

function renderPoiItem(item: JsonObject, index: number) {
  const business = asObject(item.business)
  const bizExt = asObject(item.biz_ext)
  const photo = asObject(asArray<JsonObject>(item.photos)[0])
  const address = joinNonEmpty(
    [
      firstNonEmpty(item.address),
      firstNonEmpty(item.pname),
      firstNonEmpty(item.cityname),
      firstNonEmpty(item.adname, item.district),
    ],
    " / "
  )

  return formatBlock(
    `${index + 1}. ${firstNonEmpty(item.name, item.address, item.id) || "POI result"}`,
    [
      firstNonEmpty(item.id) && `id: ${firstNonEmpty(item.id)}`,
      address && `address: ${address}`,
      firstNonEmpty(item.location) &&
        `location: ${firstNonEmpty(item.location)}`,
      firstNonEmpty(item.type, item.typecode) &&
        `type: ${firstNonEmpty(item.type, item.typecode)}`,
      firstNonEmpty(item.tel) && `tel: ${firstNonEmpty(item.tel)}`,
      formatDistance(item.distance) &&
        `distance: ${formatDistance(item.distance)}`,
      firstNonEmpty(item.opentime, business.opentime_today) &&
        `hours: ${firstNonEmpty(item.opentime, business.opentime_today)}`,
      firstNonEmpty(bizExt.rating, business.rating) &&
        `rating: ${firstNonEmpty(bizExt.rating, business.rating)}`,
      firstNonEmpty(item.biz_type) &&
        `business type: ${firstNonEmpty(item.biz_type)}`,
      firstNonEmpty(photo.url) && `photo: ${firstNonEmpty(photo.url)}`,
    ]
  )
}

function renderTipItem(item: JsonObject, index: number) {
  return formatBlock(
    `${index + 1}. ${firstNonEmpty(item.name, item.address, item.id) || "Tip result"}`,
    [
      firstNonEmpty(item.id) && `id: ${firstNonEmpty(item.id)}`,
      joinNonEmpty(
        [firstNonEmpty(item.district), firstNonEmpty(item.address)],
        " / "
      ) &&
        `address: ${joinNonEmpty([firstNonEmpty(item.district), firstNonEmpty(item.address)], " / ")}`,
      firstNonEmpty(item.location) &&
        `location: ${firstNonEmpty(item.location)}`,
      firstNonEmpty(item.typecode) &&
        `typecode: ${firstNonEmpty(item.typecode)}`,
    ]
  )
}

function renderDistrictItem(item: JsonObject, index: number) {
  const children = asArray<JsonObject>(item.districts)
  const childNames = children
    .map((child) => firstNonEmpty(child.name))
    .filter((value): value is string => Boolean(value))
    .slice(0, 10)

  return formatBlock(
    `${index + 1}. ${firstNonEmpty(item.name, item.adcode) || "District result"}`,
    [
      firstNonEmpty(item.level) && `level: ${firstNonEmpty(item.level)}`,
      firstNonEmpty(item.adcode) && `adcode: ${firstNonEmpty(item.adcode)}`,
      firstNonEmpty(item.citycode) &&
        `citycode: ${firstNonEmpty(item.citycode)}`,
      firstNonEmpty(item.center) && `center: ${firstNonEmpty(item.center)}`,
      childNames.length > 0
        ? `subdistricts: ${childNames.join(", ")}${children.length > childNames.length ? " ..." : ""}`
        : undefined,
    ]
  )
}

function renderRoadItem(item: JsonObject, index: number) {
  return formatBlock(
    `${index + 1}. ${firstNonEmpty(item.name, item.direction) || "Road"}`,
    [
      firstNonEmpty(item.location) &&
        `location: ${firstNonEmpty(item.location)}`,
      formatDistance(item.distance) &&
        `distance: ${formatDistance(item.distance)}`,
      firstNonEmpty(item.direction) &&
        `direction: ${firstNonEmpty(item.direction)}`,
    ]
  )
}

function renderRouteStep(item: JsonObject, index: number) {
  const action = joinNonEmpty(
    [
      firstNonEmpty(item.instruction),
      firstNonEmpty(item.action),
      firstNonEmpty(item.assistant_action),
    ],
    " | "
  )

  return formatBlock(
    `${index + 1}. ${action || firstNonEmpty(item.road_name, item.orientation) || "Step"}`,
    [
      firstNonEmpty(item.road_name) && `road: ${firstNonEmpty(item.road_name)}`,
      formatDistance(item.step_distance ?? item.distance) &&
        `distance: ${formatDistance(item.step_distance ?? item.distance)}`,
      formatDurationSeconds(item.duration) &&
        `duration: ${formatDurationSeconds(item.duration)}`,
      firstNonEmpty(item.orientation) &&
        `orientation: ${firstNonEmpty(item.orientation)}`,
    ]
  )
}

function formatGeocodeResponse(result: JsonObject) {
  const geocodes = asArray<JsonObject>(result.geocodes)
  return formatBlockList(
    `Geocoding results (${geocodes.length})`,
    geocodes.map((item, index) => renderGeocodeItem(item, index))
  )
}

function formatReverseGeocodeResponse(result: JsonObject) {
  const regeo = asObject(result.regeocode)
  const component = asObject(regeo.addressComponent)
  const neighborhood = asObject(component.neighborhood)
  const building = asObject(component.building)
  const pois = asArray<JsonObject>(regeo.pois).slice(0, 5)
  const roads = asArray<JsonObject>(regeo.roads).slice(0, 3)
  const sections = [
    formatBlock("Reverse geocoding result", [
      firstNonEmpty(regeo.formatted_address) &&
        `address: ${firstNonEmpty(regeo.formatted_address)}`,
      joinNonEmpty(
        [
          firstNonEmpty(component.province),
          firstNonEmpty(component.city),
          firstNonEmpty(component.district),
          firstNonEmpty(component.township),
        ],
        " / "
      ) &&
        `area: ${joinNonEmpty(
          [
            firstNonEmpty(component.province),
            firstNonEmpty(component.city),
            firstNonEmpty(component.district),
            firstNonEmpty(component.township),
          ],
          " / "
        )}`,
      firstNonEmpty(component.adcode) &&
        `adcode: ${firstNonEmpty(component.adcode)}`,
      firstNonEmpty(component.citycode) &&
        `citycode: ${firstNonEmpty(component.citycode)}`,
      firstNonEmpty(neighborhood.name) &&
        `neighborhood: ${firstNonEmpty(neighborhood.name)}`,
      firstNonEmpty(building.name) &&
        `building: ${firstNonEmpty(building.name)}`,
    ]),
  ]

  if (pois.length > 0) {
    sections.push(
      formatBlockList(
        `Nearby POIs (${pois.length})`,
        pois.map((item, index) => renderPoiItem(item, index))
      )
    )
  }

  if (roads.length > 0) {
    sections.push(
      formatBlockList(
        `Nearby roads (${roads.length})`,
        roads.map((item, index) => renderRoadItem(item, index))
      )
    )
  }

  return sections.join("\n\n")
}

function formatPoiSearchResult(title: string, result: JsonObject) {
  const pois = asArray<JsonObject>(result.pois)
  const count = firstNonEmpty(result.count) || String(pois.length)
  return formatBlockList(
    `${title} (${pois.length} shown, total ${count})`,
    pois.map((item, index) => renderPoiItem(item, index))
  )
}

function formatPlaceSuggestions(result: JsonObject) {
  const tips = asArray<JsonObject>(result.tips)
  return formatBlockList(
    `Input tips (${tips.length})`,
    tips.map((item, index) => renderTipItem(item, index))
  )
}

function formatDistrictSearch(result: JsonObject) {
  const districts = asArray<JsonObject>(result.districts)
  return formatBlockList(
    `District search results (${districts.length})`,
    districts.map((item, index) => renderDistrictItem(item, index))
  )
}

function formatWeatherResult(result: JsonObject) {
  const live = asObject(asArray<JsonObject>(result.lives)[0])
  if (Object.keys(live).length > 0) {
    return formatBlock(
      `Live weather: ${firstNonEmpty(live.city, live.adcode) || "result"}`,
      [
        joinNonEmpty(
          [firstNonEmpty(live.province), firstNonEmpty(live.city)],
          " / "
        ) &&
          `area: ${joinNonEmpty([firstNonEmpty(live.province), firstNonEmpty(live.city)], " / ")}`,
        firstNonEmpty(live.weather) &&
          `weather: ${firstNonEmpty(live.weather)}`,
        firstNonEmpty(live.temperature) &&
          `temperature: ${firstNonEmpty(live.temperature)} C`,
        firstNonEmpty(live.humidity) &&
          `humidity: ${firstNonEmpty(live.humidity)}`,
        joinNonEmpty(
          [firstNonEmpty(live.winddirection), firstNonEmpty(live.windpower)],
          " "
        ) &&
          `wind: ${joinNonEmpty([firstNonEmpty(live.winddirection), firstNonEmpty(live.windpower)], " ")}`,
        firstNonEmpty(live.reporttime) &&
          `report time: ${firstNonEmpty(live.reporttime)}`,
      ]
    )
  }

  const forecast = asObject(asArray<JsonObject>(result.forecasts)[0])
  const casts = asArray<JsonObject>(forecast.casts).slice(0, 4)
  const sections = [
    formatBlock(
      `Weather forecast: ${firstNonEmpty(forecast.city, forecast.adcode) || "result"}`,
      [
        joinNonEmpty(
          [firstNonEmpty(forecast.province), firstNonEmpty(forecast.city)],
          " / "
        ) &&
          `area: ${joinNonEmpty([firstNonEmpty(forecast.province), firstNonEmpty(forecast.city)], " / ")}`,
        firstNonEmpty(forecast.reporttime) &&
          `report time: ${firstNonEmpty(forecast.reporttime)}`,
      ]
    ),
  ]

  if (casts.length > 0) {
    sections.push(
      formatBlockList(
        `Forecast days (${casts.length})`,
        casts.map((cast, index) =>
          formatBlock(
            `${index + 1}. ${firstNonEmpty(cast.date, cast.week) || "Forecast"}`,
            [
              joinNonEmpty(
                [
                  firstNonEmpty(cast.dayweather),
                  firstNonEmpty(cast.nightweather),
                ],
                " -> "
              ) &&
                `weather: ${joinNonEmpty([firstNonEmpty(cast.dayweather), firstNonEmpty(cast.nightweather)], " -> ")}`,
              joinNonEmpty(
                [firstNonEmpty(cast.daytemp), firstNonEmpty(cast.nighttemp)],
                " / "
              ) &&
                `temperature: ${joinNonEmpty([firstNonEmpty(cast.daytemp), firstNonEmpty(cast.nighttemp)], " / ")} C`,
              joinNonEmpty(
                [firstNonEmpty(cast.daywind), firstNonEmpty(cast.nightwind)],
                " / "
              ) &&
                `wind: ${joinNonEmpty([firstNonEmpty(cast.daywind), firstNonEmpty(cast.nightwind)], " / ")}`,
            ]
          )
        )
      )
    )
  }

  return sections.join("\n\n")
}

function formatIpLocationResult(result: JsonObject) {
  const data = asObject(result.data)
  const payload = Object.keys(data).length > 0 ? data : result

  return formatBlock("IP location result", [
    joinNonEmpty(
      [
        firstNonEmpty(payload.country),
        firstNonEmpty(payload.province),
        firstNonEmpty(payload.city),
        firstNonEmpty(payload.district),
      ],
      " / "
    ) &&
      `area: ${joinNonEmpty(
        [
          firstNonEmpty(payload.country),
          firstNonEmpty(payload.province),
          firstNonEmpty(payload.city),
          firstNonEmpty(payload.district),
        ],
        " / "
      )}`,
    firstNonEmpty(payload.adcode) && `adcode: ${firstNonEmpty(payload.adcode)}`,
    firstNonEmpty(payload.location) &&
      `location: ${firstNonEmpty(payload.location)}`,
    firstNonEmpty(payload.rectangle) &&
      `rectangle: ${firstNonEmpty(payload.rectangle)}`,
    firstNonEmpty(payload.ip) && `ip: ${firstNonEmpty(payload.ip)}`,
  ])
}

function formatCoordinateConvertResult(result: JsonObject) {
  return formatBlock("Coordinate conversion result", [
    firstNonEmpty(result.locations) &&
      `locations: ${firstNonEmpty(result.locations)}`,
    firstNonEmpty(result.info) && `info: ${firstNonEmpty(result.info)}`,
  ])
}

function extractRouteSteps(path: JsonObject) {
  const steps = asArray<JsonObject>(path.steps)
  if (steps.length > 0) return steps

  const rides = asArray<JsonObject>(path.rides)
  if (rides.length > 0) return rides

  const segments = asArray<JsonObject>(path.segments)
  if (segments.length > 0) return segments

  return []
}

function formatRouteResult(title: string, result: JsonObject) {
  const route = asObject(result.route)
  const path = asObject(asArray<JsonObject>(route.paths)[0])
  const cost = asObject(path.cost)
  const steps = extractRouteSteps(path).slice(0, DEFAULT_ROUTE_STEP_LIMIT)

  if (Object.keys(path).length === 0) {
    return formatBlock(title, [`Raw response:\n${stringifyClipped(result)}`])
  }

  const sections = [
    formatBlock(title, [
      formatDistance(path.distance) &&
        `distance: ${formatDistance(path.distance)}`,
      formatDurationSeconds(cost.duration ?? path.duration) &&
        `duration: ${formatDurationSeconds(cost.duration ?? path.duration)}`,
      firstNonEmpty(path.strategy) &&
        `strategy: ${firstNonEmpty(path.strategy)}`,
      firstNonEmpty(path.tolls, cost.tolls) &&
        `tolls: ${firstNonEmpty(path.tolls, cost.tolls)}`,
      firstNonEmpty(path.toll_distance, cost.toll_distance) &&
        `toll distance: ${firstNonEmpty(path.toll_distance, cost.toll_distance)}`,
      firstNonEmpty(route.taxi_cost, path.taxi_cost) &&
        `taxi cost: ${firstNonEmpty(route.taxi_cost, path.taxi_cost)}`,
      firstNonEmpty(path.traffic_lights) &&
        `traffic lights: ${firstNonEmpty(path.traffic_lights)}`,
      firstNonEmpty(path.restriction) &&
        `restriction: ${firstNonEmpty(path.restriction)}`,
    ]),
  ]

  if (steps.length > 0) {
    sections.push(
      formatBlockList(
        `Route steps (${steps.length} shown)`,
        steps.map((step, index) => renderRouteStep(step, index))
      )
    )
  }

  return sections.join("\n\n")
}

function buildGeocodeQuery(input: JsonObject): QueryEntry[] {
  const address = readRequiredString(input, "address", "Address")
  const city =
    readOptionalString(input.city) || readOptionalString(input.region)
  const query: QueryEntry[] = [["address", address]]
  if (city) query.push(["city", city])
  return query
}

function buildReverseGeocodeQuery(input: JsonObject): QueryEntry[] {
  return [
    [
      "location",
      normalizeCoordinatePair(
        readRequiredString(input, "location", "Location"),
        "Location"
      ),
    ],
    [
      "radius",
      String(
        readInteger(input.radius, { defaultValue: 1000, min: 0, max: 3000 }) ||
          1000
      ),
    ],
    ["extensions", readOptionalString(input.extensions) || "all"],
  ]
}

function buildPoiTextSearchQuery(input: JsonObject): QueryEntry[] {
  const keywords = readRequiredString(input, "keywords", "Keywords")
  const region =
    readOptionalString(input.region) || readOptionalString(input.city)
  const types =
    readJoinedStrings(input.types, "|") || readOptionalString(input.type)
  const showFields =
    readJoinedStrings(input.showFields, ",") ||
    readOptionalString(input.show_fields)
  const cityLimit = readOptionalBoolean(input.cityLimit)
  const query: QueryEntry[] = [
    ["keywords", keywords],
    [
      "page_size",
      String(
        readInteger(input.pageSize || input.page_size, {
          defaultValue: 10,
          min: 1,
          max: MAX_POI_PAGE_SIZE,
        }) || 10
      ),
    ],
    [
      "page_num",
      String(
        readInteger(input.pageNum || input.page_num, {
          defaultValue: 1,
          min: 1,
          max: 100,
        }) || 1
      ),
    ],
  ]
  if (region) query.push(["region", region])
  if (types) query.push(["types", types])
  if (showFields) query.push(["show_fields", showFields])
  if (cityLimit !== undefined) query.push(["city_limit", String(cityLimit)])
  return query
}

function buildPoiAroundQuery(input: JsonObject): QueryEntry[] {
  const keywords = readOptionalString(input.keywords)
  const types =
    readJoinedStrings(input.types, "|") || readOptionalString(input.type)
  requireAtLeastOne(
    [keywords, types, input.location],
    "Location is required, and keywords or types are recommended for nearby POI search."
  )

  const showFields =
    readJoinedStrings(input.showFields, ",") ||
    readOptionalString(input.show_fields)
  const query: QueryEntry[] = [
    [
      "location",
      normalizeCoordinatePair(
        readRequiredString(input, "location", "Location"),
        "Location"
      ),
    ],
    [
      "radius",
      String(
        readInteger(input.radius, {
          defaultValue: 3000,
          min: 1,
          max: 50_000,
        }) || 3000
      ),
    ],
    [
      "sortrule",
      readOptionalString(input.sortRule) ||
        readOptionalString(input.sortrule) ||
        "distance",
    ],
    [
      "page_size",
      String(
        readInteger(input.pageSize || input.page_size, {
          defaultValue: 10,
          min: 1,
          max: MAX_POI_PAGE_SIZE,
        }) || 10
      ),
    ],
    [
      "page_num",
      String(
        readInteger(input.pageNum || input.page_num, {
          defaultValue: 1,
          min: 1,
          max: 100,
        }) || 1
      ),
    ],
  ]
  if (keywords) query.push(["keywords", keywords])
  if (types) query.push(["types", types])
  if (showFields) query.push(["show_fields", showFields])
  return query
}

function buildPoiPolygonQuery(input: JsonObject): QueryEntry[] {
  const keywords = readOptionalString(input.keywords)
  const types =
    readJoinedStrings(input.types, "|") || readOptionalString(input.type)
  const showFields =
    readJoinedStrings(input.showFields, ",") ||
    readOptionalString(input.show_fields)
  const query: QueryEntry[] = [
    ["polygon", normalizeCoordinateSequence(input.polygon, "Polygon", "|", 3)],
    [
      "page_size",
      String(
        readInteger(input.pageSize || input.page_size, {
          defaultValue: 10,
          min: 1,
          max: MAX_POI_PAGE_SIZE,
        }) || 10
      ),
    ],
    [
      "page_num",
      String(
        readInteger(input.pageNum || input.page_num, {
          defaultValue: 1,
          min: 1,
          max: 100,
        }) || 1
      ),
    ],
  ]
  if (keywords) query.push(["keywords", keywords])
  if (types) query.push(["types", types])
  if (showFields) query.push(["show_fields", showFields])
  return query
}

function buildPlaceDetailQuery(input: JsonObject): QueryEntry[] {
  const ids = readJoinedStrings(input.ids, "|") || readOptionalString(input.id)
  if (!ids) {
    throw new Error("Place ID is required.")
  }
  const showFields =
    readJoinedStrings(input.showFields, ",") ||
    readOptionalString(input.show_fields)
  const query: QueryEntry[] = [["id", ids]]
  if (showFields) query.push(["show_fields", showFields])
  return query
}

function buildInputTipsQuery(input: JsonObject): QueryEntry[] {
  const keywords = readRequiredString(input, "keywords", "Keywords")
  const city = readOptionalString(input.city)
  const cityLimit = readOptionalBoolean(input.cityLimit ?? input.citylimit)
  const datatype = readOptionalString(input.datatype)
  const query: QueryEntry[] = [["keywords", keywords]]
  if (city) query.push(["city", city])
  if (cityLimit !== undefined) query.push(["citylimit", String(cityLimit)])
  if (datatype) query.push(["datatype", datatype])
  return query
}

function buildDistrictQuery(input: JsonObject): QueryEntry[] {
  const keywords = readRequiredString(input, "keywords", "Keywords")
  return [
    ["keywords", keywords],
    [
      "subdistrict",
      String(
        readInteger(input.subdistrict, { defaultValue: 1, min: 0, max: 3 }) || 1
      ),
    ],
    [
      "page",
      String(
        readInteger(input.page, { defaultValue: 1, min: 1, max: 100 }) || 1
      ),
    ],
    [
      "offset",
      String(
        readInteger(input.offset, { defaultValue: 20, min: 1, max: 100 }) || 20
      ),
    ],
    ["extensions", readOptionalString(input.extensions) || "base"],
  ]
}

function buildWeatherQuery(input: JsonObject): QueryEntry[] {
  return [
    ["city", readRequiredString(input, "city", "City code or adcode")],
    ["extensions", readOptionalString(input.extensions) || "base"],
  ]
}

function buildIpLocationQuery(input: JsonObject): QueryEntry[] {
  const ip = readOptionalString(input.ip)
  const type = readInteger(input.type, { min: 1, max: 4 })
  const query: QueryEntry[] = []
  if (ip) query.push(["ip", ip])
  if (type !== undefined) query.push(["type", String(type)])
  return query
}

function buildCoordinateConvertQuery(input: JsonObject): QueryEntry[] {
  const coordsys =
    readOptionalString(input.coordSys) ||
    readOptionalString(input.coordsys) ||
    "autonavi"
  const locations = normalizeCoordinateSequence(
    input.locations || input.coordinates,
    "Locations",
    "|",
    1
  )
  return [
    ["locations", locations],
    ["coordsys", coordsys],
  ]
}

function buildDrivingRouteQuery(input: JsonObject): QueryEntry[] {
  const strategy = readOptionalString(input.strategy)
  const waypoints = input.waypoints
    ? normalizeCoordinateSequence(input.waypoints, "Waypoints", ";", 1)
    : undefined
  const showFields =
    readJoinedStrings(input.showFields, ",") ||
    readOptionalString(input.show_fields)
  const avoidRoad =
    readOptionalString(input.avoidRoad) || readOptionalString(input.avoidroad)
  const query: QueryEntry[] = [
    [
      "origin",
      normalizeCoordinatePair(
        readRequiredString(input, "origin", "Origin"),
        "Origin"
      ),
    ],
    [
      "destination",
      normalizeCoordinatePair(
        readRequiredString(input, "destination", "Destination"),
        "Destination"
      ),
    ],
  ]
  if (strategy) query.push(["strategy", strategy])
  if (waypoints) query.push(["waypoints", waypoints])
  if (showFields) query.push(["show_fields", showFields])
  if (avoidRoad) query.push(["avoidroad", avoidRoad])
  return query
}

function buildWalkingRouteQuery(input: JsonObject): QueryEntry[] {
  const showFields =
    readJoinedStrings(input.showFields, ",") ||
    readOptionalString(input.show_fields)
  const isIndoor = readOptionalBoolean(input.isIndoor ?? input.isindoor)
  const query: QueryEntry[] = [
    [
      "origin",
      normalizeCoordinatePair(
        readRequiredString(input, "origin", "Origin"),
        "Origin"
      ),
    ],
    [
      "destination",
      normalizeCoordinatePair(
        readRequiredString(input, "destination", "Destination"),
        "Destination"
      ),
    ],
  ]
  if (showFields) query.push(["show_fields", showFields])
  if (isIndoor !== undefined) query.push(["isindoor", isIndoor ? "1" : "0"])
  return query
}

function buildCyclingRouteQuery(input: JsonObject): QueryEntry[] {
  const showFields =
    readJoinedStrings(input.showFields, ",") ||
    readOptionalString(input.show_fields)
  const query: QueryEntry[] = [
    [
      "origin",
      normalizeCoordinatePair(
        readRequiredString(input, "origin", "Origin"),
        "Origin"
      ),
    ],
    [
      "destination",
      normalizeCoordinatePair(
        readRequiredString(input, "destination", "Destination"),
        "Destination"
      ),
    ],
  ]
  if (showFields) query.push(["show_fields", showFields])
  return query
}

const TOOL_SPECS: AmapToolSpec[] = [
  {
    name: "geocodeAddress",
    description:
      "Convert a free-form address into AMap coordinates and administrative area metadata.",
    path: "/v3/geocode/geo",
    params: [
      {
        name: "address",
        type: "string",
        description: "The address to geocode.",
        required: true,
      },
      {
        name: "city",
        type: "string",
        description:
          "Optional city or region hint to disambiguate the address.",
      },
    ],
    buildQuery: buildGeocodeQuery,
    formatResult: formatGeocodeResponse,
  },
  {
    name: "reverseGeocode",
    description:
      "Convert coordinates into a human-readable address, nearby POIs, and road context.",
    path: "/v3/geocode/regeo",
    params: [
      {
        name: "location",
        type: "string",
        description:
          "Longitude,latitude coordinates such as 116.397428,39.90923.",
        required: true,
      },
      {
        name: "radius",
        type: "integer",
        description: "Search radius in meters. Default 1000.",
        minimum: 0,
        maximum: 3000,
      },
      {
        name: "extensions",
        type: "string",
        description: "Set to base or all. Default all.",
        enum: ["base", "all"],
      },
    ],
    buildQuery: buildReverseGeocodeQuery,
    formatResult: formatReverseGeocodeResponse,
  },
  {
    name: "searchPlacesText",
    description:
      "Search POIs by keyword, with optional region and type filters using AMap Place Search 2.0.",
    path: "/v5/place/text",
    params: [
      {
        name: "keywords",
        type: "string",
        description: "Search keywords such as Starbucks or Beijing University.",
        required: true,
      },
      {
        name: "region",
        type: "string",
        description: "Optional region, city name, or adcode filter.",
      },
      {
        name: "types",
        type: "string_array",
        description: "Optional AMap type codes to narrow the search.",
      },
      {
        name: "cityLimit",
        type: "boolean",
        description: "When true, restrict results to the specified region.",
      },
      {
        name: "pageSize",
        type: "integer",
        description: "Results per page. Default 10, max 25.",
        minimum: 1,
        maximum: MAX_POI_PAGE_SIZE,
      },
      {
        name: "pageNum",
        type: "integer",
        description: "Page number starting from 1.",
        minimum: 1,
        maximum: 100,
      },
      {
        name: "showFields",
        type: "string_array",
        description:
          "Optional extra fields such as business, photos, or indoor.",
      },
    ],
    buildQuery: buildPoiTextSearchQuery,
    formatResult: (result) =>
      formatPoiSearchResult("POI text search results", result),
  },
  {
    name: "searchNearbyPlaces",
    description:
      "Search nearby POIs around a coordinate with optional keyword and type filters.",
    path: "/v5/place/around",
    params: [
      {
        name: "location",
        type: "string",
        description: "Center point in longitude,latitude format.",
        required: true,
      },
      {
        name: "keywords",
        type: "string",
        description: "Optional keyword filter.",
      },
      {
        name: "types",
        type: "string_array",
        description: "Optional AMap type codes to narrow the nearby search.",
      },
      {
        name: "radius",
        type: "integer",
        description: "Radius in meters. Default 3000.",
        minimum: 1,
        maximum: 50000,
      },
      {
        name: "sortRule",
        type: "string",
        description: "Nearby sorting strategy. Usually distance or weight.",
        enum: ["distance", "weight"],
      },
      {
        name: "pageSize",
        type: "integer",
        description: "Results per page. Default 10, max 25.",
        minimum: 1,
        maximum: MAX_POI_PAGE_SIZE,
      },
      {
        name: "pageNum",
        type: "integer",
        description: "Page number starting from 1.",
        minimum: 1,
        maximum: 100,
      },
      {
        name: "showFields",
        type: "string_array",
        description:
          "Optional extra fields such as business, photos, or indoor.",
      },
    ],
    buildQuery: buildPoiAroundQuery,
    formatResult: (result) =>
      formatPoiSearchResult("Nearby POI search results", result),
  },
  {
    name: "searchPlacesByPolygon",
    description:
      "Search POIs inside a polygon area, optionally filtered by keyword or type.",
    path: "/v5/place/polygon",
    params: [
      {
        name: "polygon",
        type: "string_array",
        description:
          "Polygon points as an array of longitude,latitude pairs. At least three points are required.",
        required: true,
      },
      {
        name: "keywords",
        type: "string",
        description: "Optional keyword filter inside the polygon.",
      },
      {
        name: "types",
        type: "string_array",
        description: "Optional AMap type codes to narrow the polygon search.",
      },
      {
        name: "pageSize",
        type: "integer",
        description: "Results per page. Default 10, max 25.",
        minimum: 1,
        maximum: MAX_POI_PAGE_SIZE,
      },
      {
        name: "pageNum",
        type: "integer",
        description: "Page number starting from 1.",
        minimum: 1,
        maximum: 100,
      },
      {
        name: "showFields",
        type: "string_array",
        description:
          "Optional extra fields such as business, photos, or indoor.",
      },
    ],
    buildQuery: buildPoiPolygonQuery,
    formatResult: (result) =>
      formatPoiSearchResult("Polygon POI search results", result),
  },
  {
    name: "getPlaceDetails",
    description: "Fetch detailed POI records by one or more AMap place IDs.",
    path: "/v5/place/detail",
    params: [
      {
        name: "ids",
        type: "string_array",
        description: "One or more AMap place IDs.",
        required: true,
      },
      {
        name: "showFields",
        type: "string_array",
        description:
          "Optional extra fields such as business, photos, or indoor.",
      },
    ],
    buildQuery: buildPlaceDetailQuery,
    formatResult: (result) =>
      formatPoiSearchResult("POI detail results", result),
  },
  {
    name: "getPlaceSuggestions",
    description:
      "Get autocomplete suggestions for user-entered place keywords.",
    path: "/v3/assistant/inputtips",
    params: [
      {
        name: "keywords",
        type: "string",
        description: "Partial place keyword to autocomplete.",
        required: true,
      },
      {
        name: "city",
        type: "string",
        description: "Optional city or city code hint.",
      },
      {
        name: "cityLimit",
        type: "boolean",
        description: "When true, restrict suggestions to the specified city.",
      },
      {
        name: "datatype",
        type: "string",
        description:
          "Optional suggestion type filter, such as all, poi, bus, or busline.",
      },
    ],
    buildQuery: buildInputTipsQuery,
    formatResult: formatPlaceSuggestions,
  },
  {
    name: "searchDistricts",
    description:
      "Look up administrative districts, optionally including nested subdistricts.",
    path: "/v3/config/district",
    params: [
      {
        name: "keywords",
        type: "string",
        description: "District keyword, city name, or adcode.",
        required: true,
      },
      {
        name: "subdistrict",
        type: "integer",
        description: "Nested district depth from 0 to 3. Default 1.",
        minimum: 0,
        maximum: 3,
      },
      {
        name: "page",
        type: "integer",
        description: "Page number starting from 1.",
        minimum: 1,
        maximum: 100,
      },
      {
        name: "offset",
        type: "integer",
        description: "Results per page. Default 20.",
        minimum: 1,
        maximum: 100,
      },
      {
        name: "extensions",
        type: "string",
        description: "Set to base or all. Default base.",
        enum: ["base", "all"],
      },
    ],
    buildQuery: buildDistrictQuery,
    formatResult: formatDistrictSearch,
  },
  {
    name: "getWeather",
    description:
      "Fetch live weather or a multi-day forecast for a city code or adcode.",
    path: "/v3/weather/weatherInfo",
    params: [
      {
        name: "city",
        type: "string",
        description: "City code or adcode, such as 110101.",
        required: true,
      },
      {
        name: "extensions",
        type: "string",
        description: "Set to base for live weather or all for forecasts.",
        enum: ["base", "all"],
      },
    ],
    buildQuery: buildWeatherQuery,
    formatResult: formatWeatherResult,
  },
  {
    name: "locateIp",
    description:
      "Resolve an IP address to an approximate geographic area using AMap IP location.",
    path: "/v5/ip/location",
    params: [
      {
        name: "ip",
        type: "string",
        description:
          "Optional IPv4 address. When omitted, AMap uses the caller IP.",
      },
      {
        name: "type",
        type: "integer",
        description: "Optional location type. Commonly 4.",
        minimum: 1,
        maximum: 4,
      },
    ],
    buildQuery: buildIpLocationQuery,
    formatResult: formatIpLocationResult,
  },
  {
    name: "convertCoordinates",
    description:
      "Convert coordinates from GPS, Baidu, Mapbar, or AMap formats into AMap coordinates.",
    path: "/v3/assistant/coordinate/convert",
    params: [
      {
        name: "locations",
        type: "string_array",
        description: "One or more longitude,latitude coordinates to convert.",
        required: true,
      },
      {
        name: "coordSys",
        type: "string",
        description: "Source coordinate system. Default autonavi.",
        enum: ["gps", "mapbar", "baidu", "autonavi"],
      },
    ],
    buildQuery: buildCoordinateConvertQuery,
    formatResult: formatCoordinateConvertResult,
  },
  {
    name: "planDrivingRoute",
    description:
      "Plan a driving route between two coordinates with optional strategy, waypoints, and avoidance settings.",
    path: "/v5/direction/driving",
    params: [
      {
        name: "origin",
        type: "string",
        description: "Origin in longitude,latitude format.",
        required: true,
      },
      {
        name: "destination",
        type: "string",
        description: "Destination in longitude,latitude format.",
        required: true,
      },
      {
        name: "strategy",
        type: "string",
        description: "Optional AMap driving strategy code.",
      },
      {
        name: "waypoints",
        type: "string_array",
        description: "Optional waypoint coordinates in travel order.",
      },
      {
        name: "avoidRoad",
        type: "string",
        description: "Optional road name to avoid.",
      },
      {
        name: "showFields",
        type: "string_array",
        description:
          "Optional extra fields such as cost, polyline, tmcs, or navi.",
      },
    ],
    buildQuery: buildDrivingRouteQuery,
    formatResult: (result) => formatRouteResult("Driving route", result),
  },
  {
    name: "planWalkingRoute",
    description:
      "Plan a walking route between two coordinates, optionally enabling indoor routing.",
    path: "/v5/direction/walking",
    params: [
      {
        name: "origin",
        type: "string",
        description: "Origin in longitude,latitude format.",
        required: true,
      },
      {
        name: "destination",
        type: "string",
        description: "Destination in longitude,latitude format.",
        required: true,
      },
      {
        name: "isIndoor",
        type: "boolean",
        description:
          "Set true to prefer indoor walking segments when supported.",
      },
      {
        name: "showFields",
        type: "string_array",
        description: "Optional extra fields such as cost, polyline, or navi.",
      },
    ],
    buildQuery: buildWalkingRouteQuery,
    formatResult: (result) => formatRouteResult("Walking route", result),
  },
  {
    name: "planCyclingRoute",
    description: "Plan a cycling route between two coordinates.",
    path: "/v5/direction/bicycling",
    params: [
      {
        name: "origin",
        type: "string",
        description: "Origin in longitude,latitude format.",
        required: true,
      },
      {
        name: "destination",
        type: "string",
        description: "Destination in longitude,latitude format.",
        required: true,
      },
      {
        name: "showFields",
        type: "string_array",
        description: "Optional extra fields such as cost, polyline, or navi.",
      },
    ],
    buildQuery: buildCyclingRouteQuery,
    formatResult: (result) => formatRouteResult("Cycling route", result),
  },
]

const TOOL_SPEC_MAP = new Map(TOOL_SPECS.map((spec) => [spec.name, spec]))

export const amapToolDefinitions = TOOL_SPECS.map(buildToolDefinition)

export async function executeAmapTool(
  toolName: string,
  input: JsonObject,
  config: JsonObject
) {
  const spec = TOOL_SPEC_MAP.get(toolName)
  if (!spec) {
    throw new Error(`Unknown AMap tool: ${toolName}`)
  }

  const response = await fetchAmap(spec, input, config)
  return spec.formatResult(response)
}
