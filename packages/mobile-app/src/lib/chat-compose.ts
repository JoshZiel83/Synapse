import {
  mentionBlock,
  textBlock,
  type CanonicalContentBlock,
  type ConversationEntityRef,
  type ConversationReplyRef,
} from "@shared";

export interface ChatDraftMention {
  start: number;
  end: number;
  mention: ConversationEntityRef;
}

export interface ChatDraftSelection {
  start: number;
  end: number;
}

export type ChatDraftSegment =
  | {
      kind: "text";
      text: string;
    }
  | {
      kind: "mention";
      mention: ConversationEntityRef;
    };

export interface ChatComposerSendPayload {
  contentBlocks: CanonicalContentBlock[];
  replyToItemId?: string;
  replyTo?: ConversationReplyRef;
}

export function getMentionDisplayText(mention: ConversationEntityRef) {
  const name = mention.name?.trim() || "Unknown";
  return `@${name}`;
}

function clampMentionRange(
  text: string,
  mention: ChatDraftMention,
): ChatDraftMention | null {
  const token = getMentionDisplayText(mention.mention);
  if (
    mention.start < 0 ||
    mention.end > text.length ||
    mention.start >= mention.end
  ) {
    return null;
  }

  if (text.slice(mention.start, mention.end) !== token) {
    return null;
  }

  return mention;
}

function getDiffWindow(previousText: string, nextText: string) {
  let start = 0;
  while (
    start < previousText.length &&
    start < nextText.length &&
    previousText[start] === nextText[start]
  ) {
    start += 1;
  }

  let suffix = 0;
  while (
    previousText.length - suffix - 1 >= start &&
    nextText.length - suffix - 1 >= start &&
    previousText[previousText.length - suffix - 1] ===
      nextText[nextText.length - suffix - 1]
  ) {
    suffix += 1;
  }

  return {
    start,
    previousEnd: previousText.length - suffix,
    nextEnd: nextText.length - suffix,
    delta: nextText.length - previousText.length,
  };
}

export function reconcileDraftMentions(
  previousText: string,
  nextText: string,
  mentions: ChatDraftMention[],
) {
  const diff = getDiffWindow(previousText, nextText);

  return mentions
    .map((mention) => {
      if (mention.end <= diff.start) {
        return clampMentionRange(nextText, mention);
      }

      if (mention.start >= diff.previousEnd) {
        return clampMentionRange(nextText, {
          ...mention,
          start: mention.start + diff.delta,
          end: mention.end + diff.delta,
        });
      }

      return null;
    })
    .filter((mention): mention is ChatDraftMention => Boolean(mention))
    .sort((left, right) => left.start - right.start);
}

export function normalizeMentionBackspace(
  previousText: string,
  nextText: string,
  mentions: ChatDraftMention[],
  selection: ChatDraftSelection,
) {
  if (
    selection.start !== selection.end ||
    nextText.length !== previousText.length - 1
  ) {
    return null;
  }

  const diff = getDiffWindow(previousText, nextText);
  const mention = mentions.find(
    (item) =>
      selection.start === item.end &&
      diff.start === item.end - 1 &&
      diff.previousEnd === item.end,
  );

  if (!mention) {
    return null;
  }

  let deleteEnd = mention.end;
  if (previousText[deleteEnd] === " ") {
    deleteEnd += 1;
  }

  const text =
    previousText.slice(0, mention.start) + previousText.slice(deleteEnd);

  return {
    text,
    mentions: reconcileDraftMentions(previousText, text, mentions),
    selection: mention.start,
  };
}

export function insertMentionIntoDraft(
  text: string,
  mentions: ChatDraftMention[],
  mention: ConversationEntityRef,
  insertIndex: number,
) {
  const token = getMentionDisplayText(mention);
  const nextText =
    text.slice(0, insertIndex) + token + " " + text.slice(insertIndex + 1);
  const shift = token.length;

  const shiftedMentions = mentions
    .map((item) => {
      if (item.end <= insertIndex) {
        return item;
      }
      if (item.start >= insertIndex + 1) {
        return {
          ...item,
          start: item.start + shift,
          end: item.end + shift,
        };
      }
      return null;
    })
    .filter((item): item is ChatDraftMention => Boolean(item));

  return {
    text: nextText,
    mentions: [
      ...shiftedMentions,
      {
        start: insertIndex,
        end: insertIndex + token.length,
        mention,
      },
    ].sort((left, right) => left.start - right.start),
    selection: insertIndex + token.length + 1,
  };
}

function trimDraftEdgesFromTextBlocks(blocks: CanonicalContentBlock[]) {
  const next = [...blocks];
  const first = next[0];
  if (first?.type === "text") {
    const trimmed = first.text.replace(/^\s+/, "");
    if (trimmed.length > 0) {
      next[0] = textBlock(trimmed);
    } else {
      next.shift();
    }
  }

  const last = next[next.length - 1];
  if (last?.type === "text") {
    const trimmed = last.text.replace(/\s+$/, "");
    if (trimmed.length > 0) {
      next[next.length - 1] = textBlock(trimmed);
    } else {
      next.pop();
    }
  }

  return next;
}

export function buildContentBlocksFromDraftText(
  text: string,
  mentions: ChatDraftMention[],
) {
  const blocks: CanonicalContentBlock[] = [];
  const normalizedMentions = mentions
    .map((mention) => clampMentionRange(text, mention))
    .filter((mention): mention is ChatDraftMention => Boolean(mention))
    .sort((left, right) => left.start - right.start);

  let cursor = 0;
  for (const mention of normalizedMentions) {
    const textBefore = text.slice(cursor, mention.start);
    if (textBefore.length > 0) {
      blocks.push(textBlock(textBefore));
    }

    blocks.push(
      mentionBlock({
        mention: mention.mention,
      }),
    );
    cursor = mention.end;
  }

  const trailingText = text.slice(cursor);
  if (trailingText.length > 0) {
    blocks.push(textBlock(trailingText));
  }

  return trimDraftEdgesFromTextBlocks(blocks).filter((block) => {
    return block.type !== "text" || block.text.length > 0;
  });
}

export function appendDraftTextSegment(
  segments: ChatDraftSegment[],
  text: string,
) {
  if (!text) {
    return segments;
  }

  const next = [...segments];
  const last = next[next.length - 1];
  if (last?.kind === "text") {
    next[next.length - 1] = {
      kind: "text",
      text: `${last.text}${text}`,
    };
    return next;
  }

  next.push({
    kind: "text",
    text,
  });
  return next;
}

function trimDraftEdges(segments: ChatDraftSegment[]) {
  const next = [...segments];
  while (true) {
    const first = next[0];
    if (first?.kind !== "text" || first.text.trim().length > 0) {
      break;
    }
    next.shift();
  }
  while (true) {
    const last = next[next.length - 1];
    if (last?.kind !== "text" || last.text.trim().length > 0) {
      break;
    }
    next.pop();
  }

  if (next[0]?.kind === "text") {
    next[0] = {
      kind: "text",
      text: next[0].text.replace(/^\s+/, ""),
    };
  }

  const last = next[next.length - 1];
  if (last?.kind === "text") {
    next[next.length - 1] = {
      kind: "text",
      text: last.text.replace(/\s+$/, ""),
    };
  }

  return next.filter(
    (segment) =>
      segment.kind === "mention" ||
      (segment.kind === "text" && segment.text.length > 0),
  );
}

export function buildContentBlocksFromDraftSegments(
  segments: ChatDraftSegment[],
  trailingText: string,
) {
  const normalized = trimDraftEdges(appendDraftTextSegment(segments, trailingText));
  const blocks: CanonicalContentBlock[] = [];

  for (const segment of normalized) {
    if (segment.kind === "text") {
      blocks.push(textBlock(segment.text));
      continue;
    }

    blocks.push(
      mentionBlock({
        mention: segment.mention,
      }),
    );
  }

  return blocks;
}
