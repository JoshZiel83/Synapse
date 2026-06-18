/**
 * Telegram-specific REST endpoints (mounted as a Fastify plugin from
 * controller.ts).
 *
 * SKELETON — the typed-credential create/update routes (bot token,
 * webhook secret) and the `setWebhook`/`deleteWebhook` registration
 * lifecycle land with the Telegram connector implementation. A
 * token-based account can already be created through the generic
 * `POST /im/accounts` route in the meantime.
 */

import type { FastifyInstance } from "fastify"

export default async function imTelegramController(
  _app: FastifyInstance
): Promise<void> {
  // intentionally empty until the connector body lands
}
