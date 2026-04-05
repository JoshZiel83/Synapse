"use dom";

import { useEffect, useMemo, useRef, useState } from "react";
import mermaid from "mermaid";
import twemoji from "twemoji";

import { reportApiUnauthorized } from "@/lib/api";
import {
  decodeMermaidChart,
  escapeHtml,
  renderMarkdownHtml,
} from "@/lib/chat-markdown-html";
import {
  isMarkdownMimeType,
  isPdfMimeType,
  isTextPreviewMimeType,
} from "@/lib/chat-rich-content";

export default function FilePreviewDom({
  uri,
  mimeType,
  fileName,
  token,
  source,
}: {
  uri: string;
  mimeType: string;
  fileName: string;
  token?: string | null;
  source: "local" | "remote";
  dom?: import("expo/dom").DOMProps;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [resolvedUri, setResolvedUri] = useState<string | null>(
    source === "local" ? uri : null,
  );
  const [textContent, setTextContent] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(source === "remote");

  const isTextLike = useMemo(
    () => isTextPreviewMimeType(mimeType),
    [mimeType],
  );
  const isMarkdown = useMemo(
    () => isMarkdownMimeType(mimeType),
    [mimeType],
  );
  const isPdf = useMemo(() => isPdfMimeType(mimeType), [mimeType]);
  const markdownHtml = useMemo(
    () =>
      isMarkdown && textContent !== null ? renderMarkdownHtml(textContent) : null,
    [isMarkdown, textContent],
  );

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;

    if (source === "local") {
      setLoading(false);
      return () => {
        if (objectUrl) {
          URL.revokeObjectURL(objectUrl);
        }
      };
    }

    setLoading(true);
    setErrorMessage(null);
    setResolvedUri(null);
    setTextContent(null);

    void (async () => {
      try {
        const response = await fetch(uri, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });

        if (response.status === 401) {
          reportApiUnauthorized(401);
          return;
        }

        if (!response.ok) {
          throw new Error(`Failed to load file (${response.status})`);
        }

        if (isTextLike) {
          const text = await response.text();
          if (!active) {
            return;
          }
          setTextContent(text);
          setLoading(false);
          return;
        }

        const blob = await response.blob();
        if (!active) {
          return;
        }

        objectUrl = URL.createObjectURL(blob);
        setResolvedUri(objectUrl);
        setLoading(false);
      } catch (error) {
        if (!active) {
          return;
        }
        setErrorMessage(
          error instanceof Error ? error.message : "Failed to load file preview",
        );
        setLoading(false);
      }
    })();

    return () => {
      active = false;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [isTextLike, source, token, uri]);

  useEffect(() => {
    let cancelled = false;

    async function enhancePreview() {
      if (!rootRef.current || !textContent) {
        return;
      }

      if (isMarkdown) {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "default",
          fontFamily:
            '"Noto Sans", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
        });

        const targets = Array.from(
          rootRef.current.querySelectorAll<HTMLElement>("[data-mermaid]"),
        );

        await Promise.all(
          targets.map(async (target, index) => {
            const rawChart = target.dataset.mermaid || "";
            const chart = decodeMermaidChart(rawChart);

            try {
              const result = await mermaid.render(
                `preview-mermaid-${index}-${Math.random().toString(36).slice(2)}`,
                chart,
              );
              if (!cancelled) {
                target.innerHTML = result.svg;
              }
            } catch {
              if (!cancelled) {
                target.innerHTML = `<pre class="code-block">${escapeHtml(chart)}</pre>`;
              }
            }
          }),
        );
      }

      if (!cancelled && rootRef.current) {
        twemoji.parse(rootRef.current, {
          base: "https://cdn.jsdelivr.net/gh/jdecked/twemoji@14.0.2/assets/",
          folder: "svg",
          ext: ".svg",
          className: "twemoji-inline",
        });
      }
    }

    void enhancePreview();

    return () => {
      cancelled = true;
    };
  }, [isMarkdown, markdownHtml, textContent]);

  const displayUri = source === "local" ? uri : resolvedUri;

  return (
    <div ref={rootRef} className="preview-root">
      <link
        rel="stylesheet"
        href="https://cdn.jsdelivr.net/npm/katex@0.16.44/dist/katex.min.css"
      />
      <style>{`
        body {
          margin: 0;
          background: #f8fafc;
          color: #0f172a;
          font-family: "Noto Sans", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
        }
        .preview-root {
          min-height: 100vh;
          box-sizing: border-box;
          padding: 18px;
          background: linear-gradient(180deg, #f8fafc 0%, #eef2ff 100%);
        }
        .preview-card {
          max-width: 960px;
          margin: 0 auto;
          border-radius: 24px;
          border: 1px solid rgba(148, 163, 184, 0.24);
          background: rgba(255, 255, 255, 0.92);
          box-shadow: 0 24px 60px rgba(15, 23, 42, 0.10);
          overflow: hidden;
        }
        .preview-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 18px 20px;
          border-bottom: 1px solid rgba(148, 163, 184, 0.18);
          background: rgba(255,255,255,0.9);
        }
        .preview-title {
          font-size: 18px;
          font-weight: 700;
          line-height: 1.3;
        }
        .preview-subtitle {
          margin-top: 4px;
          font-size: 12px;
          color: #64748b;
        }
        .preview-body {
          padding: 20px;
        }
        .preview-markdown > *:first-child {
          margin-top: 0;
        }
        .preview-markdown > *:last-child {
          margin-bottom: 0;
        }
        .preview-body img,
        .preview-body video,
        .preview-body audio,
        .preview-body iframe {
          width: 100%;
          max-width: 100%;
        }
        .preview-image {
          border-radius: 18px;
          background: #e2e8f0;
        }
        .preview-video {
          border-radius: 18px;
          background: #020617;
        }
        .preview-frame {
          min-height: 72vh;
          border: 0;
          border-radius: 18px;
          background: #fff;
        }
        .text-shell {
          font-size: 15px;
          line-height: 1.65;
          width: 100%;
          max-width: 100%;
          min-width: 0;
          overflow: hidden;
          overflow-wrap: anywhere;
        }
        .text-shell pre {
          overflow-x: auto;
          border-radius: 18px;
          background: #f8fafc;
          border: 1px solid rgba(148, 163, 184, 0.24);
          padding: 16px;
          white-space: pre-wrap;
        }
        .text-shell p,
        .text-shell ul,
        .text-shell ol,
        .text-shell blockquote,
        .text-shell pre,
        .text-shell .code-block-scroll,
        .text-shell .table-scroll,
        .text-shell .mermaid-shell,
        .text-shell h1,
        .text-shell h2,
        .text-shell h3 {
          margin: 0 0 12px 0;
        }
        .text-shell code {
          background: rgba(37,99,235,0.10);
          border-radius: 8px;
          padding: 2px 6px;
        }
        .text-shell .code-block {
          overflow-x: auto;
          border-radius: 18px;
          background: #f8fafc;
          border: 1px solid rgba(148, 163, 184, 0.24);
          padding: 16px;
          white-space: pre;
          box-sizing: border-box;
          margin: 0;
          display: block;
          min-width: max-content;
        }
        .text-shell .code-block code {
          background: transparent;
          padding: 0;
        }
        .text-shell .code-block-scroll,
        .text-shell .table-scroll {
          width: 100%;
          max-width: 100%;
          overflow-x: auto;
          overflow-y: hidden;
          -webkit-overflow-scrolling: touch;
        }
        .text-shell table {
          width: max-content;
          min-width: 100%;
          border-collapse: collapse;
          border-radius: 14px;
          border: 1px solid rgba(148, 163, 184, 0.24);
        }
        .text-shell th,
        .text-shell td {
          border-bottom: 1px solid rgba(148, 163, 184, 0.24);
          padding: 8px 10px;
          text-align: left;
          vertical-align: top;
        }
        .text-shell th {
          background: rgba(148,163,184,0.12);
        }
        .text-shell tr:last-child td {
          border-bottom: 0;
        }
        .text-shell blockquote {
          border-left: 3px solid #2563eb;
          padding-left: 10px;
          color: #334155;
        }
        .text-shell .katex {
          color: inherit;
        }
        .text-shell .katex-display {
          overflow-x: auto;
          overflow-y: hidden;
          padding: 6px 0;
        }
        .text-shell .mermaid-shell {
          border-radius: 18px;
          background: #f8fafc;
          border: 1px solid rgba(148, 163, 184, 0.24);
          padding: 16px;
          overflow-x: auto;
        }
        .text-shell .mermaid-shell svg {
          max-width: 100%;
          height: auto;
        }
        .twemoji-inline {
          width: 1.15em;
          height: 1.15em;
          margin: 0 0.05em;
          vertical-align: -0.18em;
        }
        .state {
          padding: 28px 22px;
          text-align: center;
          color: #64748b;
        }
      `}</style>
      <div className="preview-card">
        <div className="preview-header">
          <div>
            <div className="preview-title">{fileName}</div>
            <div className="preview-subtitle">{mimeType}</div>
          </div>
        </div>
        <div className="preview-body">
          {loading ? <div className="state">Loading preview...</div> : null}
          {!loading && errorMessage ? (
            <div className="state">{errorMessage}</div>
          ) : null}
          {!loading && !errorMessage && isTextLike && textContent !== null ? (
            <div className="text-shell">
              {isMarkdown && markdownHtml ? (
                <div
                  className="preview-markdown"
                  dangerouslySetInnerHTML={{ __html: markdownHtml }}
                />
              ) : (
                <pre>{textContent}</pre>
              )}
            </div>
          ) : null}
          {!loading &&
          !errorMessage &&
          !isTextLike &&
          displayUri &&
          mimeType.startsWith("image/") ? (
            <img className="preview-image" src={displayUri} alt={fileName} />
          ) : null}
          {!loading &&
          !errorMessage &&
          !isTextLike &&
          displayUri &&
          mimeType.startsWith("video/") ? (
            <video className="preview-video" src={displayUri} controls />
          ) : null}
          {!loading &&
          !errorMessage &&
          !isTextLike &&
          displayUri &&
          mimeType.startsWith("audio/") ? (
            <audio src={displayUri} controls />
          ) : null}
          {!loading &&
          !errorMessage &&
          !isTextLike &&
          displayUri &&
          isPdf ? (
            <iframe className="preview-frame" src={displayUri} title={fileName} />
          ) : null}
          {!loading &&
          !errorMessage &&
          !isTextLike &&
          displayUri &&
          !mimeType.startsWith("image/") &&
          !mimeType.startsWith("video/") &&
          !mimeType.startsWith("audio/") &&
          !isPdf ? (
            <iframe className="preview-frame" src={displayUri} title={fileName} />
          ) : null}
        </div>
      </div>
    </div>
  );
}
