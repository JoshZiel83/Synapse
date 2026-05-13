import { useEffect, useMemo, useRef, useState } from "react"
import {
  LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
  type TextInputProps,
} from "react-native"

import { Field } from "@/components/ui"
import { theme } from "@/theme/tokens"

const COMMON_EMAIL_DOMAINS = [
  "gmail.com",
  "outlook.com",
  "qq.com",
  "163.com",
  "icloud.com",
  "foxmail.com",
] as const

function buildEmailSuggestions(value: string) {
  const normalized = value.trim().toLowerCase()
  if (!normalized || normalized.includes(" ")) {
    return []
  }

  const parts = normalized.split("@")
  if (parts.length > 2) {
    return []
  }

  const localPart = parts[0] ?? ""
  const domainPart = parts[1] ?? ""
  if (!localPart) {
    return []
  }

  const domainMatches = COMMON_EMAIL_DOMAINS.filter((domain) =>
    domain.startsWith(domainPart)
  )

  return domainMatches
    .map((domain) => `${localPart}@${domain}`)
    .filter((item) => item !== normalized)
    .slice(0, 4)
}

type EmailFieldProps = TextInputProps & {
  label: string
  value: string
  onChangeText: (value: string) => void
}

export function EmailField({
  label,
  value,
  onChangeText,
  ...props
}: EmailFieldProps) {
  const [focused, setFocused] = useState(false)
  const [fieldHeight, setFieldHeight] = useState(0)
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const suggestions = useMemo(() => buildEmailSuggestions(value), [value])

  useEffect(() => {
    return () => {
      if (blurTimerRef.current) {
        clearTimeout(blurTimerRef.current)
      }
    }
  }, [])

  function clearBlurTimer() {
    if (blurTimerRef.current) {
      clearTimeout(blurTimerRef.current)
      blurTimerRef.current = null
    }
  }

  function handleSelectSuggestion(nextValue: string) {
    clearBlurTimer()
    onChangeText(nextValue)
    setFocused(false)
  }

  function handleFieldLayout(event: LayoutChangeEvent) {
    setFieldHeight(event.nativeEvent.layout.height)
  }

  return (
    <View
      style={[
        styles.wrapper,
        focused && suggestions.length > 0 && styles.wrapperActive,
      ]}
    >
      <View onLayout={handleFieldLayout}>
        <Field
          label={label}
          {...props}
          value={value}
          onChangeText={onChangeText}
          onFocus={(event) => {
            clearBlurTimer()
            setFocused(true)
            props.onFocus?.(event)
          }}
          onBlur={(event) => {
            blurTimerRef.current = setTimeout(() => {
              setFocused(false)
            }, 120)
            props.onBlur?.(event)
          }}
        />
      </View>

      {focused && suggestions.length > 0 ? (
        <View
          style={[
            styles.dropdown,
            {
              top: fieldHeight + 6,
            },
          ]}
        >
          {suggestions.map((item) => (
            <Pressable
              key={item}
              onPressIn={() => handleSelectSuggestion(item)}
              style={({ pressed }) => [
                styles.option,
                pressed && styles.optionPressed,
              ]}
            >
              <Text style={styles.optionText}>{item}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  wrapper: {
    position: "relative",
  },
  wrapperActive: {
    zIndex: 20,
  },
  dropdown: {
    position: "absolute",
    left: 0,
    right: 0,
    overflow: "hidden",
    borderRadius: 20,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: "rgba(255, 255, 255, 0.98)",
    boxShadow: "0 14px 30px rgba(15, 23, 42, 0.08)",
  },
  option: {
    minHeight: 46,
    justifyContent: "center",
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  optionPressed: {
    backgroundColor: theme.colors.primarySoft,
  },
  optionText: {
    fontSize: 14,
    color: theme.colors.text,
  },
})
