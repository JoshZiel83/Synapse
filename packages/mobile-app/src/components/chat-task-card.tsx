import Feather from "@expo/vector-icons/Feather"
import { useEffect, useMemo, useRef, useState } from "react"
import {
  Animated,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"

import { ChatMarkdown } from "@/components/chat-markdown"
import { Button } from "@/components/ui"
import type { ChatTaskResolveInput, ChatTaskResolvePayload } from "@/lib/api"
import { theme } from "@/theme/tokens"
import {
  TASK_REQUEST_KIND,
  type TaskInputQuestionSummary,
  type TaskSummary,
  type SharedRuntimeAuthorizationGrantSpec,
  type RuntimeAuthorizationRequestedAction,
} from "@shared"

type TaskResolutionDraftPayload = ChatTaskResolvePayload

type DraftQuestionAnswer = {
  selectedOptionIds: string[]
  otherText: string
  text: string
}

const EMPTY_DRAFT: DraftQuestionAnswer = {
  selectedOptionIds: [],
  otherText: "",
  text: "",
}

function buildDraftQuestionAnswers(
  task: TaskSummary
): Record<string, DraftQuestionAnswer> {
  if (task.kind !== TASK_REQUEST_KIND.USER_INPUT || !task.userInput) {
    return {}
  }

  return Object.fromEntries(
    task.userInput.questions.map((question) => [
      question.id,
      {
        selectedOptionIds: [...(question.answer?.selectedOptionIds || [])],
        otherText: question.answer?.otherText || "",
        text: question.answer?.text || "",
      },
    ])
  )
}

function summarizeQuestionFieldAnswer(question: TaskInputQuestionSummary) {
  const parts: string[] = []

  if (question.answer?.selectedOptionLabels?.length) {
    parts.push(question.answer.selectedOptionLabels.join(", "))
  }

  if (question.answer?.otherText) {
    parts.push(question.answer.otherText)
  }

  if (question.answer?.text) {
    parts.push(question.answer.text)
  }

  return parts.join(" | ")
}

function summarizeTaskAnswers(task: TaskSummary) {
  if (task.kind !== TASK_REQUEST_KIND.USER_INPUT || !task.userInput) {
    return ""
  }

  const questionCount = task.userInput.questions.length
  return task.userInput.questions
    .map((question) => {
      const summary = summarizeQuestionFieldAnswer(question)
      if (!summary) {
        return ""
      }

      return questionCount > 1 ? `${question.prompt}: ${summary}` : summary
    })
    .filter((value) => value.length > 0)
    .join(" | ")
}

type TaskDisplayState =
  | "pending"
  | "answered"
  | "approved"
  | "rejected"
  | "cancelled"
  | "expired"
  | "failed"

function isTaskOpen(task: TaskSummary) {
  return (
    task.lifecycleStatus === "submitted" ||
    task.lifecycleStatus === "working" ||
    task.lifecycleStatus === "input_required" ||
    task.lifecycleStatus === "auth_required"
  )
}

function getTaskDisplayState(task: TaskSummary): TaskDisplayState {
  if (isTaskOpen(task)) return "pending"
  if (task.lifecycleStatus === "cancelled") return "cancelled"
  if (task.lifecycleStatus === "expired") return "expired"
  if (task.lifecycleStatus === "failed") return "failed"
  if (task.kind === TASK_REQUEST_KIND.USER_INPUT) return "answered"
  if (task.kind === TASK_REQUEST_KIND.PLAN_APPROVAL) {
    return task.outcome === "approved" ? "approved" : "rejected"
  }
  return task.outcome === "granted" ? "approved" : "rejected"
}

function getStatusMeta(displayState: TaskDisplayState) {
  switch (displayState) {
    case "pending":
      return {
        label: "待回答",
        icon: "clock" as const,
        backgroundColor: "rgba(37, 99, 235, 0.10)",
        borderColor: "rgba(37, 99, 235, 0.18)",
        color: theme.colors.primary,
      }
    case "answered":
      return {
        label: "已完成",
        icon: "check-circle" as const,
        backgroundColor: "rgba(21, 128, 61, 0.10)",
        borderColor: "rgba(21, 128, 61, 0.18)",
        color: theme.colors.success,
      }
    case "approved":
      return {
        label: "已批准",
        icon: "check-circle" as const,
        backgroundColor: "rgba(21, 128, 61, 0.10)",
        borderColor: "rgba(21, 128, 61, 0.18)",
        color: theme.colors.success,
      }
    case "rejected":
      return {
        label: "待修改",
        icon: "rotate-ccw" as const,
        backgroundColor: "rgba(245, 158, 11, 0.12)",
        borderColor: "rgba(245, 158, 11, 0.22)",
        color: theme.colors.accent,
      }
    case "cancelled":
      return {
        label: "已取消",
        icon: "slash" as const,
        backgroundColor: "rgba(115, 115, 115, 0.10)",
        borderColor: "rgba(115, 115, 115, 0.18)",
        color: theme.colors.textMuted,
      }
    case "expired":
      return {
        label: "已过期",
        icon: "alert-circle" as const,
        backgroundColor: "rgba(220, 38, 38, 0.10)",
        borderColor: "rgba(220, 38, 38, 0.18)",
        color: theme.colors.danger,
      }
    case "failed":
      return {
        label: "失败",
        icon: "alert-triangle" as const,
        backgroundColor: "rgba(220, 38, 38, 0.10)",
        borderColor: "rgba(220, 38, 38, 0.18)",
        color: theme.colors.danger,
      }
  }
}

function getStatusNote(
  task: TaskSummary,
  viewerCanResolve: boolean,
  canResolve: boolean
) {
  const targetName = task.target?.name?.trim() || "指定用户"
  const displayState = getTaskDisplayState(task)

  if (task.kind === TASK_REQUEST_KIND.USER_INPUT) {
    if (displayState === "pending") {
      return canResolve || viewerCanResolve
        ? "点击开始逐题作答"
        : `等待 ${targetName} 回答`
    }
    if (displayState === "answered") {
      return "点击查看答题结果"
    }
    if (displayState === "expired") {
      return "此问答已过期"
    }
    if (displayState === "cancelled") {
      return "此问答已被取消"
    }
    if (displayState === "failed") {
      return "此问答处理失败"
    }
    return "点击查看详情"
  }

  if (task.kind === TASK_REQUEST_KIND.PLAN_APPROVAL) {
    if (displayState === "pending") {
      return canResolve || viewerCanResolve
        ? "点击审批或要求修改"
        : `等待 ${targetName} 审批`
    }
    if (displayState === "approved") {
      return "计划已批准"
    }
    if (displayState === "rejected") {
      return "计划需要修改"
    }
    if (displayState === "cancelled") {
      return "该审批已被取消"
    }
    return "点击查看计划详情"
  }

  if (displayState === "pending") {
    return canResolve ? "点击选择授权范围" : "等待有权限的成员处理"
  }
  if (displayState === "approved") {
    return "授权已批准"
  }
  if (displayState === "rejected") {
    return "授权已拒绝"
  }
  if (displayState === "cancelled") {
    return "授权请求已取消"
  }
  return "点击查看详情"
}

function formatRuntimeAuthorizationPresetLabel(preset: string) {
  switch (preset) {
    case "once":
      return "仅本次"
    case "actor":
      return "当前 Actor"
    case "conversation":
      return "当前会话"
    case "workspace":
      return "整个工作区"
    default:
      return preset
  }
}

function describeRuntimeAuthorizationSpec(
  scope: SharedRuntimeAuthorizationGrantSpec
) {
  if (scope.capability === "filesystem" && scope.filesystem) {
    return {
      summary:
        scope.filesystem.access === "write"
          ? "文件系统写入权限"
          : "文件系统只读权限",
      detailLines:
        scope.filesystem.pathPrefixes.length > 0
          ? scope.filesystem.pathPrefixes
          : ["整个文件系统"],
    }
  }

  if (scope.capability === "browser" && scope.browser) {
    const target =
      scope.browser.scopeType === "host"
        ? scope.browser.host
        : scope.browser.scopeType === "domain"
          ? scope.browser.registrableDomain
          : scope.browser.scopeType === "origin"
            ? scope.browser.origin
            : undefined
    return {
      summary:
        scope.browser.action === "write" ? "浏览器写入操作" : "浏览器只读访问",
      detailLines: [target || "整个浏览器环境"],
    }
  }

  if (scope.capability === "commandline" && scope.commandline) {
    const cmd = scope.commandline
    // Structural narrowing via `"program" in cmd` instead of
    // `cmd.executor === "exec_file"` — see the analogous comment in
    // web-next's message-bubble.tsx. Both narrowings are correct when
    // the shared CommandlinePolicy discriminated union is fresh, but
    // the structural one survives stale @synapse/shared dist that
    // npm-workspace mid-builds occasionally produce.
    if ("program" in cmd) {
      const argv = cmd.argvPrefix ?? []
      const argvSummary = argv.length === 0 ? "" : ` ${argv.join(" ")}`
      const summaryLabel =
        cmd.commandMatchType === "argv_exact"
          ? "结构化命令授权（精确）"
          : cmd.commandMatchType === "argv_prefix"
            ? "结构化命令授权（前缀）"
            : "结构化命令授权（预批准）"
      return {
        summary: `${summaryLabel}：${cmd.program}${argvSummary}`,
        detailLines: [
          cmd.workingDirectory ? `工作目录：${cmd.workingDirectory}` : null,
          cmd.allowBundledToolchain ? "允许使用 Synapse 自带工具链" : null,
          cmd.allowedEnv && cmd.allowedEnv.length > 0
            ? `继承环境变量：${cmd.allowedEnv.join(", ")}`
            : null,
        ].filter((value): value is string => Boolean(value)),
      }
    }
    if (cmd.executor === "sandbox") {
      return {
        summary: "沙箱命令授权（隔离 shell）",
        detailLines: [
          "在 bwrap 沙箱内执行任意命令（无网络）",
          cmd.workingDirectory ? `工作目录：${cmd.workingDirectory}` : null,
          cmd.allowedEnv && cmd.allowedEnv.length > 0
            ? `继承环境变量：${cmd.allowedEnv.join(", ")}`
            : null,
        ].filter((value): value is string => Boolean(value)),
      }
    }
    return {
      summary:
        cmd.commandMatchType === "exact"
          ? `精确命令授权（${cmd.executor}）`
          : cmd.commandMatchType === "prefix"
            ? `命令前缀授权（${cmd.executor}）`
            : `命令行访问（${cmd.executor}）`,
      detailLines: [
        cmd.commandText || cmd.executor,
        cmd.workingDirectory ? `工作目录：${cmd.workingDirectory}` : null,
      ].filter((value): value is string => Boolean(value)),
    }
  }

  return {
    summary:
      scope.cua?.access === "write" ? "桌面输入控制权限" : "桌面观察权限",
    detailLines: ["Computer Use / CUA"],
  }
}

function describeRuntimeAuthorizationRequestedAction(
  action: RuntimeAuthorizationRequestedAction
) {
  const describedScope = describeRuntimeAuthorizationSpec(action)
  return {
    summary: action.summary,
    detailLines: action.detail
      ? [action.detail, ...describedScope.detailLines]
      : describedScope.detailLines,
  }
}

function isFieldComplete(
  question: TaskInputQuestionSummary,
  draft: DraftQuestionAnswer
) {
  const textValue = draft.text.trim()
  const otherValue = draft.otherText.trim()
  const selectedCount = draft.selectedOptionIds.length

  if (question.type === "text") {
    return question.required ? textValue.length > 0 : true
  }

  const hasOption = selectedCount > 0
  const hasOther = question.allowOther ? otherValue.length > 0 : false
  const answered = hasOption || hasOther

  if (!question.required && !answered) {
    return true
  }

  if (!answered) {
    return false
  }

  if (
    question.type === "multi_select" &&
    typeof question.minSelections === "number" &&
    selectedCount > 0 &&
    selectedCount < question.minSelections
  ) {
    return false
  }

  return true
}

function buildAnswersPayload(
  questions: TaskInputQuestionSummary[],
  draftAnswers: Record<string, DraftQuestionAnswer>
): TaskResolutionDraftPayload {
  return {
    answers: questions.map((question) => {
      const draft = draftAnswers[question.id] || EMPTY_DRAFT
      return {
        questionId: question.id,
        selectedOptionIds:
          draft.selectedOptionIds.length > 0
            ? draft.selectedOptionIds
            : undefined,
        otherText: draft.otherText.trim() || undefined,
        text: draft.text.trim() || undefined,
      }
    }),
  }
}

function withTaskCommandMetadata(
  task: TaskSummary,
  payload: TaskResolutionDraftPayload
): ChatTaskResolveInput {
  return {
    ...payload,
    commandId:
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `task-${Date.now().toString(36)}-${Math.random()
            .toString(16)
            .slice(2)}`,
    baseRevision: task.revision,
  }
}

function FieldOptionButton({
  selected,
  label,
  description,
  preview,
  disabled,
  onPress,
}: {
  selected: boolean
  label: string
  description?: string
  preview?: string
  disabled?: boolean
  onPress: () => void
}) {
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.optionCard,
        selected && styles.optionCardSelected,
        pressed && !disabled && styles.optionCardPressed,
        disabled && styles.optionCardDisabled,
      ]}
    >
      <View style={styles.optionCardIcon}>
        {selected ? (
          <Feather name="check-circle" size={18} color={theme.colors.primary} />
        ) : (
          <View style={styles.optionCardDot} />
        )}
      </View>
      <View style={styles.optionCardBody}>
        <Text style={styles.optionCardTitle}>{label}</Text>
        {description ? (
          <Text style={styles.optionCardDescription}>{description}</Text>
        ) : null}
        {preview ? (
          <Text style={styles.optionCardPreview}>{preview}</Text>
        ) : null}
      </View>
    </Pressable>
  )
}

function ReadOnlyUserInputQuestion({
  question,
  index,
}: {
  question: TaskInputQuestionSummary
  index: number
}) {
  const answer = question.answer
  const selectedOptionIds = new Set(answer?.selectedOptionIds || [])
  const fallbackSelectionSummary =
    (!question.options || question.options.length === 0) &&
    answer?.selectedOptionLabels?.length
      ? answer.selectedOptionLabels.join(", ")
      : ""
  const hasVisibleAnswer =
    selectedOptionIds.size > 0 ||
    Boolean(fallbackSelectionSummary) ||
    Boolean(answer?.otherText?.trim()) ||
    Boolean(answer?.text?.trim())

  return (
    <View style={styles.summarySection}>
      <Text style={styles.summaryIndex}>{`题目 ${index + 1}`}</Text>
      <Text style={styles.summaryTitle}>{question.prompt}</Text>
      {question.description ? (
        <Text style={styles.summaryDescription}>{question.description}</Text>
      ) : null}

      {question.type === "text" ? (
        <Text style={styles.summaryAnswer}>{answer?.text || "暂无回答"}</Text>
      ) : (
        <>
          {(question.options || []).length ? (
            <View style={styles.optionList}>
              {(question.options || []).map((option) => (
                <FieldOptionButton
                  key={option.id}
                  selected={selectedOptionIds.has(option.id)}
                  label={option.label}
                  description={option.description}
                  preview={option.preview}
                  disabled
                  onPress={() => {}}
                />
              ))}
            </View>
          ) : null}

          {fallbackSelectionSummary ? (
            <View style={styles.otherAnswerWrap}>
              <Text style={styles.otherAnswerLabel}>已选答案</Text>
              <Text style={styles.summaryAnswer}>
                {fallbackSelectionSummary}
              </Text>
            </View>
          ) : null}

          {answer?.otherText ? (
            <View style={styles.otherAnswerWrap}>
              <Text style={styles.otherAnswerLabel}>其他</Text>
              <Text style={styles.summaryAnswer}>{answer.otherText}</Text>
            </View>
          ) : null}

          {answer?.text ? (
            <View style={styles.otherAnswerWrap}>
              <Text style={styles.otherAnswerLabel}>补充说明</Text>
              <Text style={styles.summaryAnswer}>{answer.text}</Text>
            </View>
          ) : null}

          {!hasVisibleAnswer ? (
            <Text style={styles.summaryAnswer}>暂无回答</Text>
          ) : null}
        </>
      )}
    </View>
  )
}

function DeviceGrantSpecSection({
  eyebrow,
  summary,
  detailLines,
}: {
  eyebrow: string
  summary: string
  detailLines: string[]
}) {
  return (
    <View style={styles.summarySection}>
      <Text style={styles.summaryIndex}>{eyebrow}</Text>
      <Text style={styles.summaryTitle}>{summary}</Text>
      {detailLines.map((line, index) => (
        <Text key={`${eyebrow}-${index}`} style={styles.summaryAnswer}>
          {line}
        </Text>
      ))}
    </View>
  )
}

export function ChatTaskCard({
  task,
  onResolveTask,
}: {
  task: TaskSummary
  onResolveTask?: (
    taskId: string,
    input: ChatTaskResolveInput
  ) => Promise<TaskSummary>
}) {
  const insets = useSafeAreaInsets()
  const [open, setOpen] = useState(false)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [draftAnswers, setDraftAnswers] = useState<
    Record<string, DraftQuestionAnswer>
  >(() => buildDraftQuestionAnswers(task))
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [resolutionNoteDraft, setResolutionNoteDraft] = useState("")
  const [selectedRuntimeGrantOptionId, setSelectedRuntimeGrantOptionId] =
    useState<string | null>(
      task.runtimeAuthorization?.grantOptions[0]?.id || null
    )
  const draftAnswersRef = useRef(draftAnswers)
  const questionCardOffset = useRef(new Animated.Value(0)).current
  const userInput = task.userInput

  const viewerCanResolve = task.viewerCanResolve === true
  const taskIsOpen = isTaskOpen(task)
  const canResolveUserInput =
    task.kind === TASK_REQUEST_KIND.USER_INPUT &&
    Boolean(onResolveTask) &&
    viewerCanResolve &&
    taskIsOpen
  const canResolvePlanApproval =
    task.kind === TASK_REQUEST_KIND.PLAN_APPROVAL &&
    Boolean(onResolveTask) &&
    viewerCanResolve &&
    taskIsOpen
  const canResolveRuntimeAuthorization =
    task.kind === TASK_REQUEST_KIND.RUNTIME_AUTHORIZATION &&
    Boolean(onResolveTask) &&
    viewerCanResolve &&
    taskIsOpen
  const canResolve =
    canResolveUserInput ||
    canResolvePlanApproval ||
    canResolveRuntimeAuthorization
  const statusMeta = getStatusMeta(getTaskDisplayState(task))

  useEffect(() => {
    const nextDraftAnswers = buildDraftQuestionAnswers(task)
    draftAnswersRef.current = nextDraftAnswers
    setDraftAnswers(nextDraftAnswers)
    setCurrentIndex(0)
    setSubmitting(false)
    setSubmitError(null)
    setResolutionNoteDraft("")
    setSelectedRuntimeGrantOptionId(
      task.runtimeAuthorization?.grantOptions[0]?.id || null
    )
  }, [task.id, task.revision, task.lifecycleStatus, task.outcome])

  useEffect(() => {
    if (!open || !canResolve) {
      questionCardOffset.setValue(0)
      return
    }

    questionCardOffset.setValue(26)
    Animated.spring(questionCardOffset, {
      toValue: 0,
      useNativeDriver: true,
      speed: 18,
      bounciness: 6,
    }).start()
  }, [canResolve, currentIndex, open, questionCardOffset])

  const answerSummary = useMemo(() => summarizeTaskAnswers(task), [task])

  const currentField = userInput?.questions[currentIndex] ?? null
  const currentDraft = currentField
    ? draftAnswers[currentField.id] || EMPTY_DRAFT
    : EMPTY_DRAFT
  const questionCardOpacity = questionCardOffset.interpolate({
    inputRange: [0, 26],
    outputRange: [1, 0],
  })

  function applyDraftAnswer(
    questionId: string,
    updater: (draft: DraftQuestionAnswer) => DraftQuestionAnswer
  ) {
    const nextAnswers = {
      ...draftAnswersRef.current,
      [questionId]: updater(draftAnswersRef.current[questionId] || EMPTY_DRAFT),
    }

    draftAnswersRef.current = nextAnswers
    setDraftAnswers(nextAnswers)
    return nextAnswers
  }

  async function submitAnswers(
    answers: Record<string, DraftQuestionAnswer> = draftAnswersRef.current
  ) {
    if (!userInput || !onResolveTask || !canResolveUserInput) {
      return
    }

    setSubmitting(true)
    setSubmitError(null)
    try {
      await onResolveTask(
        task.id,
        withTaskCommandMetadata(
          task,
          buildAnswersPayload(userInput.questions, answers)
        )
      )
      setOpen(false)
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : "提交答题结果失败。"
      )
    } finally {
      setSubmitting(false)
    }
  }

  async function submitTaskResolution(
    payload: TaskResolutionDraftPayload,
    fallbackErrorMessage: string
  ) {
    if (!onResolveTask) {
      return
    }

    setSubmitting(true)
    setSubmitError(null)
    try {
      await onResolveTask(task.id, withTaskCommandMetadata(task, payload))
      setOpen(false)
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : fallbackErrorMessage
      )
    } finally {
      setSubmitting(false)
    }
  }

  function goToNextQuestion(
    answers: Record<string, DraftQuestionAnswer> = draftAnswersRef.current
  ) {
    if (!userInput || !currentField) {
      return
    }

    if (
      !isFieldComplete(currentField, answers[currentField.id] || EMPTY_DRAFT)
    ) {
      return
    }

    if (currentIndex >= userInput.questions.length - 1) {
      void submitAnswers(answers)
      return
    }

    setCurrentIndex((value) =>
      Math.min(value + 1, userInput.questions.length - 1)
    )
  }

  function handleSelectOption(
    field: TaskInputQuestionSummary,
    optionId: string
  ) {
    if (!canResolveUserInput || submitting) {
      return
    }

    const nextAnswers = applyDraftAnswer(field.id, (draft) => {
      if (field.type === "single_select") {
        return {
          ...draft,
          selectedOptionIds: [optionId],
          otherText: "",
        }
      }

      const hasOption = draft.selectedOptionIds.includes(optionId)
      if (hasOption) {
        return {
          ...draft,
          selectedOptionIds: draft.selectedOptionIds.filter(
            (id) => id !== optionId
          ),
        }
      }

      if (
        typeof field.maxSelections === "number" &&
        draft.selectedOptionIds.length >= field.maxSelections
      ) {
        return draft
      }

      return {
        ...draft,
        selectedOptionIds: [...draft.selectedOptionIds, optionId],
      }
    })

    if (field.type === "single_select" && !field.allowOther) {
      goToNextQuestion(nextAnswers)
    }
  }

  const kindMeta =
    task.kind === TASK_REQUEST_KIND.USER_INPUT
      ? {
          label: "表单",
          icon: "help-circle" as const,
        }
      : task.kind === TASK_REQUEST_KIND.PLAN_APPROVAL
        ? {
            label: "计划审批",
            icon: "git-branch" as const,
          }
        : {
            label: "授权",
            icon: "shield" as const,
          }

  const cardTitle =
    task.kind === TASK_REQUEST_KIND.USER_INPUT
      ? task.userInput?.title || "表单"
      : task.kind === TASK_REQUEST_KIND.PLAN_APPROVAL
        ? task.planApproval?.title || "计划审批"
        : task.runtimeAuthorization
          ? `授权 ${task.runtimeAuthorization.runtimeToolStableKey}`
          : "授权请求"

  const cardDescription =
    task.kind === TASK_REQUEST_KIND.USER_INPUT
      ? task.userInput?.instructions
      : task.kind === TASK_REQUEST_KIND.PLAN_APPROVAL
        ? task.planApproval?.summary
        : task.runtimeAuthorization?.reason

  const cardSummary =
    task.kind === TASK_REQUEST_KIND.USER_INPUT
      ? answerSummary
      : task.kind === TASK_REQUEST_KIND.PLAN_APPROVAL
        ? task.resolutionNote
        : task.runtimeAuthorization?.approvedGrant
          ? "已生成授权范围"
          : task.runtimeAuthorization?.exposureDisplayName

  return (
    <View style={styles.eventWrap}>
      <Pressable
        accessibilityRole="button"
        onPress={() => setOpen(true)}
        style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      >
        <View style={styles.cardHeader}>
          <View style={styles.kindBadge}>
            <Feather
              name={kindMeta.icon}
              size={14}
              color={theme.colors.primary}
            />
            <Text style={styles.kindBadgeText}>{kindMeta.label}</Text>
          </View>
          <View
            style={[
              styles.statusBadge,
              {
                backgroundColor: statusMeta.backgroundColor,
                borderColor: statusMeta.borderColor,
              },
            ]}
          >
            <Feather
              name={statusMeta.icon}
              size={12}
              color={statusMeta.color}
            />
            <Text style={[styles.statusBadgeText, { color: statusMeta.color }]}>
              {statusMeta.label}
            </Text>
          </View>
        </View>

        <Text style={styles.cardTitle}>{cardTitle}</Text>
        {cardDescription ? (
          <Text style={styles.cardDescription}>{cardDescription}</Text>
        ) : null}
        {cardSummary ? (
          <Text numberOfLines={2} style={styles.cardSummary}>
            {cardSummary}
          </Text>
        ) : null}

        <View style={styles.cardFooter}>
          <Text style={styles.cardFooterText}>
            {getStatusNote(task, viewerCanResolve, canResolve)}
          </Text>
          <Feather
            name="chevron-up"
            size={16}
            color={theme.colors.textMuted}
            style={styles.cardFooterIcon}
          />
        </View>
      </Pressable>

      <Modal
        visible={open}
        transparent
        animationType="slide"
        onRequestClose={() => setOpen(false)}
      >
        <KeyboardAvoidingView
          style={styles.sheetOverlay}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setOpen(false)}
          />

          <View
            style={[
              styles.sheet,
              {
                paddingBottom: Math.max(insets.bottom, 12),
              },
            ]}
          >
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetEyebrow}>
                {canResolveUserInput && currentField && userInput
                  ? `第 ${currentIndex + 1} / ${userInput.questions.length} 题`
                  : statusMeta.label}
              </Text>
              <Text style={styles.sheetTitle}>{cardTitle}</Text>
              {cardDescription ? (
                <Text style={styles.sheetDescription}>{cardDescription}</Text>
              ) : null}
            </View>

            {canResolveUserInput && currentField && userInput ? (
              <>
                <ScrollView
                  style={styles.sheetScroll}
                  contentContainerStyle={styles.sheetScrollContent}
                  keyboardShouldPersistTaps="handled"
                >
                  <Animated.View
                    style={[
                      styles.questionCard,
                      {
                        opacity: questionCardOpacity,
                        transform: [{ translateX: questionCardOffset }],
                      },
                    ]}
                  >
                    <View style={styles.questionTopMeta}>
                      <Text style={styles.questionHeader}>
                        {currentField.header}
                      </Text>
                      {currentField.required ? (
                        <Text style={styles.questionRequired}>必填</Text>
                      ) : null}
                    </View>
                    <Text style={styles.questionTitle}>
                      {currentField.prompt}
                    </Text>
                    {currentField.description ? (
                      <Text style={styles.questionDescription}>
                        {currentField.description}
                      </Text>
                    ) : null}

                    {currentField.type === "text" ? (
                      <TextInput
                        multiline={!currentField.secret}
                        secureTextEntry={Boolean(currentField.secret)}
                        value={currentDraft.text}
                        onChangeText={(value) => {
                          applyDraftAnswer(currentField.id, (draft) => ({
                            ...draft,
                            text: value,
                          }))
                        }}
                        placeholder={currentField.placeholder || "请输入内容"}
                        placeholderTextColor={theme.colors.textSoft}
                        style={[
                          styles.textAnswerInput,
                          currentField.secret && styles.secretAnswerInput,
                        ]}
                        editable={!submitting}
                      />
                    ) : (
                      <View style={styles.optionList}>
                        {(currentField.options || []).map((option) => (
                          <FieldOptionButton
                            key={option.id}
                            selected={currentDraft.selectedOptionIds.includes(
                              option.id
                            )}
                            label={option.label}
                            description={option.description}
                            preview={option.preview}
                            disabled={submitting}
                            onPress={() =>
                              handleSelectOption(currentField, option.id)
                            }
                          />
                        ))}
                      </View>
                    )}

                    {currentField.allowOther ? (
                      <View style={styles.otherAnswerWrap}>
                        <Text style={styles.otherAnswerLabel}>其他</Text>
                        <TextInput
                          multiline
                          value={currentDraft.otherText}
                          onChangeText={(value) => {
                            applyDraftAnswer(currentField.id, (draft) => ({
                              ...draft,
                              otherText: value,
                              selectedOptionIds:
                                currentField.type === "single_select" &&
                                value.trim().length > 0
                                  ? []
                                  : draft.selectedOptionIds,
                            }))
                          }}
                          placeholder="补充你的答案"
                          placeholderTextColor={theme.colors.textSoft}
                          style={styles.otherAnswerInput}
                          editable={!submitting}
                        />
                      </View>
                    ) : null}
                  </Animated.View>

                  {submitError ? (
                    <View style={styles.errorCard}>
                      <Feather
                        name="alert-circle"
                        size={16}
                        color={theme.colors.danger}
                      />
                      <Text style={styles.errorText}>{submitError}</Text>
                    </View>
                  ) : null}
                </ScrollView>

                <View style={styles.sheetActions}>
                  <Button
                    label={currentIndex > 0 ? "上一题" : "关闭"}
                    variant="secondary"
                    onPress={() => {
                      if (currentIndex > 0) {
                        setCurrentIndex((value) => Math.max(0, value - 1))
                        return
                      }
                      setOpen(false)
                    }}
                    style={styles.actionButton}
                  />
                  <Button
                    label={
                      submitting
                        ? "提交中..."
                        : currentIndex >= userInput.questions.length - 1
                          ? "提交答案"
                          : "下一题"
                    }
                    onPress={() => goToNextQuestion()}
                    disabled={
                      submitting || !isFieldComplete(currentField, currentDraft)
                    }
                    style={styles.actionButton}
                  />
                </View>
              </>
            ) : (
              <>
                <ScrollView
                  style={styles.sheetScroll}
                  contentContainerStyle={styles.sheetScrollContent}
                >
                  {task.kind === TASK_REQUEST_KIND.USER_INPUT ? (
                    (userInput?.questions || []).map((question, index) => {
                      return (
                        <ReadOnlyUserInputQuestion
                          key={question.id}
                          question={question}
                          index={index}
                        />
                      )
                    })
                  ) : task.kind === TASK_REQUEST_KIND.PLAN_APPROVAL ? (
                    <>
                      <View style={styles.summarySection}>
                        <Text style={styles.summaryIndex}>计划内容</Text>
                        {task.planApproval?.planMarkdown ? (
                          <View style={styles.summaryMarkdownWrap}>
                            <ChatMarkdown
                              markdown={task.planApproval.planMarkdown}
                              mine={false}
                            />
                          </View>
                        ) : (
                          <Text style={styles.summaryAnswer}>暂无计划内容</Text>
                        )}
                      </View>
                      {(task.planApproval?.checklist || []).map(
                        (step, index) => (
                          <View
                            key={`${step.step}-${index}`}
                            style={styles.summarySection}
                          >
                            <Text
                              style={styles.summaryIndex}
                            >{`检查项 ${index + 1}`}</Text>
                            <Text style={styles.summaryTitle}>{step.step}</Text>
                            <Text style={styles.summaryAnswer}>
                              {step.status}
                            </Text>
                          </View>
                        )
                      )}
                      {task.resolutionNote ? (
                        <View style={styles.summarySection}>
                          <Text style={styles.summaryIndex}>备注</Text>
                          <Text style={styles.summaryAnswer}>
                            {task.resolutionNote}
                          </Text>
                        </View>
                      ) : null}
                      {canResolvePlanApproval ? (
                        <View style={styles.summarySection}>
                          <Text style={styles.summaryIndex}>审批备注</Text>
                          <TextInput
                            multiline
                            value={resolutionNoteDraft}
                            onChangeText={setResolutionNoteDraft}
                            placeholder="可选：填写审批意见或修改建议"
                            placeholderTextColor={theme.colors.textSoft}
                            style={styles.otherAnswerInput}
                            editable={!submitting}
                          />
                        </View>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <View style={styles.summarySection}>
                        <Text style={styles.summaryIndex}>设备</Text>
                        <Text style={styles.summaryTitle}>
                          {task.runtimeAuthorization?.runtimeDisplayName ||
                            "Device"}
                        </Text>
                        <Text style={styles.summaryDescription}>
                          {task.runtimeAuthorization?.reason || "等待授权"}
                        </Text>
                      </View>
                      <View style={styles.summarySection}>
                        <Text style={styles.summaryIndex}>暴露能力</Text>
                        <Text style={styles.summaryAnswer}>
                          {task.runtimeAuthorization?.exposureDisplayName ||
                            "未提供"}
                        </Text>
                      </View>
                      {task.runtimeAuthorization?.requestedAction ? (
                        <DeviceGrantSpecSection
                          eyebrow="请求操作"
                          summary={
                            describeRuntimeAuthorizationRequestedAction(
                              task.runtimeAuthorization.requestedAction
                            ).summary
                          }
                          detailLines={
                            describeRuntimeAuthorizationRequestedAction(
                              task.runtimeAuthorization.requestedAction
                            ).detailLines
                          }
                        />
                      ) : null}
                      {(task.runtimeAuthorization?.grantOptions || []).map(
                        (option) => (
                          <FieldOptionButton
                            key={option.id}
                            selected={
                              selectedRuntimeGrantOptionId === option.id
                            }
                            label={option.summary}
                            description={option.detail}
                            disabled={
                              !canResolveRuntimeAuthorization || submitting
                            }
                            onPress={() =>
                              setSelectedRuntimeGrantOptionId(option.id)
                            }
                          />
                        )
                      )}
                      {(task.runtimeAuthorization?.availablePresets || [])
                        .length ? (
                        <View style={styles.summarySection}>
                          <Text style={styles.summaryIndex}>授权范围</Text>
                          <Text style={styles.summaryAnswer}>
                            {(task.runtimeAuthorization?.availablePresets || [])
                              .map((preset) =>
                                formatRuntimeAuthorizationPresetLabel(preset)
                              )
                              .join(" / ")}
                          </Text>
                        </View>
                      ) : null}
                      {task.runtimeAuthorization?.approvedPreset ? (
                        <View style={styles.summarySection}>
                          <Text style={styles.summaryIndex}>已批准范围</Text>
                          <Text style={styles.summaryAnswer}>
                            {formatRuntimeAuthorizationPresetLabel(
                              task.runtimeAuthorization.approvedPreset
                            )}
                          </Text>
                        </View>
                      ) : null}
                      {task.runtimeAuthorization?.approvedGrant ? (
                        <>
                          <DeviceGrantSpecSection
                            eyebrow="已批准授权"
                            summary={
                              describeRuntimeAuthorizationSpec(
                                task.runtimeAuthorization.approvedGrant
                              ).summary
                            }
                            detailLines={[
                              ...describeRuntimeAuthorizationSpec(
                                task.runtimeAuthorization.approvedGrant
                              ).detailLines,
                              `scope: ${task.runtimeAuthorization.approvedGrant.scope}`,
                              `retention: ${task.runtimeAuthorization.approvedGrant.retention}`,
                            ]}
                          />
                        </>
                      ) : null}
                      {task.resolutionNote ? (
                        <View style={styles.summarySection}>
                          <Text style={styles.summaryIndex}>备注</Text>
                          <Text style={styles.summaryAnswer}>
                            {task.resolutionNote}
                          </Text>
                        </View>
                      ) : null}
                      {canResolveRuntimeAuthorization ? (
                        <View style={styles.summarySection}>
                          <Text style={styles.summaryIndex}>审批备注</Text>
                          <TextInput
                            multiline
                            value={resolutionNoteDraft}
                            onChangeText={setResolutionNoteDraft}
                            placeholder="可选：填写授权说明"
                            placeholderTextColor={theme.colors.textSoft}
                            style={styles.otherAnswerInput}
                            editable={!submitting}
                          />
                        </View>
                      ) : null}
                    </>
                  )}
                  {submitError ? (
                    <View style={styles.errorCard}>
                      <Text style={styles.errorText}>{submitError}</Text>
                    </View>
                  ) : null}
                </ScrollView>

                <View style={styles.sheetActions}>
                  {canResolvePlanApproval ? (
                    <>
                      <Button
                        label={submitting ? "处理中..." : "要求修改"}
                        variant="secondary"
                        onPress={() =>
                          void submitTaskResolution(
                            {
                              decision: "revise",
                              note: resolutionNoteDraft.trim() || undefined,
                            },
                            "提交审批结果失败。"
                          )
                        }
                        style={styles.actionButton}
                        disabled={submitting}
                      />
                      <Button
                        label={submitting ? "处理中..." : "批准计划"}
                        onPress={() =>
                          void submitTaskResolution(
                            {
                              decision: "approve",
                              note: resolutionNoteDraft.trim() || undefined,
                            },
                            "提交审批结果失败。"
                          )
                        }
                        style={styles.actionButton}
                        disabled={submitting}
                      />
                    </>
                  ) : canResolveRuntimeAuthorization ? (
                    <View style={styles.multiActionWrap}>
                      {(task.runtimeAuthorization?.availablePresets || []).map(
                        (preset) => (
                          <Button
                            key={preset}
                            label={
                              submitting
                                ? "处理中..."
                                : formatRuntimeAuthorizationPresetLabel(preset)
                            }
                            onPress={() =>
                              selectedRuntimeGrantOptionId
                                ? void submitTaskResolution(
                                    {
                                      decision: "approve",
                                      preset,
                                      selectedGrantOptionId:
                                        selectedRuntimeGrantOptionId,
                                      note:
                                        resolutionNoteDraft.trim() || undefined,
                                    },
                                    "提交授权结果失败。"
                                  )
                                : undefined
                            }
                            style={styles.singleActionButton}
                            disabled={
                              submitting || !selectedRuntimeGrantOptionId
                            }
                          />
                        )
                      )}
                      <Button
                        label={submitting ? "处理中..." : "拒绝"}
                        variant="secondary"
                        onPress={() =>
                          void submitTaskResolution(
                            {
                              decision: "reject",
                              note: resolutionNoteDraft.trim() || undefined,
                            },
                            "提交授权结果失败。"
                          )
                        }
                        style={styles.singleActionButton}
                        disabled={submitting}
                      />
                    </View>
                  ) : (
                    <Button
                      label="关闭"
                      variant="secondary"
                      onPress={() => setOpen(false)}
                      style={styles.singleActionButton}
                    />
                  )}
                </View>
              </>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  )
}

const styles = StyleSheet.create({
  eventWrap: {
    alignItems: "center",
    paddingVertical: 4,
  },
  card: {
    width: "92%",
    maxWidth: 360,
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: 16,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    gap: 10,
  },
  cardPressed: {
    opacity: 0.92,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  kindBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: theme.radii.pill,
    backgroundColor: theme.colors.primarySoft,
  },
  kindBadgeText: {
    fontSize: 12,
    fontWeight: "700",
    color: theme.colors.primary,
  },
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: theme.radii.pill,
    borderWidth: 1,
  },
  statusBadgeText: {
    fontSize: 12,
    fontWeight: "700",
  },
  cardTitle: {
    fontSize: 16,
    lineHeight: 23,
    fontWeight: "800",
    color: theme.colors.text,
  },
  cardDescription: {
    fontSize: 13,
    lineHeight: 20,
    color: theme.colors.textMuted,
  },
  cardSummary: {
    fontSize: 12,
    lineHeight: 18,
    color: theme.colors.text,
    backgroundColor: theme.colors.backgroundAlt,
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  cardFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    marginTop: 2,
  },
  cardFooterText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 18,
    color: theme.colors.textSoft,
  },
  cardFooterIcon: {
    transform: [{ rotate: "180deg" }],
  },
  sheetOverlay: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: theme.colors.overlay,
  },
  sheet: {
    maxHeight: "82%",
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    backgroundColor: theme.colors.background,
    paddingHorizontal: 18,
    paddingTop: 10,
    gap: 14,
  },
  sheetHandle: {
    alignSelf: "center",
    width: 42,
    height: 5,
    borderRadius: 999,
    backgroundColor: theme.colors.borderStrong,
  },
  sheetHeader: {
    gap: 6,
  },
  sheetEyebrow: {
    fontSize: 12,
    fontWeight: "700",
    color: theme.colors.primary,
  },
  sheetTitle: {
    fontSize: 20,
    lineHeight: 28,
    fontWeight: "800",
    color: theme.colors.text,
  },
  sheetDescription: {
    fontSize: 14,
    lineHeight: 22,
    color: theme.colors.textMuted,
  },
  sheetScroll: {
    maxHeight: 420,
  },
  sheetScrollContent: {
    gap: 12,
    paddingBottom: 4,
  },
  questionCard: {
    paddingTop: 2,
    gap: 12,
  },
  questionTopMeta: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  questionHeader: {
    fontSize: 12,
    lineHeight: 18,
    fontWeight: "700",
    color: theme.colors.primary,
  },
  questionTitle: {
    fontSize: 18,
    lineHeight: 26,
    fontWeight: "800",
    color: theme.colors.text,
  },
  questionDescription: {
    fontSize: 14,
    lineHeight: 22,
    color: theme.colors.textMuted,
  },
  questionRequired: {
    alignSelf: "flex-start",
    fontSize: 11,
    fontWeight: "700",
    color: theme.colors.textSoft,
    backgroundColor: theme.colors.backgroundAlt,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: theme.radii.pill,
  },
  optionList: {
    gap: 10,
  },
  optionCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  optionCardSelected: {
    borderColor: "rgba(37, 99, 235, 0.22)",
    backgroundColor: theme.colors.primarySoft,
  },
  optionCardPressed: {
    opacity: 0.88,
  },
  optionCardDisabled: {
    opacity: 0.7,
  },
  optionCardIcon: {
    width: 20,
    alignItems: "center",
    paddingTop: 1,
  },
  optionCardDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginTop: 5,
    backgroundColor: theme.colors.textSoft,
  },
  optionCardBody: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  optionCardTitle: {
    fontSize: 15,
    lineHeight: 21,
    fontWeight: "700",
    color: theme.colors.text,
  },
  optionCardDescription: {
    fontSize: 13,
    lineHeight: 19,
    color: theme.colors.textMuted,
  },
  optionCardPreview: {
    marginTop: 4,
    fontSize: 12,
    lineHeight: 18,
    color: theme.colors.textSoft,
  },
  textAnswerInput: {
    minHeight: 132,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    lineHeight: 22,
    color: theme.colors.text,
    textAlignVertical: "top",
  },
  secretAnswerInput: {
    minHeight: 54,
  },
  otherAnswerWrap: {
    gap: 8,
  },
  otherAnswerLabel: {
    fontSize: 13,
    fontWeight: "700",
    color: theme.colors.textMuted,
  },
  otherAnswerInput: {
    minHeight: 96,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    lineHeight: 22,
    color: theme.colors.text,
    textAlignVertical: "top",
  },
  errorCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    borderRadius: 16,
    backgroundColor: theme.colors.dangerSoft,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  errorText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 19,
    color: theme.colors.danger,
  },
  sheetActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  actionButton: {
    flex: 1,
  },
  singleActionButton: {
    flex: 1,
  },
  multiActionWrap: {
    flex: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  summarySection: {
    gap: 6,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  summaryIndex: {
    fontSize: 11,
    fontWeight: "700",
    color: theme.colors.primary,
  },
  summaryTitle: {
    fontSize: 16,
    lineHeight: 22,
    fontWeight: "800",
    color: theme.colors.text,
  },
  summaryDescription: {
    fontSize: 13,
    lineHeight: 19,
    color: theme.colors.textMuted,
  },
  summaryAnswer: {
    fontSize: 14,
    lineHeight: 21,
    color: theme.colors.text,
    backgroundColor: theme.colors.backgroundAlt,
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  summaryMarkdownWrap: {
    borderRadius: 14,
    backgroundColor: theme.colors.backgroundAlt,
    paddingHorizontal: 10,
    paddingVertical: 9,
    overflow: "hidden",
  },
})
