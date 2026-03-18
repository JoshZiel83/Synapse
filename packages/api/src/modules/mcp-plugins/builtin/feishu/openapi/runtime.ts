import type { ToolDefinition, ToolParameterProperty } from "@synapse/shared";
import type { McpTool } from "@larksuiteoapi/lark-mcp/dist/mcp-tool/types/index.js";
import * as larkMcpToolModule from "@larksuiteoapi/lark-mcp/dist/mcp-tool/tools/index.js";
import * as larkMcpConstantsModule from "@larksuiteoapi/lark-mcp/dist/mcp-tool/constants.js";

type ToolSection = "path" | "params" | "data";

type JsonObject = Record<string, unknown>;

export interface FeishuToolBinding {
  inputKey: string;
  sourceKey: string;
  section: ToolSection;
}

export interface FeishuToolMeta {
  officialTool: McpTool;
  bindings: FeishuToolBinding[];
  definition: ToolDefinition;
}

export interface FeishuToolRuntime {
  tools: ToolDefinition[];
  toolsManifest: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
  toolMap: Map<string, FeishuToolMeta>;
}

const {
  AllTools,
  AllToolsZh,
} = larkMcpToolModule as unknown as {
  AllTools: McpTool[];
  AllToolsZh: McpTool[];
};

const {
  defaultToolNames,
  presetTools,
} = larkMcpConstantsModule as unknown as {
  defaultToolNames: string[];
  presetTools: Record<string, string[]>;
};

const TOOL_SECTIONS: ToolSection[] = ["path", "params", "data"];
const DEFAULT_LANGUAGE = "zh";
const DEFAULT_TOOLS = "preset.default";

function asObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as JsonObject;
}

function normalizeLanguage(value: unknown) {
  return value === "en" ? "en" : DEFAULT_LANGUAGE;
}

function parseRequestedToolTokens(value: unknown) {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .flatMap((item) => item.split(/[\s,]+/))
      .map((item) => item.trim())
      .filter(Boolean);
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    return [DEFAULT_TOOLS];
  }

  return value
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveRequestedToolNames(value: unknown) {
  const expanded: string[] = [];
  for (const token of parseRequestedToolTokens(value)) {
    if (presetTools[token]) {
      expanded.push(...presetTools[token]);
      continue;
    }
    expanded.push(token);
  }
  return Array.from(new Set(expanded.length > 0 ? expanded : defaultToolNames));
}

function getOfficialTools(language: string, requestedTools: unknown) {
  const selected = new Set(resolveRequestedToolNames(requestedTools));
  const source = language === "en" ? AllTools : AllToolsZh;
  return source.filter((tool) => selected.has(tool.name));
}

function getSectionSchema(tool: McpTool, section: ToolSection) {
  const schema = asObject(tool.schema)[section];
  if (!schema || typeof schema !== "object") {
    return {};
  }
  const zodSchema = schema as { toJSONSchema?: () => unknown };
  if (typeof zodSchema.toJSONSchema !== "function") {
    return {};
  }

  const jsonSchema = zodSchema.toJSONSchema();
  return asObject(jsonSchema);
}

function getType(value: unknown) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const first = value.find((item): item is string => typeof item === "string");
    if (first) return first;
  }
  return "string";
}

function getLocationPrefix(section: ToolSection) {
  switch (section) {
    case "path":
      return "Path parameter.";
    case "params":
      return "Query parameter.";
    case "data":
    default:
      return "Request body field.";
  }
}

function toToolParameterProperty(
  schema: JsonObject,
  section: ToolSection,
): ToolParameterProperty {
  const property: ToolParameterProperty = {
    type: getType(schema.type),
    description: [
      getLocationPrefix(section),
      typeof schema.description === "string" ? schema.description : "",
    ]
      .filter(Boolean)
      .join(" "),
  };

  if (Array.isArray(schema.enum)) {
    property.enum = schema.enum.filter(
      (item): item is string => typeof item === "string",
    );
  }

  if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) {
    const itemSchema = schema.items as JsonObject;
    property.items = {
      type: getType(itemSchema.type),
    };
    if (Array.isArray(itemSchema.enum)) {
      property.items.enum = itemSchema.enum.filter(
        (item): item is string => typeof item === "string",
      );
    }
  }

  return property;
}

function buildToolMeta(tool: McpTool): FeishuToolMeta {
  const counts = new Map<string, number>();
  for (const section of TOOL_SECTIONS) {
    const properties = asObject(getSectionSchema(tool, section).properties);
    for (const key of Object.keys(properties)) {
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }

  const properties: Record<string, ToolParameterProperty> = {};
  const required = new Set<string>();
  const bindings: FeishuToolBinding[] = [];

  for (const section of TOOL_SECTIONS) {
    const sectionSchema = getSectionSchema(tool, section);
    const sectionProperties = asObject(sectionSchema.properties);
    const sectionRequired = Array.isArray(sectionSchema.required)
      ? sectionSchema.required.filter(
          (item): item is string => typeof item === "string",
        )
      : [];

    for (const [sourceKey, rawSchema] of Object.entries(sectionProperties)) {
      const inputKey =
        (counts.get(sourceKey) || 0) > 1
          ? `${section}__${sourceKey}`
          : sourceKey;

      properties[inputKey] = toToolParameterProperty(asObject(rawSchema), section);
      bindings.push({
        inputKey,
        sourceKey,
        section,
      });

      if (sectionRequired.includes(sourceKey)) {
        required.add(inputKey);
      }
    }
  }

  const definition: ToolDefinition = {
    name: tool.name,
    description: tool.description || "",
    parameters: {
      type: "object",
      properties,
      required: Array.from(required),
    },
  };

  return {
    officialTool: tool,
    bindings,
    definition,
  };
}

export function buildFeishuToolRuntime(config: Record<string, unknown> = {}): FeishuToolRuntime {
  const language = normalizeLanguage(config.language);
  const officialTools = getOfficialTools(language, config.tools);
  const metas = officialTools.map(buildToolMeta);

  return {
    tools: metas.map((meta) => meta.definition),
    toolsManifest: metas.map((meta) => ({
      name: meta.definition.name,
      description: meta.definition.description,
      inputSchema: meta.definition.parameters,
    })),
    toolMap: new Map(metas.map((meta) => [meta.definition.name, meta])),
  };
}

export function buildFeishuToolRequest(
  meta: FeishuToolMeta,
  input: Record<string, unknown>,
) {
  const request: Record<string, unknown> = {};

  for (const section of TOOL_SECTIONS) {
    const rawSection = input[section];
    if (rawSection && typeof rawSection === "object" && !Array.isArray(rawSection)) {
      request[section] = { ...(rawSection as Record<string, unknown>) };
    }
  }

  for (const binding of meta.bindings) {
    if (!(binding.inputKey in input)) continue;
    const currentSection =
      (request[binding.section] as Record<string, unknown> | undefined) || {};
    currentSection[binding.sourceKey] = input[binding.inputKey];
    request[binding.section] = currentSection;
  }

  for (const section of TOOL_SECTIONS) {
    const currentSection = request[section];
    if (
      currentSection &&
      typeof currentSection === "object" &&
      !Array.isArray(currentSection) &&
      Object.keys(currentSection as Record<string, unknown>).length === 0
    ) {
      delete request[section];
    }
  }

  return request;
}
