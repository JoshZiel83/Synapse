import {
  TransportAccountsResponseSchema,
  TransportSessionsResponseSchema,
  TransportExternalUsersResponseSchema,
  TransportAccountResponseSchema,
} from "@synapse/shared/schemas"
import { mock } from "../faker-setup"
import { designTransportConnectors } from "../fixtures/im"
import type { DesignHandlers } from "./_types"

// IM transport core: connector capabilities, accounts, sessions, external users,
// plus the per-kind account create/update mutations (feishu/wecom/qq/telegram/
// whatsapp), which all return `{ account: TransportAccountSummary }`. The
// whatsapp_unofficial login/guard methods return inline (non-schema) types and
// are left to the Proxy catch-all.
export const imCoreHandlers = {
  // Curated (real display names + real /icon/<kind>.svg) — random lorem here
  // crashed next/image in TransportKindIcon.
  getTransportConnectors: async () => designTransportConnectors,
  getTransportAccounts: async () => mock(TransportAccountsResponseSchema),
  getTransportSessions: async () => mock(TransportSessionsResponseSchema),
  getTransportExternalUsers: async () =>
    mock(TransportExternalUsersResponseSchema),
  createFeishuTransportAccount: async () =>
    mock(TransportAccountResponseSchema),
  updateFeishuTransportAccount: async () =>
    mock(TransportAccountResponseSchema),
  createWecomTransportAccount: async () => mock(TransportAccountResponseSchema),
  updateWecomTransportAccount: async () => mock(TransportAccountResponseSchema),
  createQqTransportAccount: async () => mock(TransportAccountResponseSchema),
  updateQqTransportAccount: async () => mock(TransportAccountResponseSchema),
  createTelegramTransportAccount: async () =>
    mock(TransportAccountResponseSchema),
  updateTelegramTransportAccount: async () =>
    mock(TransportAccountResponseSchema),
  createWhatsappTransportAccount: async () =>
    mock(TransportAccountResponseSchema),
  updateWhatsappTransportAccount: async () =>
    mock(TransportAccountResponseSchema),
} satisfies DesignHandlers
