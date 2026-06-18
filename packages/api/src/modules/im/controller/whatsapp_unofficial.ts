/**
 * WhatsApp (unofficial / Baileys) REST endpoints (mounted as a Fastify
 * plugin from controller.ts).
 *
 * SKELETON — the QR/pairing login-session endpoints (start login, poll
 * status, mirror weixin's QR flow) and the operator kill-switch toggle
 * land with the Baileys connector implementation.
 */

import type { FastifyInstance } from "fastify"

export default async function imWhatsappUnofficialController(
  _app: FastifyInstance
): Promise<void> {
  // intentionally empty until the connector body lands
}
