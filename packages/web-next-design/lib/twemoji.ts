/**
 * web-next-design serves Twemoji from a self-hosted LOCAL copy under
 * public/twemoji/ instead of the jsDelivr CDN the shared helper points at — the
 * design sandbox must not pull external resources at runtime. Only the base URL
 * is swapped here; the frozen v14 codepoint + detection logic (and thus the
 * exact asset filenames) is reused from `@synapse/shared/emoji`.
 *
 * Assets are fetched into public/twemoji/svg/ by scripts/fetch-twemoji.mjs
 * (that dir is git-ignored). TWEMOJI_ASSET_BASE is consumed by twemoji-scope's
 * `twemoji.parse({ base })`, so it must keep the trailing slash.
 */
import {
  getTwemojiUrl as sharedGetTwemojiUrl,
  TWEMOJI_ASSET_BASE as SHARED_TWEMOJI_ASSET_BASE,
} from "@synapse/shared/emoji"

export const TWEMOJI_ASSET_BASE = "/twemoji/"

export function getTwemojiUrl(value: string | undefined | null): string | null {
  const url = sharedGetTwemojiUrl(value)
  if (!url) return null
  // shared keeps the FE0F variation selector unconditionally, but twemoji's
  // actual filenames (grabTheRightIcon) strip FE0F unless the sequence contains
  // a ZWJ (200d) — so 🛠️ is 1f6e0.svg, not 1f6e0-fe0f.svg. Normalize to the real
  // asset name so the self-hosted files resolve (shared's variant 404s even on
  // the CDN).
  const codepoint = url.slice(url.lastIndexOf("/") + 1).replace(/\.svg$/, "")
  const normalized = codepoint.includes("200d")
    ? codepoint
    : codepoint
        .split("-")
        .filter((part) => part !== "fe0f")
        .join("-")
  return `${TWEMOJI_ASSET_BASE}svg/${normalized}.svg`
}
