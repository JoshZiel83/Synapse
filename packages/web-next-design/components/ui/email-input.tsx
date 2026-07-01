"use client"

import * as React from "react"

import { Input } from "@/components/ui/input"

// Common providers, international + China-mainland, since this is a CN-facing
// product. Order is the suggestion order before the user narrows it.
const EMAIL_DOMAINS = [
  "gmail.com",
  "outlook.com",
  "hotmail.com",
  "icloud.com",
  "qq.com",
  "163.com",
  "126.com",
  "foxmail.com",
  "sina.com",
  "yahoo.com",
]

/**
 * Email field that suggests a domain suffix as you type, via a native
 * <datalist> (the project's existing autocomplete idiom). Before "@", it
 * completes "<you>@<domain>"; after "@", it filters domains by the typed
 * prefix. Suggestions only, so a free-form address still types through.
 */
function EmailInput({ value, ...props }: React.ComponentProps<typeof Input>) {
  const listId = React.useId()
  const raw = typeof value === "string" ? value : ""

  const suggestions = React.useMemo(() => {
    const [local, domainPart] = raw.split("@")
    if (!local) return []
    if (raw.includes("@")) {
      const prefix = (domainPart ?? "").toLowerCase()
      return EMAIL_DOMAINS.filter((domain) => domain.startsWith(prefix)).map(
        (domain) => `${local}@${domain}`
      )
    }
    return EMAIL_DOMAINS.map((domain) => `${local}@${domain}`)
  }, [raw])

  return (
    <>
      <Input
        {...props}
        value={value}
        type="email"
        list={suggestions.length > 0 ? listId : undefined}
      />
      {suggestions.length > 0 ? (
        <datalist id={listId}>
          {suggestions.map((suggestion) => (
            <option key={suggestion} value={suggestion} />
          ))}
        </datalist>
      ) : null}
    </>
  )
}

export { EmailInput }
