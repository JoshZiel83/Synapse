import { ApiClient } from "@/lib/api"
import { handlers } from "./handlers"

// Build the design-time fake client by wrapping a real ApiClient instance in a
// Proxy. Wrapping a real instance keeps the result assignable to `ApiClient`
// (no unsafe cast) and lets us distinguish genuine API methods from incidental
// property probes (e.g. `then`), so the fake never accidentally looks thenable.
//
// For every real method we return either its typed handler (when one exists) or
// a no-op stub that resolves to `undefined`. The real method itself is never
// invoked, so no network request is ever made.
export function createDesignApi(): ApiClient {
  const real = new ApiClient()
  const overrides = handlers as Partial<
    Record<string, (...args: unknown[]) => unknown>
  >

  return new Proxy(real, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof prop === "string" && typeof value === "function") {
        const override = overrides[prop]
        if (override) return override
        return (..._args: unknown[]) => {
          if (process.env.NODE_ENV !== "production") {
            console.warn(
              `[design-mock] no handler for api.${prop}() — returning undefined`
            )
          }
          return Promise.resolve(undefined)
        }
      }
      return value
    },
  })
}
