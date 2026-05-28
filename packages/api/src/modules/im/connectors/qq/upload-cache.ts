/**
 * file_info cache (Stage 5).
 *
 * Uploading the same media twice in a short window is wasteful —
 * openclaw measured ~90% bandwidth saved by reusing the `file_info`
 * blob the QQ API returns after a successful upload. This module
 * caches it keyed by (account, scope, target, fileType, md5).
 *
 * Scope: c2c | group. Target: openid for c2c, group_openid for group.
 *
 * TTL: 55 minutes. QQ's published file_info validity is 60 minutes;
 * leaving 5 minutes of headroom so we never hand out a token that
 * will expire mid-flight.
 */

import type { Redis } from "ioredis"
import type { QqFileType } from "./media-constants.js"

const TTL_SECONDS = 55 * 60

export type QqMediaScope = "c2c" | "group"

function key(params: {
  accountId: string
  scope: QqMediaScope
  targetId: string
  fileType: QqFileType
  md5: string
}): string {
  return `im:qq:file-info:${params.accountId}:${params.md5}:${params.scope}:${params.targetId}:${params.fileType}`
}

export async function getCachedFileInfo(
  redis: Redis,
  params: {
    accountId: string
    scope: QqMediaScope
    targetId: string
    fileType: QqFileType
    md5: string
  }
): Promise<string | null> {
  return await redis.get(key(params))
}

export async function setCachedFileInfo(
  redis: Redis,
  params: {
    accountId: string
    scope: QqMediaScope
    targetId: string
    fileType: QqFileType
    md5: string
    fileInfo: string
  }
): Promise<void> {
  await redis.set(key(params), params.fileInfo, "EX", TTL_SECONDS)
}
