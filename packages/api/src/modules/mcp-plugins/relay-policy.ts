import {
  isValidConversationTypeMask,
  normalizeConversationTypeMask,
  resolveNarrowedConversationTypeMask,
} from "@synapse/shared";

type RelayConversationPolicyErrorOptions = {
  errorCode: string;
  errorMessage: string;
};

function buildRelayConversationPolicyError(options: RelayConversationPolicyErrorOptions) {
  const error = new Error(options.errorMessage) as Error & { code: string };
  error.code = options.errorCode;
  return error;
}

export function resolveRelayDeviceConversationTypeMask(
  workspaceConversationTypeMask: number,
  deviceConversationTypeMaskOverride?: number | null,
) {
  return resolveNarrowedConversationTypeMask(
    workspaceConversationTypeMask,
    deviceConversationTypeMaskOverride,
  );
}

export function resolveRelayCapabilityConversationTypeMask(
  deviceConversationTypeMask: number,
  capabilityConversationTypeMaskOverride?: number | null,
) {
  return resolveNarrowedConversationTypeMask(
    deviceConversationTypeMask,
    capabilityConversationTypeMaskOverride,
  );
}

export function resolveRelayGrantConversationTypeMask(
  capabilityConversationTypeMask: number,
  grantConversationTypeMaskOverride?: number | null,
) {
  return resolveNarrowedConversationTypeMask(
    capabilityConversationTypeMask,
    grantConversationTypeMaskOverride,
  );
}

export function assertRelayConversationTypeMaskWithinParent(
  parentConversationTypeMask: number,
  conversationTypeMaskOverride: number | null | undefined,
  options: RelayConversationPolicyErrorOptions,
) {
  const normalizedParentMask = normalizeConversationTypeMask(
    parentConversationTypeMask,
  );
  if (
    conversationTypeMaskOverride === null ||
    conversationTypeMaskOverride === undefined
  ) {
    return normalizedParentMask;
  }

  const effectiveConversationTypeMask = resolveNarrowedConversationTypeMask(
    normalizedParentMask,
    conversationTypeMaskOverride,
  );
  if (!isValidConversationTypeMask(effectiveConversationTypeMask)) {
    throw buildRelayConversationPolicyError(options);
  }
  return effectiveConversationTypeMask;
}
