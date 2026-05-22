/**
 * List reactions on a Feishu message.
 *
 * Reads FEISHU_APP_ID + FEISHU_APP_SECRET from env (or from a sibling
 * .env file). Never commit a copy with credentials inlined.
 *
 * Usage:
 *   FEISHU_APP_ID=... FEISHU_APP_SECRET=... \
 *     npx tsx scripts/list-reactions.mjs <message_id>
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

const msgId = process.argv[2]
if (!msgId) {
  console.error("usage: npx tsx scripts/list-reactions.mjs <message_id>")
  process.exit(1)
}
const r = await client.im.messageReaction.list({ path: { message_id: msgId } })
console.log("code:", r?.code, "msg:", r?.msg)
console.log("data:", JSON.stringify(r?.data, null, 2))
