import Feather from "@expo/vector-icons/Feather";
import { useEffect, useMemo, useRef, useState } from "react";
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
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/ui";
import type { ChatInteractionResponseInput } from "@/lib/api";
import { theme } from "@/theme/tokens";
import {
  INTERACTION_REQUEST_KIND,
  type InteractionInputQuestionSummary,
  type InteractionRequestSummary,
} from "@shared";

type DraftQuestionAnswer = {
  selectedOptionIds: string[];
  otherText: string;
  text: string;
};

const EMPTY_DRAFT: DraftQuestionAnswer = {
  selectedOptionIds: [],
  otherText: "",
  text: "",
};

function buildDraftQuestionAnswers(
  interaction: InteractionRequestSummary,
): Record<string, DraftQuestionAnswer> {
  if (
    interaction.kind !== INTERACTION_REQUEST_KIND.USER_INPUT ||
    !interaction.userInput
  ) {
    return {};
  }

  return Object.fromEntries(
    interaction.userInput.questions.map((question) => [
      question.id,
      {
        selectedOptionIds: [...(question.answer?.selectedOptionIds || [])],
        otherText: question.answer?.otherText || "",
        text: question.answer?.text || "",
      },
    ]),
  );
}

function summarizeQuestionFieldAnswer(question: InteractionInputQuestionSummary) {
  const parts: string[] = [];

  if (question.answer?.selectedOptionLabels?.length) {
    parts.push(question.answer.selectedOptionLabels.join(", "));
  }

  if (question.answer?.otherText) {
    parts.push(question.answer.otherText);
  }

  if (question.answer?.text) {
    parts.push(question.answer.text);
  }

  return parts.join(" | ");
}

function summarizeInteractionAnswers(interaction: InteractionRequestSummary) {
  if (
    interaction.kind !== INTERACTION_REQUEST_KIND.USER_INPUT ||
    !interaction.userInput
  ) {
    return "";
  }

  const questionCount = interaction.userInput.questions.length;
  return interaction.userInput.questions
    .map((question) => {
      const summary = summarizeQuestionFieldAnswer(question);
      if (!summary) {
        return "";
      }

      return questionCount > 1 ? `${question.prompt}: ${summary}` : summary;
    })
    .filter((value) => value.length > 0)
    .join(" | ");
}

function getStatusMeta(status: InteractionRequestSummary["status"]) {
  switch (status) {
    case "pending":
      return {
        label: "待回答",
        icon: "clock" as const,
        backgroundColor: "rgba(37, 99, 235, 0.10)",
        borderColor: "rgba(37, 99, 235, 0.18)",
        color: theme.colors.primary,
      };
    case "answered":
      return {
        label: "已完成",
        icon: "check-circle" as const,
        backgroundColor: "rgba(21, 128, 61, 0.10)",
        borderColor: "rgba(21, 128, 61, 0.18)",
        color: theme.colors.success,
      };
    case "approved":
      return {
        label: "已批准",
        icon: "check-circle" as const,
        backgroundColor: "rgba(21, 128, 61, 0.10)",
        borderColor: "rgba(21, 128, 61, 0.18)",
        color: theme.colors.success,
      };
    case "rejected":
      return {
        label: "待修改",
        icon: "rotate-ccw" as const,
        backgroundColor: "rgba(245, 158, 11, 0.12)",
        borderColor: "rgba(245, 158, 11, 0.22)",
        color: theme.colors.accent,
      };
    case "cancelled":
      return {
        label: "已取消",
        icon: "slash" as const,
        backgroundColor: "rgba(115, 115, 115, 0.10)",
        borderColor: "rgba(115, 115, 115, 0.18)",
        color: theme.colors.textMuted,
      };
    case "expired":
      return {
        label: "已过期",
        icon: "alert-circle" as const,
        backgroundColor: "rgba(220, 38, 38, 0.10)",
        borderColor: "rgba(220, 38, 38, 0.18)",
        color: theme.colors.danger,
      };
    case "superseded":
      return {
        label: "已失效",
        icon: "corner-up-right" as const,
        backgroundColor: "rgba(115, 115, 115, 0.10)",
        borderColor: "rgba(115, 115, 115, 0.18)",
        color: theme.colors.textMuted,
      };
    default:
      return {
        label: status,
        icon: "file-text" as const,
        backgroundColor: "rgba(115, 115, 115, 0.10)",
        borderColor: "rgba(115, 115, 115, 0.18)",
        color: theme.colors.textMuted,
      };
  }
}

function getStatusNote(
  interaction: InteractionRequestSummary,
  isTargetUser: boolean,
  canResolve: boolean,
) {
  const targetName = interaction.target?.name?.trim() || "指定用户";

  if (interaction.status === "pending") {
    return canResolve || isTargetUser
      ? "点击开始逐题作答"
      : `等待 ${targetName} 回答`;
  }

  if (interaction.status === "answered") {
    return "点击查看答题结果";
  }

  if (interaction.status === "expired") {
    return "此问答已过期";
  }

  if (interaction.status === "cancelled") {
    return "此问答已被取消";
  }

  if (interaction.status === "superseded") {
    return "此问答已被后续操作覆盖";
  }

  return "点击查看详情";
}

function isFieldComplete(
  question: InteractionInputQuestionSummary,
  draft: DraftQuestionAnswer,
) {
  const textValue = draft.text.trim();
  const otherValue = draft.otherText.trim();
  const selectedCount = draft.selectedOptionIds.length;

  if (question.type === "text") {
    return question.required ? textValue.length > 0 : true;
  }

  const hasOption = selectedCount > 0;
  const hasOther = question.allowOther ? otherValue.length > 0 : false;
  const answered = hasOption || hasOther;

  if (!question.required && !answered) {
    return true;
  }

  if (!answered) {
    return false;
  }

  if (
    question.type === "multi_select" &&
    typeof question.minSelections === "number" &&
    selectedCount > 0 &&
    selectedCount < question.minSelections
  ) {
    return false;
  }

  return true;
}

function buildAnswersPayload(
  questions: InteractionInputQuestionSummary[],
  draftAnswers: Record<string, DraftQuestionAnswer>,
): ChatInteractionResponseInput {
  return {
    answers: questions.map((question) => {
      const draft = draftAnswers[question.id] || EMPTY_DRAFT;
      return {
        questionId: question.id,
        selectedOptionIds:
          draft.selectedOptionIds.length > 0 ? draft.selectedOptionIds : undefined,
        otherText: draft.otherText.trim() || undefined,
        text: draft.text.trim() || undefined,
      };
    }),
  };
}

function FieldOptionButton({
  selected,
  label,
  description,
  preview,
  disabled,
  onPress,
}: {
  selected: boolean;
  label: string;
  description?: string;
  preview?: string;
  disabled?: boolean;
  onPress: () => void;
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
  );
}

export function ChatQuestionInteractionCard({
  interaction,
  viewerParticipantId,
  viewerWorkspaceMemberId,
  onResolveInteraction,
}: {
  interaction: InteractionRequestSummary;
  viewerParticipantId?: string;
  viewerWorkspaceMemberId?: string | null;
  onResolveInteraction?: (
    interactionId: string,
    input: ChatInteractionResponseInput,
  ) => Promise<InteractionRequestSummary>;
}) {
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [draftAnswers, setDraftAnswers] = useState<
    Record<string, DraftQuestionAnswer>
  >(() => buildDraftQuestionAnswers(interaction));
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const draftAnswersRef = useRef(draftAnswers);
  const questionCardOffset = useRef(new Animated.Value(0)).current;
  const userInput = interaction.userInput;

  const isTargetUser =
    interaction.target?.participantId === viewerParticipantId ||
    (Boolean(viewerWorkspaceMemberId) &&
      interaction.target?.workspaceMemberId === viewerWorkspaceMemberId);
  const canResolveUserInput =
    interaction.kind === INTERACTION_REQUEST_KIND.USER_INPUT &&
    Boolean(onResolveInteraction) &&
    isTargetUser &&
    interaction.status === "pending";
  const canResolve = canResolveUserInput;
  const statusMeta = getStatusMeta(interaction.status);

  useEffect(() => {
    const nextDraftAnswers = buildDraftQuestionAnswers(interaction);
    draftAnswersRef.current = nextDraftAnswers;
    setDraftAnswers(nextDraftAnswers);
    setCurrentIndex(0);
    setSubmitting(false);
    setSubmitError(null);
  }, [interaction]);

  useEffect(() => {
    if (!open || !canResolve) {
      questionCardOffset.setValue(0);
      return;
    }

    questionCardOffset.setValue(26);
    Animated.spring(questionCardOffset, {
      toValue: 0,
      useNativeDriver: true,
      speed: 18,
      bounciness: 6,
    }).start();
  }, [canResolve, currentIndex, open, questionCardOffset]);

  const answerSummary = useMemo(
    () => summarizeInteractionAnswers(interaction),
    [interaction],
  );

  const currentField = userInput?.questions[currentIndex] ?? null;
  const currentDraft = currentField
    ? draftAnswers[currentField.id] || EMPTY_DRAFT
    : EMPTY_DRAFT;
  const questionCardOpacity = questionCardOffset.interpolate({
    inputRange: [0, 26],
    outputRange: [1, 0],
  });

  function applyDraftAnswer(
    questionId: string,
    updater: (draft: DraftQuestionAnswer) => DraftQuestionAnswer,
  ) {
    const nextAnswers = {
      ...draftAnswersRef.current,
      [questionId]: updater(draftAnswersRef.current[questionId] || EMPTY_DRAFT),
    };

    draftAnswersRef.current = nextAnswers;
    setDraftAnswers(nextAnswers);
    return nextAnswers;
  }

  async function submitAnswers(
    answers: Record<string, DraftQuestionAnswer> = draftAnswersRef.current,
  ) {
    if (!userInput || !onResolveInteraction || !canResolveUserInput) {
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    try {
      await onResolveInteraction(
        interaction.id,
        buildAnswersPayload(userInput.questions, answers),
      );
      setOpen(false);
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : "提交答题结果失败。",
      );
    } finally {
      setSubmitting(false);
    }
  }

  function goToNextQuestion(
    answers: Record<string, DraftQuestionAnswer> = draftAnswersRef.current,
  ) {
    if (!userInput || !currentField) {
      return;
    }

    if (!isFieldComplete(currentField, answers[currentField.id] || EMPTY_DRAFT)) {
      return;
    }

    if (currentIndex >= userInput.questions.length - 1) {
      void submitAnswers(answers);
      return;
    }

    setCurrentIndex((value) =>
      Math.min(value + 1, userInput.questions.length - 1),
    );
  }

  function handleSelectOption(
    field: InteractionInputQuestionSummary,
    optionId: string,
  ) {
    if (!canResolveUserInput || submitting) {
      return;
    }

    const nextAnswers = applyDraftAnswer(field.id, (draft) => {
      if (field.type === "single_select") {
        return {
          ...draft,
          selectedOptionIds: [optionId],
          otherText: "",
        };
      }

      const hasOption = draft.selectedOptionIds.includes(optionId);
      if (hasOption) {
        return {
          ...draft,
          selectedOptionIds: draft.selectedOptionIds.filter((id) => id !== optionId),
        };
      }

      if (
        typeof field.maxSelections === "number" &&
        draft.selectedOptionIds.length >= field.maxSelections
      ) {
        return draft;
      }

      return {
        ...draft,
        selectedOptionIds: [...draft.selectedOptionIds, optionId],
      };
    });

    if (field.type === "single_select" && !field.allowOther) {
      goToNextQuestion(nextAnswers);
    }
  }

  if (interaction.kind !== INTERACTION_REQUEST_KIND.USER_INPUT) {
    return null;
  }

  return (
    <View style={styles.eventWrap}>
      <Pressable
        accessibilityRole="button"
        onPress={() => setOpen(true)}
        style={({ pressed }) => [
          styles.card,
          pressed && styles.cardPressed,
        ]}
      >
        <View style={styles.cardHeader}>
          <View style={styles.kindBadge}>
            <Feather name="help-circle" size={14} color={theme.colors.primary} />
            <Text style={styles.kindBadgeText}>表单</Text>
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
            <Feather name={statusMeta.icon} size={12} color={statusMeta.color} />
            <Text style={[styles.statusBadgeText, { color: statusMeta.color }]}>
              {statusMeta.label}
            </Text>
          </View>
        </View>

        <Text style={styles.cardTitle}>{userInput?.title}</Text>
        {userInput?.instructions ? (
          <Text style={styles.cardDescription}>
            {userInput.instructions}
          </Text>
        ) : null}
        {answerSummary ? (
          <Text numberOfLines={2} style={styles.cardSummary}>
            {answerSummary}
          </Text>
        ) : null}

        <View style={styles.cardFooter}>
          <Text style={styles.cardFooterText}>
            {getStatusNote(interaction, isTargetUser, canResolve)}
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
              <Text style={styles.sheetTitle}>{userInput?.title}</Text>
              {userInput?.instructions ? (
                <Text style={styles.sheetDescription}>
                  {userInput.instructions}
                </Text>
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
                    <Text style={styles.questionTitle}>{currentField.prompt}</Text>
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
                          }));
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
                            selected={currentDraft.selectedOptionIds.includes(option.id)}
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
                            }));
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
                        setCurrentIndex((value) => Math.max(0, value - 1));
                        return;
                      }
                      setOpen(false);
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
                      submitting ||
                      !isFieldComplete(currentField, currentDraft)
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
                  {(userInput?.questions || []).map((question, index) => {
                    const answer = summarizeQuestionFieldAnswer(question);
                    return (
                      <View key={question.id} style={styles.summarySection}>
                        <Text style={styles.summaryIndex}>{`题目 ${index + 1}`}</Text>
                        <Text style={styles.summaryTitle}>{question.prompt}</Text>
                        {question.description ? (
                          <Text style={styles.summaryDescription}>
                            {question.description}
                          </Text>
                        ) : null}
                        <Text style={styles.summaryAnswer}>
                          {answer || "暂无回答"}
                        </Text>
                      </View>
                    );
                  })}
                  {submitError ? (
                    <View style={styles.errorCard}>
                      <Text style={styles.errorText}>{submitError}</Text>
                    </View>
                  ) : null}
                </ScrollView>

                <View style={styles.sheetActions}>
                  <Button
                    label="关闭"
                    variant="secondary"
                    onPress={() => setOpen(false)}
                    style={styles.singleActionButton}
                  />
                </View>
              </>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
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
});
