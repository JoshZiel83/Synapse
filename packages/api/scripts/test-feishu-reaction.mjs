/**
 * Quick smoke test for the Feishu connector credentials.
 *
 * Reads FEISHU_APP_ID + FEISHU_APP_SECRET from env. Never commit credentials.
 *
 * Usage:
 *   FEISHU_APP_ID=... FEISHU_APP_SECRET=... \
 *     npx tsx scripts/test-feishu-reaction.mjs
 */
import * as Lark from "@larksuiteoapi/node-sdk"

const appId = process.env.FEISHU_APP_ID
const appSecret = process.env.FEISHU_APP_SECRET
if (!appId || !appSecret) {
  console.error(
    "FEISHU_APP_ID and FEISHU_APP_SECRET must be set in the environment."
  )
  process.exit(2)
}

const client = new Lark.Client({
  appId,
  appSecret,
  loggerLevel: Lark.LoggerLevel.warn,
})

console.log("=== tenant_access_token ===")
try {
  const t = await client.auth.tenantAccessToken.internal({
    data: { app_id: appId, app_secret: appSecret },
  })
  console.log("code:", t?.code, "msg:", t?.msg, "expire:", t?.expire)
} catch (e) {
  console.error("auth failed:", e.message)
  process.exit(1)
}

console.log("\nemoji_type catalogue is documented at:")
console.log(
  "  https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce"
)
