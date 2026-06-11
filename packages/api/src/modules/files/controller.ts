import type { FastifyInstance, FastifyReply } from "fastify"
import { z } from "zod"
import { USER_UPLOAD_FILE_ORIGIN_SYSTEMS } from "@synapse/shared/constants"
import {
  FileParseEnqueueResultSchema,
  FileParseRunViewSchema,
  FileRecordViewSchema,
  StoredFileRecordViewSchema,
} from "@synapse/shared/schemas"
import type {
  FileCreateOriginInput,
  UserUploadFileOriginSystem,
} from "@synapse/shared/types"
import { appRoute, wireRoute } from "../../infrastructure/http/route.js"
import { sendData } from "../../infrastructure/http/respond.js"
import { authMiddleware } from "../../infrastructure/middleware/auth.js"
import { workspaceMiddleware } from "../../infrastructure/middleware/workspace.js"
import {
  getFileRecord,
  buildUserUploadOrigin,
  getFileDetail,
  uploadFile,
  canUserAccessFileWorkspace,
  readFileBufferById,
  readContentBufferBySha,
  getContentMimeBySha,
} from "./service.js"
import { canUserAccessContent } from "./content-access.js"
import {
  enqueueFileParse,
  getLatestAvailableFileParse,
} from "./parse-service.js"

const fileUploadOriginSchema = z.strictObject({
  family: z.literal("user_upload"),
  system: z.enum(USER_UPLOAD_FILE_ORIGIN_SYSTEMS),
  details: z.record(z.string(), z.unknown()).optional(),
})

async function sendStoredFile(
  reply: FastifyReply,
  info: {
    fileId: string
    mimeType: string
    originalName: string
  }
) {
  try {
    const buffer = await readFileBufferById(info.fileId)
    if (!buffer) {
      return reply.status(404).send({ error: "File not found" })
    }
    reply.type(info.mimeType || "application/octet-stream")
    reply.header(
      "Content-Disposition",
      `inline; filename*=UTF-8''${encodeURIComponent(info.originalName || "file")}`
    )
    return reply.send(buffer)
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return reply.status(404).send({ error: "File not found" })
    }
    throw error
  }
}

export async function filesUploadController(app: FastifyInstance) {
  app.addHook("onRequest", authMiddleware)
  app.addHook("onRequest", workspaceMiddleware)

  appRoute(
    app,
    "POST",
    "/workspaces/:workspaceId/files",
    { schema: StoredFileRecordViewSchema },
    async (request, reply) => {
      const { workspaceId } = request.params as { workspaceId: string }
      const userId = (request as any).user!.userId

      let filePart: Awaited<ReturnType<typeof request.file>> | null = null
      let originInput: FileCreateOriginInput | null = null
      try {
        for await (const part of request.parts()) {
          if (part.type === "file") {
            if (!filePart) {
              filePart = part
            } else {
              part.file.resume()
            }
            continue
          }

          if (part.fieldname === "origin" && typeof part.value === "string") {
            try {
              originInput = JSON.parse(part.value) as FileCreateOriginInput
            } catch {
              reply.status(400).send({ error: "origin must be valid JSON" })
              return
            }
          }
        }
      } catch {
        reply.status(413).send({ error: "File too large (max 25MB)" })
        return
      }

      if (!filePart) {
        reply.status(400).send({ error: "No file provided" })
        return
      }

      let buffer
      try {
        buffer = await filePart.toBuffer()
      } catch {
        reply.status(413).send({ error: "File too large (max 25MB)" })
        return
      }

      const parsedOrigin = fileUploadOriginSchema.safeParse(originInput)
      if (!parsedOrigin.success) {
        reply.status(400).send({
          error: `Invalid origin: ${parsedOrigin.error.issues.map((issue) => issue.message).join(" ")}`,
        })
        return
      }

      const record = await uploadFile(
        buffer,
        filePart.filename,
        filePart.mimetype,
        workspaceId,
        userId,
        buildUserUploadOrigin({
          system: parsedOrigin.data.system as UserUploadFileOriginSystem,
          initiatorUserId: userId,
          details: parsedOrigin.data.details,
        })
      )
      // 201-creating write: send the { data } envelope at 201 via the same
      // sendData the helper uses, then no-op appRoute (reply already sent).
      sendData(reply, StoredFileRecordViewSchema, record, 201)
      return undefined
    }
  )
}

export async function filesReadController(app: FastifyInstance) {
  app.addHook("onRequest", authMiddleware)

  appRoute(
    app,
    "GET",
    "/files/:fileId/info",
    { schema: FileRecordViewSchema },
    async (request, reply) => {
      const userId = (request as any).user!.userId
      const { fileId } = request.params as { fileId: string }
      const detail = await getFileDetail(fileId)
      if (!detail) {
        reply.status(404).send({ error: "File not found" })
        return
      }

      const allowed = await canUserAccessFileWorkspace(
        detail.workspaceId ?? null,
        userId
      )
      if (!allowed) {
        reply.status(403).send({ error: "Forbidden" })
        return
      }

      return detail
    }
  )

  appRoute(
    app,
    "GET",
    "/files/:fileId/parses/latest",
    { schema: FileParseRunViewSchema },
    async (request, reply) => {
      const userId = (request as any).user!.userId
      const { fileId } = request.params as { fileId: string }
      const detail = await getFileDetail(fileId)
      if (!detail) {
        reply.status(404).send({ error: "File not found" })
        return
      }

      const allowed = await canUserAccessFileWorkspace(
        detail.workspaceId ?? null,
        userId
      )
      if (!allowed) {
        reply.status(403).send({ error: "Forbidden" })
        return
      }

      const parse = await getLatestAvailableFileParse(fileId)
      if (!parse) {
        reply.status(404).send({ error: "No parse found" })
        return
      }

      return parse
    }
  )

  appRoute(
    app,
    "POST",
    "/files/:fileId/parses",
    { schema: FileParseEnqueueResultSchema },
    async (request, reply) => {
      const userId = (request as any).user!.userId
      const { fileId } = request.params as { fileId: string }
      const detail = await getFileDetail(fileId)
      if (!detail) {
        reply.status(404).send({ error: "File not found" })
        return
      }

      const allowed = await canUserAccessFileWorkspace(
        detail.workspaceId ?? null,
        userId
      )
      if (!allowed) {
        reply.status(403).send({ error: "Forbidden" })
        return
      }

      const runId = await enqueueFileParse({
        fileId,
        trigger: "manual",
      })
      if (!runId) {
        reply
          .status(400)
          .send({ error: "File type is not supported for default parsing" })
        return
      }

      // 202-accepted write: send the { data } envelope at 202 via the same
      // sendData the helper uses, then no-op appRoute (reply already sent).
      sendData(reply, FileParseEnqueueResultSchema, { runId }, 202)
      return undefined
    }
  )

  wireRoute(app, "GET", "/files/:fileId", {}, async (request, reply) => {
    const userId = (request as any).user!.userId
    const { fileId } = request.params as { fileId: string }
    const info = await getFileRecord(fileId)
    if (!info) {
      return reply.status(404).send({ error: "File not found" })
    }

    const allowed = await canUserAccessFileWorkspace(
      info.workspaceId ?? null,
      userId
    )
    if (!allowed) {
      return reply.status(403).send({ error: "Forbidden" })
    }

    return sendStoredFile(reply, {
      fileId: info.id,
      mimeType: info.mimeType,
      originalName: info.originalName,
    })
  })

  // Content-addressed read: GET /api/v1/content/:sha256. file_ref blocks render
  // by content sha (pinned at message-persist time). A sha is not itself an
  // authorization token, so contentAccessResolver checks every reference path
  // the caller could legitimately reach the bytes through (message / memory /
  // file-space grant / asset). Optional ?conv= and ?space= narrow the search.
  wireRoute(app, "GET", "/content/:sha256", {}, async (request, reply) => {
    const userId = (request as any).user!.userId as string
    const { sha256 } = request.params as { sha256: string }
    const query = request.query as { conv?: string; space?: string }
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      return reply.status(400).send({ error: "Invalid content hash" })
    }

    const allowed = await canUserAccessContent(sha256, userId, {
      conversationId: query.conv ?? null,
      fileSpaceId: query.space ?? null,
    })
    if (!allowed) {
      return reply.status(403).send({ error: "Forbidden" })
    }

    const buffer = await readContentBufferBySha(sha256)
    if (!buffer) {
      return reply.status(404).send({ error: "Content not found" })
    }
    const mimeType = await getContentMimeBySha(sha256)
    reply.type(mimeType || "application/octet-stream")
    // Content is immutable (addressed by hash) → cache aggressively.
    reply.header("Cache-Control", "public, max-age=31536000, immutable")
    return reply.send(buffer)
  })
}
