import {
  DeviceListViewSchema,
  DeviceDetailViewSchema,
  RuntimePairingTicketViewSchema,
  RuntimeServiceViewSchema,
  RuntimeAuthorizationGrantRecordViewSchema,
} from "@synapse/shared/schemas"
import { mock } from "../faker-setup"
import type { DesignHandlers } from "./_types"

// Devices + runtime-authorization: device list/detail, pairing-ticket issuance,
// remote-agent daemon claim, and the manual runtime-auth grant that backs the
// browser-tool "Manual grant required" Settings card. The void delete/detach
// mutations are skipped (no response body to fake) and ride the Proxy catch-all.
export const devicesRuntimeAuthHandlers = {
  listDevices: async () => mock(DeviceListViewSchema),
  getDevice: async () => mock(DeviceDetailViewSchema),
  startDevicePairingSession: async () => mock(RuntimePairingTicketViewSchema),
  claimRemoteAgentDaemon: async () => mock(RuntimeServiceViewSchema),
  createManualRuntimeAuthorizationGrant: async () =>
    mock(RuntimeAuthorizationGrantRecordViewSchema),
} satisfies DesignHandlers
