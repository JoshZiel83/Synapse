"use client"

import Link from "next/link"
import Image from "next/image"
import QRCode from "qrcode"
import { useEffect, useMemo, useState } from "react"
import type {
  Actor,
  TransportAccountInboundActorMode,
  TransportAccountSummary,
  TransportConnectionMode,
  TransportAccountOwnerScope,
  TransportConversationInboundActorMode,
  TransportExternalUserSummary,
  TransportSessionSummary,
  WeixinQrLoginSessionSummary,
  WeixinQrLoginStatus,
  DingtalkDeviceFlowSessionSummary,
  DingtalkDeviceFlowStatus,
  DingtalkDeviceFlowStartResponse,
  TrustLevel,
} from "@synapse/shared"
import {
  DINGTALK_DEVICE_FLOW_STATUS,
  MODEL_GROUP_GRANT_SCOPE,
  WEIXIN_QR_LOGIN_STATUS,
  describeTransportKind,
} from "@synapse/shared"
import { useConnectorMetadata } from "@/lib/im-connector-metadata"
import {
  ArrowUpRight,
  Bot,
  Link2,
  MessageSquare,
  RefreshCw,
  ScanLine,
  Users,
} from "lucide-react"
import { toast } from "sonner"

import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { API_BASE, api, ApiError } from "@/lib/api"

import { createLogger } from "@/lib/client-logger"

const clientLog = createLogger("web.dashboard.im")

const WEIXIN_QR_POLLING_STATUSES = new Set<WeixinQrLoginStatus>([
  WEIXIN_QR_LOGIN_STATUS.WAITING,
  WEIXIN_QR_LOGIN_STATUS.SCANNED,
  WEIXIN_QR_LOGIN_STATUS.NEED_VERIFYCODE,
])

const DINGTALK_DEVICE_FLOW_MANUAL_FALLBACK_STATUSES =
  new Set<DingtalkDeviceFlowStatus>([
    DINGTALK_DEVICE_FLOW_STATUS.FAIL,
    DINGTALK_DEVICE_FLOW_STATUS.EXPIRED,
  ])

function isWeixinQrPollingStatus(
  status: WeixinQrLoginStatus | null | undefined
) {
  return status != null && WEIXIN_QR_POLLING_STATUSES.has(status)
}

function shouldShowDingtalkManualFallback(
  status: DingtalkDeviceFlowStatus | null | undefined
) {
  return (
    status != null && DINGTALK_DEVICE_FLOW_MANUAL_FALLBACK_STATUSES.has(status)
  )
}

type TransportAccountOwnerFormState = {
  ownerScope: TransportAccountOwnerScope
  ownerWorkspaceMemberId: string
  inboundActorMode: TransportAccountInboundActorMode
  inboundActorId: string
}

type FeishuFormState = TransportAccountOwnerFormState & {
  displayName: string
  appId: string
  appSecret: string
  connectionMode: TransportConnectionMode
  verificationToken: string
  encryptKey: string
}

type WeixinFormState = TransportAccountOwnerFormState & {
  displayName: string
  baseUrl: string
}

type WecomFormState = TransportAccountOwnerFormState & {
  displayName: string
  botId: string
  secret: string
  baseWsUrl: string
}

type DingtalkFormState = TransportAccountOwnerFormState & {
  displayName: string
  clientId: string
  clientSecret: string
}

type QqFormState = TransportAccountOwnerFormState & {
  displayName: string
  appId: string
  clientSecret: string
  botSecret: string
  connectionMode: TransportConnectionMode
  /**
   * OQ2 gate: webhook accounts ignore inbound message events until the
   * operator manually flips this to true after sandbox validation.
   * long_connection accounts ignore this field.
   */
  webhookInboundConfirmed: boolean
  /**
   * Legacy field — QQ proactive messaging API was discontinued 2025-04-21,
   * so toggling this has no runtime effect; kept for future revivals.
   */
  allowProactiveBestEffort: boolean
  /**
   * Allowlist of URL hostnames that may appear in outbound text. QQ
   * console must have these registered under "消息URL配置" or the send
   * will be rejected.
   */
  configuredUrlDomains: string
}

type WorkspaceDirectoryMember = {
  id: string
  userId: string
  userName?: string
  userEmail?: string
  avatarUrl?: string | null
  trustLevel?: TrustLevel
}

type WorkspaceActorOption = {
  actorId: string
  displayName: string
  title?: string
}

type SessionDraft = {
  outboundEnabled: boolean
  inboundActorMode: TransportConversationInboundActorMode
  inboundActorId: string
}

type AccountSettingsDraft = {
  ownerScope: TransportAccountOwnerScope
  ownerWorkspaceMemberId: string
  inboundActorMode: TransportAccountInboundActorMode
  inboundActorId: string
}

const UNASSIGNED_VALUE = "__none__"

const EMPTY_FEISHU_FORM: FeishuFormState = {
  displayName: "",
  appId: "",
  appSecret: "",
  ownerScope: "workspace",
  ownerWorkspaceMemberId: "",
  inboundActorMode: "none",
  inboundActorId: "",
  connectionMode: "webhook",
  verificationToken: "",
  encryptKey: "",
}

const EMPTY_WEIXIN_FORM: WeixinFormState = {
  displayName: "",
  baseUrl: "",
  ownerScope: "workspace",
  ownerWorkspaceMemberId: "",
  inboundActorMode: "none",
  inboundActorId: "",
}

const EMPTY_WECOM_FORM: WecomFormState = {
  displayName: "",
  botId: "",
  secret: "",
  baseWsUrl: "",
  ownerScope: "workspace",
  ownerWorkspaceMemberId: "",
  inboundActorMode: "none",
  inboundActorId: "",
}

const EMPTY_DINGTALK_FORM: DingtalkFormState = {
  displayName: "",
  clientId: "",
  clientSecret: "",
  ownerScope: "workspace",
  ownerWorkspaceMemberId: "",
  inboundActorMode: "none",
  inboundActorId: "",
}

const EMPTY_QQ_FORM: QqFormState = {
  displayName: "",
  appId: "",
  clientSecret: "",
  botSecret: "",
  ownerScope: "workspace",
  ownerWorkspaceMemberId: "",
  inboundActorMode: "none",
  inboundActorId: "",
  connectionMode: "long_connection",
  webhookInboundConfirmed: false,
  allowProactiveBestEffort: false,
  configuredUrlDomains: "",
}

function prettyTransportAccountOwnerScope(scope: TransportAccountOwnerScope) {
  return scope === MODEL_GROUP_GRANT_SCOPE.WORKSPACE
    ? "Workspace-owned"
    : "Member-owned"
}

function prettyEndpointType(endpointType: "direct" | "group") {
  return endpointType === "group" ? "Group chat" : "Direct chat"
}

function prettyConnectionMode(mode: TransportConnectionMode) {
  return mode === "webhook" ? "Webhook" : "Long connection"
}

function prettyAccountInboundActorMode(mode: TransportAccountInboundActorMode) {
  switch (mode) {
    case "follow_owner_chief_actor":
      return "Follow owner chief actor"
    case "specified_actor":
      return "Specific actor"
    default:
      return "No default actor"
  }
}

function prettySessionInboundActorMode(
  mode: TransportConversationInboundActorMode
) {
  switch (mode) {
    case "inherit_account":
      return "Follow binding setting"
    case "specified_actor":
      return "Specific actor"
    default:
      return "No default actor"
  }
}

function formatDateTime(value?: string) {
  if (!value) return "Never"
  try {
    return new Date(value).toLocaleString()
  } catch {
    return "Unknown"
  }
}

function buildWebhookUrl(account: TransportAccountSummary) {
  if (typeof window === "undefined") return ""
  try {
    const path = `${API_BASE}/im/webhooks/${account.transportKind}/${account.id}`
    return new URL(path, window.location.origin).toString()
  } catch {
    return ""
  }
}

function workspaceMemberLabel(member: WorkspaceDirectoryMember) {
  return member.userName || member.userEmail || member.userId
}

function actorOptionLabel(actor: WorkspaceActorOption) {
  return actor.title
    ? `${actor.displayName} · ${actor.title}`
    : actor.displayName
}

function transportAccountOwnerLabel(
  account: Pick<
    TransportAccountSummary,
    "ownerScope" | "ownerWorkspaceMemberId"
  >,
  workspaceMemberById: Map<string, WorkspaceDirectoryMember>,
  workspaceName?: string | null
) {
  if (account.ownerScope === "workspace") {
    return workspaceName || "Workspace"
  }
  const member = account.ownerWorkspaceMemberId
    ? workspaceMemberById.get(account.ownerWorkspaceMemberId)
    : undefined
  return member
    ? workspaceMemberLabel(member)
    : account.ownerWorkspaceMemberId || "Unknown member"
}

function transportAccountInboundActorLabel(
  account: Pick<
    TransportAccountSummary,
    "ownerScope" | "inboundActorMode" | "inboundActorId"
  >,
  actorById: Map<string, WorkspaceActorOption>
) {
  if (account.inboundActorMode === "specified_actor") {
    const actor = account.inboundActorId
      ? actorById.get(account.inboundActorId)
      : undefined
    return actor
      ? actorOptionLabel(actor)
      : account.inboundActorId || "Unknown actor"
  }
  return prettyAccountInboundActorMode(account.inboundActorMode)
}

function sessionInboundActorLabel(
  session: Pick<TransportSessionSummary, "inboundActorMode" | "inboundActorId">,
  actorById: Map<string, WorkspaceActorOption>
) {
  if (session.inboundActorMode === "specified_actor") {
    const actor = session.inboundActorId
      ? actorById.get(session.inboundActorId)
      : undefined
    return actor
      ? actorOptionLabel(actor)
      : session.inboundActorId || "Unknown actor"
  }
  return prettySessionInboundActorMode(session.inboundActorMode)
}

type TransportAccountOwnerFieldsProps = {
  idPrefix: string
  ownerScope: TransportAccountOwnerScope
  ownerWorkspaceMemberId: string
  workspaceMembers: WorkspaceDirectoryMember[]
  onOwnerScopeChange: (value: TransportAccountOwnerScope) => void
  onOwnerWorkspaceMemberIdChange: (value: string) => void
}

function TransportAccountOwnerFields({
  idPrefix,
  ownerScope,
  ownerWorkspaceMemberId,
  workspaceMembers,
  onOwnerScopeChange,
  onOwnerWorkspaceMemberIdChange,
}: TransportAccountOwnerFieldsProps) {
  return (
    <div className="space-y-4 rounded-2xl border bg-muted/20 p-4">
      <div className="grid gap-4 md:grid-cols-[14rem_minmax(0,1fr)]">
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-owner-scope`}>Account owner</Label>
          <Select
            value={ownerScope}
            onValueChange={(value) =>
              onOwnerScopeChange(value as TransportAccountOwnerScope)
            }
          >
            <SelectTrigger id={`${idPrefix}-owner-scope`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="workspace">Workspace</SelectItem>
              <SelectItem value="workspace_member">Workspace member</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {ownerScope === "workspace_member" ? (
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-owner-user`}>Owner member</Label>
            <Select
              value={ownerWorkspaceMemberId || UNASSIGNED_VALUE}
              onValueChange={(value) =>
                onOwnerWorkspaceMemberIdChange(
                  value === UNASSIGNED_VALUE ? "" : value
                )
              }
              disabled={workspaceMembers.length === 0}
            >
              <SelectTrigger id={`${idPrefix}-owner-user`}>
                <SelectValue placeholder="Select workspace member" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNASSIGNED_VALUE}>
                  Select workspace member
                </SelectItem>
                {workspaceMembers.map((member) => (
                  <SelectItem key={member.id} value={member.id}>
                    {workspaceMemberLabel(member)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </div>
      <div className="text-xs text-muted-foreground">
        Workspace-owned accounts are shared workspace infrastructure.
        Member-owned accounts keep the transport login bound to one workspace
        member while sessions still sync into workspace conversations.
      </div>
    </div>
  )
}

type TransportAccountInboundActorFieldsProps = {
  idPrefix: string
  ownerScope: TransportAccountOwnerScope
  inboundActorMode: TransportAccountInboundActorMode
  inboundActorId: string
  actors: WorkspaceActorOption[]
  onInboundActorModeChange: (value: TransportAccountInboundActorMode) => void
  onInboundActorIdChange: (value: string) => void
}

function TransportAccountInboundActorFields({
  idPrefix,
  ownerScope,
  inboundActorMode,
  inboundActorId,
  actors,
  onInboundActorModeChange,
  onInboundActorIdChange,
}: TransportAccountInboundActorFieldsProps) {
  return (
    <div className="space-y-4 rounded-2xl border bg-muted/20 p-4">
      <div className="grid gap-4 md:grid-cols-[16rem_minmax(0,1fr)]">
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-inbound-actor-mode`}>
            Inbound actor
          </Label>
          <Select
            value={inboundActorMode}
            onValueChange={(value) =>
              onInboundActorModeChange(
                value as TransportAccountInboundActorMode
              )
            }
          >
            <SelectTrigger id={`${idPrefix}-inbound-actor-mode`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No default actor</SelectItem>
              <SelectItem value="specified_actor">Specific actor</SelectItem>
              {ownerScope === "workspace_member" ? (
                <SelectItem value="follow_owner_chief_actor">
                  Follow owner chief actor
                </SelectItem>
              ) : null}
            </SelectContent>
          </Select>
        </div>

        {inboundActorMode === "specified_actor" ? (
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-inbound-actor-id`}>Actor</Label>
            <Select
              value={inboundActorId || UNASSIGNED_VALUE}
              onValueChange={(value) =>
                onInboundActorIdChange(value === UNASSIGNED_VALUE ? "" : value)
              }
              disabled={actors.length === 0}
            >
              <SelectTrigger id={`${idPrefix}-inbound-actor-id`}>
                <SelectValue placeholder="Select actor" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNASSIGNED_VALUE}>Select actor</SelectItem>
                {actors.map((actor) => (
                  <SelectItem key={actor.actorId} value={actor.actorId}>
                    {actorOptionLabel(actor)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </div>
    </div>
  )
}

type TransportSessionInboundActorFieldsProps = {
  sessionId: string
  draft: SessionDraft
  actors: WorkspaceActorOption[]
  disabled?: boolean
  onChange: (next: SessionDraft) => void
}

function TransportSessionInboundActorFields({
  sessionId,
  draft,
  actors,
  disabled,
  onChange,
}: TransportSessionInboundActorFieldsProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor={`session-inbound-actor-mode-${sessionId}`}>
        Inbound actor
      </Label>
      <Select
        value={draft.inboundActorMode}
        onValueChange={(value) =>
          onChange({
            ...draft,
            inboundActorMode: value as TransportConversationInboundActorMode,
            inboundActorId:
              value === "specified_actor" ? draft.inboundActorId : "",
          })
        }
        disabled={disabled}
      >
        <SelectTrigger id={`session-inbound-actor-mode-${sessionId}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="inherit_account">
            Follow binding setting
          </SelectItem>
          <SelectItem value="specified_actor">Specific actor</SelectItem>
          <SelectItem value="none">No default actor</SelectItem>
        </SelectContent>
      </Select>
      {draft.inboundActorMode === "specified_actor" ? (
        <Select
          value={draft.inboundActorId || UNASSIGNED_VALUE}
          onValueChange={(value) =>
            onChange({
              ...draft,
              inboundActorId: value === UNASSIGNED_VALUE ? "" : value,
            })
          }
          disabled={disabled || actors.length === 0}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select actor" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={UNASSIGNED_VALUE}>Select actor</SelectItem>
            {actors.map((actor) => (
              <SelectItem key={actor.actorId} value={actor.actorId}>
                {actorOptionLabel(actor)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
    </div>
  )
}

interface QqAccountConfigDraft {
  webhookInboundConfirmed: boolean
  configuredUrlDomains: string
}

function QqAccountConfigEditor({
  account,
  draft,
  saving,
  onChangeDraft,
  onSave,
}: {
  account: TransportAccountSummary
  draft: QqAccountConfigDraft | undefined
  saving: boolean
  onChangeDraft: (next: QqAccountConfigDraft) => void
  onSave: () => void
}) {
  // Lazy-init the draft from the live account when the user first
  // expands this row. We don't seed in state because the parent doesn't
  // know which accounts the user is currently viewing.
  const live: QqAccountConfigDraft = draft ?? {
    webhookInboundConfirmed:
      (account.config as Record<string, unknown> | undefined)
        ?.webhookInboundConfirmed === true,
    configuredUrlDomains: Array.isArray(
      (account.config as Record<string, unknown> | undefined)
        ?.configuredUrlDomains
    )
      ? (
          (account.config as Record<string, unknown>)
            .configuredUrlDomains as string[]
        ).join("\n")
      : "",
  }
  return (
    <div className="space-y-3 rounded-2xl border border-dashed bg-muted/20 p-4">
      <div className="text-xs font-medium text-foreground">
        QQ account config
      </div>
      {account.connectionMode === "webhook" ? (
        <Label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={live.webhookInboundConfirmed}
            onChange={(event) =>
              onChangeDraft({
                ...live,
                webhookInboundConfirmed: event.target.checked,
              })
            }
            className="size-4"
          />
          Webhook inbound confirmed (OQ2 verified)
        </Label>
      ) : null}
      <div className="space-y-1">
        <Label htmlFor={`qq-domains-${account.id}`}>
          Allowed URL domains (one per line)
        </Label>
        <textarea
          id={`qq-domains-${account.id}`}
          value={live.configuredUrlDomains}
          onChange={(event) =>
            onChangeDraft({
              ...live,
              configuredUrlDomains: event.target.value,
            })
          }
          className="min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm"
          placeholder={"dashboard.example.com\nlinks.example.com"}
        />
        <p className="text-xs text-muted-foreground">
          Must match QQ console &quot;消息URL配置&quot; entries. Wildcards and
          IPs are rejected by the server normalizer.
        </p>
      </div>
      <div className="flex justify-end">
        <Button size="sm" variant="outline" disabled={saving} onClick={onSave}>
          {saving ? "Saving..." : "Save QQ config"}
        </Button>
      </div>
    </div>
  )
}

export default function ImPage() {
  const { workspaceId, workspaceName } = useWorkspace()
  const connectorMetadata = useConnectorMetadata()
  // Resolve a transport label inside the component so we can read
  // the live connector metadata. Falls back to `describeTransportKind`
  // before the provider has loaded.
  const prettyTransportKind = (
    kind: TransportAccountSummary["transportKind"]
  ) => connectorMetadata?.get(kind)?.displayName ?? describeTransportKind(kind)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [creatingFeishu, setCreatingFeishu] = useState(false)
  const [creatingWeixin, setCreatingWeixin] = useState(false)
  const [creatingWecom, setCreatingWecom] = useState(false)
  const [savingAccountId, setSavingAccountId] = useState<string | null>(null)
  const [disconnectingAccountId, setDisconnectingAccountId] = useState<
    string | null
  >(null)
  const [savingSessionId, setSavingSessionId] = useState<string | null>(null)
  const [linkingAddressId, setLinkingAddressId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [accounts, setAccounts] = useState<TransportAccountSummary[]>([])
  const [sessions, setSessions] = useState<TransportSessionSummary[]>([])
  const [externalUsers, setExternalUsers] = useState<
    TransportExternalUserSummary[]
  >([])
  const [actors, setActors] = useState<Actor[]>([])
  const [workspaceMembers, setWorkspaceMembers] = useState<
    WorkspaceDirectoryMember[]
  >([])
  const [accountSettingsDrafts, setAccountSettingsDrafts] = useState<
    Record<string, AccountSettingsDraft>
  >({})
  const [sessionDrafts, setSessionDrafts] = useState<
    Record<string, SessionDraft>
  >({})
  const [externalUserDrafts, setExternalUserDrafts] = useState<
    Record<string, string>
  >({})
  const [feishuForm, setFeishuForm] =
    useState<FeishuFormState>(EMPTY_FEISHU_FORM)
  const [weixinForm, setWeixinForm] =
    useState<WeixinFormState>(EMPTY_WEIXIN_FORM)
  const [wecomForm, setWecomForm] = useState<WecomFormState>(EMPTY_WECOM_FORM)
  const [qqForm, setQqForm] = useState<QqFormState>(EMPTY_QQ_FORM)
  const [creatingQq, setCreatingQq] = useState(false)
  // Per-account QQ config edit drafts. Keyed by accountId; initialized
  // lazily from the loaded account so re-loads don't blow away pending
  // edits.
  const [qqConfigDrafts, setQqConfigDrafts] = useState<
    Record<
      string,
      {
        webhookInboundConfirmed: boolean
        configuredUrlDomains: string
      }
    >
  >({})
  const [savingQqConfigId, setSavingQqConfigId] = useState<string | null>(null)
  const [weixinSession, setWeixinSession] =
    useState<WeixinQrLoginSessionSummary | null>(null)
  const [weixinQrImageUrl, setWeixinQrImageUrl] = useState<string | null>(null)
  const [weixinVerifyCode, setWeixinVerifyCode] = useState("")
  const [submittingWeixinVerifyCode, setSubmittingWeixinVerifyCode] =
    useState(false)
  const [dingtalkForm, setDingtalkForm] =
    useState<DingtalkFormState>(EMPTY_DINGTALK_FORM)
  const [dingtalkSession, setDingtalkSession] =
    useState<DingtalkDeviceFlowSessionSummary | null>(null)
  const [dingtalkQrImageUrl, setDingtalkQrImageUrl] = useState<string | null>(
    null
  )
  // When the Device Flow start fails (providerStartFailed:true) or the
  // poll transitions to fail/expired, we flip this so the manual form
  // becomes the primary affordance.
  const [dingtalkManualMode, setDingtalkManualMode] = useState(false)
  const [dingtalkTransientError, setDingtalkTransientError] = useState<
    string | null
  >(null)
  const [creatingDingtalk, setCreatingDingtalk] = useState(false)
  const [creatingDingtalkManual, setCreatingDingtalkManual] = useState(false)

  const sortedWorkspaceMembers = useMemo(
    () =>
      [...workspaceMembers].sort((left, right) =>
        workspaceMemberLabel(left).localeCompare(workspaceMemberLabel(right))
      ),
    [workspaceMembers]
  )
  const workspaceMemberById = useMemo(
    () => new Map(workspaceMembers.map((member) => [member.id, member])),
    [workspaceMembers]
  )
  const actorOptions = useMemo<WorkspaceActorOption[]>(
    () =>
      actors
        .filter((actor) => actor.isActive)
        .map((actor) => ({
          actorId: actor.id,
          displayName:
            actor.displayName ||
            actor.definition.title ||
            actor.definition.role ||
            "Untitled actor",
          title: actor.definition.title || actor.definition.role,
        }))
        .sort((left, right) =>
          actorOptionLabel(left).localeCompare(actorOptionLabel(right))
        ),
    [actors]
  )
  const actorById = useMemo(
    () => new Map(actorOptions.map((actor) => [actor.actorId, actor])),
    [actorOptions]
  )

  useEffect(() => {
    let cancelled = false

    async function renderWeixinQr() {
      const qrTarget = weixinSession?.qrCodeUrl?.trim()
      if (!qrTarget) {
        setWeixinQrImageUrl(null)
        return
      }

      try {
        const imageUrl = await QRCode.toDataURL(qrTarget, {
          width: 288,
          margin: 1,
          color: {
            dark: "#111827",
            light: "#ffffff",
          },
        })
        if (!cancelled) {
          setWeixinQrImageUrl(imageUrl)
        }
      } catch (error) {
        clientLog.error("Failed to render WeChat QR image:", error)
        if (!cancelled) {
          setWeixinQrImageUrl(null)
        }
      }
    }

    void renderWeixinQr()

    return () => {
      cancelled = true
    }
  }, [weixinSession?.qrCodeUrl])

  useEffect(() => {
    let cancelled = false

    async function renderDingtalkQr() {
      const target = dingtalkSession?.verificationUriComplete?.trim()
      if (!target) {
        setDingtalkQrImageUrl(null)
        return
      }
      try {
        const imageUrl = await QRCode.toDataURL(target, {
          width: 288,
          margin: 1,
          color: { dark: "#111827", light: "#ffffff" },
        })
        if (!cancelled) {
          setDingtalkQrImageUrl(imageUrl)
        }
      } catch (error) {
        clientLog.error("Failed to render DingTalk QR image:", error)
        if (!cancelled) {
          setDingtalkQrImageUrl(null)
        }
      }
    }

    void renderDingtalkQr()
    return () => {
      cancelled = true
    }
  }, [dingtalkSession?.verificationUriComplete])

  function syncSessionDrafts(nextSessions: TransportSessionSummary[]) {
    setSessionDrafts(
      Object.fromEntries(
        nextSessions.map((session) => [
          session.id,
          {
            outboundEnabled: session.outboundEnabled,
            inboundActorMode: session.inboundActorMode,
            inboundActorId: session.inboundActorId || "",
          },
        ])
      )
    )
  }

  function syncAccountSettingsDrafts(nextAccounts: TransportAccountSummary[]) {
    setAccountSettingsDrafts(
      Object.fromEntries(
        nextAccounts.map((account) => [
          account.id,
          {
            ownerScope: account.ownerScope,
            ownerWorkspaceMemberId: account.ownerWorkspaceMemberId || "",
            inboundActorMode: account.inboundActorMode,
            inboundActorId: account.inboundActorId || "",
          },
        ])
      )
    )
  }

  function syncExternalUserDrafts(
    nextExternalUsers: TransportExternalUserSummary[]
  ) {
    setExternalUserDrafts(
      Object.fromEntries(
        nextExternalUsers.map((externalUser) => [
          externalUser.id,
          externalUser.linkedWorkspaceMemberId || UNASSIGNED_VALUE,
        ])
      )
    )
  }

  async function loadData(showSpinner = false) {
    if (!workspaceId) return
    if (showSpinner) {
      setRefreshing(true)
    } else {
      setLoading(true)
    }

    setError(null)
    try {
      const [
        accountsRes,
        sessionsRes,
        externalUsersRes,
        workspaceMembersRes,
        actorsRes,
      ] = await Promise.all([
        api.getTransportAccounts(workspaceId),
        api.getTransportSessions(workspaceId),
        api.getTransportExternalUsers(workspaceId),
        api.getWorkspaceMembers(workspaceId).catch((loadError) => {
          clientLog.error(
            "Failed to load workspace members for IM page:",
            loadError
          )
          return null
        }),
        api.getActors(workspaceId).catch((loadError) => {
          clientLog.error("Failed to load actors for IM page:", loadError)
          return []
        }),
      ])

      const nextAccounts = accountsRes?.accounts || []
      const nextSessions = sessionsRes?.sessions || []
      const nextExternalUsers = externalUsersRes?.externalUsers || []
      const nextWorkspaceMembers = Array.isArray(workspaceMembersRes)
        ? (workspaceMembersRes as WorkspaceDirectoryMember[])
        : []
      const nextActors = Array.isArray(actorsRes) ? (actorsRes as Actor[]) : []

      setAccounts(nextAccounts)
      setSessions(nextSessions)
      setExternalUsers(nextExternalUsers)
      setWorkspaceMembers(nextWorkspaceMembers)
      setActors(nextActors)
      syncAccountSettingsDrafts(nextAccounts)
      syncSessionDrafts(nextSessions)
      syncExternalUserDrafts(nextExternalUsers)
    } catch (loadError) {
      clientLog.error("Failed to load IM workspace state:", loadError)
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load IM workspace state"
      )
    } finally {
      setRefreshing(false)
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadData()
  }, [workspaceId])

  useEffect(() => {
    if (!workspaceId || !weixinSession) return
    const activeWorkspaceId = workspaceId
    const activeSessionId = weixinSession.sessionId
    if (!isWeixinQrPollingStatus(weixinSession.status)) {
      if (weixinSession.transportAccount) {
        void loadData(true)
      }
      return
    }

    let cancelled = false

    async function poll() {
      try {
        const result = await api.getWeixinQrTransportSession(
          activeWorkspaceId,
          activeSessionId
        )
        if (cancelled) return
        setWeixinSession(result?.session || null)
        if (result?.session?.transportAccount) {
          toast.success("WeChat account connected")
          await loadData(true)
          return
        }
        if (
          result?.session?.status === WEIXIN_QR_LOGIN_STATUS.EXPIRED ||
          result?.session?.status === WEIXIN_QR_LOGIN_STATUS.ERROR
        ) {
          return
        }
      } catch (pollError) {
        if (cancelled) return
        clientLog.error("Failed to poll WeChat QR session:", pollError)
        setError(
          pollError instanceof Error
            ? pollError.message
            : "Failed to poll WeChat QR session"
        )
        return
      }

      if (!cancelled) {
        setTimeout(() => {
          if (!cancelled) {
            void poll()
          }
        }, 1500)
      }
    }

    void poll()

    return () => {
      cancelled = true
    }
  }, [workspaceId, weixinSession])

  useEffect(() => {
    if (!workspaceId || !dingtalkSession) return
    const activeWorkspaceId = workspaceId
    const activeSessionId = dingtalkSession.sessionId
    const intervalSeconds = dingtalkSession.intervalSeconds || 5
    // Stop polling on terminal states. Reload accounts on success so the
    // newly-connected DingTalk row shows up in the bottom list.
    if (dingtalkSession.status !== DINGTALK_DEVICE_FLOW_STATUS.WAITING) {
      if (dingtalkSession.status === DINGTALK_DEVICE_FLOW_STATUS.SUCCESS) {
        void loadData(true)
      }
      if (shouldShowDingtalkManualFallback(dingtalkSession.status)) {
        setDingtalkManualMode(true)
      }
      return
    }

    let cancelled = false

    async function poll() {
      try {
        const result = await api.pollDingtalkDeviceFlow(
          activeWorkspaceId,
          activeSessionId
        )
        if (cancelled) return
        // Successful poll resets the transient error banner.
        setDingtalkTransientError(null)
        // Skip the setter when the payload is a no-op: the previous version
        // re-rendered the whole DingTalk Card (and re-rasterized the QR via
        // a downstream useEffect) on every interval, even when nothing
        // changed. Compare the user-visible fields directly.
        const next = result?.session ?? null
        setDingtalkSession((prev) => {
          if (
            prev?.sessionId === next?.sessionId &&
            prev?.status === next?.status &&
            prev?.message === next?.message &&
            prev?.userCode === next?.userCode &&
            prev?.verificationUriComplete === next?.verificationUriComplete &&
            prev?.transportAccount?.id === next?.transportAccount?.id
          ) {
            return prev
          }
          return next
        })
        if (result?.session?.transportAccount) {
          toast.success("DingTalk account connected")
          await loadData(true)
          return
        }
        if (shouldShowDingtalkManualFallback(result?.session?.status)) {
          setDingtalkManualMode(true)
          return
        }
      } catch (pollError) {
        if (cancelled) return
        // 502 is the controller's signal that the upstream registration
        // provider is having a transient hiccup — keep polling, just
        // surface a banner. Anything else (401/403/404/500) stops the
        // loop with an error so a misconfigured backend doesn't poll
        // forever.
        if (pollError instanceof ApiError && pollError.status === 502) {
          setDingtalkTransientError(
            pollError.message ||
              "Registration provider transient error, retrying..."
          )
          // fall through to schedule the next poll
        } else {
          clientLog.error("Failed to poll DingTalk Device Flow:", pollError)
          setError(
            pollError instanceof Error
              ? pollError.message
              : "Failed to poll DingTalk Device Flow"
          )
          return
        }
      }

      if (!cancelled) {
        setTimeout(() => {
          if (!cancelled) {
            void poll()
          }
        }, intervalSeconds * 1000)
      }
    }

    void poll()

    return () => {
      cancelled = true
    }
  }, [workspaceId, dingtalkSession])

  async function handleCreateFeishuAccount() {
    if (!workspaceId) return
    setCreatingFeishu(true)
    setError(null)
    if (
      feishuForm.ownerScope === "workspace_member" &&
      !feishuForm.ownerWorkspaceMemberId
    ) {
      setError("Select a workspace member owner for the Feishu account.")
      setCreatingFeishu(false)
      return
    }
    if (
      feishuForm.inboundActorMode === "specified_actor" &&
      !feishuForm.inboundActorId
    ) {
      setError("Select an actor for inbound routing.")
      setCreatingFeishu(false)
      return
    }
    try {
      const result = await api.createFeishuTransportAccount(workspaceId, {
        displayName: feishuForm.displayName.trim() || "Feishu Bot",
        appId: feishuForm.appId.trim(),
        appSecret: feishuForm.appSecret.trim(),
        ownerScope: feishuForm.ownerScope,
        ownerWorkspaceMemberId:
          feishuForm.ownerScope === "workspace_member"
            ? feishuForm.ownerWorkspaceMemberId
            : null,
        inboundActorMode: feishuForm.inboundActorMode,
        inboundActorId:
          feishuForm.inboundActorMode === "specified_actor"
            ? feishuForm.inboundActorId
            : null,
        connectionMode: feishuForm.connectionMode,
        verificationToken: feishuForm.verificationToken.trim() || undefined,
        encryptKey: feishuForm.encryptKey.trim() || undefined,
      })
      setFeishuForm((current) => ({
        ...EMPTY_FEISHU_FORM,
        connectionMode: current.connectionMode,
        ownerScope: current.ownerScope,
        ownerWorkspaceMemberId:
          current.ownerScope === "workspace_member"
            ? current.ownerWorkspaceMemberId
            : "",
        inboundActorMode:
          current.ownerScope === "workspace_member"
            ? current.inboundActorMode
            : current.inboundActorMode === "follow_owner_chief_actor"
              ? "none"
              : current.inboundActorMode,
        inboundActorId:
          current.inboundActorMode === "specified_actor"
            ? current.inboundActorId
            : "",
      }))
      await loadData(true)
      if (result?.account?.connectionMode === "webhook") {
        toast.success(
          "Feishu account created. Configure the callback URL next."
        )
      } else {
        toast.success("Feishu account created")
      }
    } catch (createError) {
      clientLog.error("Failed to create Feishu account:", createError)
      setError(
        createError instanceof Error
          ? createError.message
          : "Failed to create Feishu account"
      )
    } finally {
      setCreatingFeishu(false)
    }
  }

  async function handleCreateWecomAccount() {
    if (!workspaceId) return
    setCreatingWecom(true)
    setError(null)
    if (
      wecomForm.ownerScope === "workspace_member" &&
      !wecomForm.ownerWorkspaceMemberId
    ) {
      setError("Select a workspace member owner for the WeCom account.")
      setCreatingWecom(false)
      return
    }
    if (
      wecomForm.inboundActorMode === "specified_actor" &&
      !wecomForm.inboundActorId
    ) {
      setError("Select an actor for inbound routing.")
      setCreatingWecom(false)
      return
    }
    if (!wecomForm.botId.trim() || !wecomForm.secret.trim()) {
      setError("BotID and Secret are required for the WeCom account.")
      setCreatingWecom(false)
      return
    }
    try {
      await api.createWecomTransportAccount(workspaceId, {
        displayName: wecomForm.displayName.trim() || "WeCom Bot",
        botId: wecomForm.botId.trim(),
        secret: wecomForm.secret.trim(),
        baseWsUrl: wecomForm.baseWsUrl.trim() || undefined,
        ownerScope: wecomForm.ownerScope,
        ownerWorkspaceMemberId:
          wecomForm.ownerScope === "workspace_member"
            ? wecomForm.ownerWorkspaceMemberId
            : null,
        inboundActorMode: wecomForm.inboundActorMode,
        inboundActorId:
          wecomForm.inboundActorMode === "specified_actor"
            ? wecomForm.inboundActorId
            : null,
        connectionMode: "long_connection",
      })
      setWecomForm((current) => ({
        ...EMPTY_WECOM_FORM,
        ownerScope: current.ownerScope,
        ownerWorkspaceMemberId:
          current.ownerScope === "workspace_member"
            ? current.ownerWorkspaceMemberId
            : "",
        inboundActorMode:
          current.ownerScope === "workspace_member"
            ? current.inboundActorMode
            : current.inboundActorMode === "follow_owner_chief_actor"
              ? "none"
              : current.inboundActorMode,
        inboundActorId:
          current.inboundActorMode === "specified_actor"
            ? current.inboundActorId
            : "",
      }))
      await loadData(true)
      toast.success("WeCom account created")
    } catch (createError) {
      clientLog.error("Failed to create WeCom account:", createError)
      setError(
        createError instanceof Error
          ? createError.message
          : "Failed to create WeCom account"
      )
    } finally {
      setCreatingWecom(false)
    }
  }

  async function handleCreateQqAccount() {
    if (!workspaceId) return
    setCreatingQq(true)
    setError(null)
    if (!qqForm.appId.trim() || !qqForm.clientSecret.trim()) {
      setError("appId and clientSecret are required for QQ bot accounts.")
      setCreatingQq(false)
      return
    }
    if (
      qqForm.ownerScope === "workspace_member" &&
      !qqForm.ownerWorkspaceMemberId
    ) {
      setError("Select a workspace member owner for the QQ account.")
      setCreatingQq(false)
      return
    }
    if (
      qqForm.inboundActorMode === "specified_actor" &&
      !qqForm.inboundActorId
    ) {
      setError("Select an actor for inbound routing.")
      setCreatingQq(false)
      return
    }
    const configuredUrlDomains = qqForm.configuredUrlDomains
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean)
    try {
      const result = await api.createQqTransportAccount(workspaceId, {
        displayName: qqForm.displayName.trim() || "QQ Bot",
        appId: qqForm.appId.trim(),
        clientSecret: qqForm.clientSecret.trim(),
        botSecret: qqForm.botSecret.trim() || undefined,
        ownerScope: qqForm.ownerScope,
        ownerWorkspaceMemberId:
          qqForm.ownerScope === "workspace_member"
            ? qqForm.ownerWorkspaceMemberId
            : null,
        inboundActorMode: qqForm.inboundActorMode,
        inboundActorId:
          qqForm.inboundActorMode === "specified_actor"
            ? qqForm.inboundActorId
            : null,
        connectionMode: qqForm.connectionMode,
        webhookInboundConfirmed: qqForm.webhookInboundConfirmed,
        allowProactiveBestEffort: qqForm.allowProactiveBestEffort,
        configuredUrlDomains,
      })
      setQqForm((current) => ({
        ...EMPTY_QQ_FORM,
        connectionMode: current.connectionMode,
        ownerScope: current.ownerScope,
        ownerWorkspaceMemberId:
          current.ownerScope === "workspace_member"
            ? current.ownerWorkspaceMemberId
            : "",
        inboundActorMode:
          current.ownerScope === "workspace_member"
            ? current.inboundActorMode
            : current.inboundActorMode === "follow_owner_chief_actor"
              ? "none"
              : current.inboundActorMode,
        inboundActorId:
          current.inboundActorMode === "specified_actor"
            ? current.inboundActorId
            : "",
      }))
      await loadData(true)
      if (result?.account?.connectionMode === "webhook") {
        toast.success(
          "QQ account created. Configure the callback URL in QQ console next."
        )
      } else {
        toast.success("QQ account created")
      }
    } catch (createError) {
      clientLog.error("Failed to create QQ account:", createError)
      setError(
        createError instanceof Error
          ? createError.message
          : "Failed to create QQ account"
      )
    } finally {
      setCreatingQq(false)
    }
  }

  async function handleStartWeixinQr() {
    if (!workspaceId) return
    setCreatingWeixin(true)
    setError(null)
    if (
      weixinForm.ownerScope === "workspace_member" &&
      !weixinForm.ownerWorkspaceMemberId
    ) {
      setError("Select a workspace member owner for the WeChat account.")
      setCreatingWeixin(false)
      return
    }
    if (
      weixinForm.inboundActorMode === "specified_actor" &&
      !weixinForm.inboundActorId
    ) {
      setError("Select an actor for inbound routing.")
      setCreatingWeixin(false)
      return
    }
    try {
      const result = await api.startWeixinQrTransportSession(workspaceId, {
        displayName: weixinForm.displayName.trim() || undefined,
        baseUrl: weixinForm.baseUrl.trim() || undefined,
        ownerScope: weixinForm.ownerScope,
        ownerWorkspaceMemberId:
          weixinForm.ownerScope === "workspace_member"
            ? weixinForm.ownerWorkspaceMemberId
            : null,
        inboundActorMode: weixinForm.inboundActorMode,
        inboundActorId:
          weixinForm.inboundActorMode === "specified_actor"
            ? weixinForm.inboundActorId
            : null,
      })
      setWeixinSession(result?.session || null)
      toast.success("WeChat QR code ready")
    } catch (createError) {
      clientLog.error("Failed to start WeChat QR session:", createError)
      setError(
        createError instanceof Error
          ? createError.message
          : "Failed to start WeChat QR session"
      )
    } finally {
      setCreatingWeixin(false)
    }
  }

  async function handleSubmitWeixinVerifyCode() {
    if (!workspaceId || !weixinSession || !weixinVerifyCode.trim()) return
    setSubmittingWeixinVerifyCode(true)
    setError(null)
    try {
      const result = await api.submitWeixinQrTransportVerifyCode(
        workspaceId,
        weixinSession.sessionId,
        weixinVerifyCode.trim()
      )
      setWeixinSession(result?.session || null)
      setWeixinVerifyCode("")
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Failed to submit verification code"
      )
    } finally {
      setSubmittingWeixinVerifyCode(false)
    }
  }

  async function handleStartDingtalkDeviceFlow() {
    if (!workspaceId) return
    if (!dingtalkForm.displayName.trim()) {
      setError("Display name is required to start DingTalk registration.")
      return
    }
    if (
      dingtalkForm.ownerScope === "workspace_member" &&
      !dingtalkForm.ownerWorkspaceMemberId
    ) {
      setError("Select a workspace member owner for the DingTalk account.")
      return
    }
    if (
      dingtalkForm.inboundActorMode === "specified_actor" &&
      !dingtalkForm.inboundActorId
    ) {
      setError("Select an actor for inbound routing.")
      return
    }
    setCreatingDingtalk(true)
    setError(null)
    setDingtalkTransientError(null)
    try {
      const result: DingtalkDeviceFlowStartResponse =
        await api.startDingtalkDeviceFlow(workspaceId, {
          displayName: dingtalkForm.displayName.trim(),
          ownerScope: dingtalkForm.ownerScope,
          ownerWorkspaceMemberId:
            dingtalkForm.ownerScope === "workspace_member"
              ? dingtalkForm.ownerWorkspaceMemberId
              : null,
          inboundActorMode: dingtalkForm.inboundActorMode,
          inboundActorId:
            dingtalkForm.inboundActorMode === "specified_actor"
              ? dingtalkForm.inboundActorId
              : null,
        })
      if (result.providerStartFailed) {
        // Provider business/transient error during init/begin — switch
        // the UI to the manual form with an explanatory toast, no need
        // to throw or block the user.
        setDingtalkSession(null)
        setDingtalkManualMode(true)
        toast.warning(
          result.error
            ? `DingTalk Device Flow unavailable: ${result.error}`
            : "DingTalk Device Flow unavailable; please enter credentials manually."
        )
      } else {
        setDingtalkSession(result.session)
        setDingtalkManualMode(false)
        toast.success("DingTalk QR ready — scan with the DingTalk mobile app")
      }
    } catch (createError) {
      clientLog.error("Failed to start DingTalk Device Flow:", createError)
      setError(
        createError instanceof Error
          ? createError.message
          : "Failed to start DingTalk Device Flow"
      )
    } finally {
      setCreatingDingtalk(false)
    }
  }

  async function handleCreateDingtalkManual() {
    if (!workspaceId) return
    if (!dingtalkForm.clientId.trim() || !dingtalkForm.clientSecret.trim()) {
      setError("Both clientId and clientSecret are required.")
      return
    }
    if (!dingtalkForm.displayName.trim()) {
      setError("Display name is required for the manual DingTalk account.")
      return
    }
    if (
      dingtalkForm.ownerScope === "workspace_member" &&
      !dingtalkForm.ownerWorkspaceMemberId
    ) {
      setError("Select a workspace member owner for the DingTalk account.")
      return
    }
    if (
      dingtalkForm.inboundActorMode === "specified_actor" &&
      !dingtalkForm.inboundActorId
    ) {
      setError("Select an actor for inbound routing.")
      return
    }
    setCreatingDingtalkManual(true)
    setError(null)
    try {
      await api.createDingtalkAccountManual(workspaceId, {
        clientId: dingtalkForm.clientId.trim(),
        clientSecret: dingtalkForm.clientSecret.trim(),
        displayName: dingtalkForm.displayName.trim(),
        ownerScope: dingtalkForm.ownerScope,
        ownerWorkspaceMemberId:
          dingtalkForm.ownerScope === "workspace_member"
            ? dingtalkForm.ownerWorkspaceMemberId
            : null,
        inboundActorMode: dingtalkForm.inboundActorMode,
        inboundActorId:
          dingtalkForm.inboundActorMode === "specified_actor"
            ? dingtalkForm.inboundActorId
            : null,
      })
      toast.success("DingTalk account created")
      setDingtalkForm(EMPTY_DINGTALK_FORM)
      setDingtalkSession(null)
      setDingtalkManualMode(false)
      await loadData(true)
    } catch (createError) {
      clientLog.error(
        "Failed to create DingTalk account manually:",
        createError
      )
      setError(
        createError instanceof Error
          ? createError.message
          : "Failed to create DingTalk account"
      )
    } finally {
      setCreatingDingtalkManual(false)
    }
  }

  async function handleSaveSessionSettings(session: TransportSessionSummary) {
    if (!workspaceId) return
    const draft = sessionDrafts[session.id]
    if (!draft) return
    if (draft.inboundActorMode === "specified_actor" && !draft.inboundActorId) {
      setError("Select an actor for this session.")
      return
    }

    setSavingSessionId(session.id)
    setError(null)
    try {
      const result = await api.updateTransportSessionSettings(
        workspaceId,
        session.id,
        {
          outboundEnabled: draft.outboundEnabled,
          inboundActorMode: draft.inboundActorMode,
          inboundActorId:
            draft.inboundActorMode === "specified_actor"
              ? draft.inboundActorId
              : null,
        }
      )
      const updatedSession = result?.session
      if (updatedSession) {
        setSessions((current) =>
          current.map((entry) =>
            entry.id === updatedSession.id ? updatedSession : entry
          )
        )
        setSessionDrafts((current) => ({
          ...current,
          [session.id]: {
            outboundEnabled: updatedSession.outboundEnabled,
            inboundActorMode: updatedSession.inboundActorMode,
            inboundActorId: updatedSession.inboundActorId || "",
          },
        }))
      }
      toast.success("IM session settings saved")
    } catch (saveError) {
      clientLog.error("Failed to update IM session settings:", saveError)
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Failed to update IM session settings"
      )
    } finally {
      setSavingSessionId(null)
    }
  }

  async function handleSaveAccountSettings(account: TransportAccountSummary) {
    if (!workspaceId) return
    const draft = accountSettingsDrafts[account.id]
    if (!draft) return
    if (
      draft.ownerScope === "workspace_member" &&
      !draft.ownerWorkspaceMemberId
    ) {
      setError("Select a workspace member owner before saving the account.")
      return
    }
    if (draft.inboundActorMode === "specified_actor" && !draft.inboundActorId) {
      setError("Select an actor before saving the account.")
      return
    }

    setSavingAccountId(account.id)
    setError(null)
    try {
      const result = await api.updateTransportAccount(workspaceId, account.id, {
        ownerScope: draft.ownerScope,
        ownerWorkspaceMemberId:
          draft.ownerScope === "workspace_member"
            ? draft.ownerWorkspaceMemberId
            : null,
        inboundActorMode: draft.inboundActorMode,
        inboundActorId:
          draft.inboundActorMode === "specified_actor"
            ? draft.inboundActorId
            : null,
      })
      const updatedAccount = result?.account
      if (updatedAccount) {
        setAccounts((current) =>
          current.map((entry) =>
            entry.id === updatedAccount.id ? updatedAccount : entry
          )
        )
        setAccountSettingsDrafts((current) => ({
          ...current,
          [account.id]: {
            ownerScope: updatedAccount.ownerScope,
            ownerWorkspaceMemberId: updatedAccount.ownerWorkspaceMemberId || "",
            inboundActorMode: updatedAccount.inboundActorMode,
            inboundActorId: updatedAccount.inboundActorId || "",
          },
        }))
      }
      toast.success("Binding settings saved")
    } catch (saveError) {
      clientLog.error("Failed to update transport account settings:", saveError)
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Failed to update transport account settings"
      )
    } finally {
      setSavingAccountId(null)
    }
  }

  async function handleSaveQqConfig(account: TransportAccountSummary) {
    if (!workspaceId) return
    if (account.transportKind !== "qq") return
    const draft = qqConfigDrafts[account.id]
    if (!draft) return
    setSavingQqConfigId(account.id)
    setError(null)
    const configuredUrlDomains = draft.configuredUrlDomains
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean)
    try {
      const result = await api.updateQqTransportAccount(
        workspaceId,
        account.id,
        {
          webhookInboundConfirmed: draft.webhookInboundConfirmed,
          configuredUrlDomains,
        }
      )
      const updatedAccount = result?.account
      if (updatedAccount) {
        setAccounts((current) =>
          current.map((entry) =>
            entry.id === updatedAccount.id ? updatedAccount : entry
          )
        )
        // Reset the draft to match server-confirmed state so the
        // textarea reflects normalization (lowercasing, IDNA, etc.).
        const cfg = (updatedAccount.config || {}) as Record<string, unknown>
        setQqConfigDrafts((current) => ({
          ...current,
          [account.id]: {
            webhookInboundConfirmed: cfg.webhookInboundConfirmed === true,
            configuredUrlDomains: Array.isArray(cfg.configuredUrlDomains)
              ? (cfg.configuredUrlDomains as string[]).join("\n")
              : "",
          },
        }))
      }
      toast.success("QQ account config saved")
    } catch (saveError) {
      clientLog.error("Failed to update QQ account config:", saveError)
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Failed to update QQ account config"
      )
    } finally {
      setSavingQqConfigId(null)
    }
  }

  async function handleDisconnectAccount(account: TransportAccountSummary) {
    if (!workspaceId || account.status !== "active") return
    const confirmed = window.confirm(
      "Disconnect this account? It will stop receiving and sending new messages."
    )
    if (!confirmed) return

    setDisconnectingAccountId(account.id)
    setError(null)
    try {
      const result = await api.updateTransportAccount(workspaceId, account.id, {
        status: "disabled",
      })
      const updatedAccount = result?.account
      if (updatedAccount) {
        setAccounts((current) =>
          current.map((entry) =>
            entry.id === updatedAccount.id ? updatedAccount : entry
          )
        )
      }
      toast.success("Account disconnected")
    } catch (disconnectError) {
      clientLog.error(
        "Failed to disconnect transport account:",
        disconnectError
      )
      setError(
        disconnectError instanceof Error
          ? disconnectError.message
          : "Failed to disconnect transport account"
      )
    } finally {
      setDisconnectingAccountId(null)
    }
  }

  async function handleLinkExternalUser(
    addressId: string,
    workspaceMemberId: string
  ) {
    if (!workspaceId) return
    setLinkingAddressId(addressId)
    setError(null)
    try {
      const result = await api.setTransportExternalUserWorkspaceMember(
        workspaceId,
        addressId,
        workspaceMemberId === UNASSIGNED_VALUE ? null : workspaceMemberId
      )
      const updatedExternalUser = result?.externalUser
      if (updatedExternalUser) {
        setExternalUsers((current) =>
          current.map((entry) =>
            entry.id === updatedExternalUser.id ? updatedExternalUser : entry
          )
        )
        setExternalUserDrafts((current) => ({
          ...current,
          [addressId]:
            updatedExternalUser.linkedWorkspaceMemberId || UNASSIGNED_VALUE,
        }))
      }
      toast.success("External user mapping updated")
    } catch (linkError) {
      clientLog.error("Failed to update external user mapping:", linkError)
      setError(
        linkError instanceof Error
          ? linkError.message
          : "Failed to update external user mapping"
      )
    } finally {
      setLinkingAddressId(null)
    }
  }

  if (!workspaceId) {
    return (
      <div className="flex h-[60vh] items-center justify-center text-muted-foreground">
        No workspace selected.
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 lg:px-8">
      <Card className="overflow-hidden">
        <CardHeader className="border-b bg-muted/20">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <CardTitle className="text-2xl">IM</CardTitle>
              <CardDescription className="mt-1 max-w-3xl">
                Connect Feishu, WeChat, and WeCom as shared workspace accounts
                or bind the login to a specific workspace member. Each external
                direct chat or group chat still creates its own workspace
                conversation automatically. Session routing and address
                ownership mapping are managed here, not in the chat page.
              </CardDescription>
            </div>
            <Button
              variant="outline"
              onClick={() => void loadData(true)}
              disabled={refreshing}
            >
              {refreshing ? (
                <RefreshCw className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3 px-6 py-5 text-sm text-muted-foreground md:grid-cols-4">
          <div>
            <div className="font-medium text-foreground">Workspace</div>
            <div>{workspaceName || workspaceId}</div>
          </div>
          <div>
            <div className="font-medium text-foreground">Accounts</div>
            <div>{accounts.length}</div>
          </div>
          <div>
            <div className="font-medium text-foreground">Sessions</div>
            <div>{sessions.length}</div>
          </div>
          <div>
            <div className="font-medium text-foreground">Addresses</div>
            <div>{externalUsers.length}</div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bot className="size-4" />
              Add Feishu App Bot
            </CardTitle>
            <CardDescription>
              Enter app credentials directly. Choose whether this transport
              account is workspace-owned or member-owned. For webhook mode,
              Synapse generates the callback URL after the account is created.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="feishu-display-name">Display name</Label>
                <Input
                  id="feishu-display-name"
                  value={feishuForm.displayName}
                  onChange={(event) =>
                    setFeishuForm((current) => ({
                      ...current,
                      displayName: event.target.value,
                    }))
                  }
                  placeholder="Customer Support Bot"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="feishu-connection-mode">Connection mode</Label>
                <Select
                  value={feishuForm.connectionMode}
                  onValueChange={(value) =>
                    setFeishuForm((current) => ({
                      ...current,
                      connectionMode: value as TransportConnectionMode,
                    }))
                  }
                >
                  <SelectTrigger id="feishu-connection-mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="webhook">Webhook</SelectItem>
                    <SelectItem value="long_connection">
                      Long connection
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="feishu-app-id">App ID</Label>
                <Input
                  id="feishu-app-id"
                  value={feishuForm.appId}
                  onChange={(event) =>
                    setFeishuForm((current) => ({
                      ...current,
                      appId: event.target.value,
                    }))
                  }
                  placeholder="cli_xxxxxxxxx"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="feishu-app-secret">App Secret</Label>
                <Input
                  id="feishu-app-secret"
                  type="password"
                  value={feishuForm.appSecret}
                  onChange={(event) =>
                    setFeishuForm((current) => ({
                      ...current,
                      appSecret: event.target.value,
                    }))
                  }
                  placeholder="Enter App Secret"
                />
              </div>
            </div>

            {feishuForm.connectionMode === "webhook" ? (
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="feishu-verification-token">
                    Verification token
                  </Label>
                  <Input
                    id="feishu-verification-token"
                    value={feishuForm.verificationToken}
                    onChange={(event) =>
                      setFeishuForm((current) => ({
                        ...current,
                        verificationToken: event.target.value,
                      }))
                    }
                    placeholder="verification token"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="feishu-encrypt-key">Encrypt key</Label>
                  <Input
                    id="feishu-encrypt-key"
                    type="password"
                    value={feishuForm.encryptKey}
                    onChange={(event) =>
                      setFeishuForm((current) => ({
                        ...current,
                        encryptKey: event.target.value,
                      }))
                    }
                    placeholder="encrypt key"
                  />
                </div>
              </div>
            ) : null}

            <TransportAccountOwnerFields
              idPrefix="feishu"
              ownerScope={feishuForm.ownerScope}
              ownerWorkspaceMemberId={feishuForm.ownerWorkspaceMemberId}
              workspaceMembers={sortedWorkspaceMembers}
              onOwnerScopeChange={(value) =>
                setFeishuForm((current) => ({
                  ...current,
                  ownerScope: value,
                  ownerWorkspaceMemberId:
                    value === "workspace" ? "" : current.ownerWorkspaceMemberId,
                  inboundActorMode:
                    value === "workspace" &&
                    current.inboundActorMode === "follow_owner_chief_actor"
                      ? "none"
                      : current.inboundActorMode,
                }))
              }
              onOwnerWorkspaceMemberIdChange={(value) =>
                setFeishuForm((current) => ({
                  ...current,
                  ownerWorkspaceMemberId: value,
                }))
              }
            />

            <TransportAccountInboundActorFields
              idPrefix="feishu"
              ownerScope={feishuForm.ownerScope}
              inboundActorMode={feishuForm.inboundActorMode}
              inboundActorId={feishuForm.inboundActorId}
              actors={actorOptions}
              onInboundActorModeChange={(value) =>
                setFeishuForm((current) => ({
                  ...current,
                  inboundActorMode: value,
                  inboundActorId:
                    value === "specified_actor" ? current.inboundActorId : "",
                }))
              }
              onInboundActorIdChange={(value) =>
                setFeishuForm((current) => ({
                  ...current,
                  inboundActorId: value,
                }))
              }
            />

            <div className="flex justify-end">
              <Button
                onClick={() => void handleCreateFeishuAccount()}
                disabled={creatingFeishu}
              >
                {creatingFeishu ? "Creating..." : "Create Feishu account"}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bot className="size-4" />
              Add WeCom AI Bot (long connection)
            </CardTitle>
            <CardDescription>
              Enter the smart-bot BotID and Secret from the WeCom admin console
              (API mode &gt; long connection). Synapse opens a persistent
              WebSocket to wss://openws.work.weixin.qq.com — no public callback
              URL required. v1 supports text and markdown only; image / file /
              template_card are out of scope.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="wecom-display-name">Display name</Label>
                <Input
                  id="wecom-display-name"
                  value={wecomForm.displayName}
                  onChange={(event) =>
                    setWecomForm((current) => ({
                      ...current,
                      displayName: event.target.value,
                    }))
                  }
                  placeholder="WeCom AI Bot"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="wecom-base-ws-url">
                  Base WSS URL (optional)
                </Label>
                <Input
                  id="wecom-base-ws-url"
                  value={wecomForm.baseWsUrl}
                  onChange={(event) =>
                    setWecomForm((current) => ({
                      ...current,
                      baseWsUrl: event.target.value,
                    }))
                  }
                  placeholder="wss://openws.work.weixin.qq.com"
                />
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="wecom-bot-id">BotID</Label>
                <Input
                  id="wecom-bot-id"
                  value={wecomForm.botId}
                  onChange={(event) =>
                    setWecomForm((current) => ({
                      ...current,
                      botId: event.target.value,
                    }))
                  }
                  placeholder="bot id from WeCom admin"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="wecom-secret">Secret</Label>
                <Input
                  id="wecom-secret"
                  type="password"
                  value={wecomForm.secret}
                  onChange={(event) =>
                    setWecomForm((current) => ({
                      ...current,
                      secret: event.target.value,
                    }))
                  }
                  placeholder="bot secret"
                />
              </div>
            </div>

            <TransportAccountOwnerFields
              idPrefix="wecom"
              ownerScope={wecomForm.ownerScope}
              ownerWorkspaceMemberId={wecomForm.ownerWorkspaceMemberId}
              workspaceMembers={sortedWorkspaceMembers}
              onOwnerScopeChange={(value) =>
                setWecomForm((current) => ({
                  ...current,
                  ownerScope: value,
                  ownerWorkspaceMemberId:
                    value === "workspace" ? "" : current.ownerWorkspaceMemberId,
                  inboundActorMode:
                    value === "workspace" &&
                    current.inboundActorMode === "follow_owner_chief_actor"
                      ? "none"
                      : current.inboundActorMode,
                }))
              }
              onOwnerWorkspaceMemberIdChange={(value) =>
                setWecomForm((current) => ({
                  ...current,
                  ownerWorkspaceMemberId: value,
                }))
              }
            />

            <TransportAccountInboundActorFields
              idPrefix="wecom"
              ownerScope={wecomForm.ownerScope}
              inboundActorMode={wecomForm.inboundActorMode}
              inboundActorId={wecomForm.inboundActorId}
              actors={actorOptions}
              onInboundActorModeChange={(value) =>
                setWecomForm((current) => ({
                  ...current,
                  inboundActorMode: value,
                  inboundActorId:
                    value === "specified_actor" ? current.inboundActorId : "",
                }))
              }
              onInboundActorIdChange={(value) =>
                setWecomForm((current) => ({
                  ...current,
                  inboundActorId: value,
                }))
              }
            />

            <div className="flex justify-end">
              <Button
                onClick={() => void handleCreateWecomAccount()}
                disabled={creatingWecom}
              >
                {creatingWecom ? "Creating..." : "Create WeCom account"}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ScanLine className="size-4" />
              Connect WeChat via QR
            </CardTitle>
            <CardDescription>
              Start a QR session, scan with WeChat, and Synapse stores the bot
              token automatically after confirmation. The connected login can be
              owned by the workspace or by a specific workspace member.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="weixin-display-name">Display name</Label>
              <Input
                id="weixin-display-name"
                value={weixinForm.displayName}
                onChange={(event) =>
                  setWeixinForm((current) => ({
                    ...current,
                    displayName: event.target.value,
                  }))
                }
                placeholder="Sales WeChat Bot"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="weixin-base-url">Base URL (optional)</Label>
              <Input
                id="weixin-base-url"
                value={weixinForm.baseUrl}
                onChange={(event) =>
                  setWeixinForm((current) => ({
                    ...current,
                    baseUrl: event.target.value,
                  }))
                }
                placeholder="https://ilinkai.weixin.qq.com"
              />
            </div>

            <TransportAccountOwnerFields
              idPrefix="weixin"
              ownerScope={weixinForm.ownerScope}
              ownerWorkspaceMemberId={weixinForm.ownerWorkspaceMemberId}
              workspaceMembers={sortedWorkspaceMembers}
              onOwnerScopeChange={(value) =>
                setWeixinForm((current) => ({
                  ...current,
                  ownerScope: value,
                  ownerWorkspaceMemberId:
                    value === "workspace" ? "" : current.ownerWorkspaceMemberId,
                  inboundActorMode:
                    value === "workspace" &&
                    current.inboundActorMode === "follow_owner_chief_actor"
                      ? "none"
                      : current.inboundActorMode,
                }))
              }
              onOwnerWorkspaceMemberIdChange={(value) =>
                setWeixinForm((current) => ({
                  ...current,
                  ownerWorkspaceMemberId: value,
                }))
              }
            />

            <TransportAccountInboundActorFields
              idPrefix="weixin"
              ownerScope={weixinForm.ownerScope}
              inboundActorMode={weixinForm.inboundActorMode}
              inboundActorId={weixinForm.inboundActorId}
              actors={actorOptions}
              onInboundActorModeChange={(value) =>
                setWeixinForm((current) => ({
                  ...current,
                  inboundActorMode: value,
                  inboundActorId:
                    value === "specified_actor" ? current.inboundActorId : "",
                }))
              }
              onInboundActorIdChange={(value) =>
                setWeixinForm((current) => ({
                  ...current,
                  inboundActorId: value,
                }))
              }
            />

            <Button
              className="w-full"
              onClick={() => void handleStartWeixinQr()}
              disabled={creatingWeixin}
            >
              {creatingWeixin ? "Generating QR..." : "Generate WeChat QR"}
            </Button>

            {weixinSession ? (
              <div className="space-y-3 rounded-2xl border bg-muted/20 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-foreground">
                      QR session
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Status: {weixinSession.status}
                    </div>
                  </div>
                  <Badge variant="outline">{weixinSession.status}</Badge>
                </div>

                {weixinQrImageUrl ? (
                  <div className="overflow-hidden rounded-2xl border bg-white p-3">
                    <Image
                      src={weixinQrImageUrl}
                      alt="WeChat QR"
                      width={288}
                      height={288}
                      unoptimized
                      className="mx-auto max-h-72 w-full max-w-72 rounded-xl object-contain"
                    />
                  </div>
                ) : null}

                <div className="text-sm text-muted-foreground">
                  {weixinSession.message}
                </div>
                {weixinSession.status ===
                WEIXIN_QR_LOGIN_STATUS.NEED_VERIFYCODE ? (
                  <div className="flex gap-2">
                    <Input
                      value={weixinVerifyCode}
                      onChange={(event) =>
                        setWeixinVerifyCode(event.target.value)
                      }
                      placeholder="Verification code"
                      inputMode="numeric"
                      disabled={submittingWeixinVerifyCode}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          void handleSubmitWeixinVerifyCode()
                        }
                      }}
                    />
                    <Button
                      onClick={() => void handleSubmitWeixinVerifyCode()}
                      disabled={
                        submittingWeixinVerifyCode || !weixinVerifyCode.trim()
                      }
                    >
                      Submit
                    </Button>
                  </div>
                ) : null}
                <div className="text-xs text-muted-foreground">
                  Expires: {formatDateTime(weixinSession.expiresAt)}
                </div>
                {weixinSession.transportAccount ? (
                  <div className="rounded-xl bg-background px-3 py-3 text-sm">
                    Connected account:{" "}
                    <span className="font-medium text-foreground">
                      {weixinSession.transportAccount.displayName}
                    </span>
                  </div>
                ) : null}
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Add DingTalk Bot</CardTitle>
          <CardDescription>
            Connect a DingTalk enterprise robot via Stream mode. The default
            flow uses the scan-to-authorize Device Flow; if the registration
            provider is unavailable, the form falls back to manual entry of
            AppKey + AppSecret.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="dingtalk-display-name">Display name</Label>
              <Input
                id="dingtalk-display-name"
                placeholder="DingTalk Bot"
                value={dingtalkForm.displayName}
                onChange={(event) =>
                  setDingtalkForm((current) => ({
                    ...current,
                    displayName: event.target.value,
                  }))
                }
              />
            </div>
          </div>
          <TransportAccountOwnerFields
            idPrefix="dingtalk"
            ownerScope={dingtalkForm.ownerScope}
            ownerWorkspaceMemberId={dingtalkForm.ownerWorkspaceMemberId}
            workspaceMembers={sortedWorkspaceMembers}
            onOwnerScopeChange={(value) =>
              setDingtalkForm((current) => ({
                ...current,
                ownerScope: value,
                ownerWorkspaceMemberId:
                  value === "workspace" ? "" : current.ownerWorkspaceMemberId,
                // The backend rejects `follow_owner_chief_actor` for
                // workspace-owned accounts (controller/_shared.ts:132).
                // Mirror the Feishu/Weixin flow: reset to "none" when the
                // owner switches back so the user doesn't submit a stale
                // combination that fails 400.
                inboundActorMode:
                  value === "workspace" &&
                  current.inboundActorMode === "follow_owner_chief_actor"
                    ? "none"
                    : current.inboundActorMode,
              }))
            }
            onOwnerWorkspaceMemberIdChange={(value) =>
              setDingtalkForm((current) => ({
                ...current,
                ownerWorkspaceMemberId: value,
              }))
            }
          />

          <TransportAccountInboundActorFields
            idPrefix="dingtalk"
            ownerScope={dingtalkForm.ownerScope}
            inboundActorMode={dingtalkForm.inboundActorMode}
            inboundActorId={dingtalkForm.inboundActorId}
            actors={actorOptions}
            onInboundActorModeChange={(value) =>
              setDingtalkForm((current) => ({
                ...current,
                inboundActorMode: value,
                inboundActorId:
                  value === "specified_actor" ? current.inboundActorId : "",
              }))
            }
            onInboundActorIdChange={(value) =>
              setDingtalkForm((current) => ({
                ...current,
                inboundActorId: value,
              }))
            }
          />

          {dingtalkManualMode ? (
            <div className="space-y-3 rounded-2xl border border-amber-200 bg-amber-50/50 p-4 dark:border-amber-900/50 dark:bg-amber-950/20">
              <div className="text-sm font-medium text-foreground">
                Manual AppKey / AppSecret
              </div>
              <div className="text-xs text-muted-foreground">
                Paste the credentials from the DingTalk Open Platform (Developer
                Console → your app → Credentials).
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="dingtalk-client-id">Client ID (AppKey)</Label>
                  <Input
                    id="dingtalk-client-id"
                    placeholder="dingxxxxxxxxxxxxxxxx"
                    value={dingtalkForm.clientId}
                    onChange={(event) =>
                      setDingtalkForm((current) => ({
                        ...current,
                        clientId: event.target.value,
                      }))
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="dingtalk-client-secret">
                    Client Secret (AppSecret)
                  </Label>
                  <Input
                    id="dingtalk-client-secret"
                    type="password"
                    placeholder="•••••••••••••••"
                    value={dingtalkForm.clientSecret}
                    onChange={(event) =>
                      setDingtalkForm((current) => ({
                        ...current,
                        clientSecret: event.target.value,
                      }))
                    }
                  />
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => void handleCreateDingtalkManual()}
                  disabled={creatingDingtalkManual}
                >
                  {creatingDingtalkManual
                    ? "Saving..."
                    : "Create DingTalk account"}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setDingtalkManualMode(false)
                    setDingtalkSession(null)
                    setDingtalkTransientError(null)
                  }}
                  disabled={creatingDingtalkManual}
                >
                  Back to scan
                </Button>
              </div>
            </div>
          ) : (
            <Button
              onClick={() => void handleStartDingtalkDeviceFlow()}
              disabled={creatingDingtalk}
            >
              {creatingDingtalk
                ? "Starting..."
                : "Scan to register DingTalk bot"}
            </Button>
          )}

          {dingtalkSession ? (
            <div className="space-y-3 rounded-2xl border bg-muted/20 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-foreground">
                    Device Flow session
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Status: {dingtalkSession.status}
                  </div>
                </div>
                <Badge variant="outline">{dingtalkSession.status}</Badge>
              </div>

              {dingtalkQrImageUrl ? (
                <div className="overflow-hidden rounded-2xl border bg-white p-3">
                  <Image
                    src={dingtalkQrImageUrl}
                    alt="DingTalk authorize QR"
                    width={288}
                    height={288}
                    unoptimized
                    className="mx-auto max-h-72 w-full max-w-72 rounded-xl object-contain"
                  />
                </div>
              ) : null}

              {dingtalkSession.userCode ? (
                <div className="rounded-xl bg-background px-3 py-2 text-sm">
                  User code:{" "}
                  <span className="font-mono font-semibold tracking-wide">
                    {dingtalkSession.userCode}
                  </span>
                </div>
              ) : null}

              {dingtalkSession.message ? (
                <div className="text-sm text-muted-foreground">
                  {dingtalkSession.message}
                </div>
              ) : null}

              {dingtalkTransientError ? (
                <div className="text-xs text-amber-600 dark:text-amber-400">
                  {dingtalkTransientError}
                </div>
              ) : null}

              <div className="text-xs text-muted-foreground">
                Expires: {formatDateTime(dingtalkSession.expiresAt)}
              </div>

              {dingtalkSession.transportAccount ? (
                <div className="rounded-xl bg-background px-3 py-3 text-sm">
                  Connected account:{" "}
                  <span className="font-medium text-foreground">
                    {dingtalkSession.transportAccount.displayName}
                  </span>
                </div>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bot className="size-4" />
            Add QQ Bot
          </CardTitle>
          <CardDescription>
            Connect a QQ official bot via webhook or long connection. Long
            connection is recommended for v1 — webhook needs the operator to
            confirm that QQ actually delivers C2C / GROUP_AT events before
            inbound messages are accepted.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="qq-display-name">Display name</Label>
              <Input
                id="qq-display-name"
                value={qqForm.displayName}
                onChange={(event) =>
                  setQqForm((current) => ({
                    ...current,
                    displayName: event.target.value,
                  }))
                }
                placeholder="QQ Customer Bot"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="qq-connection-mode">Connection mode</Label>
              <Select
                value={qqForm.connectionMode}
                onValueChange={(value) =>
                  setQqForm((current) => ({
                    ...current,
                    connectionMode: value as TransportConnectionMode,
                  }))
                }
              >
                <SelectTrigger id="qq-connection-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="long_connection">
                    Long connection (recommended)
                  </SelectItem>
                  <SelectItem value="webhook">Webhook</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="qq-app-id">App ID</Label>
              <Input
                id="qq-app-id"
                value={qqForm.appId}
                onChange={(event) =>
                  setQqForm((current) => ({
                    ...current,
                    appId: event.target.value,
                  }))
                }
                placeholder="102000000"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="qq-client-secret">Client secret</Label>
              <Input
                id="qq-client-secret"
                type="password"
                value={qqForm.clientSecret}
                onChange={(event) =>
                  setQqForm((current) => ({
                    ...current,
                    clientSecret: event.target.value,
                  }))
                }
                placeholder="QQ console clientSecret"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="qq-bot-secret">
              Bot secret (optional, for webhook Ed25519)
            </Label>
            <Input
              id="qq-bot-secret"
              type="password"
              value={qqForm.botSecret}
              onChange={(event) =>
                setQqForm((current) => ({
                  ...current,
                  botSecret: event.target.value,
                }))
              }
              placeholder="Falls back to clientSecret if empty"
            />
            <p className="text-xs text-muted-foreground">
              QQ webhooks sign payloads with an Ed25519 seed derived from the
              bot secret. Leave empty unless the QQ console exposes a separate
              botSecret distinct from clientSecret.
            </p>
          </div>

          {qqForm.connectionMode === "webhook" ? (
            <div className="space-y-2 rounded-2xl border border-dashed bg-muted/20 p-4">
              <Label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={qqForm.webhookInboundConfirmed}
                  onChange={(event) =>
                    setQqForm((current) => ({
                      ...current,
                      webhookInboundConfirmed: event.target.checked,
                    }))
                  }
                  className="size-4"
                />
                I confirmed that QQ webhook delivers C2C / GROUP_AT message
                events for this account (OQ2 verified).
              </Label>
              <p className="text-xs text-muted-foreground">
                If unchecked: this account&apos;s bindings default to outbound
                disabled and inbound messages are dropped. Long connection mode
                ignores this gate.
              </p>
            </div>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="qq-url-domains">
              Allowed URL domains (one per line)
            </Label>
            <textarea
              id="qq-url-domains"
              value={qqForm.configuredUrlDomains}
              onChange={(event) =>
                setQqForm((current) => ({
                  ...current,
                  configuredUrlDomains: event.target.value,
                }))
              }
              placeholder={"dashboard.example.com\nlinks.example.com"}
              className="min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Must match domains registered under QQ console &quot;消息URL
              配置&quot;. Any unlisted hostname in an outbound message will fail
              locally (no quota consumed). Wildcards and IPs are rejected.
            </p>
          </div>

          <TransportAccountOwnerFields
            idPrefix="qq"
            ownerScope={qqForm.ownerScope}
            ownerWorkspaceMemberId={qqForm.ownerWorkspaceMemberId}
            workspaceMembers={sortedWorkspaceMembers}
            onOwnerScopeChange={(value) =>
              setQqForm((current) => ({
                ...current,
                ownerScope: value,
                ownerWorkspaceMemberId:
                  value === "workspace" ? "" : current.ownerWorkspaceMemberId,
                inboundActorMode:
                  value === "workspace" &&
                  current.inboundActorMode === "follow_owner_chief_actor"
                    ? "none"
                    : current.inboundActorMode,
              }))
            }
            onOwnerWorkspaceMemberIdChange={(value) =>
              setQqForm((current) => ({
                ...current,
                ownerWorkspaceMemberId: value,
              }))
            }
          />

          <TransportAccountInboundActorFields
            idPrefix="qq"
            ownerScope={qqForm.ownerScope}
            inboundActorMode={qqForm.inboundActorMode}
            inboundActorId={qqForm.inboundActorId}
            actors={actorOptions}
            onInboundActorModeChange={(value) =>
              setQqForm((current) => ({
                ...current,
                inboundActorMode: value,
                inboundActorId:
                  value === "specified_actor" ? current.inboundActorId : "",
              }))
            }
            onInboundActorIdChange={(value) =>
              setQqForm((current) => ({
                ...current,
                inboundActorId: value,
              }))
            }
          />

          <div className="flex justify-end">
            <Button
              onClick={() => void handleCreateQqAccount()}
              disabled={creatingQq}
            >
              {creatingQq ? "Creating..." : "Create QQ account"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Connected Accounts</CardTitle>
          <CardDescription>
            Accounts can be owned by the workspace or by a specific workspace
            member. Conversations are still created from inbound IM sessions,
            not hand-bound from chat.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? (
            <div className="text-sm text-muted-foreground">
              Loading accounts...
            </div>
          ) : accounts.length === 0 ? (
            <div className="rounded-2xl border border-dashed px-4 py-4 text-sm text-muted-foreground">
              No IM accounts connected yet.
            </div>
          ) : (
            accounts.map((account) => {
              const accountBusy =
                savingAccountId === account.id ||
                disconnectingAccountId === account.id
              const webhookUrl =
                account.connectionMode === "webhook"
                  ? buildWebhookUrl(account)
                  : ""
              const draft = accountSettingsDrafts[account.id] || {
                ownerScope: account.ownerScope,
                ownerWorkspaceMemberId: account.ownerWorkspaceMemberId || "",
                inboundActorMode: account.inboundActorMode,
                inboundActorId: account.inboundActorId || "",
              }
              const savedOwnerLabel = transportAccountOwnerLabel(
                account,
                workspaceMemberById,
                workspaceName
              )
              const draftOwnerLabel = transportAccountOwnerLabel(
                {
                  ownerScope: draft.ownerScope,
                  ownerWorkspaceMemberId:
                    draft.ownerWorkspaceMemberId || undefined,
                },
                workspaceMemberById,
                workspaceName
              )
              const savedInboundActorLabel = transportAccountInboundActorLabel(
                account,
                actorById
              )
              const draftInboundActorLabel =
                draft.inboundActorMode === "specified_actor"
                  ? draft.inboundActorId
                    ? actorOptionLabel(
                        actorById.get(draft.inboundActorId) || {
                          actorId: draft.inboundActorId,
                          displayName: draft.inboundActorId,
                        }
                      )
                    : "Select actor"
                  : prettyAccountInboundActorMode(draft.inboundActorMode)
              return (
                <div
                  key={account.id}
                  className="grid gap-4 rounded-2xl border bg-muted/20 px-4 py-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="text-sm font-medium text-foreground">
                        {account.displayName}
                      </div>
                      <Badge variant="secondary">
                        {prettyTransportKind(account.transportKind)}
                      </Badge>
                      <Badge variant="outline">
                        {prettyConnectionMode(account.connectionMode)}
                      </Badge>
                      <Badge variant="outline">
                        {prettyTransportAccountOwnerScope(account.ownerScope)}
                      </Badge>
                      <Badge variant="outline">{account.status}</Badge>
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Account key: {account.accountKey}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Owner: {savedOwnerLabel}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Inbound actor: {savedInboundActorLabel}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Updated: {formatDateTime(account.updatedAt)}
                    </div>
                  </div>

                  <div className="min-w-0 space-y-3">
                    {connectorMetadata?.get(account.transportKind)
                      ?.showsBaseUrlConfig === true ? (
                      <div className="text-xs text-muted-foreground">
                        Base URL:{" "}
                        {String(
                          account.config?.baseUrl ||
                            "https://ilinkai.weixin.qq.com"
                        )}
                      </div>
                    ) : null}
                    {webhookUrl ? (
                      <div className="rounded-xl bg-background px-3 py-2 text-xs text-muted-foreground">
                        Webhook URL:{" "}
                        <span className="break-all text-foreground">
                          {webhookUrl}
                        </span>
                      </div>
                    ) : null}
                    <div className="grid gap-3 rounded-xl border bg-background/80 p-3">
                      <div>
                        <div className="text-sm font-medium text-foreground">
                          Binding settings
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Owner and default inbound actor.
                        </div>
                      </div>
                      <div className="grid gap-3 md:grid-cols-[12rem_minmax(0,1fr)]">
                        <Select
                          value={draft.ownerScope}
                          onValueChange={(value) =>
                            setAccountSettingsDrafts((current) => ({
                              ...current,
                              [account.id]: {
                                ...draft,
                                ownerScope: value as TransportAccountOwnerScope,
                                ownerWorkspaceMemberId:
                                  value === "workspace"
                                    ? ""
                                    : draft.ownerWorkspaceMemberId,
                                inboundActorMode:
                                  value === "workspace" &&
                                  draft.inboundActorMode ===
                                    "follow_owner_chief_actor"
                                    ? "none"
                                    : draft.inboundActorMode,
                              },
                            }))
                          }
                          disabled={accountBusy}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="workspace">Workspace</SelectItem>
                            <SelectItem value="workspace_member">
                              Workspace member
                            </SelectItem>
                          </SelectContent>
                        </Select>
                        {draft.ownerScope === "workspace_member" ? (
                          <Select
                            value={
                              draft.ownerWorkspaceMemberId || UNASSIGNED_VALUE
                            }
                            onValueChange={(value) =>
                              setAccountSettingsDrafts((current) => ({
                                ...current,
                                [account.id]: {
                                  ...draft,
                                  ownerWorkspaceMemberId:
                                    value === UNASSIGNED_VALUE ? "" : value,
                                },
                              }))
                            }
                            disabled={
                              accountBusy || sortedWorkspaceMembers.length === 0
                            }
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Select workspace member" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={UNASSIGNED_VALUE}>
                                Select workspace member
                              </SelectItem>
                              {sortedWorkspaceMembers.map((member) => (
                                <SelectItem key={member.id} value={member.id}>
                                  {workspaceMemberLabel(member)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : null}
                      </div>
                      <TransportAccountInboundActorFields
                        idPrefix={`account-${account.id}`}
                        ownerScope={draft.ownerScope}
                        inboundActorMode={draft.inboundActorMode}
                        inboundActorId={draft.inboundActorId}
                        actors={actorOptions}
                        onInboundActorModeChange={(value) =>
                          setAccountSettingsDrafts((current) => ({
                            ...current,
                            [account.id]: {
                              ...draft,
                              inboundActorMode: value,
                              inboundActorId:
                                value === "specified_actor"
                                  ? draft.inboundActorId
                                  : "",
                            },
                          }))
                        }
                        onInboundActorIdChange={(value) =>
                          setAccountSettingsDrafts((current) => ({
                            ...current,
                            [account.id]: {
                              ...draft,
                              inboundActorId: value,
                            },
                          }))
                        }
                      />
                      {account.transportKind === "qq" ? (
                        <QqAccountConfigEditor
                          account={account}
                          draft={qqConfigDrafts[account.id]}
                          saving={savingQqConfigId === account.id}
                          onChangeDraft={(next) =>
                            setQqConfigDrafts((current) => ({
                              ...current,
                              [account.id]: next,
                            }))
                          }
                          onSave={() => void handleSaveQqConfig(account)}
                        />
                      ) : null}
                      <div className="flex items-center justify-between gap-3">
                        <div className="space-y-1 text-xs text-muted-foreground">
                          <div>Effective owner: {draftOwnerLabel}</div>
                          <div>
                            Effective inbound actor: {draftInboundActorLabel}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {account.status === "active" ? (
                            <Button
                              size="sm"
                              variant="destructive"
                              onClick={() =>
                                void handleDisconnectAccount(account)
                              }
                              disabled={accountBusy}
                            >
                              {disconnectingAccountId === account.id
                                ? "Disconnecting..."
                                : "Disconnect"}
                            </Button>
                          ) : null}
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              void handleSaveAccountSettings(account)
                            }
                            disabled={accountBusy}
                          >
                            {savingAccountId === account.id
                              ? "Saving..."
                              : "Save"}
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>IM Sessions</CardTitle>
          <CardDescription>
            Each external direct chat or group chat maps to its own
            conversation. Routing and outbound delivery are configured at the
            session level here.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? (
            <div className="text-sm text-muted-foreground">
              Loading sessions...
            </div>
          ) : sessions.length === 0 ? (
            <div className="rounded-2xl border border-dashed px-4 py-4 text-sm text-muted-foreground">
              No IM sessions discovered yet. Send a message to the bot from
              Feishu, WeChat, or WeCom to create one automatically.
            </div>
          ) : (
            sessions.map((session) => {
              const draft = sessionDrafts[session.id] || {
                outboundEnabled: session.outboundEnabled,
                inboundActorMode: session.inboundActorMode,
                inboundActorId: session.inboundActorId || "",
              }
              return (
                <div
                  key={session.id}
                  className="grid gap-4 rounded-2xl border bg-muted/20 px-4 py-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(21rem,0.9fr)]"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="truncate text-sm font-medium text-foreground">
                        {session.endpoint.displayName ||
                          session.endpoint.externalId}
                      </div>
                      <Badge variant="secondary">
                        {prettyTransportKind(session.transportKind)}
                      </Badge>
                      <Badge variant="outline">
                        {prettyEndpointType(session.endpoint.endpointType)}
                      </Badge>
                      <Badge variant="outline">
                        {draft.outboundEnabled ? "outbound on" : "outbound off"}
                      </Badge>
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Account: {session.account.displayName}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Endpoint: {session.endpoint.externalId}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Last inbound: {formatDateTime(session.lastInboundAt)}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Last outbound: {formatDateTime(session.lastOutboundAt)}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Inbound actor:{" "}
                      {sessionInboundActorLabel(session, actorById)}
                    </div>
                    <div className="mt-3 text-sm">
                      <div className="font-medium text-foreground">
                        {session.conversationTitle || "Conversation pending"}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {session.conversationId
                          ? "Conversation linked automatically"
                          : "Waiting for conversation creation"}
                      </div>
                    </div>
                  </div>

                  <div className="space-y-4 rounded-2xl border bg-background/80 p-4">
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-sm font-medium text-foreground">
                            Outbound enabled
                          </div>
                          <div className="text-xs text-muted-foreground">
                            External delivery only happens when a message
                            explicitly targets a participant that is reachable
                            in this IM session.
                          </div>
                        </div>
                        <Switch
                          checked={draft.outboundEnabled}
                          onCheckedChange={(checked) =>
                            setSessionDrafts((current) => ({
                              ...current,
                              [session.id]: {
                                ...draft,
                                outboundEnabled: checked,
                              },
                            }))
                          }
                          disabled={!session.conversationId}
                        />
                      </div>
                    </div>

                    <div className="space-y-2">
                      <TransportSessionInboundActorFields
                        sessionId={session.id}
                        draft={draft}
                        actors={actorOptions}
                        disabled={!session.conversationId}
                        onChange={(next) =>
                          setSessionDrafts((current) => ({
                            ...current,
                            [session.id]: next,
                          }))
                        }
                      />
                      <div className="text-xs text-muted-foreground">
                        Choose whether this session follows the binding, uses a
                        specific actor, or has no default actor.
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-3">
                      {session.conversationId ? (
                        <Button asChild variant="outline" size="sm">
                          <Link
                            href={`/dashboard/chat?conversation=${session.conversationId}`}
                          >
                            <MessageSquare className="size-4" />
                            Open conversation
                            <ArrowUpRight className="size-3.5" />
                          </Link>
                        </Button>
                      ) : (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Link2 className="size-3.5" />
                          Auto-created on inbound
                        </div>
                      )}
                      <Button
                        size="sm"
                        onClick={() => void handleSaveSessionSettings(session)}
                        disabled={
                          !session.conversationId ||
                          savingSessionId === session.id
                        }
                      >
                        {savingSessionId === session.id
                          ? "Saving..."
                          : "Save session"}
                      </Button>
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="size-4" />
            Transport Addresses
          </CardTitle>
          <CardDescription>
            Address ownership is workspace-scoped at the transport level. The
            same external address under the same bot maps to one workspace user
            across every session, and linked addresses speak as that workspace
            user inside bound conversations.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? (
            <div className="text-sm text-muted-foreground">
              Loading transport addresses...
            </div>
          ) : externalUsers.length === 0 ? (
            <div className="rounded-2xl border border-dashed px-4 py-4 text-sm text-muted-foreground">
              No transport addresses discovered yet.
            </div>
          ) : (
            externalUsers.map((externalUser) => (
              <div
                key={externalUser.id}
                className="grid gap-4 rounded-2xl border bg-muted/20 px-4 py-4 xl:grid-cols-[minmax(0,1fr)_18rem]"
              >
                <div className="min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="truncate text-sm font-medium text-foreground">
                      {externalUser.displayName || externalUser.externalId}
                    </div>
                    <Badge variant="secondary">
                      {prettyTransportKind(externalUser.transportKind)}
                    </Badge>
                    <Badge variant="outline">
                      {externalUser.accountDisplayName}
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    External ID: {externalUser.externalId}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Last seen: {formatDateTime(externalUser.lastSeenAt)}
                  </div>
                  <div className="flex flex-wrap gap-2 pt-1">
                    {externalUser.sessions.length > 0 ? (
                      externalUser.sessions.map((sessionRef, index) =>
                        sessionRef.conversationId ? (
                          <Button
                            key={`${externalUser.id}-${sessionRef.endpointId || index}`}
                            asChild
                            variant="outline"
                            size="sm"
                          >
                            <Link
                              href={`/dashboard/chat?conversation=${sessionRef.conversationId}`}
                            >
                              {sessionRef.endpointDisplayName ||
                                sessionRef.conversationTitle ||
                                sessionRef.endpointExternalId ||
                                "Open session"}
                              <ArrowUpRight className="size-3.5" />
                            </Link>
                          </Button>
                        ) : (
                          <Badge
                            key={`${externalUser.id}-${sessionRef.endpointId || index}`}
                            variant="outline"
                          >
                            {sessionRef.endpointDisplayName ||
                              sessionRef.endpointExternalId ||
                              "Session"}
                          </Badge>
                        )
                      )
                    ) : (
                      <div className="text-xs text-muted-foreground">
                        No linked sessions yet
                      </div>
                    )}
                  </div>
                </div>

                <div className="space-y-2 rounded-2xl border bg-background/80 p-4">
                  <div>
                    <div className="text-sm font-medium text-foreground">
                      Linked workspace user
                    </div>
                    <div className="text-xs text-muted-foreground">
                      This mapping applies across the workspace for this bot
                      address and controls how inbound authors and outbound
                      recipients resolve inside bound conversations.
                    </div>
                  </div>
                  <Select
                    value={
                      externalUserDrafts[externalUser.id] || UNASSIGNED_VALUE
                    }
                    onValueChange={(value) => {
                      setExternalUserDrafts((current) => ({
                        ...current,
                        [externalUser.id]: value,
                      }))
                      void handleLinkExternalUser(externalUser.id, value)
                    }}
                    disabled={linkingAddressId === externalUser.id}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Unlinked" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={UNASSIGNED_VALUE}>Unlinked</SelectItem>
                      {sortedWorkspaceMembers.map((member) => (
                        <SelectItem key={member.id} value={member.id}>
                          {workspaceMemberLabel(member)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="text-xs text-muted-foreground">
                    {externalUser.linkedWorkspaceMemberName
                      ? `Currently linked to ${externalUser.linkedWorkspaceMemberName}`
                      : "No workspace member linked"}
                  </div>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {error ? (
        <div className="rounded-2xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="grid gap-3 text-xs text-muted-foreground md:grid-cols-2">
        <div className="rounded-2xl border bg-muted/20 px-4 py-3">
          Feishu webhook mode requires Verification Token and Encrypt Key. Long
          connection only needs App ID and App Secret.
        </div>
        <div className="rounded-2xl border bg-muted/20 px-4 py-3">
          WeChat QR login stores the token after confirmation and starts polling
          via the transport runtime automatically.
        </div>
      </div>
    </div>
  )
}
