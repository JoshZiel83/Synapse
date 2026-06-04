import { createAuthEndpoint } from "better-auth/api"
import { setSessionCookie } from "better-auth/cookies"
import { APIError } from "better-call"
import * as z from "zod"

/**
 * deviceSessionCookiePlugin — bridges a deviceAuthorization `access_token`
 * (which IS a real Better Auth session token, but is returned as JSON with no
 * Set-Cookie) into the browser's session cookie.
 *
 * The desktop QR flow polls /device/token and receives `access_token` once the
 * phone approves. A cookie-based web client then POSTs that token here; we look
 * up the session, verify it hasn't expired (findSession does NOT check expiry),
 * and issue the canonical session cookie via Better Auth's own signing context
 * (which is why this must be a plugin endpoint, not a plain Fastify route).
 *
 * Mirrors the in-tree multi-session set-active pattern.
 */
export const deviceSessionCookie = () => ({
  id: "device-session-cookie",
  endpoints: {
    deviceSessionCookie: createAuthEndpoint(
      "/device/session-cookie",
      {
        method: "POST",
        body: z.object({
          access_token: z.string().min(1),
        }),
      },
      async (ctx) => {
        const token = ctx.body.access_token
        const result = await ctx.context.internalAdapter.findSession(token)
        if (!result || result.session.expiresAt < new Date()) {
          throw new APIError("UNAUTHORIZED", {
            message: "Invalid or expired device session token",
          })
        }
        await setSessionCookie(ctx, {
          session: result.session,
          user: result.user,
        })
        return ctx.json({ status: true })
      }
    ),
  },
})
