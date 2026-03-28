export type ToolErrorKind = "model_actionable" | "internal";

export interface ToolExecutionErrorOptions {
  code?: string;
  kind?: ToolErrorKind;
  retryable?: boolean;
  details?: unknown;
  extra?: Record<string, unknown>;
  cause?: unknown;
}

export class ToolExecutionError extends Error {
  readonly code?: string;
  readonly kind: ToolErrorKind;
  readonly retryable: boolean;
  readonly details?: unknown;
  readonly extra?: Record<string, unknown>;
  declare readonly cause?: unknown;

  constructor(baseMessage: string, options: ToolExecutionErrorOptions = {}) {
    super(formatToolErrorMessage(baseMessage, options));
    this.name = "ToolExecutionError";
    this.code = options.code;
    this.kind = options.kind ?? "model_actionable";
    this.retryable =
      options.retryable ?? (this.kind === "model_actionable");
    this.details = options.details;
    this.extra =
      options.extra && Object.keys(options.extra).length > 0
        ? options.extra
        : undefined;
    this.cause = options.cause;
  }
}

function stringifyToolErrorDetail(detail: unknown): string | null {
  if (typeof detail === "string") {
    const trimmed = detail.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (detail === null || detail === undefined) {
    return null;
  }

  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

export function formatToolErrorMessage(
  baseMessage: string,
  options?: Pick<ToolExecutionErrorOptions, "details" | "extra">,
) {
  const parts = [baseMessage.trim()];
  const details = options?.details;

  if (Array.isArray(details)) {
    const rendered = details
      .map((detail) => stringifyToolErrorDetail(detail))
      .filter((detail): detail is string => Boolean(detail));
    if (rendered.length > 0) {
      parts.push(`Details: ${rendered.join(" ")}`);
    }
  } else {
    const rendered = stringifyToolErrorDetail(details);
    if (rendered) {
      parts.push(`Details: ${rendered}`);
    }
  }

  if (options?.extra && Object.keys(options.extra).length > 0) {
    parts.push(JSON.stringify(options.extra));
  }

  return parts.join(" ");
}

export function throwToolError(
  baseMessage: string,
  options?: Omit<ToolExecutionErrorOptions, "kind">,
): never {
  throw new ToolExecutionError(baseMessage, {
    ...options,
    kind: "model_actionable",
  });
}

export function throwInternalToolError(
  baseMessage: string,
  options?: Omit<ToolExecutionErrorOptions, "kind">,
): never {
  throw new ToolExecutionError(baseMessage, {
    ...options,
    kind: "internal",
    retryable: options?.retryable ?? false,
  });
}

export function isToolExecutionError(
  error: unknown,
): error is ToolExecutionError {
  return error instanceof ToolExecutionError;
}

export function getToolErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  const rendered = stringifyToolErrorDetail(error);
  return rendered || "Unknown tool error";
}

export function getToolErrorMetadata(
  error: unknown,
): Record<string, unknown> {
  if (error instanceof ToolExecutionError) {
    return {
      toolError: {
        kind: error.kind,
        retryable: error.retryable,
        ...(error.code ? { code: error.code } : {}),
        ...(error.details !== undefined ? { details: error.details } : {}),
        ...(error.extra ? { extra: error.extra } : {}),
      },
    };
  }

  const raw =
    typeof error === "object" && error !== null
      ? (error as Record<string, unknown>)
      : null;
  const code = typeof raw?.code === "string" ? raw.code : undefined;

  return {
    toolError: {
      kind: "internal",
      retryable: raw?.retryable === true,
      ...(code ? { code } : {}),
    },
  };
}

function getToolErrorStatus(error: unknown): number | undefined {
  const raw =
    typeof error === "object" && error !== null
      ? (error as Record<string, unknown>)
      : null;
  if (typeof raw?.statusCode === "number") {
    return raw.statusCode;
  }
  if (typeof raw?.status === "number") {
    return raw.status;
  }
  return undefined;
}

export function rethrowToolExecutionError(
  error: unknown,
  fallbackMessage: string,
  options?: Omit<ToolExecutionErrorOptions, "kind">,
): never {
  if (error instanceof ToolExecutionError) {
    throw error;
  }

  const message = getToolErrorMessage(error) || fallbackMessage;
  const status = getToolErrorStatus(error);

  if (status !== undefined && status < 500) {
    throwToolError(message, options);
  }

  throwInternalToolError(message, options);
}
