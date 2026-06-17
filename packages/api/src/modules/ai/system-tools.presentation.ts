// Presentation descriptors for the in-process system/callable tools.
//
// Co-located with the tool registry (these tools are defined in ai/*.ts via
// registerToolPlugin). Keyed by the tool's registry name, which is ALSO its
// system stableKey (source.kind === "system" → registryKey). registerToolPlugin
// auto-attaches the matching descriptor, so the 26 call sites stay untouched and
// this file is the single source of truth.
//
// Descriptors here may reference node:path-free args only; the API renderer does
// the rest. Result summaries are mostly omitted (these tools return varied
// shapes); titles give the friendly "verb + object" the UI needs.

import type { ToolPresentationDescriptor } from "@synapse/shared/tool-presentation"

const title = (
  key: string,
  message: string,
  args?: ToolPresentationDescriptor["title"]["args"]
): ToolPresentationDescriptor => ({
  v: 1,
  icon: "wrench",
  title: { key, message, ...(args ? { args } : { args: {} }) },
  request: { mode: "summary" },
})

function withIcon(
  d: ToolPresentationDescriptor,
  icon: string
): ToolPresentationDescriptor {
  return { ...d, icon }
}

export const SYSTEM_TOOL_PRESENTATION: Record<
  string,
  ToolPresentationDescriptor
> = {
  read_skill: withIcon(
    title("tool.sys.read_skill.title", "读取技能实例 {skill}", {
      skill: { path: "skillInstanceId", default: "" },
    }),
    "book-open"
  ),
  get_current_time: withIcon(
    title("tool.sys.get_current_time.title", "获取当前时间"),
    "clock"
  ),
  send_to: withIcon(title("tool.sys.send_to.title", "发送消息"), "send"),
  request_user_input: withIcon(
    title("tool.sys.request_user_input.title", "请求用户输入"),
    "message-circle-question"
  ),
  enter_plan_mode: withIcon(
    title("tool.sys.enter_plan_mode.title", "进入计划模式"),
    "list-checks"
  ),
  update_plan: withIcon(
    title("tool.sys.update_plan.title", "更新计划"),
    "list-checks"
  ),
  exit_plan_mode: withIcon(
    title("tool.sys.exit_plan_mode.title", "退出计划模式"),
    "list-checks"
  ),
  list_tasks: withIcon(title("tool.sys.list_tasks.title", "列出任务"), "list"),
  get_task_status: withIcon(
    title("tool.sys.get_task_status.title", "查看任务状态"),
    "list"
  ),
  cancel_task: withIcon(
    title("tool.sys.cancel_task.title", "取消任务"),
    "x-circle"
  ),
  tail_task_output: withIcon(
    title("tool.sys.tail_task_output.title", "查看任务输出"),
    "scroll-text"
  ),
  invite_actor: withIcon(
    title("tool.sys.invite_actor.title", "邀请成员"),
    "user-plus"
  ),
  memory_search: withIcon(
    title("tool.sys.memory_search.title", "搜索记忆 {query}", {
      query: { path: "queryText", preprocess: "truncate60", default: "" },
    }),
    "search"
  ),
  create_memory: withIcon(
    title("tool.sys.create_memory.title", "记录记忆"),
    "brain"
  ),
  schedule_self_wakeup: withIcon(
    title("tool.sys.schedule_self_wakeup.title", "安排唤醒 {name}", {
      name: { path: "name", preprocess: "truncate60", default: "" },
    }),
    "alarm-clock"
  ),
  list_event_sources: withIcon(
    title("tool.sys.list_event_sources.title", "列出事件源"),
    "rss"
  ),
  subscribe_event: withIcon(
    title("tool.sys.subscribe_event.title", "订阅事件 {name}", {
      name: { path: "name", preprocess: "truncate60", default: "" },
    }),
    "rss"
  ),
  view_event_source_history: withIcon(
    title("tool.sys.view_event_source_history.title", "查看事件历史"),
    "rss"
  ),
  list_automations: withIcon(
    title("tool.sys.list_automations.title", "列出自动化"),
    "workflow"
  ),
  cancel_automation: withIcon(
    title("tool.sys.cancel_automation.title", "取消自动化"),
    "x-circle"
  ),
  sleep: withIcon(title("tool.sys.sleep.title", "等待"), "hourglass"),
  rename_self: withIcon(
    title("tool.sys.rename_self.title", "重命名自己"),
    "pencil"
  ),
  change_avatar: withIcon(
    title("tool.sys.change_avatar.title", "更换头像"),
    "image"
  ),
  upload_file: withIcon(
    title("tool.sys.upload_file.title", "上传文件 {file}", {
      file: { path: "filename", preprocess: "basename", default: "" },
    }),
    "upload"
  ),
  get_file_link: withIcon(
    title("tool.sys.get_file_link.title", "获取文件链接"),
    "link"
  ),
  get_file_info: withIcon(
    title("tool.sys.get_file_info.title", "查看文件信息"),
    "file-search"
  ),
}
