/**
 * Single source of truth for connector registration.
 *
 * Production (`packages/api/src/modules/im/index.ts`) and the
 * capability contract tests (`capability-assertions.test.ts`) both
 * import this file — and only this file — so the registered set is
 * guaranteed to match at runtime and in tests. Adding a new
 * connector means appending one `import` here; do NOT side-effect
 * register from any other location.
 *
 * Each `import` triggers the connector's `index.ts` to call
 * `registerConnector(...)` at module load. Per the contract in
 * `connectors/types.ts`, those `index.ts` files MUST NOT perform any
 * top-level IO (no Redis instantiation, no timers, no network) —
 * otherwise this import chain would drag platform deps into the
 * contract tests.
 */

import "./feishu/index.js"
import "./weixin/index.js"
import "./wecom/index.js"
import "./dingtalk/index.js"
import "./qq/index.js"
import "./telegram/index.js"
import "./whatsapp/index.js"
import "./whatsapp_unofficial/index.js"
