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
  onSaveDesktopSettings: (startup: StartupSettings, notifications: NotificationSettings) => Promise<void>
}

type SettingKey =
  | 'runAtLogin'
  | 'autoConnect'
  | 'launchHidden'
  | 'closeBehavior'
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

export function SettingsPanel({ config, onSaveDesktopSettings }: SettingsPanelProps) {
  const [saving, setSaving] = useState<SettingKey | null>(null)
  const [error, setError] = useState('')

  async function updateStartup(nextStartup: Partial<StartupSettings>, key: SettingKey) {
    setSaving(key)
    setError('')
    try {
      await onSaveDesktopSettings({
        ...config.startup,
        ...nextStartup,
      }, {
        ...config.notifications,
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
      await onSaveDesktopSettings({
        ...config.startup,
      }, {
        ...config.notifications,
        [key]: value,
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
          onChange={(checked) => void updateStartup({ runAtLogin: checked }, 'runAtLogin')}
        />
        <Separator />
        <SettingToggle
          label="Auto-connect on launch"
          description="Try to start the relay when the app launches."
          checked={Boolean(config.startup?.autoConnect)}
          disabled={saving === 'autoConnect'}
          onChange={(checked) => void updateStartup({ autoConnect: checked }, 'autoConnect')}
        />
        <Separator />
        <SettingToggle
          label="Launch hidden at login"
          description="When started at login, keep the window hidden in the tray."
          checked={Boolean(config.startup?.launchHidden)}
          disabled={saving === 'launchHidden'}
          onChange={(checked) => void updateStartup({ launchHidden: checked }, 'launchHidden')}
        />
        <Separator />
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel>Close window while running</FieldLabel>
            <FieldDescription>Choose whether the close button asks every time, minimizes to the tray, or exits the app.</FieldDescription>
          </FieldContent>
          <select
            className="h-11 rounded-2xl border border-border/70 bg-background px-3 text-sm"
            value={config.startup?.closeBehavior || 'ask'}
            disabled={saving === 'closeBehavior'}
            onChange={(event) => void updateStartup({ closeBehavior: event.target.value as StartupSettings['closeBehavior'] }, 'closeBehavior')}
          >
            <option value="ask">Ask every time</option>
            <option value="tray">Minimize to tray</option>
            <option value="quit">Exit app</option>
          </select>
        </Field>
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
