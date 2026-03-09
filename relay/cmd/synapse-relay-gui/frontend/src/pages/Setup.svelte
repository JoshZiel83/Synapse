<script lang="ts">
  import { callGo } from '../lib/wails'

  let endpoint = $state('')
  let token = $state('')
  let testResult = $state('')
  let testError = $state('')
  let testing = $state(false)
  let saving = $state(false)

  async function loadConfig() {
    try {
      const cfg = await callGo<any>('GetConfig')
      endpoint = cfg.endpoint || ''
      token = cfg.token || ''
    } catch {}
  }

  async function testConnection() {
    if (!endpoint || !token) return
    testing = true
    testResult = ''
    testError = ''
    try {
      const result = await callGo<string>('TestConnection', endpoint, token)
      testResult = result
    } catch (e: any) {
      testError = e?.message || String(e)
    } finally {
      testing = false
    }
  }

  async function save() {
    saving = true
    try {
      const cfg = await callGo<any>('GetConfig')
      cfg.endpoint = endpoint
      cfg.token = token
      await callGo('SaveConfig', cfg)
      testResult = 'Configuration saved.'
      testError = ''
    } catch (e: any) {
      testError = e?.message || String(e)
    } finally {
      saving = false
    }
  }

  loadConfig()
</script>

<div class="p-6 max-w-xl">
  <h2 class="text-lg font-semibold text-zinc-200 mb-1">Connection Setup</h2>
  <p class="text-sm text-zinc-500 mb-6">Configure the relay endpoint and authentication token.</p>

  <label class="block mb-4">
    <span class="text-xs font-medium text-zinc-400 uppercase tracking-wide">Endpoint URL</span>
    <input
      type="text"
      bind:value={endpoint}
      placeholder="wss://your-server/relay/ws"
      class="mt-1 w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30"
    />
  </label>

  <label class="block mb-6">
    <span class="text-xs font-medium text-zinc-400 uppercase tracking-wide">Auth Token</span>
    <input
      type="password"
      bind:value={token}
      placeholder="relay-xxxxx"
      class="mt-1 w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30"
    />
  </label>

  <div class="flex gap-3">
    <button
      onclick={testConnection}
      disabled={testing || !endpoint || !token}
      class="px-4 py-2 text-sm rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
    >
      {testing ? 'Testing...' : 'Test Connection'}
    </button>
    <button
      onclick={save}
      disabled={saving || !endpoint || !token}
      class="px-4 py-2 text-sm rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
    >
      {saving ? 'Saving...' : 'Save'}
    </button>
  </div>

  {#if testResult}
    <div class="mt-4 px-3 py-2 rounded bg-emerald-900/30 border border-emerald-800/50 text-sm text-emerald-300">
      {testResult}
    </div>
  {/if}
  {#if testError}
    <div class="mt-4 px-3 py-2 rounded bg-red-900/30 border border-red-800/50 text-sm text-red-300">
      {testError}
    </div>
  {/if}
</div>
