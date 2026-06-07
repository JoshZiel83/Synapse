// Presentation descriptors for the filesystem builtin tools.
//
// PURE DATA: imports only the descriptor TYPE from @synapse/device-protocol.
// MUST NOT import the runtime filesystem.ts (which pulls in VFS/fs-helper/etc.) —
// the leaf barrel that aggregates these files is consumed by the API display
// path, which must stay free of device runtime weight.
//
// Keyed by the presentation stableKey = `${exposure_stable_key}/${visible_tool_name}`
// = `builtin/filesystem/<tool name>` (NOT the tool's own `stable_key`).

import type { ToolPresentationDescriptor } from "@synapse/device-protocol/tool-presentation"

const EXPOSURE = "builtin/filesystem"
const k = (name: string) => `${EXPOSURE}/${name}`

export const FILESYSTEM_PRESENTATION: Record<
  string,
  ToolPresentationDescriptor
> = {
  [k("list_dir")]: {
    v: 1,
    icon: "folder",
    title: {
      key: "tool.fs.list_dir.title",
      message: "列出目录 {dir}",
      args: { dir: { path: "path", preprocess: "basename", default: "/" } },
    },
    request: { mode: "summary" },
    result: {
      summary: {
        key: "tool.fs.list_dir.result",
        message: "{count, plural, other {# 个条目}}",
        args: { count: { path: "meta.entry_count", default: "0" } },
      },
    },
  },

  [k("fs_stat")]: {
    v: 1,
    icon: "file-search",
    title: {
      key: "tool.fs.stat.title",
      message: "查看 {file}",
      args: { file: { path: "path", preprocess: "basename" } },
    },
    request: { mode: "summary" },
  },

  [k("fs_read")]: {
    v: 1,
    icon: "file-text",
    title: {
      key: "tool.fs.read.title",
      message: "读取 {file}",
      args: { file: { path: "path", preprocess: "basename" } },
    },
    request: { mode: "summary" },
    result: {
      summary: {
        key: "tool.fs.read.result",
        message: "{bytes, number} 字节",
        args: { bytes: { path: "meta.bytes_read", default: "0" } },
      },
    },
  },

  [k("fs_write")]: {
    v: 1,
    icon: "file-plus",
    title: {
      key: "tool.fs.write.title",
      message: "写入 {file}",
      args: { file: { path: "path", preprocess: "basename" } },
    },
    request: { mode: "summary" },
    result: {
      summary: {
        key: "tool.fs.write.result",
        message: "已写入 {bytes, number} 字节",
        args: { bytes: { path: "meta.bytes_written", default: "0" } },
      },
    },
  },

  [k("fs_edit")]: {
    v: 1,
    icon: "file-pen",
    title: {
      key: "tool.fs.edit.title",
      message: "正在编辑 {file}",
      args: { file: { path: "path", preprocess: "basename" } },
    },
    detail: {
      key: "tool.fs.edit.detail",
      message: "{count, plural, other {# 处修改}}",
      args: { count: { path: "edits", preprocess: "length" } },
    },
    request: {
      mode: "diff",
      diff: {
        itemsPath: "edits",
        oldField: "old_string",
        newField: "new_string",
      },
    },
    result: {
      summary: {
        key: "tool.fs.edit.result",
        message:
          "已写入 {bytes, number} 字节, {applied, plural, other {# 处生效}}",
        args: {
          bytes: { path: "meta.bytes_written", default: "0" },
          applied: { path: "meta.edits_applied", default: "0" },
        },
      },
    },
  },

  [k("fs_delete")]: {
    v: 1,
    icon: "trash",
    title: {
      key: "tool.fs.delete.title",
      message: "删除 {file}",
      args: { file: { path: "path", preprocess: "basename" } },
    },
    request: { mode: "summary" },
  },

  [k("fs_history_list")]: {
    v: 1,
    icon: "history",
    title: {
      key: "tool.fs.history_list.title",
      message: "查看 {file} 的历史",
      args: { file: { path: "path", preprocess: "basename" } },
    },
    request: { mode: "summary" },
  },

  [k("fs_history_diff")]: {
    v: 1,
    icon: "git-compare",
    title: {
      key: "tool.fs.history_diff.title",
      message: "比较 {file} 的版本",
      args: { file: { path: "path", preprocess: "basename" } },
    },
    request: { mode: "summary" },
  },

  [k("fs_history_restore")]: {
    v: 1,
    icon: "rotate-ccw",
    title: {
      key: "tool.fs.history_restore.title",
      message: "恢复 {file}",
      args: { file: { path: "path", preprocess: "basename" } },
    },
    request: { mode: "summary" },
  },

  [k("fs_search")]: {
    v: 1,
    icon: "search",
    title: {
      key: "tool.fs.search.title",
      message: "搜索 {query}",
      args: { query: { path: "query", preprocess: "truncate60" } },
    },
    request: { mode: "summary" },
    result: {
      summary: {
        key: "tool.fs.search.result",
        message: "{count, plural, other {# 个匹配}}",
        args: { count: { path: "meta.hit_count", default: "0" } },
      },
    },
  },

  [k("fs_index_status")]: {
    v: 1,
    icon: "database",
    title: {
      key: "tool.fs.index_status.title",
      message: "查看索引状态",
      args: {},
    },
    request: { mode: "summary" },
  },

  [k("fs_index_rebuild")]: {
    v: 1,
    icon: "database",
    title: {
      key: "tool.fs.index_rebuild.title",
      message: "重建索引",
      args: {},
    },
    request: { mode: "summary" },
  },

  [k("fs_index_task_status")]: {
    v: 1,
    icon: "database",
    title: {
      key: "tool.fs.index_task_status.title",
      message: "查看索引任务状态",
      args: {},
    },
    request: { mode: "summary" },
  },
}
