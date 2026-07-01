# web-next-design

A faithful, **backend-free clone of `web-next`** for UI / interface design work.
Every screen renders on **mock data** — there is no API, database, or auth server
to run. Iterate on layout, components, theming and flows here without standing up
the stack.

```bash
npm run dev:web-design      # from the repo root → http://localhost:3100
```

(`web-next` keeps using port 3000, so both can run side by side.)

## How the mocking works

The design build swaps the network client for a **typed fake `ApiClient`** that
serves data generated from the project's real Zod schemas. Two principles drive
the design:

1. **No hand-written response shapes.** Data is generated with
   [`zod-schema-faker`](https://github.com/soc221b/zod-schema-faker) directly from
   the `@synapse/shared` schemas (`fake(SomeViewSchema)`), so the single source of
   truth stays in `@synapse/shared`.
2. **Drift surfaces at compile time.** Each handler is checked against the real
   `ApiClient` method signature (`satisfies DesignHandlers`). If a schema or method
   return type changes upstream, the mock fails to compile — you find out at
   `tsc`, not at runtime.

### Layers (`lib/design/`)

| File                   | Role                                                                                                                                                                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `faker-setup.ts`       | Wires faker into zod-schema-faker, seeds it for stable output, and registers a custom faker for the `IsoInstantString` brand so every timestamp is a valid UTC ISO instant. Exports `mock(schema)`.                                                       |
| `handlers/_types.ts`   | `DesignHandlers = Partial<PublicApi>` — the compile-time contract every handler module is checked against.                                                                                                                                                |
| `handlers/<domain>.ts` | One module per API domain. Each entry is `methodName: async () => mock(SomeViewSchema)`.                                                                                                                                                                  |
| `handlers/index.ts`    | Merges all domain modules into one `handlers` map.                                                                                                                                                                                                        |
| `mock-api.ts`          | `createDesignApi()` — a `Proxy` over a real `ApiClient` instance. Mocked methods return their handler; everything else returns a no-op stub (`undefined`) so unmocked endpoints render empty states instead of crashing. No network request is ever made. |
| `auth.ts`              | A stable fake `{ user, session }` so protected routes render.                                                                                                                                                                                             |

The swap itself lives at the bottom of `lib/api.ts`, and auth is bypassed in
`lib/server-auth.ts` + `proxy.ts`. All of it is gated on
`NEXT_PUBLIC_DESIGN_MOCK` (default on; set to `0` to restore the real network
client).

## Adding / fixing a mock

- **New endpoint** — add `methodName: async () => mock(MatchingViewSchema)` to the
  relevant `handlers/<domain>.ts`. Use the schema whose name matches the method's
  return type (`Promise<FooView>` → `FooViewSchema`).
- **Richer data for a screen** — register field-aware custom fakers in
  `faker-setup.ts`, or build the value explicitly in the handler.
- Unmocked methods are not an error: the Proxy catch-all returns `undefined` and
  logs `[design-mock] no handler for api.X()` in the browser console.

## shadcn

This is a normal shadcn project (`components.json` carried over from `web-next`),
so `npx shadcn@latest add <component>` works as usual.

## Relationship to `web-next`

This package is **excluded from the production build, tests and CI guards** (those
target `web-next` by name). Treat it as a design sandbox; port finished UI back to
`web-next` deliberately. It does drift from `web-next` over time — re-sync screens
when you need the latest.
