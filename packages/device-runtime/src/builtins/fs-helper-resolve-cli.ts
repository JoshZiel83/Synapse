// Thin CLI bridging pretest-fs-helper.sh to the REAL fs-helper resolver, so the
// shell guard never re-implements candidate/priority logic in bash (that mirror
// drifted out of sync with fs-helper-resolve.ts four times). Run via tsx:
//
//   tsx fs-helper-resolve-cli.ts <profile> <sidecarDir>
//
// Emits one shell-evalable line of KEY=VALUE pairs describing what the profile's
// resolver would actually pick, honoring SYNAPSE_DEVICE_FS_HELPER_PATH exactly
// like every other consumer:
//
//   RESOLVED=<abs path the resolver would pick, or empty if nothing resolves>
//   TARGET=<abs path `cargo build [--release]` of this profile writes>
//   ENV_SET=<1|0>          whether SYNAPSE_DEVICE_FS_HELPER_PATH points at a real file
//   ENV_IS_TARGET=<1|0>    whether that override is exactly TARGET (build refreshes it)
//
// The shell guard reads these and decides fail/build/skip — no path logic in bash.

import { existsSync } from "node:fs"
import { resolve } from "node:path"
import {
  resolveFsHelperForProfile,
  fsHelperBuildOutput,
  FS_HELPER_ENV_VAR,
  type FsHelperProfile,
} from "./fs-helper-resolve.js"

function sh(value: string): string {
  // Single-quote for safe `eval` in bash; escape embedded single quotes.
  return `'${value.replace(/'/g, "'\\''")}'`
}

const profile = process.argv[2] as FsHelperProfile
const sidecarDirArg = process.argv[3]

if (profile !== "release" && profile !== "debug") {
  process.stderr.write(
    `fs-helper-resolve-cli: bad profile '${profile}' (want release|debug)\n`
  )
  process.exit(2)
}
if (!sidecarDirArg) {
  process.stderr.write("fs-helper-resolve-cli: missing <sidecarDir>\n")
  process.exit(2)
}

const sidecarDir = resolve(sidecarDirArg)
const resolved = resolveFsHelperForProfile(profile, sidecarDir) ?? ""
const target = fsHelperBuildOutput(profile, sidecarDir)

const envRaw = process.env[FS_HELPER_ENV_VAR]?.trim()
const envSet = !!envRaw && existsSync(envRaw)
const envIsTarget = envSet ? resolve(envRaw!) === resolve(target) : false

process.stdout.write(
  `${[
    `RESOLVED=${sh(resolved)}`,
    `TARGET=${sh(target)}`,
    `ENV_SET=${envSet ? "1" : "0"}`,
    `ENV_IS_TARGET=${envIsTarget ? "1" : "0"}`,
  ].join("\n")}\n`
)
