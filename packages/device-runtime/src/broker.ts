// Per-OS-user identity broker. v3.0 file-backed implementation that stores
// non-sensitive registry state in a JSON file under the platform per-user
// config directory and (best-effort) holds private keys in OS keychain via
// a pluggable adapter. The default in-process key store is a plaintext file
// next to the broker — explicitly OS keychain integration is the
// implementer's responsibility (this avoids a hard dependency on
// `keytar` / DBus / Wincred in v3.0 skeleton).
//
// See docs/device-runtime-v3.md §5.1.

import { generateKeyPairSync, createHash, randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir, platform } from "node:os"
import { DEVICE_SERVICE_KINDS, HOST_KINDS } from "@synapse/device-protocol"
import { z } from "zod"
import type {
  DeviceIdentityBroker,
  DeviceIdentityRecord,
  KeyPair,
} from "./types.js"

const PersistedKeyEntrySchema = z.strictObject({
  publicKey: z.string().min(1),
  privateKey: z.string().min(1),
  publicKeyFingerprint: z.string().min(1),
})

type PersistedKeyEntry = z.infer<typeof PersistedKeyEntrySchema>

const KeystoreSchema = z.record(z.string(), PersistedKeyEntrySchema)

const DeviceIdentityServiceSchema = z.strictObject({
  serviceKind: z.enum(DEVICE_SERVICE_KINDS),
  serviceId: z.string().min(1),
  pubkeyFingerprint: z.string().min(1),
  privateKeyRef: z.string().min(1),
})

const DeviceIdentityRecordSchema = z.strictObject({
  deviceId: z.string().min(1),
  serverOrigin: z.string().min(1),
  hostKind: z.enum(HOST_KINDS),
  services: z.array(DeviceIdentityServiceSchema),
  devicePubkeyFingerprint: z.string().min(1),
  devicePrivateKeyRef: z.string().min(1),
}) satisfies z.ZodType<DeviceIdentityRecord>

function resolveDefaultBrokerDir(): string {
  switch (platform()) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", "Synapse")
    case "win32":
      return join(
        process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
        "Synapse"
      )
    default:
      return join(
        process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
        "synapse"
      )
  }
}

export interface FileBackedBrokerOptions {
  /** Override the broker dir (test fixture). Defaults to platform per-user. */
  brokerDir?: string
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"))
}

function readKeystoreFromFile(
  keystorePath: string
): Record<string, PersistedKeyEntry> {
  if (!existsSync(keystorePath)) return {}
  try {
    return KeystoreSchema.parse(readJsonFile(keystorePath))
  } catch {
    return {}
  }
}

export function readPrivateKeyPemFromKeystoreFile(
  keystorePath: string,
  privateKeyRef: string
): string | null {
  return readKeystoreFromFile(keystorePath)[privateKeyRef]?.privateKey ?? null
}

export function createFileBackedBroker(
  opts: FileBackedBrokerOptions = {}
): DeviceIdentityBroker {
  const brokerDir = opts.brokerDir ?? resolveDefaultBrokerDir()
  const brokerFilePath = join(brokerDir, "device-identity.json")
  const keystorePath = join(brokerDir, "device-keys.json")

  function ensureDir() {
    mkdirSync(brokerDir, { recursive: true })
  }

  function readKeystore(): Record<string, PersistedKeyEntry> {
    return readKeystoreFromFile(keystorePath)
  }

  function writeKeystore(entries: Record<string, PersistedKeyEntry>) {
    ensureDir()
    writeFileSync(keystorePath, JSON.stringify(entries, null, 2), {
      mode: 0o600,
    })
  }

  return {
    brokerFilePath,
    async loadDeviceIdentity(): Promise<DeviceIdentityRecord | null> {
      if (!existsSync(brokerFilePath)) return null
      try {
        return DeviceIdentityRecordSchema.parse(readJsonFile(brokerFilePath))
      } catch {
        return null
      }
    },
    async saveDeviceIdentity(record: DeviceIdentityRecord): Promise<void> {
      ensureDir()
      writeFileSync(brokerFilePath, JSON.stringify(record, null, 2), {
        mode: 0o600,
      })
    },
    async generateKeyPair(label: string): Promise<KeyPair> {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519")
      const pem = publicKey.export({ format: "pem", type: "spki" }) as string
      const sk = privateKey.export({
        format: "pem",
        type: "pkcs8",
      }) as string
      const fingerprint = createHash("sha256").update(pem).digest("hex")
      const privateKeyRef = `local:${label}:${randomBytes(8).toString("hex")}`
      const entries = readKeystore()
      entries[privateKeyRef] = {
        publicKey: pem,
        privateKey: sk,
        publicKeyFingerprint: fingerprint,
      }
      writeKeystore(entries)
      return {
        publicKey: pem,
        privateKeyRef,
        publicKeyFingerprint: fingerprint,
      }
    },
    async loadKeyPair(label: string): Promise<KeyPair | null> {
      const entries = readKeystore()
      const entry = entries[label]
      if (!entry) return null
      return {
        publicKey: entry.publicKey,
        privateKeyRef: label,
        publicKeyFingerprint: entry.publicKeyFingerprint,
      }
    },
  }
}
