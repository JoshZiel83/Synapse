"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  buildAutomationRuleCreatePayloadFromDraft,
  describeAutomationDelivery,
  describeAutomationPolicy,
  describeAutomationTrigger,
  parseAutomationIdList,
  parseAutomationJsonObjectText,
} from "@synapse/shared";
import type {
  AutomationDeliveryMode,
  AutomationEventSource,
  AutomationRuleCreatePayload,
  AutomationRuleDraft,
  AutomationScheduleKind,
  AutomationTargetPolicy,
  AutomationTriggerKind,
} from "@synapse/shared";
import { ArrowLeft, Plus, RefreshCw, Save } from "lucide-react";
import { toast } from "sonner";

import {
  AppCard,
  AppCardContent,
  AppCardDescription,
  AppCardHeader,
  AppCardTitle,
} from "@/components/app-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";

type AutomationRuleEditorProps = {
  workspaceId?: string | null;
  workspaceName?: string | null;
  title: string;
  description: string;
  submitLabel: string;
  loadingLabel: string;
  initialDraft: AutomationRuleDraft;
  loadingInitial?: boolean;
  includeInactiveEventSources?: boolean;
  onSubmit: (payload: AutomationRuleCreatePayload) => Promise<void>;
};

function formatDateTime(value?: string) {
  if (!value) return "Not scheduled";
  return new Date(value).toLocaleString();
}

export function AutomationRuleEditor({
  workspaceId,
  workspaceName,
  title,
  description,
  submitLabel,
  loadingLabel,
  initialDraft,
  loadingInitial = false,
  includeInactiveEventSources = false,
  onSubmit,
}: AutomationRuleEditorProps) {
  const [eventSources, setEventSources] = useState<AutomationEventSource[]>([]);
  const [formState, setFormState] = useState<AutomationRuleDraft>(initialDraft);
  const [loadingEventSources, setLoadingEventSources] = useState(true);
  const [savingTrigger, setSavingTrigger] = useState(false);

  useEffect(() => {
    setFormState(initialDraft);
  }, [initialDraft]);

  const selectedEventSource = useMemo(
    () => eventSources.find((source) => source.id === formState.eventSourceId) || null,
    [eventSources, formState.eventSourceId],
  );

  const previewMatcher = useMemo(() => {
    try {
      return parseAutomationJsonObjectText(formState.matcherText, "matcher");
    } catch {
      return {};
    }
  }, [formState.matcherText]);

  const triggerPreview = useMemo(() => {
    if (formState.triggerKind === "event") {
      return describeAutomationTrigger({
        triggerKind: "event",
        sourceKind: selectedEventSource?.providerKind || "internal",
        eventSourceName: selectedEventSource?.name,
        eventSourceKey: selectedEventSource?.sourceKey,
        eventProviderKind: selectedEventSource?.providerKind,
        eventProviderRef: selectedEventSource?.providerRef,
        eventSourceIntegration: selectedEventSource?.integration,
        eventIntegrationProvider: selectedEventSource?.integration?.provider,
        eventIntegrationTargetLabel: selectedEventSource?.integration?.targetLabel,
        matcher: previewMatcher,
      });
    }

    return describeAutomationTrigger(
      {
        triggerKind: "schedule",
        sourceKind: "clock",
        scheduleKind: formState.scheduleKind,
        scheduleExpr:
          formState.scheduleKind === "cron"
            ? formState.scheduleExpr.trim() || undefined
            : undefined,
        scheduleTimezone:
          formState.scheduleKind === "cron"
            ? formState.scheduleTimezone.trim() || "UTC"
            : undefined,
        intervalSeconds:
          formState.scheduleKind === "interval"
            ? Number.parseInt(formState.intervalSeconds, 10) || undefined
            : undefined,
        startsAt:
          formState.scheduleKind === "at"
            ? formState.startsAt || undefined
            : undefined,
      },
      { formatTimestamp: formatDateTime },
    );
  }, [
    formState.eventSourceId,
    formState.intervalSeconds,
    formState.matcherText,
    formState.scheduleExpr,
    formState.scheduleKind,
    formState.scheduleTimezone,
    formState.startsAt,
    formState.triggerKind,
    previewMatcher,
    selectedEventSource,
  ]);

  const policyPreview = useMemo(
    () =>
      describeAutomationPolicy(
        {
          activeFrom: formState.activeFrom || undefined,
          activeUntil: formState.activeUntil || undefined,
          maxTriggerCount: Number.parseInt(formState.maxTriggerCount, 10) || undefined,
          completionStatus: formState.completionStatus,
        },
        { formatTimestamp: formatDateTime },
      ),
    [
      formState.activeFrom,
      formState.activeUntil,
      formState.completionStatus,
      formState.maxTriggerCount,
    ],
  );

  const deliveryPreview = useMemo(
    () =>
      describeAutomationDelivery({
        deliveryMode: formState.deliveryMode,
        targetPolicy: formState.targetPolicy,
        conversationId: formState.conversationId.trim() || undefined,
        sessionId: formState.sessionId.trim() || undefined,
        conversationTitle: formState.conversationTitle.trim() || undefined,
        messageText: formState.message.trim() || undefined,
        wakeReasonText: formState.wakeReason.trim() || undefined,
        participants: [
          ...parseAutomationIdList(formState.participantActorIds).map((entityId) => ({
            entityKind: "actor" as const,
            entityId,
          })),
          ...parseAutomationIdList(formState.participantWorkspaceMemberIds).map((entityId) => ({
            entityKind: "workspace_member" as const,
            entityId,
          })),
        ],
        recipients: [
          ...parseAutomationIdList(formState.recipientActorIds).map((entityId) => ({
            entityKind: "actor" as const,
            entityId,
          })),
          ...parseAutomationIdList(formState.recipientWorkspaceMemberIds).map((entityId) => ({
            entityKind: "workspace_member" as const,
            entityId,
          })),
        ],
      }),
    [
      formState.conversationId,
      formState.conversationTitle,
      formState.deliveryMode,
      formState.message,
      formState.participantActorIds,
      formState.participantWorkspaceMemberIds,
      formState.recipientActorIds,
      formState.recipientWorkspaceMemberIds,
      formState.sessionId,
      formState.targetPolicy,
      formState.wakeReason,
    ],
  );

  async function loadEventSources() {
    if (!workspaceId) return;

    setLoadingEventSources(true);
    try {
      const sources = await api.getAutomationEventSources(
        workspaceId,
        includeInactiveEventSources ? undefined : { status: "active" },
      );
      setEventSources(sources);
      setFormState((current) => ({
        ...current,
        eventSourceId: current.eventSourceId || sources[0]?.id || "",
      }));
    } catch (error) {
      console.error("Failed to load event sources for trigger editing:", error);
      toast.error(error instanceof Error ? error.message : "Failed to load event sources");
    } finally {
      setLoadingEventSources(false);
    }
  }

  useEffect(() => {
    void loadEventSources();
  }, [includeInactiveEventSources, workspaceId]);

  async function handleSubmit() {
    if (!workspaceId) return;

    const built = buildAutomationRuleCreatePayloadFromDraft(formState);
    if (!built.ok) {
      toast.error(built.error);
      return;
    }

    setSavingTrigger(true);
    try {
      await onSubmit(built.data);
    } catch (error) {
      console.error("Failed to save trigger:", error);
      toast.error(error instanceof Error ? error.message : "Failed to save trigger");
    } finally {
      setSavingTrigger(false);
    }
  }

  if (!workspaceId) {
    return (
      <div className="px-4 pb-6 pt-6 text-sm text-muted-foreground lg:px-6">
        Select a workspace to manage triggers.
      </div>
    );
  }

  if (loadingInitial) {
    return (
      <div className="flex flex-col gap-6 px-4 pb-6 pt-6 lg:px-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-2">
            <Button asChild type="button" variant="outline" size="sm">
              <Link href="/dashboard/triggers">
                <ArrowLeft data-icon="inline-start" />
                Back to Triggers
              </Link>
            </Button>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {workspaceName ? `${description} Workspace: ${workspaceName}.` : description}
              </p>
            </div>
          </div>
        </div>
        <AppCard variant="panel">
          <AppCardContent className="px-6 py-10 text-sm text-muted-foreground">
            {loadingLabel}
          </AppCardContent>
        </AppCard>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 px-4 pb-6 pt-6 lg:px-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-2">
          <Button asChild type="button" variant="outline" size="sm">
            <Link href="/dashboard/triggers">
              <ArrowLeft data-icon="inline-start" />
              Back to Triggers
            </Link>
          </Button>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {workspaceName ? `${description} Workspace: ${workspaceName}.` : description}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => void loadEventSources()}
            disabled={loadingEventSources}
          >
            <RefreshCw
              data-icon="inline-start"
              className={loadingEventSources ? "animate-spin" : undefined}
            />
            Refresh Event Sources
          </Button>
          <Button type="button" onClick={() => void handleSubmit()} disabled={savingTrigger}>
            {savingTrigger ? (
              <RefreshCw data-icon="inline-start" className="animate-spin" />
            ) : submitLabel.toLowerCase().includes("create") ? (
              <Plus data-icon="inline-start" />
            ) : (
              <Save data-icon="inline-start" />
            )}
            {submitLabel}
          </Button>
        </div>
      </div>

      <AppCard variant="panel">
        <AppCardHeader className="gap-3">
          <AppCardTitle>Trigger Definition</AppCardTitle>
          <AppCardDescription>
            Triggers can be schedule-based or event-based. Delivery currently exposes the same four backend modes.
          </AppCardDescription>
        </AppCardHeader>
        <AppCardContent className="grid gap-5">
          <div className="rounded-[24px] border border-border/70 bg-muted/20 p-4">
            <div className="text-sm font-medium text-foreground">Trigger Preview</div>
            <div className="mt-3">
              <div className="text-sm font-medium text-foreground">{triggerPreview.title}</div>
              <div className="mt-1 text-xs text-muted-foreground">{triggerPreview.summary}</div>
              {triggerPreview.description ? (
                <p className="mt-2 text-sm text-muted-foreground">{triggerPreview.description}</p>
              ) : null}
              <dl className="mt-3 grid gap-2 text-sm md:grid-cols-2">
                {triggerPreview.details.map((detail) => (
                  <div key={detail.label}>
                    <dt className="text-muted-foreground">{detail.label}</dt>
                    <dd className="font-medium text-foreground">{detail.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>

          <div className="rounded-[24px] border border-border/70 bg-muted/20 p-4">
            <div className="text-sm font-medium text-foreground">Policy Preview</div>
            <div className="mt-3">
              <div className="text-sm font-medium text-foreground">{policyPreview.title}</div>
              <div className="mt-1 text-xs text-muted-foreground">{policyPreview.summary}</div>
              {policyPreview.description ? (
                <p className="mt-2 text-sm text-muted-foreground">{policyPreview.description}</p>
              ) : null}
              <dl className="mt-3 grid gap-2 text-sm md:grid-cols-2">
                {policyPreview.details.map((detail) => (
                  <div key={detail.label}>
                    <dt className="text-muted-foreground">{detail.label}</dt>
                    <dd className="font-medium text-foreground">{detail.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>

          <div className="rounded-[24px] border border-border/70 bg-muted/20 p-4">
            <div className="text-sm font-medium text-foreground">Delivery Preview</div>
            <div className="mt-3">
              <div className="text-sm font-medium text-foreground">{deliveryPreview.title}</div>
              <div className="mt-1 text-xs text-muted-foreground">{deliveryPreview.summary}</div>
              {deliveryPreview.description ? (
                <p className="mt-2 text-sm text-muted-foreground">{deliveryPreview.description}</p>
              ) : null}
              <dl className="mt-3 grid gap-2 text-sm md:grid-cols-2">
                {deliveryPreview.details.map((detail) => (
                  <div key={detail.label}>
                    <dt className="text-muted-foreground">{detail.label}</dt>
                    <dd className="font-medium text-foreground">{detail.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="grid gap-2">
              <label className="text-sm font-medium text-foreground" htmlFor="trigger-name">
                Name
              </label>
              <Input
                id="trigger-name"
                value={formState.name}
                onChange={(event) => setFormState((current) => ({ ...current, name: event.target.value }))}
                placeholder="Morning follow-up"
              />
            </div>
            <div className="grid gap-2">
              <label className="text-sm font-medium text-foreground" htmlFor="trigger-kind">
                Trigger kind
              </label>
              <Select
                value={formState.triggerKind}
                onValueChange={(value) =>
                  setFormState((current) => ({ ...current, triggerKind: value as AutomationTriggerKind }))
                }
              >
                <SelectTrigger id="trigger-kind" className="w-full">
                  <SelectValue placeholder="Trigger kind" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="schedule">Schedule</SelectItem>
                  <SelectItem value="event">Event subscription</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-2">
            <label className="text-sm font-medium text-foreground" htmlFor="trigger-description">
              Description
            </label>
            <Textarea
              id="trigger-description"
              value={formState.description}
              onChange={(event) => setFormState((current) => ({ ...current, description: event.target.value }))}
              rows={3}
              placeholder="Why this trigger exists and what it is expected to do."
            />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="grid gap-2">
              <label className="text-sm font-medium text-foreground" htmlFor="trigger-owner-conversation">
                Owner conversation ID
              </label>
              <Input
                id="trigger-owner-conversation"
                value={formState.ownerConversationId}
                onChange={(event) =>
                  setFormState((current) => ({ ...current, ownerConversationId: event.target.value }))
                }
                placeholder="Optional owner conversation"
              />
            </div>
            <div className="grid gap-2">
              <label className="text-sm font-medium text-foreground" htmlFor="trigger-owner-session">
                Owner session ID
              </label>
              <Input
                id="trigger-owner-session"
                value={formState.ownerSessionId}
                onChange={(event) =>
                  setFormState((current) => ({ ...current, ownerSessionId: event.target.value }))
                }
                placeholder="Optional owner session"
              />
            </div>
          </div>

          <div className="rounded-[24px] border border-border/70 bg-muted/20 p-4">
            <div className="text-sm font-medium text-foreground">Trigger Setup</div>
            {formState.triggerKind === "schedule" ? (
              <div className="mt-4 grid gap-4">
                <div className="grid gap-4 md:grid-cols-3">
                  <div className="grid gap-2">
                    <label className="text-sm font-medium text-foreground" htmlFor="trigger-schedule-kind">
                      Schedule kind
                    </label>
                    <Select
                      value={formState.scheduleKind}
                      onValueChange={(value) =>
                        setFormState((current) => ({ ...current, scheduleKind: value as AutomationScheduleKind }))
                      }
                    >
                      <SelectTrigger id="trigger-schedule-kind" className="w-full">
                        <SelectValue placeholder="Schedule kind" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="at">At</SelectItem>
                        <SelectItem value="interval">Interval</SelectItem>
                        <SelectItem value="cron">Cron</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {formState.scheduleKind === "interval" ? (
                    <div className="grid gap-2">
                      <label className="text-sm font-medium text-foreground" htmlFor="trigger-interval-seconds">
                        Interval seconds
                      </label>
                      <Input
                        id="trigger-interval-seconds"
                        type="number"
                        min="1"
                        value={formState.intervalSeconds}
                        onChange={(event) =>
                          setFormState((current) => ({ ...current, intervalSeconds: event.target.value }))
                        }
                      />
                    </div>
                  ) : null}
                  {formState.scheduleKind === "cron" ? (
                    <div className="grid gap-2 md:col-span-2">
                      <label className="text-sm font-medium text-foreground" htmlFor="trigger-schedule-expr">
                        Cron expression
                      </label>
                      <Input
                        id="trigger-schedule-expr"
                        value={formState.scheduleExpr}
                        onChange={(event) =>
                          setFormState((current) => ({ ...current, scheduleExpr: event.target.value }))
                        }
                        placeholder="0 9 * * *"
                      />
                    </div>
                  ) : null}
                </div>
                <div className="grid gap-4 md:grid-cols-3">
                  <div className="grid gap-2">
                    <label className="text-sm font-medium text-foreground" htmlFor="trigger-starts-at">
                      {formState.scheduleKind === "at" ? "Fire at" : "First fire"}
                    </label>
                    <Input
                      id="trigger-starts-at"
                      type="datetime-local"
                      value={formState.startsAt}
                      onChange={(event) => setFormState((current) => ({ ...current, startsAt: event.target.value }))}
                    />
                  </div>
                  <div className="grid gap-2">
                    <label className="text-sm font-medium text-foreground" htmlFor="trigger-timezone">
                      Timezone
                    </label>
                    <Input
                      id="trigger-timezone"
                      value={formState.scheduleTimezone}
                      onChange={(event) =>
                        setFormState((current) => ({ ...current, scheduleTimezone: event.target.value }))
                      }
                      placeholder="Asia/Shanghai"
                      disabled={formState.scheduleKind !== "cron"}
                    />
                  </div>
                </div>
              </div>
            ) : (
              <div className="mt-4 grid gap-4">
                <div className="grid gap-2">
                  <label className="text-sm font-medium text-foreground" htmlFor="trigger-event-source">
                    Event source
                  </label>
                  <Select
                    value={formState.eventSourceId}
                    onValueChange={(value) => setFormState((current) => ({ ...current, eventSourceId: value }))}
                  >
                    <SelectTrigger id="trigger-event-source" className="w-full">
                      <SelectValue placeholder="Select event source" />
                    </SelectTrigger>
                    <SelectContent>
                      {eventSources.length > 0 ? (
                        eventSources.map((source) => (
                          <SelectItem key={source.id} value={source.id}>
                            {source.name} ({source.providerKind}/{source.sourceKey}
                            {source.status !== "active" ? `/${source.status}` : ""})
                          </SelectItem>
                        ))
                      ) : (
                        <SelectItem value="__none" disabled>
                          No available event sources
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <label className="text-sm font-medium text-foreground" htmlFor="trigger-matcher-text">
                    Matcher JSON
                  </label>
                  <Textarea
                    id="trigger-matcher-text"
                    value={formState.matcherText}
                    onChange={(event) => setFormState((current) => ({ ...current, matcherText: event.target.value }))}
                    rows={6}
                    className="font-mono text-xs"
                  />
                </div>
              </div>
            )}
          </div>

          <div className="rounded-[24px] border border-border/70 bg-muted/20 p-4">
            <div className="text-sm font-medium text-foreground">Policy / Termination</div>
            <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <div className="grid gap-2">
                <label className="text-sm font-medium text-foreground" htmlFor="trigger-active-from">
                  Active from
                </label>
                <Input
                  id="trigger-active-from"
                  type="datetime-local"
                  value={formState.activeFrom}
                  onChange={(event) => setFormState((current) => ({ ...current, activeFrom: event.target.value }))}
                />
              </div>
              <div className="grid gap-2">
                <label className="text-sm font-medium text-foreground" htmlFor="trigger-active-until">
                  Active until
                </label>
                <Input
                  id="trigger-active-until"
                  type="datetime-local"
                  value={formState.activeUntil}
                  onChange={(event) => setFormState((current) => ({ ...current, activeUntil: event.target.value }))}
                />
              </div>
              <div className="grid gap-2">
                <label className="text-sm font-medium text-foreground" htmlFor="trigger-max-count">
                  Max trigger count
                </label>
                <Input
                  id="trigger-max-count"
                  type="number"
                  min="1"
                  value={formState.maxTriggerCount}
                  onChange={(event) =>
                    setFormState((current) => ({ ...current, maxTriggerCount: event.target.value }))
                  }
                  placeholder="Unlimited"
                />
              </div>
              <div className="grid gap-2">
                <label className="text-sm font-medium text-foreground" htmlFor="trigger-completion-status">
                  On completion
                </label>
                <Select
                  value={formState.completionStatus}
                  onValueChange={(value) =>
                    setFormState((current) => ({
                      ...current,
                      completionStatus: value as AutomationRuleDraft["completionStatus"],
                    }))
                  }
                >
                  <SelectTrigger id="trigger-completion-status" className="w-full">
                    <SelectValue placeholder="Completion status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="completed">completed</SelectItem>
                    <SelectItem value="archived">archived</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          <div className="rounded-[24px] border border-border/70 bg-muted/20 p-4">
            <div className="text-sm font-medium text-foreground">Action / Delivery</div>
            <div className="mt-4 grid gap-4">
              <div className="grid gap-4 md:grid-cols-3">
                <div className="grid gap-2">
                  <label className="text-sm font-medium text-foreground" htmlFor="trigger-delivery-mode">
                    Delivery mode
                  </label>
                  <Select
                    value={formState.deliveryMode}
                    onValueChange={(value) =>
                      setFormState((current) => ({ ...current, deliveryMode: value as AutomationDeliveryMode }))
                    }
                  >
                    <SelectTrigger id="trigger-delivery-mode" className="w-full">
                      <SelectValue placeholder="Delivery mode" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="wake_session">wake_session</SelectItem>
                      <SelectItem value="conversation_notice">conversation_notice</SelectItem>
                      <SelectItem value="create_conversation_once">create_conversation_once</SelectItem>
                      <SelectItem value="create_conversation_each_time">create_conversation_each_time</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <label className="text-sm font-medium text-foreground" htmlFor="trigger-target-policy">
                    Target policy
                  </label>
                  <Select
                    value={formState.targetPolicy}
                    onValueChange={(value) =>
                      setFormState((current) => ({ ...current, targetPolicy: value as AutomationTargetPolicy }))
                    }
                  >
                    <SelectTrigger id="trigger-target-policy" className="w-full">
                      <SelectValue placeholder="Target policy" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all_members">all_members</SelectItem>
                      <SelectItem value="specified_members">specified_members</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <label className="text-sm font-medium text-foreground" htmlFor="trigger-session-id">
                    Target session ID
                  </label>
                  <Input
                    id="trigger-session-id"
                    value={formState.sessionId}
                    onChange={(event) => setFormState((current) => ({ ...current, sessionId: event.target.value }))}
                    placeholder="Required for wake_session"
                  />
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="grid gap-2">
                  <label className="text-sm font-medium text-foreground" htmlFor="trigger-conversation-id">
                    Conversation ID
                  </label>
                  <Input
                    id="trigger-conversation-id"
                    value={formState.conversationId}
                    onChange={(event) =>
                      setFormState((current) => ({ ...current, conversationId: event.target.value }))
                    }
                    placeholder="Required for conversation_notice"
                  />
                </div>
                <div className="grid gap-2">
                  <label className="text-sm font-medium text-foreground" htmlFor="trigger-conversation-title">
                    Conversation title
                  </label>
                  <Input
                    id="trigger-conversation-title"
                    value={formState.conversationTitle}
                    onChange={(event) =>
                      setFormState((current) => ({ ...current, conversationTitle: event.target.value }))
                    }
                    placeholder="Used when creating a conversation"
                  />
                </div>
              </div>

              <div className="grid gap-2">
                <label className="text-sm font-medium text-foreground" htmlFor="trigger-message">
                  Visible system message
                </label>
                <Textarea
                  id="trigger-message"
                  value={formState.message}
                  onChange={(event) => setFormState((current) => ({ ...current, message: event.target.value }))}
                  rows={4}
                  placeholder="This system message is shown in the conversation when the trigger fires."
                />
              </div>

              <div className="grid gap-2">
                <label className="text-sm font-medium text-foreground" htmlFor="trigger-wake-reason">
                  Wake reason
                </label>
                <Textarea
                  id="trigger-wake-reason"
                  value={formState.wakeReason}
                  onChange={(event) => setFormState((current) => ({ ...current, wakeReason: event.target.value }))}
                  rows={3}
                  placeholder="Private reasoning text injected into the woken session context."
                />
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="grid gap-2">
                  <label className="text-sm font-medium text-foreground" htmlFor="trigger-recipient-actors">
                    Recipient actor IDs
                  </label>
                  <Textarea
                    id="trigger-recipient-actors"
                    value={formState.recipientActorIds}
                    onChange={(event) =>
                      setFormState((current) => ({ ...current, recipientActorIds: event.target.value }))
                    }
                    rows={4}
                    placeholder="Comma, space, or newline separated"
                  />
                </div>
                <div className="grid gap-2">
                  <label className="text-sm font-medium text-foreground" htmlFor="trigger-recipient-users">
                    Recipient workspace member IDs
                  </label>
                  <Textarea
                    id="trigger-recipient-users"
                    value={formState.recipientWorkspaceMemberIds}
                    onChange={(event) =>
                      setFormState((current) => ({ ...current, recipientWorkspaceMemberIds: event.target.value }))
                    }
                    rows={4}
                    placeholder="Comma, space, or newline separated"
                  />
                </div>
                <div className="grid gap-2">
                  <label className="text-sm font-medium text-foreground" htmlFor="trigger-participant-actors">
                    Conversation participant actor IDs
                  </label>
                  <Textarea
                    id="trigger-participant-actors"
                    value={formState.participantActorIds}
                    onChange={(event) =>
                      setFormState((current) => ({ ...current, participantActorIds: event.target.value }))
                    }
                    rows={4}
                    placeholder="Used for conversation creation modes"
                  />
                </div>
                <div className="grid gap-2">
                  <label className="text-sm font-medium text-foreground" htmlFor="trigger-participant-users">
                    Conversation participant workspace member IDs
                  </label>
                  <Textarea
                    id="trigger-participant-users"
                    value={formState.participantWorkspaceMemberIds}
                    onChange={(event) =>
                      setFormState((current) => ({ ...current, participantWorkspaceMemberIds: event.target.value }))
                    }
                    rows={4}
                    placeholder="Used for conversation creation modes"
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-[22px] border border-border/70 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
            `wakeReason` is stored separately from the visible system notice and is injected into the woken session
            context when the trigger fires.
          </div>
        </AppCardContent>
      </AppCard>
    </div>
  );
}
