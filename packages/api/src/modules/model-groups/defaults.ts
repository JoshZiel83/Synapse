import type { ModelAttemptPolicy } from "@synapse/shared";

export const DEFAULT_MODEL_ATTEMPT_TIMEOUT_MS = 5 * 60 * 1000;

export const DEFAULT_MODEL_ATTEMPT_POLICY: ModelAttemptPolicy = {
  maxAttemptsTotal: 4,
  maxAttemptsPerBinding: 2,
  timeoutMsPerAttempt: DEFAULT_MODEL_ATTEMPT_TIMEOUT_MS,
  continueOn: ["timeout", "5xx", "network", "rate_limit"],
  stopOn: ["auth_error", "bad_request", "policy_block"],
  retryBackoffMs: [0, 1000, 3000],
};
