"use client"

import type { ReactNode } from "react"

import { AppCard, AppCardContent } from "@/components/app-card"
import { PluginIcon, getLocale, transportLabels, translate } from "./plugin-ui"

interface Props {
  plugin: any
  eyebrow?: string
  action?: ReactNode
}

export default function PluginHeroCard({ plugin, eyebrow, action }: Props) {
  const locale = getLocale(plugin?.default_locale)
  const title =
    translate(
      plugin?.display_name_i18n,
      locale,
      plugin?.default_locale || "en"
    ) ||
    plugin?.display_name ||
    "Plugin"
  const description =
    translate(
      plugin?.long_description_i18n || plugin?.description_i18n,
      locale,
      plugin?.default_locale || "en"
    ) ||
    plugin?.long_description ||
    plugin?.description ||
    "No description provided."
  const primaryCategory = Array.isArray(plugin?.categories)
    ? plugin.categories[0]
    : null
  const primaryCategoryLabel = primaryCategory
    ? translate(
        primaryCategory.displayNameI18n,
        locale,
        primaryCategory.defaultLocale || "en"
      ) || primaryCategory.displayName
    : null
  const details = [
    transportLabels[plugin?.transport] || plugin?.transport,
    plugin?.org_display_name,
    primaryCategoryLabel,
  ].filter(Boolean)

  return (
    <AppCard variant="panel">
      <AppCardContent className="p-6">
        <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
          <div className="flex min-w-0 items-start gap-4">
            <PluginIcon
              iconUrl={plugin?.icon_url}
              title={title}
              transport={plugin?.transport}
              containerClassName="h-20 w-20 rounded-[24px]"
              className="h-8 w-8"
            />

            <div className="min-w-0 space-y-3">
              {eyebrow ? (
                <div className="text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase">
                  {eyebrow}
                </div>
              ) : null}

              <div className="space-y-2">
                <h1 className="text-2xl font-semibold text-foreground">
                  {title}
                </h1>
                {details.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                    {details.map((detail, index) => (
                      <span
                        key={`${detail}-${index}`}
                        className="inline-flex items-center gap-2"
                      >
                        {index > 0 ? (
                          <span className="text-muted-foreground/50">/</span>
                        ) : null}
                        <span>{detail}</span>
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>

              <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
                {description}
              </p>
            </div>
          </div>

          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      </AppCardContent>
    </AppCard>
  )
}
