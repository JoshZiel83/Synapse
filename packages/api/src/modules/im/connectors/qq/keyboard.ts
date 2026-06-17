/**
 * QQ Inline Keyboard payload construction (Stage 8).
 *
 * QQ's "interactive button" feature requires:
 *   - msg_type = 2 (markdown)
 *   - A non-empty markdown.content (the bubble that carries the buttons)
 *   - A keyboard.content.rows[] structure where each row has up to 5
 *     buttons; whole keyboard caps at 5 rows × 5 columns.
 *
 * Each button has:
 *   - id: unique within the keyboard
 *   - render_data: { label, visited_label, style } where style is the
 *                    official botgo RenderData enum: 0 = gray frame,
 *                    1 = blue frame, 3 = white bg + red font (danger),
 *                    4 = blue bg + white font. (There is NO style 2 — the
 *                    old "danger = 2" was an openclaw mis-numbering.)
 *   - action: {
 *       type: 1 (Callback → triggers an INTERACTION_CREATE event),
 *       data: synapse-interaction:{actionToken} (the action token is a
 *             uuidv4 so the full value is ~56 chars; the QQ wiki/botgo/botpy
 *             document NO length cap on action.data — the only documented
 *             100-char limit is on the text-chain command `text` field,
 *             a different field),
 *       permission: { type: 2 } (2 = everyone can click; intentional.
 *             Other enum values: 0 = specified users (needs
 *             specify_user_ids), 1 = managers, 3 = specified roles
 *             (channel only)),
 *       click_limit: 1 (legacy field, see plan G5 note — we don't rely
 *             on it for idempotence; the action-token + commandId path
 *             handles that durably),
 *       unsupport_tips: "请升级 QQ 版本以使用此功能" (required by QQ docs),
 *     }
 *
 * group_id (mutex group) sits at the button top level (NOT inside
 * action). All buttons in our keyboard share the same group_id so QQ's
 * native UI greys out the others once one is clicked. The fallback
 * still relies on our server-side resolveTaskRequest dedup.
 *
 * The action_token is opaque (uuidv4) — the connector's INTERACTION_CREATE
 * handler will reverse it via lookupActionToken to recover the original
 * decision payload (decision, preset, selectedGrantOptionId).
 */

import { QQ_MSG_TYPE } from "./types.js"

export const QQ_BUTTON_ACTION_TYPE_CALLBACK = 1
export const QQ_BUTTON_PERMISSION_EVERYONE = 2
export const QQ_BUTTON_STYLE_DEFAULT = 0
export const QQ_BUTTON_STYLE_PRIMARY = 1
// botgo dto/keyboard RenderData.Style enum is 0/1/3/4 — there is NO 2.
// danger (white bg + red font) is 3 (the previous value 2 was an openclaw
// mis-numbering and renders as an undefined style / may be rejected).
export const QQ_BUTTON_STYLE_DANGER = 3

const ACTION_TOKEN_PREFIX = "synapse-interaction:"
const DEFAULT_UNSUPPORT_TIPS = "请升级 QQ 版本以使用此功能"
const MUTEX_GROUP_PREFIX = "synapse-interaction-"

export interface QqKeyboardOption {
  id: string
  label: string
  actionToken: string
  style?: "primary" | "danger" | "default"
}

export interface QqKeyboardPayload {
  msg_type: typeof QQ_MSG_TYPE.MARKDOWN
  markdown: { content: string }
  keyboard: {
    content: {
      rows: Array<{
        buttons: Array<QqKeyboardButton>
      }>
    }
  }
}

export interface QqKeyboardButton {
  id: string
  group_id?: string
  render_data: {
    label: string
    visited_label: string
    style: number
  }
  action: {
    type: typeof QQ_BUTTON_ACTION_TYPE_CALLBACK
    data: string
    permission: { type: typeof QQ_BUTTON_PERMISSION_EVERYONE }
    click_limit: number
    unsupport_tips: string
  }
}

/**
 * Build a single-row keyboard with one button per option. v1 caps the
 * options array at 5 (one row max) — anything larger throws. Multi-row
 * keyboards land when we have a real use case for them.
 *
 * `taskId` seeds the mutex group_id so QQ's native UI
 * greys-out non-selected buttons once any one is clicked.
 */
export function buildQqInteractionKeyboard(params: {
  taskId: string
  title?: string
  fallbackText: string
  options: QqKeyboardOption[]
}): QqKeyboardPayload {
  if (!params.options || params.options.length === 0) {
    throw new Error("buildQqInteractionKeyboard: options must be non-empty")
  }
  if (params.options.length > 5) {
    throw new Error(
      `buildQqInteractionKeyboard: v1 supports ≤5 options, got ${params.options.length}`
    )
  }
  for (const opt of params.options) {
    if (!opt.actionToken) {
      throw new Error(
        `buildQqInteractionKeyboard: option ${opt.id} missing actionToken`
      )
    }
  }
  const groupId = `${MUTEX_GROUP_PREFIX}${params.taskId}`
  const buttons: QqKeyboardButton[] = params.options.map((opt) => ({
    id: opt.id,
    group_id: groupId,
    render_data: {
      label: opt.label,
      visited_label: opt.label,
      style: styleNumber(opt.style),
    },
    action: {
      type: QQ_BUTTON_ACTION_TYPE_CALLBACK,
      data: `${ACTION_TOKEN_PREFIX}${opt.actionToken}`,
      permission: { type: QQ_BUTTON_PERMISSION_EVERYONE },
      click_limit: 1,
      unsupport_tips: DEFAULT_UNSUPPORT_TIPS,
    },
  }))
  const markdownContent = buildMarkdownContent({
    title: params.title,
    fallbackText: params.fallbackText,
  })
  return {
    msg_type: QQ_MSG_TYPE.MARKDOWN,
    markdown: { content: markdownContent },
    keyboard: {
      content: {
        rows: [{ buttons }],
      },
    },
  }
}

/**
 * Parse an INTERACTION_CREATE button_data string back to the action
 * token. Accepts only our `synapse-interaction:{token}` prefix — any
 * other payload returns null so unrelated keyboards from other bots
 * sharing this account can't accidentally route through our resolver.
 */
export function parseQqInteractionButtonData(
  data: string | undefined
): { actionToken: string } | null {
  if (!data || typeof data !== "string") return null
  if (!data.startsWith(ACTION_TOKEN_PREFIX)) return null
  const token = data.slice(ACTION_TOKEN_PREFIX.length).trim()
  if (!token) return null
  return { actionToken: token }
}

function styleNumber(style: QqKeyboardOption["style"]): number {
  switch (style) {
    case "primary":
      return QQ_BUTTON_STYLE_PRIMARY
    case "danger":
      return QQ_BUTTON_STYLE_DANGER
    default:
      return QQ_BUTTON_STYLE_DEFAULT
  }
}

function buildMarkdownContent(params: {
  title?: string
  fallbackText: string
}): string {
  const lines: string[] = []
  if (params.title) lines.push(params.title)
  if (params.fallbackText) lines.push(params.fallbackText)
  lines.push("请选择：")
  return lines.join("\n\n")
}
