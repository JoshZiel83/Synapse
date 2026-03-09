<script lang="ts">
  declare const window: any

  interface ImportedServer {
    name: string
    transport: string
    command: string
    args: string[]
    env: Record<string, string>
    endpoint: string
  }

  interface Source {
    name: string
    configPath: string
    available: boolean
    servers: ImportedServer[]
    error: string
  }

  let sources = $state<Source[]>([])
  let loading = $state(true)
  let importing = $state(false)
  let selected = $state<Set<string>>(new Set())
  let message = $state('')

  async function detect() {
    loading = true
    try {
      sources = await window.go.main.App.DetectSources()
    } catch {}
    loading = false
  }

  function toggleServer(key: string) {
    const next = new Set(selected)
    if (next.has(key)) {
      next.delete(key)
    } else {
      next.add(key)
    }
    selected = next
  }

  function selectAll() {
    const all = new Set<string>()
    for (const src of sources) {
      if (!src.available) continue
      for (const srv of src.servers) {
        all.add(`${src.name}::${srv.name}`)
      }
    }
    selected = all
  }

  function getSelectedServers(): ImportedServer[] {
    const result: ImportedServer[] = []
    for (const src of sources) {
      for (const srv of src.servers) {
        if (selected.has(`${src.name}::${srv.name}`)) {
          result.push(srv)
        }
      }
    }
    return result
  }

  async function importSelected() {
    const servers = getSelectedServers()
    if (servers.length === 0) return
    importing = true
    message = ''
    try {
      await window.go.main.App.ImportServers(servers)
      message = `Imported ${servers.length} server(s) successfully.`
      selected = new Set()
    } catch (e: any) {
      message = `Error: ${e?.message || String(e)}`
    } finally {
      importing = false
    }
  }

  detect()
</script>

<div class="p-6">
  <div class="flex items-center justify-between mb-6">
    <div>
      <h2 class="text-lg font-semibold text-zinc-200">Import MCP Servers</h2>
      <p class="text-sm text-zinc-500">Import server configurations from other AI tools.</p>
    </div>
    <button
      onclick={detect}
      disabled={loading}
      class="px-3 py-1.5 text-sm rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-40 transition-colors"
    >
      {loading ? 'Scanning...' : 'Rescan'}
    </button>
  </div>

  {#if loading}
    <div class="text-center py-12 text-zinc-500 text-sm">Scanning for MCP configurations...</div>
  {:else}
    <!-- Sources overview -->
    <div class="grid grid-cols-2 gap-3 mb-6">
      {#each sources as src}
        <div class="p-3 rounded-lg border {src.available ? 'border-emerald-800/50 bg-emerald-950/20' : 'border-zinc-800 bg-zinc-900/30'}">
          <div class="flex items-center gap-2 mb-1">
            <span class="w-2 h-2 rounded-full {src.available ? 'bg-emerald-500' : 'bg-zinc-600'}"></span>
            <span class="text-sm font-medium text-zinc-200">{src.name}</span>
          </div>
          <p class="text-xs text-zinc-500 truncate">{src.configPath}</p>
          {#if src.available}
            <p class="text-xs text-emerald-400 mt-1">{src.servers.length} server(s) found</p>
          {:else if src.error}
            <p class="text-xs text-red-400 mt-1">{src.error}</p>
          {:else}
            <p class="text-xs text-zinc-600 mt-1">Not found</p>
          {/if}
        </div>
      {/each}
    </div>

    <!-- Server list -->
    {@const allServers = sources.flatMap(src => src.available ? src.servers.map(srv => ({ source: src.name, server: srv })) : [])}
    {#if allServers.length > 0}
      <div class="flex items-center justify-between mb-3">
        <span class="text-sm text-zinc-400">{allServers.length} server(s) available</span>
        <button onclick={selectAll} class="text-xs text-blue-400 hover:text-blue-300 transition-colors">Select All</button>
      </div>
      <div class="space-y-1.5 mb-6">
        {#each allServers as entry}
          {@const key = `${entry.source}::${entry.server.name}`}
          <button
            class="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors text-left {selected.has(key) ? 'border-blue-700/50 bg-blue-950/20' : 'border-zinc-800 bg-zinc-900/30 hover:bg-zinc-900/50'}"
            onclick={() => toggleServer(key)}
          >
            <span class="w-4 h-4 rounded border flex items-center justify-center text-xs {selected.has(key) ? 'border-blue-500 bg-blue-600 text-white' : 'border-zinc-600'}">
              {#if selected.has(key)}✓{/if}
            </span>
            <div class="flex-1 min-w-0">
              <span class="text-sm text-zinc-200">{entry.server.name}</span>
              <span class="ml-2 text-xs text-zinc-500">{entry.source}</span>
            </div>
            <span class="px-1.5 py-0.5 text-xs rounded bg-zinc-800 text-zinc-500">{entry.server.transport}</span>
          </button>
        {/each}
      </div>
      <button
        onclick={importSelected}
        disabled={importing || selected.size === 0}
        class="px-4 py-2 text-sm rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {importing ? 'Importing...' : `Import ${selected.size} Selected`}
      </button>
    {:else}
      <div class="text-center py-8 text-zinc-600 text-sm">No MCP servers found in any detected tool.</div>
    {/if}

    {#if message}
      <div class="mt-4 px-3 py-2 rounded text-sm {message.startsWith('Error') ? 'bg-red-900/30 border border-red-800/50 text-red-300' : 'bg-emerald-900/30 border border-emerald-800/50 text-emerald-300'}">
        {message}
      </div>
    {/if}
  {/if}
</div>
