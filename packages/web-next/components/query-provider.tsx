"use client"

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
        // Server state is generally fresh for a short window; tune per-query.
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        retry: (failureCount, error) => {
          // Do not retry auth/permission/not-found errors — only transient ones.
          if (error instanceof ApiError) {
            if (error.status === 401 || error.status === 403) return false
            if (error.status === 404) return false
            if (error.status >= 400 && error.status < 500) return false
          }
          return failureCount < 2
        },
      },
      mutations: {
        retry: false,
      },
    },
  })
}

/**
 * Mounts the React Query client for the whole app. Placed inside AuthStoreProvider
 * (see app/layout.tsx) so query/mutation hooks can coordinate with auth. The
 * client is created once per browser session via a lazy useState initializer.
 */
export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(makeQueryClient)
  return (
    <TanstackQueryClientProvider client={client}>
      {children}
    </TanstackQueryClientProvider>
  )
}
