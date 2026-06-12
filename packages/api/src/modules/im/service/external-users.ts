/**
 * transport_external_users domain: the dashboard's list of external IM
 * users (with their joined sessions + auto-link state). Read-only side
 * — address writes live in addresses.ts.
 *
 * The query lives in repo.ts (the module's repo file, which may import
 * the db client); this file re-exports it for back-compat so service.ts
 * and weixin-binding.ts importers stay unchanged.
 */

export { listTransportExternalUsers } from "./repo.js"
