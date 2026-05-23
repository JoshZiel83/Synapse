import {
  CanonicalContentBlock,
  FILE_ORIGIN_SYSTEMS,
  textBlock,
  ToolDefinition,
} from "@synapse/shared"
import type { SubFeature } from "./types.js"
import type { BuiltinPluginExecuteResult } from "../../index.js"
import {
  saveFromUrl,
  fileToBuffer,
} from "../../../../../infrastructure/storage/file-io.js"
import {
  pluginOutputFileRef,
  resolveFileRefRecord,
  fileRefProperty,
} from "../../../file-ref.js"
import {
  normalizeZhipuTransportError,
  throwZhipuApiError,
} from "./zhipu-errors.js"
import { buildToolOutputOrigin } from "../../../../files/service.js"

const ZHIPU_API_BASE = "https://open.bigmodel.cn/api/paas/v4"

const FILE_TYPES = [
  "WPS",
  "PDF",
  "DOCX",
  "DOC",
  "XLS",
  "XLSX",
  "PPT",
  "PPTX",
  "PNG",
  "JPG",
  "JPEG",
  "CSV",
  "TXT",
  "MD",
  "HTML",
  "BMP",
  "GIF",
  "WEBP",
  "HEIC",
  "EPS",
  "ICNS",
  "IM",
  "PCX",
  "PPM",
  "TIFF",
  "XBM",
  "HEIF",
  "JP2",
]

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "parse_file_sync",
    description:
      "Run ZhipuAI synchronous file parser on a FileRef. " +
      "The official Prime-sync parser supports many office documents, images, markdown, HTML, spreadsheets, and plain text. " +
      "It may return parsed text content and/or a downloadable parsing result package.",
    parameters: {
      type: "object",
      properties: {
        fileRef: fileRefProperty(
          "Document or image FileRef to parse with the synchronous parser."
        ),
        fileType: {
          type: "string",
          description:
            "Optional explicit file type. If omitted, the server infers it from the FileRef filename/mime type.",
          enum: FILE_TYPES,
        },
      },
      required: ["fileRef"],
    },
  },
]

function inferFileType(originalName: string, mimeType: string): string {
  const ext = originalName.split(".").pop()?.trim().toUpperCase() || ""
  if (FILE_TYPES.includes(ext)) return ext

  const mimeToType: Record<string, string> = {
    "application/pdf": "PDF",
    "application/msword": "DOC",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      "DOCX",
    "application/vnd.ms-excel": "XLS",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "XLSX",
    "application/vnd.ms-powerpoint": "PPT",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      "PPTX",
    "text/csv": "CSV",
    "text/plain": "TXT",
    "text/markdown": "MD",
    "text/html": "HTML",
    "image/png": "PNG",
    "image/jpeg": "JPEG",
    "image/jpg": "JPG",
    "image/bmp": "BMP",
    "image/gif": "GIF",
    "image/webp": "WEBP",
    "image/heic": "HEIC",
    "image/heif": "HEIF",
    "image/tiff": "TIFF",
    "image/jp2": "JP2",
  }

  return mimeToType[mimeType] || "PDF"
}

function toBlobBytes(buffer: Buffer) {
  const bytes = new Uint8Array(buffer.byteLength)
  bytes.set(buffer)
  return bytes
}

export const fileParserSyncFeature: SubFeature = {
  featureKey: "feature_file_parser",

  getTools(): ToolDefinition[] {
    return TOOL_DEFINITIONS
  },

  async execute(
    _toolName: string,
    input: Record<string, unknown>,
    config: Record<string, unknown>
  ): Promise<BuiltinPluginExecuteResult> {
    const apiKey = config.apiKey as string
    if (!apiKey) throw new Error("ZhipuAI API key not configured.")

    const workspaceId = (config.workspace_id as string) || null
    const record = await resolveFileRefRecord(input.fileRef, "fileRef")
    const buffer = await fileToBuffer(record)
    const fileType =
      typeof input.fileType === "string" && FILE_TYPES.includes(input.fileType)
        ? input.fileType
        : inferFileType(record.originalName, record.mimeType)

    const form = new FormData()
    form.append(
      "file",
      new Blob([toBlobBytes(buffer)], { type: record.mimeType }),
      record.originalName
    )
    form.append("tool_type", "prime-sync")
    form.append("file_type", fileType)

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 180000)

    try {
      const response = await fetch(`${ZHIPU_API_BASE}/files/parser/sync`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: form,
        signal: controller.signal,
      })

      if (!response.ok) {
        await throwZhipuApiError("文件解析(同步) API", response)
      }

      const result = (await response.json()) as {
        status?: string
        message?: string
        task_id?: string
        content?: string | null
        parsing_result_url?: string | null
      }

      const output: CanonicalContentBlock[] = []
      output.push(
        textBlock(
          `File parser task ${result.task_id || ""} status: ${result.status || "unknown"}${result.message ? ` (${result.message})` : ""}`
        )
      )

      if (result.content) {
        output.push(textBlock(result.content))
      }

      if (result.parsing_result_url) {
        const parsedArchive = await saveFromUrl(
          result.parsing_result_url,
          workspaceId,
          null,
          `${record.originalName || "parsed-result"}.zip`,
          buildToolOutputOrigin({
            system: FILE_ORIGIN_SYSTEMS.ZHIPU_FILE_PARSER_SYNC,
            providerKey: "bigmodel",
            parentFileId: record.id,
            details: {
              taskId: result.task_id,
            },
          })
        )
        output.push(textBlock("Structured parsing result archive:"))
        output.push(pluginOutputFileRef(parsedArchive))
      }

      return output
    } catch (error) {
      throw normalizeZhipuTransportError("文件解析(同步) API", error)
    } finally {
      clearTimeout(timeout)
    }
  },
}
