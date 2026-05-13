import type { Actor } from "@shared"
import { extractText } from "@shared"
import type { ContactHubEntryView } from "@/types/api"

export function titleCase(input: string) {
  return input
    .split("_")
    .join(" ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

export function actorSummary(actor: Actor) {
  const docs = [...actor.definition.docs].sort(
    (left, right) => right.priority - left.priority
  )
  const summary = docs
    .map((doc) => extractText(doc.content).replace(/\s+/g, " ").trim())
    .find(Boolean)

  return summary || actor.definition.title || titleCase(actor.definition.role)
}

export function scopedContactName(contact: ContactHubEntryView) {
  return contact.title || "未命名联系人"
}

export function scopedContactSubtitle(contact: ContactHubEntryView) {
  return [contact.workspace.name, contact.subtitle || ""]
    .filter(Boolean)
    .join(" · ")
}

export function scopedContactSummary(contact: ContactHubEntryView) {
  if (contact.kind.startsWith("friend-")) {
    return `来自 ${contact.workspace.name} 的好友联系人`
  }
  return `来自 ${contact.workspace.name} 的工作区联系人`
}
