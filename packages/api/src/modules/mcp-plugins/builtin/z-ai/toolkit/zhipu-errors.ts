import { z } from "zod"

type ErrorHelp = {
  summary: string
  suggestion?: string
}

const HTTP_ERROR_HELP: Record<number, ErrorHelp> = {
  400: {
    summary: "参数错误或文件内容异常",
    suggestion: "检查接口参数是否正确，文件内容或格式是否符合官方要求。",
  },
  401: {
    summary: "鉴权失败或 Token 超时",
    suggestion: "确认 API Key / 鉴权 Token 是否正确并且未过期。",
  },
  404: {
    summary: "接口未开放、任务不存在或资源不存在",
    suggestion: "确认接口可用、任务 ID 或资源标识正确，必要时联系平台开通。",
  },
  429: {
    summary: "并发、频率、余额或账户状态受限",
    suggestion: "降低请求频率或并发，检查余额、账户状态和套餐额度。",
  },
  434: {
    summary: "暂无 API 权限",
    suggestion: "等待接口开放或联系平台申请权限。",
  },
  435: {
    summary: "文件大小超过限制",
    suggestion: "缩小文件大小或分批处理文件。",
  },
  500: {
    summary: "服务器内部错误",
    suggestion: "稍后重试；如果持续失败，联系平台支持。",
  },
}

const BUSINESS_ERROR_HELP: Record<string, ErrorHelp> = {
  "500": {
    summary: "内部错误",
    suggestion: "稍后重试；如果持续失败，联系平台支持。",
  },
  "1000": { summary: "身份验证失败", suggestion: "确认认证信息是否正确。" },
  "1001": {
    summary: "未收到 Authentication 参数",
    suggestion: "检查请求头中的鉴权字段是否正确传递。",
  },
  "1002": {
    summary: "Authentication Token 非法",
    suggestion: "确认鉴权 Token 是否正确传递。",
  },
  "1003": {
    summary: "Authentication Token 已过期",
    suggestion: "重新生成或获取有效 Token。",
  },
  "1004": {
    summary: "Authentication Token 验证失败",
    suggestion: "检查 Token 是否正确、是否与当前平台匹配。",
  },
  "1100": {
    summary: "账户读写异常",
    suggestion: "稍后重试；如持续失败，联系平台支持。",
  },
  "1110": {
    summary: "账户处于非活动状态",
    suggestion: "检查账户状态并完成必要的账户操作。",
  },
  "1111": {
    summary: "账户不存在",
    suggestion: "确认当前 API Key 对应的账户是否存在。",
  },
  "1112": { summary: "账户已被锁定", suggestion: "联系平台客服解除锁定。" },
  "1113": { summary: "账户已欠费", suggestion: "充值后重试。" },
  "1120": {
    summary: "无法访问账户",
    suggestion: "稍后重试；如持续失败，联系平台支持。",
  },
  "1121": {
    summary: "账户存在违规行为并被锁定",
    suggestion: "联系平台客服排查账户限制。",
  },
  "1200": {
    summary: "API 调用错误",
    suggestion: "检查接口参数、接口地址和调用方式。",
  },
  "1210": {
    summary: "API 调用参数有误",
    suggestion: "根据官方文档检查请求参数、格式和字段命名。",
  },
  "1211": { summary: "模型不存在", suggestion: "检查模型代码是否正确。" },
  "1212": {
    summary: "当前模型不支持该调用方式",
    suggestion: "更换支持该方法的模型或调整接口用法。",
  },
  "1213": {
    summary: "缺少必需参数",
    suggestion: "检查请求中是否遗漏必需字段。",
  },
  "1214": { summary: "参数非法", suggestion: "检查字段值范围、枚举值和格式。" },
  "1215": {
    summary: "存在互斥参数同时设置",
    suggestion: "检查文档中 mutually exclusive 的参数要求。",
  },
  "1220": {
    summary: "无权访问该 API",
    suggestion: "确认当前 API Key 是否拥有对应接口权限。",
  },
  "1221": {
    summary: "API 已下线",
    suggestion: "停止调用旧接口并切换到官方现行接口。",
  },
  "1222": { summary: "API 不存在", suggestion: "检查接口名称和地址是否正确。" },
  "1230": {
    summary: "API 调用流程出错",
    suggestion: "稍后重试；如持续失败，联系平台支持。",
  },
  "1231": {
    summary: "存在重复请求 request_id",
    suggestion: "更换唯一 request_id 后重试。",
  },
  "1234": {
    summary: "网络错误",
    suggestion: "根据错误 ID 联系平台支持，或稍后重试。",
  },
  "1300": {
    summary: "API 调用被策略阻止",
    suggestion: "检查输入内容和调用方式是否触发平台策略。",
  },
  "1301": {
    summary: "输入或生成内容可能包含不安全或敏感内容",
    suggestion: "调整输入提示，避免敏感或高风险内容。",
  },
  "1302": {
    summary: "API 并发数过高",
    suggestion: "降低并发或联系平台增加限额。",
  },
  "1303": {
    summary: "API 调用频率过高",
    suggestion: "降低频率或联系平台增加限额。",
  },
  "1304": {
    summary: "达到当日调用次数上限",
    suggestion: "等待限额重置或联系平台购买更多额度。",
  },
  "1305": { summary: "API 触发流量限制", suggestion: "降低流量或稍后重试。" },
  "1308": {
    summary: "达到周期性使用上限",
    suggestion: "等待限额在下一个刷新时间重置。",
  },
  "1309": {
    summary: "GLM Coding Plan 套餐已到期",
    suggestion: "续订官方套餐后重试。",
  },
  "1310": {
    summary: "达到周/月使用上限",
    suggestion: "等待限额重置或升级套餐。",
  },
}

function parseJson(text: string): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const ZhipuErrorBodySchema = z
  .object({
    error: z
      .object({
        code: z.string().optional(),
        message: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

function extractErrorBody(body: unknown): { code?: string; message?: string } {
  const parsed = ZhipuErrorBodySchema.safeParse(body)
  if (!parsed.success) return {}
  const error = parsed.data.error
  if (!error) return {}
  return {
    code: error.code,
    message: error.message,
  }
}

function formatBodyPreview(rawText: string): string | null {
  const trimmed = rawText.trim()
  if (!trimmed) return null
  return trimmed.length <= 500 ? trimmed : `${trimmed.slice(0, 497)}...`
}

export async function throwZhipuApiError(
  apiName: string,
  response: Response
): Promise<never> {
  const rawText = await response.text().catch(() => "")
  const parsed = parseJson(rawText)
  const { code, message } = extractErrorBody(parsed)
  const httpHelp = HTTP_ERROR_HELP[response.status]
  const businessHelp = code ? BUSINESS_ERROR_HELP[code] : undefined

  const lines = [
    `${apiName} 调用失败。`,
    `HTTP 状态码: ${response.status}${httpHelp ? `（${httpHelp.summary}）` : ""}`,
    code
      ? `业务错误码: ${code}${businessHelp ? `（${businessHelp.summary}）` : ""}`
      : null,
    message ? `原始错误消息: ${message}` : null,
    !message && rawText ? `响应体: ${formatBodyPreview(rawText)}` : null,
    businessHelp?.suggestion ? `建议: ${businessHelp.suggestion}` : null,
    !businessHelp?.suggestion && httpHelp?.suggestion
      ? `建议: ${httpHelp.suggestion}`
      : null,
  ].filter(Boolean)

  throw new Error(lines.join("\n"))
}

export function normalizeZhipuTransportError(
  apiName: string,
  error: unknown
): Error {
  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return new Error(
        `${apiName} 调用超时。\n建议: 缩小输入规模、降低文件大小或稍后重试。`
      )
    }
    if (
      error.message.includes("fetch failed") ||
      error.message.includes("ECONNRESET") ||
      error.message.includes("ENOTFOUND") ||
      error.message.includes("network")
    ) {
      return new Error(
        `${apiName} 调用遇到网络错误。\n原始错误消息: ${error.message}\n建议: 检查网络连通性，稍后重试。`
      )
    }
    return error
  }
  return new Error(`${apiName} 调用失败，出现未知错误。`)
}
