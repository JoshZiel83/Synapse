<script lang="ts">
  import { callGo } from '../lib/wails'

  interface ServerConfig {
    name: string
    transport: string
    command: string
    args: string[]
    env: Record<string, string>
    endpoint: string
  }

  let servers = $state<ServerConfig[]>([])
  let showAdd = $state(false)
  let newName = $state('')
  let newTransport = $state('stdio')
  let newCommand = $state('')
  let newArgs = $state('')
  let newEndpoint = $state('')

  async function loadServers() {
    try {
      const cfg = await callGo<any>('GetConfig')
      servers = cfg.servers || []
    } catch {}
  }

  async function addServer() {
    const sc: ServerConfig = {
      name: newName,
      transport: newTransport,
      command: newTransport === 'stdio' ? newCommand : '',
      args: newTransport === 'stdio' ? newArgs.split(' ').filter(Boolean) : [],
      env: {},
      endpoint: newTransport === 'http' ? newEndpoint : '',
    }
    try {
      await callGo('AddServer', sc)
      showAdd = false
      newName = ''; newCommand = ''; newArgs = ''; newEndpoint = ''
      await loadServers()
    } catch (e: any) {
      alert(e?.message || String(e))
    }
  }

  async function removeServer(name: string) {
    try {
      await callGo('RemoveServer', name)
      await loadServers()
    } catch (e: any) {
      alert(e?.message || String(e))
    }
  }

  loadServers()
</script>

<div class="p-6">
  <div class="flex items-center justify-between mb-6">
    <div>
      <h2 class="text-lg font-semibold text-zinc-200">MCP Servers</h2>
      <p class="text-sm text-zinc-500">Manage local MCP servers the relay connects to.</p>
    </div>
    <button
      onclick={() => showAdd = !showAdd}
      class="px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-500 transition-colors"
    >
      {showAdd ? 'Cancel' : '+ Add Server'}
    </button>
  </div>

  {#if showAdd}
    <div class="mb-6 p-4 rounded-lg border border-zinc-800 bg-zinc-900/50">
      <div class="grid grid-cols-2 gap-4 mb-4">
        <label class="block">
          <span class="text-xs font-medium text-zinc-400 uppercase tracking-wide">Name</span>
          <input bind:value={newName} placeholder="my-server" class="mt-1 w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-blue-500" />
        </label>
        <label class="block">
          <span class="text-xs font-medium text-zinc-400 uppercase tracking-wide">Transport</span>
          <select bind:value={newTransport} class="mt-1 w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded text-sm text-zinc-100 focus:outline-none focus:border-blue-500">
            <option value="stdio">stdio</option>
            <option value="http">http</option>
          </select>
        </label>
      </div>
      {#if newTransport === 'stdio'}
        <label class="block mb-3">
          <span class="text-xs font-medium text-zinc-400 uppercase tracking-wide">Command</span>
          <input bind:value={newCommand} placeholder="npx" class="mt-1 w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-blue-500" />
        </label>
        <label class="block mb-4">
          <span class="text-xs font-medium text-zinc-400 uppercase tracking-wide">Args (space-separated)</span>
          <input bind:value={newArgs} placeholder="-y @modelcontextprotocol/server-filesystem /" class="mt-1 w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-blue-500" />
        </label>
      {:else}
        <label class="block mb-4">
          <span class="text-xs font-medium text-zinc-400 uppercase tracking-wide">Endpoint URL</span>
          <input bind:value={newEndpoint} placeholder="http://localhost:8080/mcp" class="mt-1 w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-blue-500" />
        </label>
      {/if}
      <button onclick={addServer} disabled={!newName} class="px-4 py-2 text-sm rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 transition-colors">
        Add
      </button>
    </div>
  {/if}

  {#if servers.length === 0}
    <div class="text-center py-12 text-zinc-600">
      <p class="text-sm">No servers configured.</p>
      <p class="text-xs mt-1">Add a server above or import from other tools.</p>
    </div>
  {:else}
    <div class="border border-zinc-800 rounded-lg overflow-hidden">
      <table class="w-full text-sm">
        <thead>
          <tr class="bg-zinc-900/80 text-xs text-zinc-500 uppercase tracking-wider">
            <th class="text-left px-4 py-2.5 font-medium">Name</th>
            <th class="text-left px-4 py-2.5 font-medium">Transport</th>
            <th class="text-left px-4 py-2.5 font-medium">Command / Endpoint</th>
            <th class="text-right px-4 py-2.5 font-medium w-20"></th>
          </tr>
        </thead>
        <tbody>
          {#each servers as server}
            <tr class="border-t border-zinc-800/60 hover:bg-zinc-900/30">
              <td class="px-4 py-2.5 text-zinc-200 font-medium">{server.name}</td>
              <td class="px-4 py-2.5">
                <span class="px-1.5 py-0.5 text-xs rounded bg-zinc-800 text-zinc-400">{server.transport}</span>
              </td>
              <td class="px-4 py-2.5 text-zinc-400 font-mono text-xs truncate max-w-xs">
                {server.transport === 'stdio' ? `${server.command} ${(server.args || []).join(' ')}` : server.endpoint}
              </td>
              <td class="px-4 py-2.5 text-right">
                <button onclick={() => removeServer(server.name)} class="text-xs text-red-400/70 hover:text-red-400 transition-colors">Remove</button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>
