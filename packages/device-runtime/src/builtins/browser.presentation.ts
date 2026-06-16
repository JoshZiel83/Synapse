// Presentation descriptors for the browser-lite builtin tools.
// PURE DATA — see filesystem.presentation.ts for the layering rules.
// stableKey = `builtin/browser/<tool name>`.

import type { ToolPresentationDescriptor } from "@synapse/shared/tool-presentation"

const EXPOSURE = "builtin/browser"
const k = (name: string) => `${EXPOSURE}/${name}`

export const BROWSER_PRESENTATION: Record<string, ToolPresentationDescriptor> =
  {
    [k("browser_navigate")]: {
      v: 1,
      icon: "globe",
      title: {
        key: "tool.browser.navigate.title",
        message: "打开 {url}",
        args: { url: { path: "url", preprocess: "truncate60" } },
      },
      request: { mode: "summary" },
    },
    [k("browser_read_text")]: {
      v: 1,
      icon: "file-text",
      title: {
        key: "tool.browser.read_text.title",
        message: "读取页面文本",
        args: {},
      },
      request: { mode: "summary" },
      result: {
        summary: {
          key: "tool.browser.read_text.result",
          message: "{count, plural, other {# 个字符}}",
          args: { count: { path: "meta.char_count", default: "0" } },
        },
      },
    },
  }
