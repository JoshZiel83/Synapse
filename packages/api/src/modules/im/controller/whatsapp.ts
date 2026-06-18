/**
 * WhatsApp Cloud API REST endpoints (mounted as a Fastify plugin from
 * controller.ts).
 *
 * SKELETON — the typed-credential create/update routes (phoneNumberId,
 * wabaId, access token, app secret, verify token) and any live
 * `phoneNumberId` probe land with the WhatsApp Cloud connector
 * implementation. The webhook GET-verify + POST routes live in the shared
 * `public-controller.ts`, not here.
 */

import type { FastifyInstance } from "fastify"

export default async function imWhatsappController(
  _app: FastifyInstance
): Promise<void> {
  // intentionally empty until the connector body lands
}
