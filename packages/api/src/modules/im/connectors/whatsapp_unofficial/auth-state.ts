/**
 * DB-backed Baileys `AuthenticationState`.
 *
 * Baileys' own docs say `useMultiFileAuthState` must NEVER be used in prod, so
 * we hand-roll a state that holds the snapshot in memory and flushes it through
 * the service layer (see creds-persistence.ts) on EVERY mutation:
 *
 *   - `creds.update` event       → driver calls `flush()`  (creds changed)
 *   - `keys.set(...)`            → mutates the in-memory key buckets, then the
 *                                  driver flushes (Signal keys change on nearly
 *                                  every message; missing a flush = decryption
 *                                  failures + QR re-request on restart)
 *
 * The state is PURE w.r.t. IO: it never persists by itself. It exposes
 * `getSnapshot()` so the caller (connection-controller) owns the single
 * persistence call. This keeps the file unit-testable with no DB and lets the
 * controller debounce/coalesce flushes.
 */

import type {
  AuthenticationState,
  SignalDataTypeMap,
  SignalKeyStore,
} from "baileys"
import type { AuthSnapshot, SignalKeyData } from "./creds-persistence.js"

export interface ManagedAuthState {
  /** The object handed to `makeWASocket({ auth })`. */
  state: AuthenticationState
  /** Current in-memory snapshot (creds + keys) for persistence. */
  getSnapshot(): AuthSnapshot
  /** Invoked whenever the key store mutates (so the caller can flush). */
  onKeysChanged(listener: () => void): void
}

/**
 * Build a `ManagedAuthState` from an existing snapshot.
 *
 * `creds` is held by reference: Baileys mutates the SAME `creds` object in
 * place and emits `creds.update`, so `getSnapshot().creds` always reflects the
 * latest. The key store is an in-memory map mirrored into `snapshot.keys`.
 */
export function buildManagedAuthState(
  snapshot: AuthSnapshot
): ManagedAuthState {
  const creds = snapshot.creds
  const keys: SignalKeyData = snapshot.keys ?? {}
  const keyListeners: Array<() => void> = []

  function emitKeysChanged(): void {
    for (const l of keyListeners) {
      try {
        l()
      } catch {
        /* listener errors must not break the key store */
      }
    }
  }

  const keyStore: SignalKeyStore = {
    get<T extends keyof SignalDataTypeMap>(
      type: T,
      ids: string[]
    ): { [id: string]: SignalDataTypeMap[T] } {
      const out: { [id: string]: SignalDataTypeMap[T] } = {}
      const bucket = keys[type] as
        | Record<string, SignalDataTypeMap[T]>
        | undefined
      if (bucket) {
        for (const id of ids) {
          const value = bucket[id]
          if (value !== undefined) {
            out[id] = value
          }
        }
      }
      return out
    },
    set(data): void {
      let mutated = false
      for (const typeKey of Object.keys(data) as Array<
        keyof SignalDataTypeMap
      >) {
        const incoming = data[typeKey]
        if (!incoming) continue
        const bucket =
          (keys[typeKey] as Record<string, unknown> | undefined) ?? {}
        for (const id of Object.keys(incoming)) {
          const value = (incoming as Record<string, unknown>)[id]
          if (value === null || value === undefined) {
            delete bucket[id]
          } else {
            bucket[id] = value
          }
          mutated = true
        }
        ;(keys as Record<string, unknown>)[typeKey as string] = bucket
      }
      if (mutated) emitKeysChanged()
    },
  }

  const state: AuthenticationState = { creds, keys: keyStore }

  return {
    state,
    getSnapshot: () => ({ creds, keys }),
    onKeysChanged: (listener) => {
      keyListeners.push(listener)
    },
  }
}
