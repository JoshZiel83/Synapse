/**
 * Shared memory-module error type. Extracted to its own file so both the
 * service (orchestration) and the repo (DB access) can throw it without a
 * circular import. Re-exported from service.ts so existing importers
 * (controller.ts) stay unchanged.
 */
export class MemoryError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number
  ) {
    super(message)
    this.name = "MemoryError"
  }
}
