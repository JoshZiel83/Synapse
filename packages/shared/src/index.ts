export * from "./types/index.js"
export * from "./types/relay.js"
export * from "./constants/index.js"
export * from "./utils/index.js"
export * from "./automation/index.js"
export * from "./chat-catalog/index.js"
export * from "./chat-queue/index.js"
// NOTE: ./schemas is NOT re-exported from the root barrel on purpose.
// schemas/* pulls in zod, and the chat service workers (web + mobile)
// transitively reach the root barrel via @synapse/shared / @shared
// imports. Including zod in the SW bundle would bloat each pre-built
// worker by ~150kB. Consumers that need the zod schemas import via the
// dedicated subpath: `@synapse/shared/schemas` (web) or
// `@shared/schemas` (mobile).
