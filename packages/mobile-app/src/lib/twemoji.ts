/**
 * Re-export of the canonical Twemoji helper from @synapse/shared.
 *
 * Implementation now lives in `@synapse/shared/emoji` (dependency-free, single
 * source of truth across web + mobile, imported here via the `@shared` alias).
 */
export { getTwemojiUrl, TWEMOJI_ASSET_BASE } from "@shared/emoji"
