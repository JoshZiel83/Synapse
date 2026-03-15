import type { RelayConfig, StatusInfo } from '../types'

type StatusVariant = 'success' | 'warning' | 'destructive' | 'secondary'

export interface RelayUiStatus {
  label: string
  variant: StatusVariant
  detail: string
}

export function getRelayUiStatus(config: RelayConfig, status: StatusInfo): RelayUiStatus {
  const enabledServerCount = (config.servers || []).filter((server) => server.enabled !== false).length

  if (!config.relay?.deviceId) {
    return {
      label: 'Not Paired',
      variant: 'warning',
      detail: 'Paste a pairing link to bind this device.',
    }
  }

  if (status.authFailureMessage) {
    return {
      label: 'Auth Failed',
      variant: 'destructive',
      detail: status.authFailureMessage,
    }
  }

  if (status.state === 'running') {
    return {
      label: 'Running',
      variant: 'success',
      detail: 'Relay is connected and serving MCP traffic.',
    }
  }

  if (status.state === 'starting') {
    return {
      label: 'Starting',
      variant: 'warning',
      detail: 'Relay is starting now.',
    }
  }

  if (status.state === 'stopping') {
    return {
      label: 'Stopping',
      variant: 'warning',
      detail: 'Relay is stopping now.',
    }
  }

  if (status.state === 'error' || status.error) {
    return {
      label: 'Error',
      variant: 'destructive',
      detail: status.error || 'Relay stopped because of an error.',
    }
  }

  if (enabledServerCount === 0) {
    return {
      label: 'No MCP',
      variant: 'warning',
      detail: 'Add at least one MCP before starting the relay.',
    }
  }

  return {
    label: 'Ready',
    variant: 'secondary',
    detail: 'Setup is complete. Start the relay when you are ready.',
  }
}
