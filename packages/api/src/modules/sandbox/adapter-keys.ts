// Config-free LEAF: the registered `${provider}:${mode}` sandbox adapter keys.
// Imported by BOTH config/index.ts (boot validation) and adapter-registry.ts
// (the ADAPTER_FACTORIES map) so the registered set and the validated set can
// never drift. This file MUST NOT import config or adapter-registry (that would
// re-introduce the config<->registry cycle the leaf exists to avoid).

export const SANDBOX_ADAPTER_KEYS = [
  "local:resident",
  "docker:resident",
  "local:bare",
  "docker:bare",
  // First OFF-BOX (Mode-B) adapter — confinedFs:'unsupported', satisfies the P1.2
  // host-side guard via adapter.rebuildDataPlane (P4b).
  "cubesandbox:bare",
] as const

export type SandboxAdapterKey = (typeof SANDBOX_ADAPTER_KEYS)[number]

/** True iff `${provider}:${mode}` names a registered adapter. */
export function isRegisteredSandboxAdapterKey(key: string): boolean {
  return (SANDBOX_ADAPTER_KEYS as readonly string[]).includes(key)
}
