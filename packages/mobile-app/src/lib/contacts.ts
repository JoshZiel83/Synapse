import type { Actor } from "@shared";
import { extractText } from "@shared";

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
