import type { ApiClient } from "@/lib/api"

// The public surface of the real client. `keyof` on a class type excludes
// private members, so the private `fetch` is naturally dropped.
export type PublicApi = { [K in keyof ApiClient]: ApiClient[K] }

// A domain handler module supplies as many methods as are useful for design;
// the Proxy catch-all covers the rest. `satisfies DesignHandlers` on each module
// type-checks every supplied method against the real ApiClient signature, so a
// handler whose generated data no longer matches the upstream contract fails to
// compile. Because handlers can ignore their arguments, the canonical form of an
// entry is simply `methodName: async () => mock(SomeSchema)`.
export type DesignHandlers = Partial<PublicApi>
