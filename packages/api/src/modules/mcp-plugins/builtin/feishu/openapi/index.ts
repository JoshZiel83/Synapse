import { Client } from "@larksuiteoapi/node-sdk";
import type { BuiltinPluginHandler } from "../../index.js";
import * as larkMcpUtils from "@larksuiteoapi/lark-mcp/dist/mcp-tool/utils/handler.js";
import { config } from "../../../../../config/index.js";
import {
  buildFeishuToolRequest,
  buildFeishuToolRuntime,
} from "./runtime.js";

type OAuthConnectionConfig = {
  accessToken?: string;
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

function getOAuthConnection(configData: Record<string, unknown>) {
  const raw = configData.feishuAccount;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  return raw as OAuthConnectionConfig;
}

function createClient() {
  if (!config.feishu.appId || !config.feishu.appSecret) {
    throw new Error(
      "Feishu MCP is not configured. Set FEISHU_MCP_APP_ID and FEISHU_MCP_APP_SECRET in the API environment.",
    );
  }

  return new Client({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    domain: config.feishu.domain,
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

    const client = createClient();
    const connection = getOAuthConnection(configData);
    const accessToken = connection?.accessToken;
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
