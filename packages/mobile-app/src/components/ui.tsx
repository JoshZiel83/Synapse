import Feather from "@expo/vector-icons/Feather";
import { Image } from "expo-image";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type RefreshControlProps,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";

import { buildAuthenticatedSource } from "@/lib/api";
import { theme } from "@/theme/tokens";

export function ScreenScroll({
  children,
  contentContainerStyle,
  refreshControl,
  bottomPadding = 128,
  topPadding = 16,
}: {
  children: React.ReactNode;
  contentContainerStyle?: StyleProp<ViewStyle>;
  refreshControl?: React.ReactElement<RefreshControlProps>;
  bottomPadding?: number;
  topPadding?: number;
}) {
  const insets = useSafeAreaInsets();

  return (
    <SafeAreaView style={styles.safeArea} edges={["top"]}>
      <View style={styles.screen}>
        <BackgroundWash />
        <ScrollView
          style={styles.fill}
          contentContainerStyle={[
            styles.scrollContent,
            {
              paddingTop: topPadding,
              paddingBottom: bottomPadding + insets.bottom,
            },
            contentContainerStyle,
          ]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentInsetAdjustmentBehavior="automatic"
          refreshControl={refreshControl}
        >
          {children}
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

export function ScreenView({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <SafeAreaView style={styles.safeArea} edges={["top", "bottom"]}>
      <View style={[styles.screen, style]}>
        <BackgroundWash />
        {children}
      </View>
    </SafeAreaView>
  );
}

export function BackgroundWash() {
  return (
    <>
      <View style={[styles.glow, styles.glowPrimary]} />
      <View style={[styles.glow, styles.glowAccent]} />
    </>
  );
}

export function Card({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function SectionBlock({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return <View style={[styles.sectionBlock, style]}>{children}</View>;
}

export function SectionTitleRow({
  title,
  action,
}: {
  title: string;
  action?: React.ReactNode;
}) {
  return (
    <View style={styles.sectionTitleRow}>
      <Text style={styles.sectionTitleText}>{title}</Text>
      {action}
    </View>
  );
}

export function MobilePageHeader({
  title,
  action,
}: {
  title: string;
  action?: React.ReactNode;
}) {
  return (
    <View style={styles.pageHeader}>
      <View style={styles.pageHeaderRow}>
        <Text numberOfLines={1} style={styles.pageHeaderTitle}>
          {title}
        </Text>
        {action ? <View style={styles.pageHeaderAction}>{action}</View> : null}
      </View>
    </View>
  );
}

export function SectionHeader({
  eyebrow,
  title,
  subtitle,
  action,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <View style={styles.sectionHeader}>
      <View style={styles.sectionHeaderText}>
        {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
        <Text style={styles.sectionTitle}>{title}</Text>
        {subtitle ? (
          <Text style={styles.sectionSubtitle}>{subtitle}</Text>
        ) : null}
      </View>
      {action}
    </View>
  );
}

export function Button({
  label,
  onPress,
  variant = "primary",
  icon,
  disabled,
  style,
}: {
  label: string;
  onPress?: () => void;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  icon?: keyof typeof Feather.glyphMap;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        variant === "primary" && styles.buttonPrimary,
        variant === "secondary" && styles.buttonSecondary,
        variant === "ghost" && styles.buttonGhost,
        variant === "danger" && styles.buttonDanger,
        disabled && styles.buttonDisabled,
        pressed && !disabled && styles.buttonPressed,
        style,
      ]}
    >
      {icon ? (
        <Feather
          name={icon}
          size={18}
          color={
            variant === "secondary" || variant === "ghost"
              ? theme.colors.text
              : theme.colors.white
          }
        />
      ) : null}
      <Text
        style={[
          styles.buttonLabel,
          (variant === "secondary" || variant === "ghost") &&
            styles.buttonLabelDark,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function Field({
  label,
  hint,
  style,
  ...props
}: TextInputProps & {
  label: string;
  hint?: string;
  style?: StyleProp<TextStyle>;
}) {
  return (
    <View style={styles.fieldGroup}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        placeholderTextColor={theme.colors.textSoft}
        style={[styles.input, style]}
        {...props}
      />
      {hint ? <Text style={styles.fieldHint}>{hint}</Text> : null}
    </View>
  );
}

export function Pill({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: "neutral" | "accent" | "primary";
}) {
  return (
    <View
      style={[
        styles.pill,
        tone === "accent" && styles.pillAccent,
        tone === "primary" && styles.pillPrimary,
      ]}
    >
      <Text
        style={[
          styles.pillLabel,
          tone === "accent" && styles.pillLabelAccent,
          tone === "primary" && styles.pillLabelPrimary,
        ]}
      >
        {label}
      </Text>
    </View>
  );
}

export function Avatar({
  name,
  uri,
  size = 44,
  icon,
}: {
  name?: string;
  uri?: string | null;
  size?: number;
  icon?: keyof typeof Feather.glyphMap;
}) {
  const fallback = (name || "?").slice(0, 1).toUpperCase();
  const source = uri ? buildAuthenticatedSource(uri) : null;

  return (
    <View
      style={[
        styles.avatar,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
        },
      ]}
    >
      {source ? (
        <Image
          source={source}
          style={{
            width: size,
            height: size,
            borderRadius: size / 2,
          }}
          contentFit="cover"
        />
      ) : icon ? (
        <Feather name={icon} size={size * 0.45} color={theme.colors.primary} />
      ) : (
        <Text style={[styles.avatarLabel, { fontSize: size * 0.36 }]}>
          {fallback}
        </Text>
      )}
    </View>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: keyof typeof Feather.glyphMap;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <View style={styles.emptyState}>
      <View style={styles.emptyStateIcon}>
        <Feather name={icon} size={22} color={theme.colors.primary} />
      </View>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyDescription}>{description}</Text>
      {action}
    </View>
  );
}

export function LoadingBlock({ label }: { label?: string }) {
  return (
    <View style={styles.loadingBlock}>
      <ActivityIndicator color={theme.colors.primary} />
      {label ? <Text style={styles.loadingLabel}>{label}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.background,
  },
  fill: {
    flex: 1,
    minHeight: 0,
  },
  screen: {
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
    backgroundColor: theme.colors.background,
  },
  scrollContent: {
    paddingHorizontal: 18,
    gap: 16,
  },
  glow: {
    position: "absolute",
    borderRadius: 999,
    opacity: 0.24,
  },
  glowPrimary: {
    width: 260,
    height: 260,
    top: -80,
    right: -70,
    backgroundColor: "rgba(37, 99, 235, 0.12)",
  },
  glowAccent: {
    width: 200,
    height: 200,
    top: 70,
    left: -70,
    backgroundColor: "rgba(148, 163, 184, 0.12)",
  },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.lg,
    gap: theme.spacing.sm,
  },
  sectionBlock: {
    marginHorizontal: -18,
    paddingHorizontal: 18,
    paddingVertical: 16,
    backgroundColor: theme.colors.surface,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
    gap: 12,
  },
  sectionTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  sectionTitleText: {
    fontSize: 18,
    fontWeight: "800",
    color: theme.colors.text,
  },
  pageHeader: {
    marginHorizontal: -18,
    paddingHorizontal: 18,
    paddingBottom: 10,
    minHeight: 62,
    justifyContent: "flex-end",
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.background,
  },
  pageHeaderRow: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  pageHeaderTitle: {
    flex: 1,
    fontSize: 22,
    fontWeight: "800",
    color: theme.colors.text,
  },
  pageHeaderAction: {
    justifyContent: "center",
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: theme.spacing.md,
  },
  sectionHeaderText: {
    flex: 1,
    gap: 4,
  },
  eyebrow: {
    fontSize: 12,
    letterSpacing: 1.2,
    textTransform: "uppercase",
    color: theme.colors.textSoft,
    fontWeight: "700",
  },
  sectionTitle: {
    fontSize: 28,
    color: theme.colors.text,
    fontFamily: theme.fonts.display,
  },
  sectionSubtitle: {
    fontSize: 15,
    lineHeight: 22,
    color: theme.colors.textMuted,
  },
  button: {
    minHeight: 52,
    borderRadius: theme.radii.pill,
    paddingHorizontal: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  buttonPrimary: {
    backgroundColor: theme.colors.primary,
  },
  buttonSecondary: {
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderStrong,
  },
  buttonGhost: {
    backgroundColor: "transparent",
  },
  buttonDanger: {
    backgroundColor: theme.colors.danger,
  },
  buttonDisabled: {
    opacity: 0.55,
  },
  buttonPressed: {
    transform: [{ scale: 0.985 }],
  },
  buttonLabel: {
    fontSize: 15,
    fontWeight: "700",
    color: theme.colors.white,
  },
  buttonLabelDark: {
    color: theme.colors.text,
  },
  fieldGroup: {
    gap: 8,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: "700",
    color: theme.colors.textMuted,
  },
  fieldHint: {
    fontSize: 12,
    color: theme.colors.textSoft,
  },
  input: {
    minHeight: 54,
    borderRadius: 20,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    color: theme.colors.text,
  },
  pill: {
    alignSelf: "flex-start",
    borderRadius: theme.radii.pill,
    backgroundColor: theme.colors.surfaceMuted,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  pillAccent: {
    backgroundColor: theme.colors.accentSoft,
  },
  pillPrimary: {
    backgroundColor: theme.colors.primarySoft,
  },
  pillLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: theme.colors.textMuted,
  },
  pillLabelAccent: {
    color: theme.colors.accent,
  },
  pillLabelPrimary: {
    color: theme.colors.primary,
  },
  avatar: {
    backgroundColor: theme.colors.primarySoft,
    borderWidth: 1,
    borderColor: "rgba(15, 118, 110, 0.12)",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  avatarLabel: {
    color: theme.colors.primary,
    fontWeight: "800",
  },
  emptyState: {
    alignItems: "center",
    paddingVertical: 26,
  },
  emptyStateIcon: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.primarySoft,
    marginBottom: 10,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: "700",
    color: theme.colors.text,
  },
  emptyDescription: {
    fontSize: 14,
    lineHeight: 21,
    color: theme.colors.textMuted,
    textAlign: "center",
  },
  loadingBlock: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingVertical: 24,
  },
  loadingLabel: {
    fontSize: 14,
    color: theme.colors.textMuted,
  },
});
