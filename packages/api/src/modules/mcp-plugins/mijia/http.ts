import type { JsonObject } from "./types.js";

export class MijiaTimeoutError extends Error {
  constructor(message = "Mijia request timed out") {
    super(message);
    this.name = "MijiaTimeoutError";
  }
}

export class CookieJar {
  private readonly values = new Map<string, string>();

  constructor(initial?: Record<string, string | undefined>) {
    if (!initial) return;
    for (const [key, value] of Object.entries(initial)) {
      if (typeof value === "string" && value.length > 0) {
        this.values.set(key, value);
      }
    }
  }

  set(name: string, value: string) {
    if (!name || !value) return;
    this.values.set(name, value);
  }

  get(name: string) {
    return this.values.get(name);
  }

  toHeader() {
    return Array.from(this.values.entries())
      .map(([key, value]) => `${key}=${value}`)
      .join(";");
  }

  absorb(response: Response) {
    const headerBag = response.headers as Headers & {
      getSetCookie?: () => string[];
    };
    const setCookies =
      typeof headerBag.getSetCookie === "function"
        ? headerBag.getSetCookie()
        : (() => {
            const single = response.headers.get("set-cookie");
            return single ? [single] : [];
          })();

    for (const item of setCookies) {
      const [pair] = item.split(";", 1);
      if (!pair) continue;
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (!name || !value) continue;
      this.values.set(name, value);
    }
  }
}

export function asObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as JsonObject;
}

export function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit & { timeoutMs?: number } = {},
) {
  const { timeoutMs = 5_000, signal, ...requestInit } = init;
  const controller = new AbortController();
  let abortReason: "timeout" | "aborted" | null = null;
  const timeout = setTimeout(() => {
    abortReason = "timeout";
    controller.abort();
  }, timeoutMs);

  const abortListener = () => {
    abortReason = "aborted";
    controller.abort();
  };
  signal?.addEventListener("abort", abortListener, { once: true });

  try {
    return await fetch(input, {
      ...requestInit,
      signal: controller.signal,
    });
  } catch (error) {
    if (
      abortReason === "timeout" ||
      (error instanceof Error && error.message.trim().toLowerCase() === "timeout")
    ) {
      throw new MijiaTimeoutError();
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortListener);
  }
}

export async function fetchWithCookies(
  input: string | URL,
  init: RequestInit & { timeoutMs?: number },
  jar: CookieJar,
  maxRedirects = 5,
) {
  let url = new URL(typeof input === "string" ? input : input.toString());
  let nextInit = { ...init };

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const headers = new Headers(nextInit.headers || {});
    const cookieHeader = jar.toHeader();
    if (cookieHeader) {
      headers.set("Cookie", cookieHeader);
    }

    const response = await fetchWithTimeout(url, {
      ...nextInit,
      headers,
      redirect: "manual",
    });
    jar.absorb(response);

    const location = response.headers.get("location");
    if (
      location &&
      [301, 302, 303, 307, 308].includes(response.status)
    ) {
      url = new URL(location, url);
      if (response.status === 303) {
        nextInit = {
          ...nextInit,
          method: "GET",
          body: undefined,
        };
      }
      continue;
    }

    return response;
  }

  throw new Error("Too many redirects while talking to Mijia");
}

export function parsePrefixedJson(text: string) {
  const normalized = text.replace(/^&&&START&&&/, "");
  return JSON.parse(normalized) as JsonObject;
}
