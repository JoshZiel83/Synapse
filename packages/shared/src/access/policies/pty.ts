import { z } from "zod"

// pty (interactive terminal) session-scope policy (§5 / §11 inv-31). Unlike the
// commandline policy family, a pty policy carries NO command/argv/byte matcher:
// `pty.open` is matched ONCE against the session's working directory + isolation
// posture, and every subsequent `pty.write`/`resize`/`signal`/`stream`/`close`
// references the already-opened session id and is NEVER re-matched. Routing pty
// bytes through a command-text matcher would be fail-OPEN — a narrow command
// grant (e.g. "allow `ls`") would silently become a full interactive shell — so
// the pty capability is a distinct family with its own cwd/isolation-only gate.
export const PtyPolicySchema = z.object({
  // Optional narrower cwd cap (a sub-mount). Absent = the whole sandbox mount
  // points. Never a command constraint.
  workingDirectory: z.string().optional(),
  // Curated allow-list of env var names the pty session may inherit. Never the
  // raw process env.
  allowedEnv: z.array(z.string()).optional(),
})

export type PtyPolicy = z.infer<typeof PtyPolicySchema>
