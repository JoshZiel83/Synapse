import twemoji from "twemoji"

export const TWEMOJI_ASSET_BASE =
  "https://cdn.jsdelivr.net/gh/jdecked/twemoji@14.0.2/assets/"

export function getTwemojiUrl(emoji: string | undefined | null): string | null {
  if (!emoji) return null

  const tester = (
    twemoji as typeof twemoji & {
      test?: (value: string) => boolean
    }
  ).test
  if (typeof tester === "function" && !tester(emoji.trim())) return null

  const codePoint = twemoji.convert.toCodePoint(emoji.trim())
  if (!codePoint) return null

  return `${TWEMOJI_ASSET_BASE}svg/${codePoint}.svg`
}
