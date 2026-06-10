import type { FastifyReply } from "fastify"
import type { z } from "zod"

/**
 * app-facing success response: uniform `{ data }` envelope.
 *
 * Always parses — the schema IS the contract boundary, so schemas carrying a
 * transform/codec must run (skipping parse would ship the un-normalized
 * `z.input` shape). The arg is `z.input<S>` (the "pre-parse" domain shape a
 * presenter produces); what gets sent is `z.output<S>` (the normalized
 * contract). See docs/architecture-boundary-refactor-master-plan.md §5.1.
 *
 * Use ONLY for app-facing endpoints with a body. No-content writes keep their
 * 204 (`reply.status(204).send()`); wire/machine endpoints send bare payloads.
 */
export function sendData<S extends z.ZodType>(
  reply: FastifyReply,
  schema: S,
  data: z.input<S>,
  status = 200
): FastifyReply {
  const payload: z.output<S> = schema.parse(data)
  return reply.status(status).send({ data: payload })
}
