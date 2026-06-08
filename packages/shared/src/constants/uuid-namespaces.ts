/**
 * Deterministic UUID v5 namespaces — used wherever we need stable IDs
 * derived from external identifiers (so a retry / replay produces the
 * same UUID instead of a fresh random one).
 *
 * Each constant is a fixed, well-known UUID v4 literal. NEVER rotate
 * them: every previously-derived ID becomes unfindable if the namespace
 * changes.
 */

/**
 * Namespace for Synapse "interaction" command IDs that are derived from
 * an external interaction event (e.g. a QQ INTERACTION_CREATE button
 * click). The derivation is
 *   `uuidv5(<transport-event-id>:<action-token>:<clicker-external-id>, this)`
 * so a replayed click → same commandId → resolveTaskRequest's
 * (task_id, command_id) idempotence cell short-circuits the
 * second attempt to the cached result.
 */
export const SYNAPSE_INTERACTION_NAMESPACE =
  "8e1f6c3e-2a55-4b3f-9a4c-9c1f0a8e7b22"
