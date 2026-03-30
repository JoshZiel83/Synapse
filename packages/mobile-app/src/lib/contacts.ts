import type { Actor } from "@shared";
import { extractText } from "@shared";
import type { ScopedContactView } from "@/types/api";

export function titleCase(input: string) {
  return input
    .split("_")
    .join(" ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function actorSummary(actor: Actor) {
  const docs = [...actor.definition.docs].sort(
    (left, right) => right.priority - left.priority,
  );
  const summary = docs
    .map((doc) => extractText(doc.content).replace(/\s+/g, " ").trim())
    .find(Boolean);

  return summary || actor.definition.title || titleCase(actor.definition.role);
}

export function scopedContactName(contact: ScopedContactView) {
  return (
    contact.actor?.name ||
    contact.user?.name ||
    contact.user?.email ||
    "未命名联系人"
  );
}

export function scopedContactSubtitle(contact: ScopedContactView) {
  if (contact.actor) {
    return [
      contact.targetWorkspace.name,
      contact.actor.title || titleCase(contact.actor.role || "actor"),
    ]
      .filter(Boolean)
      .join(" · ");
  }

  return [
    contact.targetWorkspace.name,
    contact.user?.email || "远端用户",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function scopedContactSummary(contact: ScopedContactView) {
  if (contact.actor) {
    return `来自 ${contact.targetWorkspace.name} 的角色联系人`;
  }

  return `来自 ${contact.targetWorkspace.name} 的用户联系人`;
}
