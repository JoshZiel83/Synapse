export interface McpHostJsonRpcRequest {
  id: string | number | null
  method: string
  params?: unknown
}

export interface McpHostJsonRpcError {
  httpStatus: number
  id: string | number | null
  code: number
  message: string
}

export type McpHostJsonRpcParseResult =
  | { ok: true; request: McpHostJsonRpcRequest }
  | { ok: false; error: McpHostJsonRpcError }

export function parseMcpHostRequestBody(
  raw: string
): McpHostJsonRpcParseResult {
  let body: unknown
  try {
    body = JSON.parse(raw || "{}")
  } catch {
    return {
      ok: false,
      error: {
        httpStatus: 400,
        id: null,
        code: -32700,
        message: "parse error",
      },
    }
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      ok: false,
      error: {
        httpStatus: 200,
        id: null,
        code: -32600,
        message: "invalid request",
      },
    }
  }

  const request = body as {
    id?: unknown
    method?: unknown
    params?: unknown
  }
  const id =
    typeof request.id === "string" ||
    typeof request.id === "number" ||
    request.id === null
      ? request.id
      : null

  if (typeof request.method !== "string") {
    return {
      ok: false,
      error: {
        httpStatus: 200,
        id,
        code: -32600,
        message: "method required",
      },
    }
  }

  return {
    ok: true,
    request: {
      id,
      method: request.method,
      params: request.params,
    },
  }
}
