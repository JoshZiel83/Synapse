import {
  WeixinQrSessionResponseSchema,
  WeixinBindingResponseSchema,
  WeixinBindingCandidatesResponseSchema,
  DingtalkDeviceFlowStartResponseSchema,
  DingtalkDeviceFlowPollResponseSchema,
  TransportAccountResponseSchema,
  TransportSessionResponseSchema,
  TransportExternalUserResponseSchema,
} from "@synapse/shared/schemas"
import { mock } from "../faker-setup"
import type { DesignHandlers } from "./_types"

// WeChat (QR-login transport + per-user binding) and DingTalk (device-flow +
// manual) account onboarding, plus the shared transport account/session/
// external-user mutations these IM connectors drive.
export const imWeixinDingtalkHandlers = {
  startWeixinQrTransportSession: async () =>
    mock(WeixinQrSessionResponseSchema),
  getWeixinQrTransportSession: async () => mock(WeixinQrSessionResponseSchema),
  submitWeixinQrTransportVerifyCode: async () =>
    mock(WeixinQrSessionResponseSchema),
  startDingtalkDeviceFlow: async () =>
    mock(DingtalkDeviceFlowStartResponseSchema),
  pollDingtalkDeviceFlow: async () =>
    mock(DingtalkDeviceFlowPollResponseSchema),
  createDingtalkAccountManual: async () => mock(TransportAccountResponseSchema),
  getCurrentUserWeixinBinding: async () => mock(WeixinBindingResponseSchema),
  getCurrentUserWeixinBindingCandidates: async () =>
    mock(WeixinBindingCandidatesResponseSchema),
  startCurrentUserWeixinBindingQr: async () =>
    mock(WeixinQrSessionResponseSchema),
  getCurrentUserWeixinBindingQr: async () =>
    mock(WeixinQrSessionResponseSchema),
  submitCurrentUserWeixinBindingVerifyCode: async () =>
    mock(WeixinQrSessionResponseSchema),
  linkCurrentUserWeixinBinding: async () => mock(WeixinBindingResponseSchema),
  setCurrentUserWeixinBindingAutoLink: async () =>
    mock(WeixinBindingResponseSchema),
  createTransportAccount: async () => mock(TransportAccountResponseSchema),
  updateTransportAccount: async () => mock(TransportAccountResponseSchema),
  updateTransportSessionSettings: async () =>
    mock(TransportSessionResponseSchema),
  setTransportExternalUserWorkspaceMember: async () =>
    mock(TransportExternalUserResponseSchema),
} satisfies DesignHandlers
