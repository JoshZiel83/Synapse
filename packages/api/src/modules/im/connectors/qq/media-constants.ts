/**
 * QQ rich-media size limits (Stage 5).
 *
 * Sourced from openclaw-qqbot/src/utils/file-utils.ts (the README's
 * older "20MB / 30MB" values are stale; the code constants are current).
 *
 * The platform also enforces a per-bot 2GB daily cumulative upload
 * limit via the `upload_prepare` API; that surfaces as biz code
 * 40093002 at request time, not as a connector-side check.
 */

import { QQ_MSG_TYPE } from "./types.js"

export const QQ_FILE_TYPE = {
  IMAGE: 1,
  VIDEO: 2,
  VOICE: 3,
  FILE: 4,
} as const
export type QqFileType = (typeof QQ_FILE_TYPE)[keyof typeof QQ_FILE_TYPE]

/** Per-file size cap in bytes. */
export const QQ_UPLOAD_SIZE_LIMITS: Record<QqFileType, number> = {
  [QQ_FILE_TYPE.IMAGE]: 30 * 1024 * 1024,
  [QQ_FILE_TYPE.VIDEO]: 100 * 1024 * 1024,
  [QQ_FILE_TYPE.VOICE]: 20 * 1024 * 1024,
  [QQ_FILE_TYPE.FILE]: 100 * 1024 * 1024,
}

/** Allowed CDN hosts QQ inbound attachments may live on. Conservative;
 *  unknown hosts get rejected by `downloadToBufferWithLimit`. */
export const QQ_INBOUND_MEDIA_HOSTS: string[] = [
  "multimedia.nt.qq.com.cn",
  "gchat.qpic.cn",
  "c2cpicdw.qpic.cn",
  "wx.qlogo.cn",
]

export const QQ_MEDIA_MSG_TYPE = QQ_MSG_TYPE.MEDIA
