function normalizeExpoWebBasePath(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "/") {
    return "";
  }

  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/, "");
}

function normalizeWebPath(path: string) {
  return path.startsWith("/") ? path : `/${path}`;
}

export const EXPO_WEB_BASE_PATH = normalizeExpoWebBasePath(
  process.env.EXPO_BASE_URL,
);
export const EXPO_WEB_RUNTIME_BASE_PATH =
  process.env.NODE_ENV === "production" ? EXPO_WEB_BASE_PATH : "";

export function getExpoWebBasePath() {
  return EXPO_WEB_BASE_PATH;
}

export function withExpoWebBasePath(path: string) {
  const normalizedPath = normalizeWebPath(path);
  return EXPO_WEB_RUNTIME_BASE_PATH
    ? `${EXPO_WEB_RUNTIME_BASE_PATH}${normalizedPath}`
    : normalizedPath;
}

export function getExpoWebBaseScope() {
  return EXPO_WEB_RUNTIME_BASE_PATH
    ? `${EXPO_WEB_RUNTIME_BASE_PATH}/`
    : "/";
}
