import twemoji from 'twemoji';

export function getTwemojiUrl(emoji: string | undefined | null): string | null {
  if (!emoji) return null;

  const codePoint = twemoji.convert.toCodePoint(emoji.trim());
  if (!codePoint) return null;

  return `https://cdn.jsdelivr.net/gh/jdecked/twemoji@latest/assets/svg/${codePoint}.svg`;
}
