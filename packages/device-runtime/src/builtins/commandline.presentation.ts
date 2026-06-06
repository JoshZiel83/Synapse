// Presentation descriptors for the commandline builtin tools.
// PURE DATA — see filesystem.presentation.ts for the layering rules.
// stableKey = `builtin/commandline/<tool name>`.

import type { ToolPresentationDescriptor } from "@synapse/device-protocol/tool-presentation"

const EXPOSURE = "builtin/commandline"
const k = (name: string) => `${EXPOSURE}/${name}`

// bash & powershell share the same {command} shape.
function shellDescriptor(verb: string): ToolPresentationDescriptor {
  return {
    v: 1,
    icon: "terminal",
    title: {
      key: "tool.cmd.shell.title",
      message: `${verb} {cmd}`,
      args: { cmd: { path: "command", preprocess: "truncate60" } },
    },
    request: { mode: "code", codeArg: { path: "command" } },
    result: {
      summary: {
        key: "tool.cmd.shell.result",
        message: "退出码 {code}",
        args: { code: { path: "meta.exit_code", default: "?" } },
      },
    },
  }
}

export const COMMANDLINE_PRESENTATION: Record<
  string,
  ToolPresentationDescriptor
> = {
  [k("bash")]: shellDescriptor("运行"),
  [k("powershell")]: shellDescriptor("运行"),
  [k("exec_file")]: {
    v: 1,
    icon: "terminal",
    title: {
      key: "tool.cmd.exec_file.title",
      message: "执行 {program}",
      args: { program: { path: "program", preprocess: "basename" } },
    },
    request: { mode: "args_table" },
    result: {
      summary: {
        key: "tool.cmd.exec_file.result",
        message: "退出码 {code}",
        args: { code: { path: "meta.exit_code", default: "?" } },
      },
    },
  },
}
