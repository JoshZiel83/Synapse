// Presentation descriptors for the cua (computer-use) builtin tools.
// PURE DATA — see filesystem.presentation.ts for the layering rules.
// stableKey = `builtin/cua/<tool name>`.

import type { ToolPresentationDescriptor } from "@synapse/device-protocol/tool-presentation"

const EXPOSURE = "builtin/cua"
const k = (name: string) => `${EXPOSURE}/${name}`

function simple(
  name: string,
  icon: string,
  message: string
): ToolPresentationDescriptor {
  return {
    v: 1,
    icon,
    title: { key: `tool.cua.${name}.title`, message, args: {} },
    request: { mode: "summary" },
  }
}

export const CUA_PRESENTATION: Record<string, ToolPresentationDescriptor> = {
  [k("cua_list_displays")]: simple("list_displays", "monitor", "列出显示器"),
  [k("cua_capture_display")]: {
    v: 1,
    icon: "camera",
    title: {
      key: "tool.cua.capture_display.title",
      message: "截取显示器 {index}",
      args: { index: { path: "index", default: "0" } },
    },
    request: { mode: "summary" },
    result: { bodyMode: "image" },
  },
  [k("cua_click")]: {
    v: 1,
    icon: "mouse-pointer-click",
    title: {
      key: "tool.cua.click.title",
      message: "点击 ({x}, {y})",
      args: { x: { path: "x", default: "0" }, y: { path: "y", default: "0" } },
    },
    request: { mode: "summary" },
  },
  [k("cua_type_text")]: {
    v: 1,
    icon: "keyboard",
    title: {
      key: "tool.cua.type_text.title",
      message: "输入 {text}",
      args: { text: { path: "text", preprocess: "truncate60" } },
    },
    request: { mode: "summary" },
  },
  [k("cua_list_windows")]: simple("list_windows", "app-window", "列出窗口"),
  [k("cua_set_focus")]: {
    v: 1,
    icon: "focus",
    title: {
      key: "tool.cua.set_focus.title",
      message: "聚焦 {target}",
      args: { target: { path: "target", default: "display" } },
    },
    request: { mode: "summary" },
  },
  [k("cua_get_focus")]: simple("get_focus", "focus", "获取当前焦点"),
  [k("cua_capture_view")]: {
    ...simple("capture_view", "camera", "截取当前视图"),
    result: { bodyMode: "image" },
  },
}
