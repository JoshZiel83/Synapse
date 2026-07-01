/**
 * Re-export of the canonical Twemoji helper from @synapse/shared.
 *
 * The implementation now lives in `@synapse/shared/emoji` (dependency-free,
 * single source of truth across web + mobile). This shim keeps the existing
 * `@/lib/twemoji` import path stable for current call-sites.
 */
export { getTwemojiUrl, TWEMOJI_ASSET_BASE } from "@synapse/shared/emoji"
