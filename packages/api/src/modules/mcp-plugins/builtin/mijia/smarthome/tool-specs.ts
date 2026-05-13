import { ToolDefinition } from "@synapse/shared"
import {
  DEFAULT_STATUS_PROPERTY_NAMES,
  getMijiaDeviceSpec,
  normalizeMijiaCapabilityName,
} from "../../../mijia/device-spec.js"
import { MijiaCloudClient, MijiaApiError } from "../../../mijia/cloud-client.js"
import type {
  JsonObject,
  MijiaDeviceActionSpec,
  MijiaDevicePropertySpec,
  MijiaDeviceRecord,
} from "../../../mijia/types.js"

type ToolSpec = {
  name: string
  description: string
  raw?: boolean
  parameters: ToolDefinition["parameters"]
  execute: (
    client: MijiaCloudClient,
    input: JsonObject,
    config: Record<string, unknown>
  ) => Promise<unknown>
}

function buildTool(
  name: string,
  description: string,
  properties: ToolDefinition["parameters"]["properties"],
  required: string[],
  execute: ToolSpec["execute"],
  options?: { raw?: boolean }
): ToolSpec {
  return {
    name,
    description,
    raw: options?.raw === true,
    parameters: {
      type: "object",
      properties,
      required,
    },
    execute,
  }
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined
}

function readBoolean(value: unknown, fallback = false) {
  return typeof value === "boolean" ? value : fallback
}

function readNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function readStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0
      )
    : []
}

function pickDeviceQuery(input: JsonObject) {
  const did = readString(input.did)
  const deviceName = readString(input.deviceName)
  if (!did && !deviceName) {
    throw new Error("Provide either did or deviceName.")
  }
  return {
    did,
    deviceName,
  }
}

async function loadVisibleDevices(
  client: MijiaCloudClient,
  config: Record<string, unknown>,
  includeSharedOverride?: boolean
) {
  const includeShared =
    includeSharedOverride ?? readBoolean(config.includeSharedDevices, true)
  const devices = await client.getDevicesList()
  if (!includeShared) return devices
  return devices.concat(await client.getSharedDevicesList())
}

function filterByQuery<
  T extends { name?: string; model?: string; did?: string },
>(values: T[], query?: string) {
  if (!query) return values
  const normalized = query.toLowerCase()
  return values.filter((value) =>
    [value.name, value.model, value.did]
      .filter((item): item is string => typeof item === "string")
      .some((item) => item.toLowerCase().includes(normalized))
  )
}

async function resolveDevice(
  client: MijiaCloudClient,
  input: JsonObject,
  config: Record<string, unknown>
) {
  const query = pickDeviceQuery(input)
  const devices = await loadVisibleDevices(
    client,
    config,
    typeof input.includeShared === "boolean" ? input.includeShared : undefined
  )

  if (query.did) {
    const matched = devices.find((device) => device.did === query.did)
    if (!matched) {
      throw new Error(`Device ${query.did} was not found.`)
    }
    return matched
  }

  const deviceName = query.deviceName!.toLowerCase()
  const matches = devices.filter(
    (device) => device.name.toLowerCase() === deviceName
  )
  if (matches.length === 0) {
    throw new Error(`Device '${query.deviceName}' was not found.`)
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple devices are named '${query.deviceName}'. Use did instead. Candidates: ${matches
        .map((device) => `${device.name} (${device.did})`)
        .join(", ")}`
    )
  }
  return matches[0]!
}

function pickProperty(
  deviceName: string,
  spec: Awaited<ReturnType<typeof getMijiaDeviceSpec>>,
  propertyName: string
) {
  const property = spec.propertyMap.get(
    normalizeMijiaCapabilityName(propertyName)
  )
  if (!property) {
    throw new Error(
      `Device '${deviceName}' does not expose property '${propertyName}'.`
    )
  }
  return property
}

function pickAction(
  deviceName: string,
  spec: Awaited<ReturnType<typeof getMijiaDeviceSpec>>,
  actionName: string
) {
  const action = spec.actionMap.get(normalizeMijiaCapabilityName(actionName))
  if (!action) {
    throw new Error(
      `Device '${deviceName}' does not expose action '${actionName}'.`
    )
  }
  return action
}

function listVisiblePropertyValues(property: MijiaDevicePropertySpec) {
  return property.valueList?.map((item) => ({
    value: item.value,
    description: item.description,
  }))
}

function summarizeCapabilities(
  device: MijiaDeviceRecord,
  spec: Awaited<ReturnType<typeof getMijiaDeviceSpec>>
) {
  return {
    device: {
      did: device.did,
      name: device.name,
      model: device.model,
      homeId: device.homeId,
      homeName: device.homeName,
      roomId: device.roomId,
      roomName: device.roomName,
      isOnline: device.isOnline,
      isShared: device.isShared,
    },
    properties: spec.properties.map((property) => ({
      name: property.name,
      description: property.description,
      readable: property.readable,
      writable: property.writable,
      type: property.type,
      unit: property.unit,
      range: property.range,
      valueList: listVisiblePropertyValues(property),
      siid: property.method.siid,
      piid: property.method.piid,
    })),
    actions: spec.actions.map((action) => ({
      name: action.name,
      description: action.description,
      siid: action.method.siid,
      aiid: action.method.aiid,
    })),
  }
}

function selectStatusProperties(
  spec: Awaited<ReturnType<typeof getMijiaDeviceSpec>>,
  requestedNames: string[]
) {
  if (requestedNames.length > 0) {
    return requestedNames.map((name) => pickProperty(spec.name, spec, name))
  }

  const selected: MijiaDevicePropertySpec[] = []
  for (const name of DEFAULT_STATUS_PROPERTY_NAMES) {
    const property = spec.propertyMap.get(normalizeMijiaCapabilityName(name))
    if (property && property.readable && !selected.includes(property)) {
      selected.push(property)
    }
  }

  if (selected.length === 0) {
    selected.push(
      ...spec.properties.filter((property) => property.readable).slice(0, 8)
    )
  }

  return selected.slice(0, 16)
}

function parsePropertyValue(
  property: MijiaDevicePropertySpec,
  rawValue: string
) {
  let parsed: unknown = rawValue

  switch (property.type) {
    case "bool": {
      const normalized = rawValue.toLowerCase()
      if (["true", "1", "on", "yes"].includes(normalized)) return true
      if (["false", "0", "off", "no"].includes(normalized)) return false
      throw new Error(`Property '${property.name}' expects a boolean value.`)
    }
    case "int":
    case "uint":
    case "float": {
      const numeric = Number(rawValue)
      if (!Number.isFinite(numeric)) {
        throw new Error(`Property '${property.name}' expects a numeric value.`)
      }
      parsed = property.type === "float" ? numeric : Math.trunc(numeric)
      break
    }
    case "string":
    default:
      parsed = rawValue
      break
  }

  if (property.range && typeof parsed === "number") {
    const [minimum, maximum, step] = property.range
    if (parsed < minimum || parsed > maximum) {
      throw new Error(
        `Value ${parsed} is out of range for '${property.name}' (${minimum}..${maximum}).`
      )
    }
    if (typeof step === "number" && step > 0) {
      const delta = Math.abs((parsed - minimum) / step)
      if (!Number.isInteger(delta)) {
        throw new Error(
          `Value ${parsed} must respect the step ${step} for '${property.name}'.`
        )
      }
    }
  }

  if (property.valueList && property.valueList.length > 0) {
    const matches = property.valueList.some((item) => item.value === parsed)
    if (!matches) {
      throw new Error(
        `Value ${rawValue} is not supported for '${property.name}'. Allowed values: ${property.valueList
          .map((item) => `${item.value}`)
          .join(", ")}`
      )
    }
  }

  return parsed
}

function parseActionArgs(rawValue: unknown) {
  const text = readString(rawValue)
  if (!text) return undefined
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed)) return parsed
    return [parsed]
  } catch {
    return [text]
  }
}

function parseJsonInput(rawValue: unknown, fieldName: string) {
  const text = readString(rawValue)
  if (!text) {
    throw new Error(
      `${fieldName} must be a JSON object or array encoded as a string.`
    )
  }
  try {
    return JSON.parse(text) as JsonObject | JsonObject[]
  } catch {
    throw new Error(`${fieldName} must be valid JSON.`)
  }
}

function formatRawResult(result: unknown) {
  if (result && typeof result === "object") {
    return result
  }
  return {
    result,
  }
}

const toolSpecs: ToolSpec[] = [
  buildTool(
    "list_homes",
    "List Xiaomi/Mijia homes available to the connected account.",
    {
      query: {
        type: "string",
        description: "Optional substring filter for home names.",
      },
    },
    [],
    async (client, input) => {
      const homes = await client.getHomesList()
      const query = readString(input.query)?.toLowerCase()
      const filtered = homes.filter(
        (home: any) =>
          !query ||
          String(home?.name || "")
            .toLowerCase()
            .includes(query)
      )
      return {
        homes: filtered.map((home: any) => ({
          id: String(home.id),
          name: String(home.name || home.id),
          ownerUid: Number(home.uid),
          roomCount: Array.isArray(home.roomlist) ? home.roomlist.length : 0,
          address: readString(home.address),
        })),
      }
    }
  ),
  buildTool(
    "list_devices",
    "List Mijia devices, optionally scoped to one home or filtered by name/model.",
    {
      homeId: {
        type: "string",
        description: "Optional home ID to limit the search to a single home.",
      },
      query: {
        type: "string",
        description:
          "Optional substring filter across device name, model, or did.",
      },
      includeShared: {
        type: "boolean",
        description:
          "Override whether shared devices are included in the result.",
      },
    },
    [],
    async (client, input, config) => {
      const homeId = readString(input.homeId)
      const includeShared =
        typeof input.includeShared === "boolean"
          ? input.includeShared
          : undefined
      const devices = await loadVisibleDevices(client, config, includeShared)
      const filtered = filterByQuery(
        homeId ? devices.filter((device) => device.homeId === homeId) : devices,
        readString(input.query)
      )
      return {
        devices: filtered.map((device) => ({
          did: device.did,
          name: device.name,
          model: device.model,
          homeId: device.homeId,
          homeName: device.homeName,
          roomId: device.roomId,
          roomName: device.roomName,
          isOnline: device.isOnline,
          isShared: device.isShared,
        })),
      }
    }
  ),
  buildTool(
    "get_device_capabilities",
    "Describe which readable properties, writable properties, and actions a Mijia device supports.",
    {
      did: {
        type: "string",
        description: "Target device did. Prefer this when you know it.",
      },
      deviceName: {
        type: "string",
        description:
          "Target device name from the Mi Home app. Use only when unique.",
      },
    },
    [],
    async (client, input, config) => {
      const device = await resolveDevice(client, input, config)
      const spec = await getMijiaDeviceSpec(device.model)
      return summarizeCapabilities(device, spec)
    }
  ),
  buildTool(
    "get_device_status",
    "Read the current state of one Mijia device using friendly property names.",
    {
      did: {
        type: "string",
        description: "Target device did. Prefer this when you know it.",
      },
      deviceName: {
        type: "string",
        description:
          "Target device name from the Mi Home app. Use only when unique.",
      },
      propertyNames: {
        type: "array",
        description:
          "Optional property names to read. When omitted, the tool picks common status properties.",
        items: {
          type: "string",
        },
      },
      includeShared: {
        type: "boolean",
        description:
          "Override whether shared devices are considered for lookup.",
      },
    },
    [],
    async (client, input, config) => {
      const device = await resolveDevice(client, input, config)
      const spec = await getMijiaDeviceSpec(device.model)
      const properties = selectStatusProperties(
        spec,
        readStringArray(input.propertyNames)
      )
      if (properties.length === 0) {
        throw new Error(
          `Device '${device.name}' does not expose readable properties.`
        )
      }

      const results = await client.getDevicesProp(
        properties.map((property) => ({
          did: device.did,
          siid: property.method.siid,
          piid: property.method.piid,
        }))
      )

      const resultList = Array.isArray(results) ? results : [results]
      return {
        device: {
          did: device.did,
          name: device.name,
          model: device.model,
          homeId: device.homeId,
          homeName: device.homeName,
          roomId: device.roomId,
          roomName: device.roomName,
          isOnline: device.isOnline,
          isShared: device.isShared,
        },
        properties: properties.map((property, index) => {
          const raw = (resultList[index] || {}) as Record<string, unknown>
          const code = typeof raw.code === "number" ? raw.code : 0
          return {
            name: property.name,
            description: property.description,
            value: raw.value,
            valueDisplay: raw.value,
            code,
            error: code === 0 ? undefined : `Mijia error ${code}`,
            readable: property.readable,
            writable: property.writable,
            unit: property.unit,
            range: property.range,
            valueList: listVisiblePropertyValues(property),
            siid: property.method.siid,
            piid: property.method.piid,
            updateTime:
              typeof raw.updateTime === "number" ? raw.updateTime : undefined,
          }
        }),
      }
    }
  ),
  buildTool(
    "set_device_property",
    "Set one writable Mijia device property using a friendly property name.",
    {
      did: {
        type: "string",
        description: "Target device did. Prefer this when you know it.",
      },
      deviceName: {
        type: "string",
        description:
          "Target device name from the Mi Home app. Use only when unique.",
      },
      propertyName: {
        type: "string",
        description:
          "Friendly property name such as on, brightness, or target-temperature.",
      },
      value: {
        type: "string",
        description:
          "New value encoded as text. Booleans accept true/false, 1/0, on/off.",
      },
      includeShared: {
        type: "boolean",
        description:
          "Override whether shared devices are considered for lookup.",
      },
    },
    ["propertyName", "value"],
    async (client, input, config) => {
      const device = await resolveDevice(client, input, config)
      const spec = await getMijiaDeviceSpec(device.model)
      const property = pickProperty(
        device.name,
        spec,
        String(input.propertyName || "")
      )
      if (!property.writable) {
        throw new Error(
          `Property '${property.name}' is read-only on '${device.name}'.`
        )
      }

      const parsedValue = parsePropertyValue(property, String(input.value))
      const result = await client.setDevicesProp({
        did: device.did,
        siid: property.method.siid,
        piid: property.method.piid,
        value: parsedValue,
      })

      return {
        device: {
          did: device.did,
          name: device.name,
          model: device.model,
        },
        property: {
          name: property.name,
          description: property.description,
          value: parsedValue,
          siid: property.method.siid,
          piid: property.method.piid,
        },
        result: formatRawResult(result),
      }
    }
  ),
  buildTool(
    "run_device_action",
    "Execute one Mijia device action using a friendly action name.",
    {
      did: {
        type: "string",
        description: "Target device did. Prefer this when you know it.",
      },
      deviceName: {
        type: "string",
        description:
          "Target device name from the Mi Home app. Use only when unique.",
      },
      actionName: {
        type: "string",
        description: "Friendly action name such as toggle or start-cleaning.",
      },
      argsJson: {
        type: "string",
        description: "Optional JSON array of action arguments. Example: [2].",
      },
      includeShared: {
        type: "boolean",
        description:
          "Override whether shared devices are considered for lookup.",
      },
    },
    ["actionName"],
    async (client, input, config) => {
      const device = await resolveDevice(client, input, config)
      const spec = await getMijiaDeviceSpec(device.model)
      const action = pickAction(
        device.name,
        spec,
        String(input.actionName || "")
      )
      const args = parseActionArgs(input.argsJson)
      const result = await client.runAction({
        did: device.did,
        siid: action.method.siid,
        aiid: action.method.aiid,
        ...(args ? { value: args } : {}),
      })

      return {
        device: {
          did: device.did,
          name: device.name,
          model: device.model,
        },
        action: {
          name: action.name,
          description: action.description,
          siid: action.method.siid,
          aiid: action.method.aiid,
          args,
        },
        result: formatRawResult(result),
      }
    }
  ),
  buildTool(
    "list_scenes",
    "List manual Mijia scenes that the connected account can trigger.",
    {
      homeId: {
        type: "string",
        description: "Optional home ID to limit the search to a single home.",
      },
      query: {
        type: "string",
        description: "Optional substring filter for scene names.",
      },
    },
    [],
    async (client, input) => {
      const scenes = await client.getScenesList(readString(input.homeId))
      const query = readString(input.query)?.toLowerCase()
      return {
        scenes: scenes
          .filter(
            (scene: any) =>
              !query ||
              String(scene?.name || "")
                .toLowerCase()
                .includes(query)
          )
          .map((scene: any) => ({
            sceneId: String(scene.scene_id),
            name: String(scene.name || scene.scene_id),
            homeId: String(scene.home_id),
            homeName: readString(scene.home_name),
          })),
      }
    }
  ),
  buildTool(
    "run_scene",
    "Run a Mijia manual scene by ID or unique name.",
    {
      sceneId: {
        type: "string",
        description: "Scene ID to execute.",
      },
      sceneName: {
        type: "string",
        description: "Scene name to execute. Use only when unique.",
      },
      homeId: {
        type: "string",
        description:
          "Optional home ID, useful when multiple scenes share a name.",
      },
    },
    [],
    async (client, input) => {
      const sceneId = readString(input.sceneId)
      let homeId = readString(input.homeId)
      let sceneName = readString(input.sceneName)
      if (!sceneId && !sceneName) {
        throw new Error("Provide either sceneId or sceneName.")
      }

      if (!sceneId) {
        const scenes = await client.getScenesList(homeId)
        const matches = scenes.filter(
          (scene: any) =>
            String(scene?.name || "").toLowerCase() === sceneName!.toLowerCase()
        )
        if (matches.length === 0) {
          throw new Error(`Scene '${sceneName}' was not found.`)
        }
        if (matches.length > 1) {
          throw new Error(
            `Multiple scenes are named '${sceneName}'. Provide sceneId or homeId. Candidates: ${matches
              .map((scene: any) => `${scene.name} (${scene.scene_id})`)
              .join(", ")}`
          )
        }
        sceneName = String(matches[0]!.name)
        homeId = String(matches[0]!.home_id)
      }

      const result = await client.runScene(sceneId || "", homeId || "")
      return {
        scene: {
          sceneId: sceneId || undefined,
          sceneName,
          homeId,
        },
        result: formatRawResult(result),
      }
    }
  ),
  buildTool(
    "get_device_statistics",
    "Read Mijia device statistics such as energy usage when the device exposes them.",
    {
      did: {
        type: "string",
        description: "Target device did. Prefer this when you know it.",
      },
      deviceName: {
        type: "string",
        description:
          "Target device name from the Mi Home app. Use only when unique.",
      },
      key: {
        type: "string",
        description: "Statistic key such as 7.1. Usually this is siid.piid.",
      },
      dataType: {
        type: "string",
        description:
          "Statistic granularity such as stat_hour_v3, stat_day_v3, stat_week_v3, or stat_month_v3.",
      },
      limit: {
        type: "number",
        description: "Optional maximum number of returned data points.",
      },
      timeStart: {
        type: "number",
        description:
          "Optional Unix timestamp in seconds for the beginning of the range.",
      },
      timeEnd: {
        type: "number",
        description:
          "Optional Unix timestamp in seconds for the end of the range.",
      },
      includeShared: {
        type: "boolean",
        description:
          "Override whether shared devices are considered for lookup.",
      },
    },
    ["key", "dataType"],
    async (client, input, config) => {
      const device = await resolveDevice(client, input, config)
      const timeEnd = Math.trunc(
        readNumber(input.timeEnd) || Date.now() / 1_000
      )
      const timeStart = Math.trunc(
        readNumber(input.timeStart) || timeEnd - 30 * 24 * 60 * 60
      )
      const result = await client.getStatistics({
        did: device.did,
        key: String(input.key),
        data_type: String(input.dataType),
        limit: Math.trunc(readNumber(input.limit) || 20),
        time_start: timeStart,
        time_end: timeEnd,
      })

      return {
        device: {
          did: device.did,
          name: device.name,
          model: device.model,
        },
        statistics: formatRawResult(result),
      }
    }
  ),
  buildTool(
    "get_properties_raw",
    "Read one or more Mijia properties using raw did/siid/piid payloads.",
    {
      paramsJson: {
        type: "string",
        description:
          "JSON object or JSON array accepted by the Mijia prop/get endpoint.",
      },
    },
    ["paramsJson"],
    async (client, input) => {
      return formatRawResult(
        await client.getDevicesProp(
          parseJsonInput(input.paramsJson, "paramsJson")
        )
      )
    },
    { raw: true }
  ),
  buildTool(
    "set_properties_raw",
    "Set one or more Mijia properties using raw did/siid/piid/value payloads.",
    {
      paramsJson: {
        type: "string",
        description:
          "JSON object or JSON array accepted by the Mijia prop/set endpoint.",
      },
    },
    ["paramsJson"],
    async (client, input) => {
      return formatRawResult(
        await client.setDevicesProp(
          parseJsonInput(input.paramsJson, "paramsJson")
        )
      )
    },
    { raw: true }
  ),
  buildTool(
    "run_action_raw",
    "Execute a raw Mijia action payload using did/siid/aiid/value fields.",
    {
      paramsJson: {
        type: "string",
        description:
          "JSON object or JSON array accepted by the Mijia action endpoint.",
      },
    },
    ["paramsJson"],
    async (client, input) => {
      return formatRawResult(
        await client.runAction(parseJsonInput(input.paramsJson, "paramsJson"))
      )
    },
    { raw: true }
  ),
]

export function getMijiaToolDefinitions(config: Record<string, unknown> = {}) {
  const exposeRawTools = readBoolean(config.exposeRawMiotTools, false)
  return toolSpecs
    .filter((tool) => exposeRawTools || tool.raw !== true)
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }))
}

export async function executeMijiaTool(
  toolName: string,
  input: JsonObject,
  config: Record<string, unknown>,
  client: MijiaCloudClient
) {
  const tool = toolSpecs.find((item) => item.name === toolName)
  if (!tool) {
    throw new Error(`Unknown Mijia tool '${toolName}'.`)
  }
  try {
    return await tool.execute(client, input, config)
  } catch (error) {
    if (error instanceof MijiaApiError) {
      throw new Error(error.message)
    }
    throw error
  }
}
