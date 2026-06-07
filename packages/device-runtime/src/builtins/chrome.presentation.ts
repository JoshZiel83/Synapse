// Presentation descriptors for the chrome-devtools-mcp browser tools.
//
// PURE DATA — generated from the shared BROWSER_TOOL_MAP + exposure stable keys
// (both in @synapse/device-protocol, no runtime weight). Per-tool overrides give
// the high-traffic tools a friendly title with an arg; everything else gets a
// readable default keyed by exposure. Keyed by the presentation stableKey
// `${exposure_stable_key}/${toolName}` (e.g. builtin/browser/navigation/new_page).

import type { ToolPresentationDescriptor } from "@synapse/device-protocol/tool-presentation"
import {
  BROWSER_TOOL_MAP,
  BROWSER_EXPOSURE_STABLE_KEYS,
  type BrowserExposureKey,
} from "@synapse/device-protocol/browser-tools"

// Icon per exposure group.
const EXPOSURE_ICON: Record<BrowserExposureKey, string> = {
  navigation: "globe",
  read: "file-text",
  input: "mouse-pointer-click",
  network: "network",
  performance: "gauge",
  script: "code",
  extensions: "puzzle",
  webmcp: "plug",
}

// Per-tool friendly titles (ICU). Tools not listed fall back to a default that
// shows the bare tool name. Arg paths reference the chrome tool input schema.
type TitleSpec = {
  message: string
  arg?: { name: string; path: string; preprocess?: "basename" | "truncate60" }
}

const TOOL_TITLE: Record<string, TitleSpec> = {
  list_pages: { message: "列出标签页" },
  new_page: {
    message: "新建标签页 {url}",
    arg: { name: "url", path: "url", preprocess: "truncate60" },
  },
  navigate_page: {
    message: "导航到 {url}",
    arg: { name: "url", path: "url", preprocess: "truncate60" },
  },
  navigate_page_history: { message: "浏览历史" },
  select_page: { message: "切换标签页" },
  close_page: { message: "关闭标签页" },
  wait_for: {
    message: "等待 {text}",
    arg: { name: "text", path: "text", preprocess: "truncate60" },
  },
  take_snapshot: { message: "捕获页面快照" },
  take_screenshot: { message: "截屏" },
  list_console_messages: { message: "读取控制台日志" },
  click: { message: "点击元素" },
  fill: { message: "填写输入" },
  fill_form: { message: "填写表单" },
  hover: { message: "悬停元素" },
  handle_dialog: { message: "处理对话框" },
  list_network_requests: { message: "列出网络请求" },
  get_network_request: {
    message: "查看网络请求 {url}",
    arg: { name: "url", path: "url", preprocess: "truncate60" },
  },
  performance_start_trace: { message: "开始性能追踪" },
  performance_stop_trace: { message: "停止性能追踪" },
  performance_analyze_insight: { message: "分析性能洞察" },
  evaluate_script: { message: "执行脚本" },
}

// take_screenshot returns an image; render it as such.
const IMAGE_TOOLS = new Set(["take_screenshot"])

function buildChromePresentation(): Record<string, ToolPresentationDescriptor> {
  const out: Record<string, ToolPresentationDescriptor> = {}
  for (const [toolName, descriptor] of Object.entries(BROWSER_TOOL_MAP)) {
    const exposure = descriptor.exposure as BrowserExposureKey
    const exposureKey = BROWSER_EXPOSURE_STABLE_KEYS[exposure]
    if (!exposureKey) continue
    // The lite browser_navigate / browser_read_text rows are handled by
    // browser.presentation.ts under builtin/browser/<name>; skip them here so
    // we don't double-register under a navigation/read exposure path.
    if (toolName === "browser_navigate" || toolName === "browser_read_text") {
      continue
    }
    const stableKey = `${exposureKey}/${toolName}`
    const spec = TOOL_TITLE[toolName]
    const title = spec
      ? {
          key: `tool.chrome.${toolName}.title`,
          message: spec.message,
          args: spec.arg
            ? {
                [spec.arg.name]: {
                  path: spec.arg.path,
                  ...(spec.arg.preprocess
                    ? { preprocess: spec.arg.preprocess }
                    : {}),
                },
              }
            : {},
        }
      : {
          key: `tool.chrome.${toolName}.title`,
          message: toolName,
          args: {},
        }
    out[stableKey] = {
      v: 1,
      icon: EXPOSURE_ICON[exposure] ?? "globe",
      title,
      request: { mode: "summary" },
      ...(IMAGE_TOOLS.has(toolName)
        ? { result: { bodyMode: "image" as const } }
        : {}),
    }
  }
  return out
}

export const CHROME_PRESENTATION: Record<string, ToolPresentationDescriptor> =
  buildChromePresentation()
