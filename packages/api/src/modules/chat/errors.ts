export interface ChatServiceError extends Error {
  code: string
  statusCode: number
  details?: Record<string, unknown>
}

export function createChatError(
  statusCode: number,
  code: string,
  message: string,
  details?: Record<string, unknown>
): ChatServiceError {
  const error = new Error(message) as ChatServiceError
  error.statusCode = statusCode
  error.code = code
  error.details = details
  return error
}

export function isChatServiceError(value: unknown): value is ChatServiceError {
  return Boolean(
    value &&
    typeof value === "object" &&
    "statusCode" in value &&
    "code" in value
  )
}
