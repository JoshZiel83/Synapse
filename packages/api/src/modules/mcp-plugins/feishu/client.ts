type JsonObject = Record<string, unknown>;
type RequestBody =
  | string
  | URLSearchParams
  | FormData
  | Blob
  | ArrayBuffer
  | Uint8Array;

export type FeishuBrand = "feishu" | "lark";

type FeishuResolvedConnection = {
  status?: string;
  publicPayload?: JsonObject;
  secretPayload?: JsonObject;
};

function asObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as JsonObject;
}

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function resolveFeishuOpenBaseUrl(brand: FeishuBrand) {
  return brand === "lark"
    ? "https://open.larksuite.com"
    : "https://open.feishu.cn";
}

export function resolveFeishuAccountsBaseUrl(brand: FeishuBrand) {
  return brand === "lark"
    ? "https://accounts.larksuite.com"
    : "https://accounts.feishu.cn";
}

function readFeishuConnection(config: Record<string, unknown>): FeishuResolvedConnection {
  const raw = config.feishuAccount;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Feishu account is not configured. Reconnect the plugin and try again.");
  }

  const connection = raw as FeishuResolvedConnection;
  if (connection.status && connection.status !== "active") {
    throw new Error("Feishu account authorization expired. Reconnect the plugin and try again.");
  }

  return connection;
}

export function getFeishuConnectionMetadata(config: Record<string, unknown>) {
  const connection = readFeishuConnection(config);
  const publicPayload = asObject(connection.publicPayload);
  const secretPayload = asObject(connection.secretPayload);
  const brand =
    asString(publicPayload.brand) === "lark"
      ? "lark"
      : "feishu";
  const openBaseUrl =
    asString(publicPayload.openBaseUrl) ||
    resolveFeishuOpenBaseUrl(brand);
  const accountsBaseUrl =
    asString(publicPayload.accountsBaseUrl) ||
    resolveFeishuAccountsBaseUrl(brand);
  const accessToken = asString(secretPayload.accessToken);
  const appId = asString(secretPayload.appId);
  const appSecret = asString(secretPayload.appSecret);
  const refreshToken = asString(secretPayload.refreshToken);

  if (!accessToken) {
    throw new Error("Feishu user access token is missing. Reconnect the plugin and try again.");
  }

  return {
    brand: brand as FeishuBrand,
    openBaseUrl,
    accountsBaseUrl,
    accessToken,
    appId,
    appSecret,
    refreshToken,
    scopes: Array.isArray(publicPayload.scopes)
      ? publicPayload.scopes.filter((item): item is string => typeof item === "string")
      : [],
  };
}

async function parseErrorResponse(response: Response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const payload = asObject(await response.json().catch(() => ({})));
    const message =
      asString(payload.msg) ||
      asString(payload.error_description) ||
      asString(payload.error) ||
      `HTTP ${response.status}`;
    const code = payload.code;
    if (typeof code === "number") {
      return `[${code}] ${message}`;
    }
    return message;
  }

  const text = await response.text().catch(() => "");
  return text.trim() || `HTTP ${response.status}`;
}

export class FeishuApiClient {
  constructor(
    public readonly openBaseUrl: string,
    private readonly accessToken: string,
  ) {}

  private buildUrl(path: string, query?: Record<string, string | number | boolean | undefined>) {
    const url = new URL(path, this.openBaseUrl);
    for (const [key, value] of Object.entries(query || {})) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
    return url;
  }

  async requestJson<T = JsonObject>(input: {
    path: string;
    method?: string;
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    headers?: Record<string, string>;
  }): Promise<T> {
    const url = this.buildUrl(input.path, input.query);
    const headers = new Headers(input.headers || {});
    headers.set("Authorization", `Bearer ${this.accessToken}`);
    headers.set("Accept", "application/json");

    let body: RequestBody | undefined;
    if (input.body !== undefined) {
      if (input.body instanceof FormData) {
        body = input.body;
      } else {
        headers.set("Content-Type", "application/json");
        body = JSON.stringify(input.body);
      }
    }

    const response = await fetch(url, {
      method: input.method || "GET",
      headers,
      body,
    });

    if (!response.ok) {
      throw new Error(await parseErrorResponse(response));
    }

    const payload = asObject(await response.json().catch(() => ({})));
    if (typeof payload.code === "number" && payload.code !== 0) {
      throw new Error(
        `[${payload.code}] ${
          asString(payload.msg) || "Feishu API request failed"
        }`,
      );
    }

    return (asObject(payload.data).code !== undefined
      ? payload.data
      : (payload.data ?? payload)) as T;
  }

  async requestBuffer(input: {
    path: string;
    method?: string;
    query?: Record<string, string | number | boolean | undefined>;
    body?: RequestBody;
    headers?: Record<string, string>;
  }) {
    const url = this.buildUrl(input.path, input.query);
    const headers = new Headers(input.headers || {});
    headers.set("Authorization", `Bearer ${this.accessToken}`);

    const response = await fetch(url, {
      method: input.method || "GET",
      headers,
      body: input.body,
    });

    if (!response.ok) {
      throw new Error(await parseErrorResponse(response));
    }

    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") || "application/octet-stream",
      contentDisposition: response.headers.get("content-disposition") || "",
    };
  }
}

export function createFeishuApiClient(config: Record<string, unknown>) {
  const metadata = getFeishuConnectionMetadata(config);
  return {
    metadata,
    client: new FeishuApiClient(metadata.openBaseUrl, metadata.accessToken),
  };
}

export function parseJsonObjectInput(
  value: unknown,
  label: string,
): JsonObject {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as JsonObject;
      }
    } catch {
      throw new Error(`${label} must be a JSON object.`);
    }
    throw new Error(`${label} must be a JSON object.`);
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }

  throw new Error(`${label} must be a JSON object.`);
}

export function parseJsonArrayInput(
  value: unknown,
  label: string,
): unknown[] {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      throw new Error(`${label} must be a JSON array.`);
    }
    throw new Error(`${label} must be a JSON array.`);
  }

  if (Array.isArray(value)) {
    return value;
  }

  throw new Error(`${label} must be a JSON array.`);
}

export function stripMarkdown(value: string) {
  return value
    .replace(/^#+\s+/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}
