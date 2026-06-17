import { z } from "zod"

const weixinQrCodeResponseSchema = z
  .object({
    qrcode: z.string().optional(),
    qrcode_img_content: z.string().optional(),
  })
  .passthrough()

const weixinQrStatusResponseSchema = z
  .object({
    status: z
      .enum([
        "wait",
        "scaned",
        "confirmed",
        "expired",
        "need_verifycode",
        "scaned_but_redirect",
        "binded_redirect",
        "verify_code_blocked",
      ])
      .optional(),
    bot_token: z.string().optional(),
    ilink_bot_id: z.string().optional(),
    baseurl: z.string().optional(),
    ilink_user_id: z.string().optional(),
    /** New host to redirect status polling to (status scaned_but_redirect). */
    redirect_host: z.string().optional(),
  })
  .passthrough()

export type WeixinQrCodeResponse = z.infer<typeof weixinQrCodeResponseSchema>
export type WeixinQrStatusResponse = z.infer<
  typeof weixinQrStatusResponseSchema
>

function parseJsonText(text: string): unknown | null {
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export function parseWeixinQrCodeResponseText(
  text: string
): WeixinQrCodeResponse | null {
  const json = parseJsonText(text)
  if (json === null) return null
  const parsed = weixinQrCodeResponseSchema.safeParse(json)
  return parsed.success ? parsed.data : null
}

export function parseWeixinQrStatusResponseText(
  text: string
): WeixinQrStatusResponse | null {
  const json = parseJsonText(text)
  if (json === null) return null
  const parsed = weixinQrStatusResponseSchema.safeParse(json)
  return parsed.success ? parsed.data : null
}
