import { useState, type ReactNode } from "react"
import {
  QueryClient,
  QueryClientProvider as TanstackQueryClientProvider,
} from "@tanstack/react-query"

import { ApiError } from "@/lib/api"

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: (failureCount, error) => {
          if (error instanceof ApiError) {
            if (error.status === 401 || error.status === 403) return false
            if (error.status === 404) return false
            if (error.status >= 400 && error.status < 500) return false
          }
          return failureCount < 2
        },
      },
      mutations: { retry: false },
    },
  })
}

/**
 * React Query client for the mobile app. Mounted inside AppProviders (above the
 * Session/Workspace/Chat providers) so screen hooks can use queries. The chat
 * realtime store stays on ChatRuntime — only request/response screen data uses
 * React Query.
 */
export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(makeQueryClient)
  return (
    <TanstackQueryClientProvider client={client}>
      {children}
    </TanstackQueryClientProvider>
  )
}
