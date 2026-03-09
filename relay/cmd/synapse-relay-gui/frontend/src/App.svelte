<script lang="ts">
  import './app.css'
  import Setup from './pages/Setup.svelte'
  import Servers from './pages/Servers.svelte'
  import Import from './pages/Import.svelte'
  import Dashboard from './pages/Dashboard.svelte'

  let currentPage = $state('dashboard')

  const pages = [
    { id: 'dashboard', label: 'Dashboard', icon: '◉' },
    { id: 'servers', label: 'Servers', icon: '⬡' },
    { id: 'import', label: 'Import', icon: '↓' },
    { id: 'setup', label: 'Setup', icon: '⚙' },
  ]
</script>

<div class="flex h-screen bg-zinc-950 text-zinc-100 select-none">
  <!-- Sidebar -->
  <nav class="w-48 border-r border-zinc-800 bg-zinc-900/50 flex flex-col">
    <div class="px-4 py-5 border-b border-zinc-800">
      <h1 class="text-sm font-semibold tracking-wide text-zinc-300 uppercase">Synapse Relay</h1>
    </div>
    <div class="flex-1 py-2">
      {#each pages as page}
        <button
          class="w-full text-left px-4 py-2.5 text-sm flex items-center gap-2.5 transition-colors {currentPage === page.id ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'}"
          onclick={() => currentPage = page.id}
        >
          <span class="text-base opacity-70">{page.icon}</span>
          {page.label}
        </button>
      {/each}
    </div>
    <div class="px-4 py-3 border-t border-zinc-800 text-xs text-zinc-600">
      v0.1.0
    </div>
  </nav>

  <!-- Main content -->
  <main class="flex-1 overflow-auto">
    {#if currentPage === 'setup'}
      <Setup />
    {:else if currentPage === 'servers'}
      <Servers />
    {:else if currentPage === 'import'}
      <Import />
    {:else}
      <Dashboard />
    {/if}
  </main>
</div>
