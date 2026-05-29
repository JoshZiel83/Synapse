// Shell providers (bash + powershell) and the exec_file descriptor builder.
//
// Two key invariants enforced here, both from the plan's设计红线:
// 1. Programs always spawn via absolute paths (the provider holds
//    `environment.bash` / `environment.powershell`, never a literal "bash"
//    string), so child PATH search (which can be hijacked via empty/relative
//    PATH segments) can't substitute a different binary.
// 2. PowerShell always uses -EncodedCommand with a UTF-16LE base64 payload
//    that includes a prologue setting OutputEncoding to UTF-8. This kills the
//    quoting + Unicode edge cases in one shot.

import type {
  ResolvedTerminalEnvironment,
  ResolvedToolchain,
  ShellProvider,
  SpawnDescriptor,
  TerminalExecFileRequest,
  TerminalShellRequest,
} from "./types.js"

export class ShellNotAvailableError extends Error {
  readonly name = "ShellNotAvailableError"
  constructor(public readonly executor: "bash" | "powershell") {
    super(`shell executor not available on this device: ${executor}`)
  }
}

class PosixBashProviderImpl implements ShellProvider {
  readonly executor = "bash" as const
  constructor(private readonly bashPath: string) {}

  static fromEnvironment(
    env: ResolvedTerminalEnvironment
  ): PosixBashProviderImpl | null {
    if (!env.bash) return null
    return new PosixBashProviderImpl(env.bash)
  }

  isAvailable(env: ResolvedTerminalEnvironment): boolean {
    return env.bash !== null
  }

  buildShellDescriptor(req: TerminalShellRequest): SpawnDescriptor {
    if (req.executor !== "bash") {
      throw new Error(
        `PosixBashProvider received non-bash executor: ${req.executor}`
      )
    }
    // Use `-c` (not `-lc`); the executor injects PATH explicitly via
    // ResolvedToolchain.binDir + sanitized osEnv.PATH so we don't need
    // login profile to set it up.
    return {
      program: this.bashPath,
      args: ["-c", req.command],
      stdio: ["ignore", "pipe", "pipe"],
    }
  }
}

class PowerShellProviderImpl implements ShellProvider {
  readonly executor = "powershell" as const
  constructor(private readonly pwshPath: string) {}

  static fromEnvironment(
    env: ResolvedTerminalEnvironment
  ): PowerShellProviderImpl | null {
    if (!env.powershell) return null
    return new PowerShellProviderImpl(env.powershell)
  }

  isAvailable(env: ResolvedTerminalEnvironment): boolean {
    return env.powershell !== null
  }

  buildShellDescriptor(req: TerminalShellRequest): SpawnDescriptor {
    if (req.executor !== "powershell") {
      throw new Error(
        `PowerShellProvider received non-powershell executor: ${req.executor}`
      )
    }
    const encoded = encodePowerShellCommand(req.command)
    return {
      program: this.pwshPath,
      args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      stdio: ["ignore", "pipe", "pipe"],
    }
  }
}

export const POWERSHELL_PROLOGUE =
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n" +
  "$OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n"

/**
 * Encodes a PowerShell command body for `-EncodedCommand`. Prepends the
 * UTF-8 OutputEncoding prologue and encodes the result as UTF-16LE base64,
 * which is what PowerShell expects.
 */
export function encodePowerShellCommand(command: string): string {
  const full = POWERSHELL_PROLOGUE + command
  const utf16le = Buffer.from(full, "utf16le")
  return utf16le.toString("base64")
}

export function decodePowerShellCommand(encoded: string): string {
  return Buffer.from(encoded, "base64").toString("utf16le")
}

export const PosixBashProvider = PosixBashProviderImpl
export const PowerShellProvider = PowerShellProviderImpl

/**
 * Build a spawn descriptor for exec_file. NEVER goes through a shell — that
 * would re-introduce quoting / shell-injection risks. Caller passes the
 * resolved toolchain so we use its absolute `binPath` (whether system,
 * bundled-cache, or bundled-archive). For shell-branch callers, providers
 * above are the path.
 */
export function buildExecFileDescriptor(
  req: TerminalExecFileRequest,
  resolved: ResolvedToolchain
): SpawnDescriptor {
  return {
    program: resolved.binPath,
    args: [...req.args],
    stdio: ["ignore", "pipe", "pipe"],
  }
}
