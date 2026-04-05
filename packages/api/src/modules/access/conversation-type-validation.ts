import type pg from "pg";
import {
  isValidConversationTypeMask,
  maskAllowsConversationType,
  normalizeConversationTypeMask,
  resolveConversationTypeKey,
  resolveNarrowedConversationTypeMask,
  type ConversationTypeKey,
} from "@synapse/shared";
import type { CapabilityAccessTargetType } from "@synapse/shared/types";
import { executeSql, executeSqlOn } from "../../infrastructure/database/kysely.js";
import { listConversationParticipants } from "../chat/service.js";

type Queryable = Pick<pg.PoolClient, "query">;

type ConversationTargetRecord = {
  conversationId: string;
  kind: string;
  boundary: string;
  conversationTypeKey: ConversationTypeKey;
};

function formatConversationTypeKey(value: ConversationTypeKey) {
  return value.replaceAll("_", " ");
}

export function targetSupportsConversationTypeOverride(
  targetType: CapabilityAccessTargetType,
) {
  return targetType === "workspace" || targetType === "actor";
}

export function assertConversationTypeMaskWithinParent(params: {
  parentConversationTypeMask: number;
  conversationTypeMaskOverride: number | null | undefined;
  buildError: (message: string) => Error;
  invalidMaskMessage: string;
}) {
  const normalizedParentMask = normalizeConversationTypeMask(
    params.parentConversationTypeMask,
  );
  if (
    params.conversationTypeMaskOverride === null ||
    params.conversationTypeMaskOverride === undefined
  ) {
    return normalizedParentMask;
  }

  const effectiveConversationTypeMask = resolveNarrowedConversationTypeMask(
    normalizedParentMask,
    params.conversationTypeMaskOverride,
  );
  if (!isValidConversationTypeMask(effectiveConversationTypeMask)) {
    throw params.buildError(params.invalidMaskMessage);
  }
  return effectiveConversationTypeMask;
}

export function assertGrantConversationTypeOverrideAllowed(params: {
  targetType: CapabilityAccessTargetType;
  parentConversationTypeMask: number;
  conversationTypeMaskOverride: number | null | undefined;
  buildError: (message: string) => Error;
  invalidMaskMessage: string;
}) {
  if (!targetSupportsConversationTypeOverride(params.targetType)) {
    if (
      params.conversationTypeMaskOverride !== null &&
      params.conversationTypeMaskOverride !== undefined
    ) {
      throw params.buildError(
        "conversationTypeMaskOverride is not allowed for conversation-scoped access targets.",
      );
    }
    return normalizeConversationTypeMask(params.parentConversationTypeMask);
  }

  return assertConversationTypeMaskWithinParent({
    parentConversationTypeMask: params.parentConversationTypeMask,
    conversationTypeMaskOverride: params.conversationTypeMaskOverride,
    buildError: params.buildError,
    invalidMaskMessage: params.invalidMaskMessage,
  });
}

async function loadConversationTargetRecord(
  conversationId: string,
  queryable?: Queryable,
) {
  const result = queryable
    ? await executeSqlOn<{
        id: string;
        kind: string;
        boundary: string;
      }>(
        queryable,
        `
          SELECT id, kind, boundary
          FROM conversations
          WHERE id = $1
          LIMIT 1
        `,
        [conversationId],
      )
    : await executeSql<{
        id: string;
        kind: string;
        boundary: string;
      }>(
        `
          SELECT id, kind, boundary
          FROM conversations
          WHERE id = $1
          LIMIT 1
        `,
        [conversationId],
      );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  const conversationTypeKey = resolveConversationTypeKey(
    row.kind,
    row.boundary,
  );
  if (!conversationTypeKey) {
    return null;
  }

  return {
    conversationId: row.id,
    kind: row.kind,
    boundary: row.boundary,
    conversationTypeKey,
  } satisfies ConversationTargetRecord;
}

export async function validateConversationScopedAccessTarget(params: {
  targetType: CapabilityAccessTargetType;
  conversationId?: string | null;
  actorId?: string | null;
  effectiveConversationTypeMask: number;
  buildError: (message: string) => Error;
  queryable?: Queryable;
}) {
  if (
    params.targetType !== "conversation" &&
    params.targetType !== "actor_in_conversation"
  ) {
    return null;
  }

  if (!params.conversationId) {
    throw params.buildError(
      "conversationId is required for conversation-scoped access targets.",
    );
  }

  const conversation = await loadConversationTargetRecord(
    params.conversationId,
    params.queryable,
  );
  if (!conversation) {
    throw params.buildError("Selected conversation was not found.");
  }

  if (
    !maskAllowsConversationType(
      params.effectiveConversationTypeMask,
      conversation.kind,
      conversation.boundary,
    )
  ) {
    throw params.buildError(
      `Selected conversation is ${formatConversationTypeKey(
        conversation.conversationTypeKey,
      )} and is blocked by the current conversation type policy.`,
    );
  }

  if (params.targetType !== "actor_in_conversation") {
    return conversation;
  }

  if (!params.actorId) {
    throw params.buildError(
      "actorId is required for actor_in_conversation access targets.",
    );
  }

  const participants = await listConversationParticipants(
    params.conversationId,
    { queryable: params.queryable },
  );
  const hasActiveActor = participants.some(
    (participant) =>
      participant.actor_id === params.actorId && participant.state === "active",
  );
  if (!hasActiveActor) {
    throw params.buildError(
      "Selected actor must already be an active participant in the selected conversation.",
    );
  }

  return conversation;
}
