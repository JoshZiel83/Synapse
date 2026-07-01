// Curated IM transport-connector metadata. The random mock filled `iconAssetPath`
// / `displayName` with lorem text, which then blew up `next/image` (an invalid
// src throws "Failed to construct 'URL'"). These are a small fixed set anyway, so
// we serve real display names + the real `/icon/<kind>.svg` assets that ship in
// public/icon/.
import type { TransportConnectorsResponseSchemaType } from "@synapse/shared/schemas"

type Connector = TransportConnectorsResponseSchemaType["connectors"][number]
type Kind = Connector["transportKind"]

const defs: Array<{ kind: Kind; name: string; group: boolean }> = [
  { kind: "weixin", name: "微信", group: true },
  { kind: "wecom", name: "企业微信", group: true },
  { kind: "feishu", name: "飞书", group: true },
  { kind: "dingtalk", name: "钉钉", group: true },
  { kind: "qq", name: "QQ", group: true },
  { kind: "telegram", name: "Telegram", group: true },
  { kind: "whatsapp", name: "WhatsApp", group: false },
  { kind: "whatsapp_unofficial", name: "WhatsApp（个人）", group: true },
]

export const designTransportConnectors: TransportConnectorsResponseSchemaType =
  {
    connectors: defs.map((d) => ({
      transportKind: d.kind,
      supportedConnectionModes: ["long_connection"],
      supportedEndpointTypes: ["direct", "group"],
      supportsDirectMessages: true,
      supportsGroupMessages: d.group,
      displayName: d.name,
      iconAssetPath: `/icon/${d.kind}.svg`,
    })),
  }
