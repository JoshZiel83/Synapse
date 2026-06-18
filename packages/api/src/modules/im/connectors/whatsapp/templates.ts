/**
 * WhatsApp template SEND shaping — SHAPING ONLY.
 *
 * ⚠ This is NOT a template-management subsystem (OD-1a). Template CRUD,
 * Meta approval-status sync, and agent-output → template-variable mapping are
 * a multi-week feature LARGER than this connector and are explicitly out of
 * scope. This module only builds the `type:"template"` message body Meta
 * expects when a caller already knows the approved template name + language
 * + ordered parameter values.
 *
 * Because there is no template registry in v1, the outbound path cannot
 * AUTO-pick a template to recover a free-form send outside the 24h window;
 * it fails with `whatsapp_24h_window_closed` (→ 131047). A future
 * template-management feature would call `buildTemplateMessage(...)` here
 * with a resolved template + mapped params.
 */

export interface WhatsappTemplateParameter {
  type: "text" | "currency" | "date_time"
  text?: string
}

export interface WhatsappTemplateComponent {
  type: "header" | "body" | "button"
  /** for button components. */
  sub_type?: string
  index?: string
  parameters?: WhatsappTemplateParameter[]
}

export interface BuildTemplateMessageInput {
  /** recipient wa_id (E.164, no +). */
  to: string
  templateName: string
  /** BCP-47 / Meta language code, e.g. "en_US". */
  languageCode: string
  components?: WhatsappTemplateComponent[]
}

/**
 * Build the `type:"template"` message body for `POST /<id>/messages`. The
 * `messaging_product` + `recipient_type` are injected by the client, so this
 * returns only the message-shape fields.
 */
export function buildTemplateMessage(
  input: BuildTemplateMessageInput
): Record<string, unknown> {
  const template: Record<string, unknown> = {
    name: input.templateName,
    language: { code: input.languageCode },
  }
  if (input.components && input.components.length > 0) {
    template.components = input.components
  }
  return {
    to: input.to,
    type: "template",
    template,
  }
}
