/**
 * @deprecated Use ./connectors/weixin/qr-login.js directly.
 * This shim only exists so the controller's import paths can migrate
 * without a flag-day. Will be deleted in a follow-up commit.
 */

export {
  getWeixinQrLoginSessionOwner,
  startWeixinQrLoginSession,
  getWeixinQrLoginSession,
} from "./connectors/weixin/qr-login.js"
