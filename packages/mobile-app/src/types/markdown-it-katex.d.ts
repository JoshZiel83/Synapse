declare module "markdown-it-katex" {
  import type MarkdownIt from "markdown-it";

  export default function markdownItKatex(
    md: MarkdownIt,
    options?: Record<string, unknown>,
  ): void;
}
