import { Client } from "@larksuiteoapi/node-sdk";
import type { BuiltinPluginHandler } from "../../index.js";
import * as larkMcpUtils from "@larksuiteoapi/lark-mcp/dist/mcp-tool/utils/handler.js";
import {
  buildFeishuToolRequest,
  buildFeishuToolRuntime,
} from "./runtime.js";

type FeishuConnectionConfig = {
  secretPayload?: {
    accessToken?: string;
  };
};

type FeishuClientConfig = {
  appId?: string;
  appSecret?: string;
  domain?: string;
};

const { larkOapiHandler } = larkMcpUtils as unknown as {
  larkOapiHandler: (
    client: Client,
    params: Record<string, unknown>,
    options: {
      userAccessToken?: string;
      tool: unknown;
    },
  ) => Promise<unknown>;
};

function getConnectionConfig(configData: Record<string, unknown>) {
  const raw = configData.feishuAccount;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  return raw as FeishuConnectionConfig;
}

function getClientConfig(configData: Record<string, unknown>) {
  return {
    appId: typeof configData.appId === "string" ? configData.appId : "",
    appSecret: typeof configData.appSecret === "string" ? configData.appSecret : "",
    domain:
      typeof configData.domain === "string" && configData.domain.trim().length > 0
        ? configData.domain
        : "https://open.feishu.cn",
  } satisfies FeishuClientConfig;
}

function createClient(configData: Record<string, unknown>) {
  const clientConfig = getClientConfig(configData);
  if (!clientConfig.appId || !clientConfig.appSecret) {
    throw new Error(
      "Feishu MCP is not configured. Set the App ID and App Secret in the plugin setup.",
    );
  }

  return new Client({
    appId: clientConfig.appId,
    appSecret: clientConfig.appSecret,
    domain: clientConfig.domain,
  });
}

export const feishuOpenapiHandler: BuiltinPluginHandler = {
  getTools() {
    return buildFeishuToolRuntime().tools;
  },

  getToolsFiltered(configData) {
    return buildFeishuToolRuntime(configData).tools;
  },

  async execute(toolName, input, configData) {
    const runtime = buildFeishuToolRuntime(configData);
    const toolMeta = runtime.toolMap.get(toolName);
    if (!toolMeta) {
      throw new Error(`Unknown Feishu tool: ${toolName}`);
    }

    const client = createClient(configData);
    const connection = getConnectionConfig(configData);
    const accessToken =
      connection?.secretPayload?.accessToken;
    const accessTokens = Array.isArray(toolMeta.officialTool.accessTokens)
      ? toolMeta.officialTool.accessTokens
      : [];
    const supportsUserToken = accessTokens.includes("user");
    const supportsTenantToken = accessTokens.includes("tenant");

    if (supportsUserToken && !supportsTenantToken && !accessToken) {
      throw new Error(
        "This Feishu tool requires a connected user account. Reconnect Feishu and try again.",
      );
    }

    const request = buildFeishuToolRequest(toolMeta, input);
    return larkOapiHandler(
      client,
      {
        ...request,
        useUAT: Boolean(accessToken) && supportsUserToken,
      },
      {
        userAccessToken: accessToken,
        tool: toolMeta.officialTool,
      },
    );
  },
};
