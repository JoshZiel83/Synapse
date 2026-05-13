"use dom"

import { useEffect, useMemo, useRef } from "react"
import mermaid from "mermaid"
import twemoji from "twemoji"

import {
  decodeMermaidChart,
  escapeHtml,
  renderMarkdownHtml,
} from "@/lib/chat-markdown-html"

export default function ChatMarkdownDom({
  markdown,
  mine,
}: {
  markdown: string
  mine: boolean
  dom?: import("expo/dom").DOMProps
}) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const html = useMemo(() => renderMarkdownHtml(markdown), [markdown])

  useEffect(() => {
    let cancelled = false

    async function enhanceMarkdown() {
      if (!rootRef.current) {
        return
      }

      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: mine ? "dark" : "default",
        fontFamily:
          '"Noto Sans", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
      })

      const targets = Array.from(
        rootRef.current.querySelectorAll<HTMLElement>("[data-mermaid]")
      )

      await Promise.all(
        targets.map(async (target, index) => {
          const rawChart = target.dataset.mermaid || ""
          const chart = decodeMermaidChart(rawChart)

          try {
            const result = await mermaid.render(
              `chat-mermaid-${index}-${Math.random().toString(36).slice(2)}`,
              chart
            )
            if (!cancelled) {
              target.innerHTML = result.svg
            }
          } catch {
            if (!cancelled) {
              target.innerHTML = `<pre class="code-block">${escapeHtml(chart)}</pre>`
            }
          }
        })
      )

      if (!cancelled && rootRef.current) {
        twemoji.parse(rootRef.current, {
          base: "https://cdn.jsdelivr.net/gh/jdecked/twemoji@14.0.2/assets/",
          folder: "svg",
          ext: ".svg",
          className: "twemoji-inline",
        })
      }
    }

    void enhanceMarkdown()

    return () => {
      cancelled = true
    }
  }, [html, mine])

  const paletteClass = useMemo(
    () => (mine ? "markdown-root markdown-root-mine" : "markdown-root"),
    [mine]
  )

  return (
    <div ref={rootRef} className={paletteClass}>
      <link
        rel="stylesheet"
        href="https://cdn.jsdelivr.net/npm/katex@0.16.44/dist/katex.min.css"
      />
      <style>{`
        :root {
          color-scheme: light;
        }
        body {
          margin: 0;
          background: transparent;
          font-family: "Noto Sans", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
        }
        .markdown-root {
          color: #0f172a;
          font-size: 15px;
          line-height: 1.55;
          width: 100%;
          max-width: 100%;
          min-width: 0;
          box-sizing: border-box;
          overflow: hidden;
          overflow-wrap: anywhere;
          word-break: break-word;
        }
        .markdown-root-mine {
          color: #ffffff;
        }
        .markdown-content > *:first-child {
          margin-top: 0;
        }
        .markdown-content > *:last-child {
          margin-bottom: 0;
        }
        .markdown-content p,
        .markdown-content ul,
        .markdown-content ol,
        .markdown-content blockquote,
        .markdown-content .code-block-scroll,
        .markdown-content .table-scroll,
        .markdown-content .mermaid-shell,
        .markdown-content h1,
        .markdown-content h2,
        .markdown-content h3,
        .markdown-content h4 {
          margin: 0 0 10px 0;
        }
        .markdown-content a {
          color: inherit;
          text-decoration: underline;
        }
        .markdown-content code {
          background: ${mine ? "rgba(255,255,255,0.18)" : "rgba(37,99,235,0.10)"};
          border-radius: 8px;
          padding: 2px 6px;
          font-size: 0.9em;
        }
        .markdown-content .code-block-scroll,
        .markdown-content .table-scroll {
          width: 100%;
          max-width: 100%;
          overflow-x: auto;
          overflow-y: hidden;
          -webkit-overflow-scrolling: touch;
        }
        .markdown-content pre,
        .markdown-content .code-block,
        .markdown-content .mermaid-shell {
          background: ${mine ? "rgba(15,23,42,0.22)" : "#f8fafc"};
          border: 1px solid ${mine ? "rgba(255,255,255,0.16)" : "rgba(148,163,184,0.3)"};
          border-radius: 16px;
          padding: 12px;
          box-sizing: border-box;
        }
        .markdown-content pre,
        .markdown-content .code-block {
          margin: 0;
          display: block;
          min-width: max-content;
          white-space: pre;
          overflow-x: auto;
        }
        .markdown-content pre code,
        .markdown-content .code-block code {
          background: transparent;
          padding: 0;
        }
        .markdown-content blockquote {
          border-left: 3px solid ${mine ? "rgba(255,255,255,0.55)" : "#2563eb"};
          padding-left: 10px;
          opacity: 0.9;
        }
        .markdown-content table {
          width: max-content;
          min-width: 100%;
          border-collapse: collapse;
          border-radius: 14px;
          border: 1px solid ${mine ? "rgba(255,255,255,0.16)" : "rgba(148,163,184,0.3)"};
        }
        .markdown-content th,
        .markdown-content td {
          border-bottom: 1px solid ${mine ? "rgba(255,255,255,0.16)" : "rgba(148,163,184,0.3)"};
          padding: 8px 10px;
          text-align: left;
          vertical-align: top;
        }
        .markdown-content th {
          background: ${mine ? "rgba(255,255,255,0.12)" : "rgba(148,163,184,0.12)"};
        }
        .markdown-content tr:last-child td {
          border-bottom: 0;
        }
        .markdown-content img {
          max-width: 100%;
          border-radius: 14px;
        }
        .markdown-content hr {
          border: 0;
          border-top: 1px solid ${mine ? "rgba(255,255,255,0.16)" : "rgba(148,163,184,0.3)"};
          margin: 12px 0;
        }
        .markdown-content .katex {
          color: inherit;
        }
        .markdown-content .katex-display {
          overflow-x: auto;
          overflow-y: hidden;
          padding: 6px 0;
        }
        .twemoji-inline {
          width: 1.15em;
          height: 1.15em;
          margin: 0 0.05em;
          vertical-align: -0.18em;
        }
        .mermaid-loading {
          padding: 10px 12px;
          border-radius: 14px;
          background: ${mine ? "rgba(15,23,42,0.22)" : "#f8fafc"};
          border: 1px solid ${mine ? "rgba(255,255,255,0.16)" : "rgba(148,163,184,0.3)"};
          font-size: 13px;
          opacity: 0.75;
        }
        .mermaid-shell svg {
          max-width: 100%;
          height: auto;
        }
      `}</style>
      <div
        className="markdown-content"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}
