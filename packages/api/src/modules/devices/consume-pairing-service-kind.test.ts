// R2/P2.3 — consumePairing must reject any non-device_runtime service kind.
// consumeLocalPairingTx ALWAYS writes 'device_runtime', so accepting a
// bare_dataplane consume (bare sandboxes direct-mint, they are not paired)
// would be a silent lie. The reject fires before any DB access, so this is a
// pure unit test with no withTestDb seam.

import test from "node:test"
import assert from "node:assert/strict"
import { consumePairing, DeviceModuleError } from "./service.js"

test("consumePairing rejects bare_dataplane with 400 service_kind_not_pairable", async () => {
  await assert.rejects(
    () =>
      consumePairing(
        {
          pairingCode: "code-abc",
          devicePubkey: "dpk",
          servicePubkey: "spk",
          serviceKind: "bare_dataplane",
        },
        { controlPlaneUrl: "http://localhost:3001" }
      ),
    (err: unknown) => {
      assert.ok(err instanceof DeviceModuleError, "throws DeviceModuleError")
      assert.equal(err.statusCode, 400)
      assert.equal(err.code, "service_kind_not_pairable")
      return true
    }
  )
})

test("consumePairing still rejects remote_agent_daemon (v1 daemon claim path)", async () => {
  await assert.rejects(
    () =>
      consumePairing(
        {
          pairingCode: "code-abc",
          devicePubkey: "dpk",
          servicePubkey: "spk",
          serviceKind: "remote_agent_daemon",
        },
        { controlPlaneUrl: "http://localhost:3001" }
      ),
    (err: unknown) => {
      assert.ok(err instanceof DeviceModuleError)
      assert.equal(err.statusCode, 400)
      assert.equal(err.code, "service_kind_not_pairable")
      return true
    }
  )
})
