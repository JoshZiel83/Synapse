"use client";

import Link from "next/link";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import type { AutomationExecution, AutomationRule } from "@synapse/shared";
import {
  describeAutomationDelivery,
  describeAutomationPolicy,
  describeAutomationTrigger,
} from "@synapse/shared";
import {
  Clock3,
  Pause,
  PencilLine,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

import { useWorkspace } from "@/app/dashboard/workspace-provider";
import {
  AppCard,
  AppCardContent,
  AppCardDescription,
  AppCardHeader,
  AppCardTitle,
} from "@/components/app-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

type TriggerStatus = AutomationRule["status"];
type TriggerCategory = AutomationRule["category"];

function formatDateTime(value?: string) {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
}

function triggerStatusVariant(status: TriggerStatus) {
  switch (status) {
    case "active":
      return "secondary";
    case "completed":
      return "secondary";
    case "paused":
    case "expired":
      return "outline";
    case "error":
    case "archived":
      return "destructive";
    default:
      return "outline";
  }
}

function executionStatusVariant(status: AutomationExecution["status"]) {
  switch (status) {
    case "completed":
      return "secondary";
    case "pending":
    case "running":
    case "skipped":
      return "outline";
    case "failed":
      return "destructive";
    default:
      return "outline";
  }
}

function serializeDetails(value: unknown) {
  return JSON.stringify(value || {}, null, 2);
}

function executionOccurrenceTitle(execution: AutomationExecution) {
  return (
    execution.occurrenceTitle ||
    execution.occurrenceEventSourceName ||
    execution.occurrenceId
  );
}

function executionOccurrenceSummary(execution: AutomationExecution) {
  return execution.occurrenceSummary?.trim() || null;
}

export default function TriggersPage() {
  const { workspaceId, workspaceName } = useWorkspace();
  const [rules, setRules] = useState<AutomationRule[]>([]);
  const [executions, setExecutions] = useState<AutomationExecution[]>([]);
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);
  const [loadingRules, setLoadingRules] = useState(true);
  const [loadingExecutions, setLoadingExecutions] = useState(false);
  const [savingRule, setSavingRule] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | TriggerStatus>("all");
  const [categoryFilter, setCategoryFilter] = useState<"all" | TriggerCategory>("all");
  const deferredSearch = useDeferredValue(search);

  async function loadRules() {
    if (!workspaceId) return;

    setLoadingRules(true);
    try {
      const nextRules = await api.getAutomations(workspaceId);
      setRules(nextRules);
      setSelectedRuleId((currentId) => {
        if (currentId && nextRules.some((rule) => rule.id === currentId)) {
          return currentId;
        }
        return nextRules[0]?.id || null;
      });
    } catch (error) {
      console.error("Failed to load automations:", error);
      toast.error(error instanceof Error ? error.message : "Failed to load triggers");
    } finally {
      setLoadingRules(false);
    }
  }

  async function loadExecutions(ruleId: string) {
    if (!workspaceId) return;

    setLoadingExecutions(true);
    try {
      const nextExecutions = await api.getAutomationExecutions(workspaceId, ruleId);
      setExecutions(nextExecutions);
    } catch (error) {
      console.error("Failed to load automation executions:", error);
      toast.error(error instanceof Error ? error.message : "Failed to load trigger history");
      setExecutions([]);
    } finally {
      setLoadingExecutions(false);
    }
  }

  useEffect(() => {
    void loadRules();
  }, [workspaceId]);

  useEffect(() => {
    if (!selectedRuleId) {
      setExecutions([]);
      return;
    }
    void loadExecutions(selectedRuleId);
  }, [selectedRuleId, workspaceId]);

  const filteredRules = useMemo(() => {
    const keyword = deferredSearch.trim().toLowerCase();

    return rules.filter((rule) => {
      if (statusFilter !== "all" && rule.status !== statusFilter) {
        return false;
      }
      if (categoryFilter !== "all" && rule.category !== categoryFilter) {
        return false;
      }
      if (!keyword) {
        return true;
      }

      const haystack = [
        rule.name,
        rule.description,
        rule.trigger.eventSourceName || "",
        rule.trigger.eventSourceKey || "",
        rule.trigger.scheduleExpr || "",
        rule.delivery.messageText,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(keyword);
    });
  }, [categoryFilter, deferredSearch, rules, statusFilter]);

  const selectedRule = useMemo(
    () => filteredRules.find((rule) => rule.id === selectedRuleId) || rules.find((rule) => rule.id === selectedRuleId) || null,
    [filteredRules, rules, selectedRuleId],
  );

  const selectedTriggerDisplay = useMemo(
    () =>
      selectedRule
        ? describeAutomationTrigger(selectedRule.trigger, { formatTimestamp: formatDateTime })
        : null,
    [selectedRule],
  );
  const selectedDeliveryDisplay = useMemo(
    () => (selectedRule ? describeAutomationDelivery(selectedRule.delivery) : null),
    [selectedRule],
  );
  const selectedPolicyDisplay = useMemo(
    () =>
      selectedRule
        ? describeAutomationPolicy(selectedRule.policy, { formatTimestamp: formatDateTime })
        : null,
    [selectedRule],
  );

  async function handleUpdateRuleStatus(rule: AutomationRule, status: TriggerStatus) {
    if (!workspaceId || rule.status === status) return;

    setSavingRule(true);
    try {
      await api.updateAutomation(workspaceId, rule.id, { status });
      toast.success(`Trigger marked ${status}`);
      await loadRules();
      if (selectedRuleId === rule.id) {
        await loadExecutions(rule.id);
      }
    } catch (error) {
      console.error("Failed to update trigger status:", error);
      toast.error(error instanceof Error ? error.message : "Failed to update trigger");
    } finally {
      setSavingRule(false);
    }
  }

  async function handleDeleteRule(rule: AutomationRule) {
    if (!workspaceId) return;
    if (!window.confirm(`Delete trigger "${rule.name}"? This cannot be undone.`)) {
      return;
    }

    setSavingRule(true);
    try {
      await api.deleteAutomation(workspaceId, rule.id);
      toast.success("Trigger deleted");
      await loadRules();
    } catch (error) {
      console.error("Failed to delete trigger:", error);
      toast.error(error instanceof Error ? error.message : "Failed to delete trigger");
    } finally {
      setSavingRule(false);
    }
  }

  if (!workspaceId) {
    return (
      <div className="px-4 pb-6 pt-6 text-sm text-muted-foreground lg:px-6">
        Select a workspace to manage automation triggers.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 px-4 pb-6 pt-6 lg:px-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Triggers</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage scheduled wakeups and event subscriptions for {workspaceName || "this workspace"}.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => void loadRules()} disabled={loadingRules}>
            <RefreshCw className={cn(loadingRules && "animate-spin")} data-icon="inline-start" />
            Refresh
          </Button>
          <Button asChild type="button">
            <Link href="/dashboard/triggers/new">
              <Plus data-icon="inline-start" />
              Create Trigger
            </Link>
          </Button>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
        <AppCard variant="panel">
          <AppCardHeader className="gap-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <AppCardTitle>Automation Rules</AppCardTitle>
                <AppCardDescription>
                  Schedule-based rules and event subscriptions share the same execution pipeline.
                </AppCardDescription>
              </div>
              <Badge variant="outline">{rules.length}</Badge>
            </div>
            <div className="grid gap-3">
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search by name, source, message..."
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as "all" | TriggerStatus)}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="paused">Paused</SelectItem>
                    <SelectItem value="error">Error</SelectItem>
                    <SelectItem value="completed">Completed</SelectItem>
                    <SelectItem value="expired">Expired</SelectItem>
                    <SelectItem value="archived">Archived</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={categoryFilter} onValueChange={(value) => setCategoryFilter(value as "all" | TriggerCategory)}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Category" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All categories</SelectItem>
                    <SelectItem value="schedule">Schedule</SelectItem>
                    <SelectItem value="event_subscription">Event subscription</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </AppCardHeader>
          <AppCardContent className="flex flex-col gap-3">
            {loadingRules ? (
              <div className="rounded-[22px] border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
                Loading triggers...
              </div>
            ) : filteredRules.length === 0 ? (
              <div className="rounded-[22px] border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
                No triggers match the current filters.
              </div>
            ) : (
              filteredRules.map((rule) => {
                const selected = rule.id === selectedRuleId;
                const triggerDisplay = describeAutomationTrigger(rule.trigger, {
                  formatTimestamp: formatDateTime,
                });
                const policyDisplay = describeAutomationPolicy(rule.policy, {
                  formatTimestamp: formatDateTime,
                });
                return (
                  <button
                    key={rule.id}
                    type="button"
                    onClick={() => setSelectedRuleId(rule.id)}
                    className={cn(
                      "rounded-[22px] border px-4 py-4 text-left transition-colors",
                      selected
                        ? "border-primary/30 bg-primary/5"
                        : "border-border/70 hover:bg-muted/50",
                    )}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="text-sm font-medium text-foreground">{rule.name}</div>
                          <Badge variant={triggerStatusVariant(rule.status)}>{rule.status}</Badge>
                          <Badge variant="outline">
                            {rule.category === "schedule" ? "schedule" : "event"}
                          </Badge>
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {triggerDisplay.summary}
                        </div>
                        <div className="mt-1 text-[11px] text-muted-foreground/80">
                          {policyDisplay.summary}
                        </div>
                      </div>
                      {rule.category === "schedule" ? (
                        <Clock3 className="size-4 text-muted-foreground" />
                      ) : (
                        <Zap className="size-4 text-muted-foreground" />
                      )}
                    </div>
                    <p className="mt-3 line-clamp-2 text-sm text-muted-foreground">
                      {rule.delivery.wakeReasonText || rule.delivery.messageText || rule.description || "No message"}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
                      <span>Next {formatDateTime(rule.trigger.nextFireAt)}</span>
                      <span>Last run {formatDateTime(rule.lastTriggeredAt)}</span>
                    </div>
                  </button>
                );
              })
            )}
          </AppCardContent>
        </AppCard>

        <div className="flex min-w-0 flex-col gap-6">
          {selectedRule ? (
            <>
              <AppCard variant="panel">
                <AppCardHeader className="gap-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <AppCardTitle>{selectedRule.name}</AppCardTitle>
                        <Badge variant={triggerStatusVariant(selectedRule.status)}>
                          {selectedRule.status}
                        </Badge>
                        <Badge variant="outline">{selectedRule.category}</Badge>
                      </div>
                      <AppCardDescription className="mt-2">
                        {selectedRule.description || "No description"}
                      </AppCardDescription>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button asChild type="button" variant="outline" size="sm">
                        <Link href={`/dashboard/triggers/${selectedRule.id}/edit`}>
                          <PencilLine data-icon="inline-start" />
                          Edit
                        </Link>
                      </Button>
                      {selectedRule.status !== "active" ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => void handleUpdateRuleStatus(selectedRule, "active")}
                          disabled={savingRule}
                        >
                          <Play data-icon="inline-start" />
                          Activate
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => void handleUpdateRuleStatus(selectedRule, "paused")}
                          disabled={savingRule}
                        >
                          <Pause data-icon="inline-start" />
                          Pause
                        </Button>
                      )}
                      {selectedRule.status !== "archived" ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => void handleUpdateRuleStatus(selectedRule, "archived")}
                          disabled={savingRule}
                        >
                          Archive
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        onClick={() => void handleDeleteRule(selectedRule)}
                        disabled={savingRule}
                      >
                        <Trash2 data-icon="inline-start" />
                        Delete
                      </Button>
                    </div>
                  </div>
                </AppCardHeader>
                <AppCardContent className="grid gap-6 xl:grid-cols-2">
                  <div className="rounded-[22px] border border-border/70 bg-muted/20 p-4">
                    <div className="text-sm font-medium text-foreground">Trigger</div>
                    <dl className="mt-3 grid gap-3 text-sm">
                      <div>
                        <dt className="text-muted-foreground">Kind</dt>
                        <dd className="font-medium text-foreground">{selectedRule.trigger.triggerKind}</dd>
                      </div>
                      {selectedTriggerDisplay?.details
                        .filter((detail) => detail.label !== "Kind")
                        .map((detail) => (
                          <div key={detail.label}>
                            <dt className="text-muted-foreground">{detail.label}</dt>
                            <dd className="font-medium text-foreground">{detail.value}</dd>
                          </div>
                        ))}
                      <div>
                        <dt className="text-muted-foreground">Matcher</dt>
                        <dd className="font-medium text-foreground">
                          <pre className="mt-2 overflow-x-auto rounded-2xl bg-background px-3 py-3 text-xs">
                            {serializeDetails(selectedRule.trigger.matcher)}
                          </pre>
                        </dd>
                      </div>
                      {selectedTriggerDisplay?.description ? (
                        <div>
                          <dt className="text-muted-foreground">Behavior</dt>
                          <dd className="font-medium text-foreground">{selectedTriggerDisplay.description}</dd>
                        </div>
                      ) : null}
                    </dl>
                  </div>

                  <div className="rounded-[22px] border border-border/70 bg-muted/20 p-4">
                    <div className="text-sm font-medium text-foreground">Policy</div>
                    <dl className="mt-3 grid gap-3 text-sm">
                      {selectedPolicyDisplay?.details.map((detail) => (
                        <div key={detail.label}>
                          <dt className="text-muted-foreground">{detail.label}</dt>
                          <dd className="font-medium text-foreground">{detail.value}</dd>
                        </div>
                      ))}
                      {selectedPolicyDisplay?.description ? (
                        <div>
                          <dt className="text-muted-foreground">Behavior</dt>
                          <dd className="font-medium text-foreground">{selectedPolicyDisplay.description}</dd>
                        </div>
                      ) : null}
                    </dl>
                  </div>

                  <div className="rounded-[22px] border border-border/70 bg-muted/20 p-4">
                    <div className="text-sm font-medium text-foreground">Delivery</div>
                    <dl className="mt-3 grid gap-3 text-sm">
                      {selectedDeliveryDisplay?.details.map((detail) => (
                        <div key={detail.label}>
                          <dt className="text-muted-foreground">{detail.label}</dt>
                          <dd className="whitespace-pre-wrap font-medium text-foreground">{detail.value}</dd>
                        </div>
                      ))}
                      <div>
                        <dt className="text-muted-foreground">Conversation</dt>
                        <dd className="font-medium text-foreground">{selectedRule.conversationId}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Created by participant</dt>
                        <dd className="font-medium text-foreground">{selectedRule.createdByParticipantId}</dd>
                      </div>
                      {selectedDeliveryDisplay?.description ? (
                        <div>
                          <dt className="text-muted-foreground">Behavior</dt>
                          <dd className="font-medium text-foreground">{selectedDeliveryDisplay.description}</dd>
                        </div>
                      ) : null}
                    </dl>
                  </div>
                </AppCardContent>
              </AppCard>

              <AppCard variant="panel">
                <AppCardHeader className="gap-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <AppCardTitle>Execution Log</AppCardTitle>
                      <AppCardDescription>
                        Trigger configuration and runtime executions are persisted separately for auditability.
                      </AppCardDescription>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void loadExecutions(selectedRule.id)}
                      disabled={loadingExecutions}
                    >
                      <RefreshCw className={cn(loadingExecutions && "animate-spin")} data-icon="inline-start" />
                      Refresh
                    </Button>
                  </div>
                </AppCardHeader>
                <AppCardContent className="flex flex-col gap-4">
                  {loadingExecutions ? (
                    <div className="rounded-[22px] border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
                      Loading execution history...
                    </div>
                  ) : executions.length === 0 ? (
                    <div className="rounded-[22px] border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
                      No executions recorded for this trigger yet.
                    </div>
                  ) : (
                    executions.map((execution, index) => (
                      <div key={execution.id} className="rounded-[22px] border border-border/70 px-4 py-4">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-foreground">
                              {executionOccurrenceTitle(execution)}
                            </div>
                            <div className="mt-1 text-xs text-muted-foreground">
                              Execution {execution.id.slice(0, 8)}
                            </div>
                            {execution.occurrenceDescription ? (
                              <p className="mt-2 text-sm text-muted-foreground">
                                {execution.occurrenceDescription}
                              </p>
                            ) : null}
                            {executionOccurrenceSummary(execution) ? (
                              <div className="mt-2">
                                <Badge variant="secondary">{executionOccurrenceSummary(execution)}</Badge>
                              </div>
                            ) : null}
                          </div>
                          <Badge variant={executionStatusVariant(execution.status)}>
                            {execution.status}
                          </Badge>
                        </div>
                        <div className="mt-3 grid gap-3 text-sm lg:grid-cols-2">
                          <div>
                            <div className="text-muted-foreground">Created</div>
                            <div className="font-medium text-foreground">{formatDateTime(execution.createdAt)}</div>
                          </div>
                          <div>
                            <div className="text-muted-foreground">Started</div>
                            <div className="font-medium text-foreground">{formatDateTime(execution.startedAt)}</div>
                          </div>
                          <div>
                            <div className="text-muted-foreground">Completed</div>
                            <div className="font-medium text-foreground">{formatDateTime(execution.completedAt)}</div>
                          </div>
                          <div>
                            <div className="text-muted-foreground">Occurrence</div>
                            <div className="font-medium text-foreground">
                              {formatDateTime(execution.occurrenceOccurredAt)}
                            </div>
                            <div className="mt-1 text-xs text-muted-foreground break-all">
                              {execution.occurrenceId}
                            </div>
                          </div>
                        </div>
                        {execution.errorMessage ? (
                          <div className="mt-3 rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                            {execution.errorMessage}
                          </div>
                        ) : null}
                        {index < executions.length - 1 ? <Separator className="mt-4" /> : null}
                      </div>
                    ))
                  )}
                </AppCardContent>
              </AppCard>
            </>
          ) : (
            <AppCard variant="panel">
              <AppCardContent className="py-16 text-center text-sm text-muted-foreground">
                Select a trigger to inspect its definition and execution history.
              </AppCardContent>
            </AppCard>
          )}
        </div>
      </div>
    </div>
  );
}
