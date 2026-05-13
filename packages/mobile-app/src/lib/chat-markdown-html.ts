import MarkdownIt from "markdown-it"
import markdownItKatex from "markdown-it-katex"

const markdown = MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
})

markdown.use(markdownItKatex as never)

function renderCodeBlock(language: string, content: string) {
  const className = language
    ? ` class="language-${markdown.utils.escapeHtml(language)}"`
    : ""

  return `<div class="code-block-scroll"><pre class="code-block"><code${className}>${markdown.utils.escapeHtml(
    content
  )}</code></pre></div>`
}

markdown.renderer.rules.fence = (tokens, index) => {
  const token = tokens[index]
  const info = token.info.trim().split(/\s+/, 1)[0] || ""
  const content = token.content.replace(/\n$/, "")

  if (info === "mermaid") {
    return `<div class="mermaid-shell"><div class="mermaid-target" data-mermaid="${encodeURIComponent(
      content
    )}"></div></div>`
  }

  return renderCodeBlock(info, content)
}

markdown.renderer.rules.code_block = (tokens, index) =>
  renderCodeBlock("", tokens[index]?.content.replace(/\n$/, "") || "")

markdown.renderer.rules.table_open = () => '<div class="table-scroll"><table>'
markdown.renderer.rules.table_close = () => "</table></div>"

export function renderMarkdownHtml(markdownText: string) {
  return markdown.render(markdownText)
}

export function decodeMermaidChart(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function escapeHtml(value: string) {
  return markdown.utils.escapeHtml(value)
}
