import { useState } from 'react'

import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '../components/ui/field'
import { Separator } from '../components/ui/separator'
import type { NotificationSettings, RelayConfig, StartupSettings } from '../types'

interface SettingsPanelProps {
  config: RelayConfig
  onSave: (nextConfig: RelayConfig) => Promise<void>
}

type SettingKey =
  | 'runAtLogin'
  | 'autoConnect'
  | 'launchHidden'
  | 'backgroundEnabled'

function SettingToggle({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string
  description: string
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel>{label}</FieldLabel>
        <FieldDescription>{description}</FieldDescription>
      </FieldContent>
      <input
        type="checkbox"
        className="mt-0.5 size-4 accent-[color:var(--primary)]"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </Field>
  )
}

export function SettingsPanel({ config, onSave }: SettingsPanelProps) {
  const [saving, setSaving] = useState<SettingKey | null>(null)
  const [error, setError] = useState('')

  async function updateStartup(key: keyof StartupSettings, value: boolean) {
    setSaving(key)
    setError('')
    try {
      await onSave({
        ...config,
        startup: {
          ...config.startup,
          [key]: value,
        },
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(null)
    }
  }

  async function updateNotifications(key: keyof NotificationSettings, value: boolean) {
    setSaving(key)
    setError('')
    try {
      await onSave({
        ...config,
        notifications: {
          ...config.notifications,
          [key]: value,
        },
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(null)
    }
  }

  return (
    <section className="flex flex-col gap-5">
      <div>
        <h1 className="text-[28px] leading-none font-semibold tracking-tight text-foreground">Settings</h1>
        <div className="mt-3 text-sm text-muted-foreground">Startup and background behavior.</div>
      </div>

      {error ? (
        <div className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <FieldGroup>
        <SettingToggle
          label="Launch at login"
          description="Start the desktop app when your OS session starts."
          checked={Boolean(config.startup?.runAtLogin)}
          disabled={saving === 'runAtLogin'}
          onChange={(checked) => void updateStartup('runAtLogin', checked)}
        />
        <Separator />
        <SettingToggle
          label="Auto-connect on launch"
          description="Try to start the relay when the app launches."
          checked={Boolean(config.startup?.autoConnect)}
          disabled={saving === 'autoConnect'}
          onChange={(checked) => void updateStartup('autoConnect', checked)}
        />
        <Separator />
        <SettingToggle
          label="Launch hidden at login"
          description="When started at login, keep the window hidden in the tray."
          checked={Boolean(config.startup?.launchHidden)}
          disabled={saving === 'launchHidden'}
          onChange={(checked) => void updateStartup('launchHidden', checked)}
        />
        <Separator />
        <SettingToggle
          label="Background notifications"
          description="Show tray notifications for connect and error events while hidden."
          checked={Boolean(config.notifications?.backgroundEnabled)}
          disabled={saving === 'backgroundEnabled'}
          onChange={(checked) => void updateNotifications('backgroundEnabled', checked)}
        />
      </FieldGroup>
    </section>
  )
}
