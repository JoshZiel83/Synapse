"use client"

import { useCallback } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useAuthStore } from "@/stores/auth-store"
import { qk } from "@/lib/query-keys"

/**
 * Logout that also wipes the React Query cache, so a subsequent login (possibly
 * as a different user) never reads another session's cached data. Kept as a hook
 * — rather than baked into the vanilla zustand auth store — so the store stays
 * free of a React Query dependency.
 */
export function useLogout() {
  const logout = useAuthStore((state) => state.logout)
  const queryClient = useQueryClient()

  return useCallback(async () => {
    try {
      await logout()
    } finally {
      queryClient.clear()
    }
  }, [logout, queryClient])
}

/**
 * Drop every cached query scoped to a workspace. Call when switching workspaces
 * so the previous workspace's data doesn't bleed into the next.
 */
export function useClearWorkspaceQueries() {
  const queryClient = useQueryClient()
  return useCallback(
    (workspaceId: string) => {
      queryClient.removeQueries({ queryKey: qk.workspace(workspaceId) })
    },
    [queryClient]
  )
}
