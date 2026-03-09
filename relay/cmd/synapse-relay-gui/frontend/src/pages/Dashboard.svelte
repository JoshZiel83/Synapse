<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  declare const window: any

  interface StatusInfo {
    state: string
    error?: string
    servers?: any[]
  }

  interface LogEntry {
    time: string
    type: string
    message: string
  }

  let status = $state<StatusInfo>({ state: 'stopped' })
  let logs = $state<LogEntry[]>([])
  let starting = $state(false)
  let stopping = $state(false)
  let pollInterval: any

  const stateColors: Record<string, string> = {
    stopped: 'bg-zinc-600',
    starting: 'bg-amber-500 animate-pulse',
    running: 'bg-emerald-500',
    stopping: 'bg-amber-500 animate-pulse',
    error: 'bg-red-500',
  }

  const stateLabels: Record<string, string> = {
    stopped: 'Stopped',
    starting: 'Starting...',
    running: 'Connected',
    stopping: 'Stopping...',
    error: 'Error',
  }

  async function refreshStatus() {
    try {
      status = await window.go.main.App.GetStatus()
    } catch {}
    starting = false
    stopping = false
  }

  async function loadLogs() {
    try {
      logs = await window.go.main.App.GetRecentLogs(100)
    } catch {}
  }

  async function start() {
    starting = true
    try {
      await window.go.main.App.StartRelay()
    } catch (e: any) {
      status = { state: 'error', error: e?.message || String(e) }
      starting = false
    }
  }

  async function stop() {
    stopping = true
    try {
      await window.go.main.App.StopRelay()
    } catch {}
  }

  async function restart() {
    stopping = true
    try {
      await window.go.main.App.RestartRelay()
    } catch (e: any) {
      status = { state: 'error', error: e?.message || String(e) }
    }
    stopping = false
  }

  onMount(() => {
    refreshStatus()
    loadLogs()
    pollInterval = setInterval(() => {
      refreshStatus()
      loadLogs()
    }, 2000)

    // Listen for relay events
    if (window.runtime?.EventsOn) {
      window.runtime.EventsOn('relay:event', (evt: any) => {
        logs = [...logs.slice(-199), { time: evt.time, type: evt.type, message: evt.message }]
        refreshStatus()
      })
    }
  })

  onDestroy(() => {
    if (pollInterval) clearInterval(pollInterval)
  })
</script>

<div class="p-6 flex flex-col h-full">
  <!-- Header status -->
  <div class="flex items-center justify-between mb-6">
    <div class="flex items-center gap-3">
      <span class="w-3 h-3 rounded-full {stateColors[status.state] || 'bg-zinc-600'}"></span>
      <div>
        <h2 class="text-lg font-semibold text-zinc-200">{stateLabels[status.state] || status.state}</h2>
        {#if status.error}
          <p class="text-xs text-red-400 mt-0.5">{status.error}</p>
        {/if}
      </div>
    </div>
    <div class="flex gap-2">
      {#if status.state === 'stopped' || status.state === 'error'}
        <button
          onclick={start}
          disabled={starting}
          class="px-4 py-1.5 text-sm rounded bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40 transition-colors"
        >
          {starting ? 'Starting...' : 'Start'}
        </button>
      {:else if status.state === 'running'}
        <button
          onclick={restart}
          class="px-4 py-1.5 text-sm rounded bg-zinc-700 text-zinc-300 hover:bg-zinc-600 transition-colors"
        >
          Restart
        </button>
        <button
          onclick={stop}
          disabled={stopping}
          class="px-4 py-1.5 text-sm rounded bg-red-600/80 text-white hover:bg-red-500 disabled:opacity-40 transition-colors"
        >
          {stopping ? 'Stopping...' : 'Stop'}
        </button>
      {/if}
    </div>
  </div>

  <!-- Servers -->
  {#if status.servers && status.servers.length > 0}
    <div class="mb-6">
      <h3 class="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-2">Registered Servers</h3>
      <div class="grid grid-cols-3 gap-2">
        {#each status.servers as server}
          <div class="px-3 py-2 rounded-lg bg-zinc-900/50 border border-zinc-800">
            <div class="text-sm text-zinc-200 font-medium">{server.name}</div>
            <div class="text-xs text-zinc-500 mt-0.5">{server.transport} &middot; {server.tools?.length || 0} tools</div>
          </div>
        {/each}
      </div>
    </div>
  {/if}

  <!-- Logs -->
  <div class="flex-1 min-h-0 flex flex-col">
    <div class="flex items-center justify-between mb-2">
      <h3 class="text-xs font-medium text-zinc-500 uppercase tracking-wider">Logs</h3>
      <span class="text-xs text-zinc-600">{logs.length} entries</span>
    </div>
    <div class="flex-1 overflow-auto rounded-lg bg-zinc-950 border border-zinc-800 p-3 font-mono text-xs">
      {#if logs.length === 0}
        <div class="text-zinc-600 py-4 text-center">No logs yet. Start the relay to see activity.</div>
      {:else}
        {#each logs as log}
          <div class="py-0.5 flex gap-2 hover:bg-zinc-900/50">
            <span class="text-zinc-600 shrink-0">{log.time}</span>
            <span class="shrink-0 w-24 text-right {
              log.type === 'error' || log.type === 'auth_failed' ? 'text-red-400' :
              log.type === 'connected' || log.type === 'servers_ready' ? 'text-emerald-400' :
              log.type === 'tool_call' || log.type === 'tool_result' ? 'text-blue-400' :
              'text-zinc-500'
            }">[{log.type}]</span>
            <span class="text-zinc-300 break-all">{log.message}</span>
          </div>
        {/each}
      {/if}
    </div>
  </div>
</div>
