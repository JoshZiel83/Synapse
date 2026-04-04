import twemoji from "twemoji";

export const TWEMOJI_ASSET_BASE =
  "https://cdn.jsdelivr.net/gh/jdecked/twemoji@14.0.2/assets/";

export function getTwemojiUrl(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  const tester = (
    twemoji as typeof twemoji & {
      test?: (input: string) => boolean;
    }
  ).test;

  if (typeof tester === "function" && !tester(trimmed)) {
    return null;
  }

  const codePoint = twemoji.convert.toCodePoint(trimmed);
  if (!codePoint) {
    return null;
  }

  return `${TWEMOJI_ASSET_BASE}svg/${codePoint}.svg`;
}
