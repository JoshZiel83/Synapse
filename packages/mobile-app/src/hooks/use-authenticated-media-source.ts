import { useEffect, useMemo, useState } from "react"
import { Platform } from "react-native"

import { buildAuthenticatedSource, reportApiUnauthorized } from "@/lib/api"

type AuthenticatedMediaSource = ReturnType<
  typeof buildAuthenticatedSource
> | null

export function useAuthenticatedMediaSource(
  pathOrUrl?: string | null
): AuthenticatedMediaSource {
  const nativeSource = useMemo(
    () => (pathOrUrl ? buildAuthenticatedSource(pathOrUrl) : null),
    [pathOrUrl]
  )
  const [webSource, setWebSource] = useState<AuthenticatedMediaSource>(
    Platform.OS === "web" ? null : nativeSource
  )

  useEffect(() => {
    if (Platform.OS !== "web") {
      return
    }

    setWebSource(null)
    if (!pathOrUrl) {
      return
    }

    const remoteSource = buildAuthenticatedSource(pathOrUrl)
    const controller = new AbortController()
    let active = true
    let objectUrl: string | null = null

    void (async () => {
      try {
        const response = await fetch(remoteSource.uri, {
          headers: remoteSource.headers,
          signal: controller.signal,
        })

        if (response.status === 401) {
          reportApiUnauthorized(401)
          return
        }

        if (!response.ok) {
          return
        }

        const blob = await response.blob()
        if (!active) {
          return
        }

        objectUrl = URL.createObjectURL(blob)
        setWebSource({ uri: objectUrl })
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return
        }
      }
    })()

    return () => {
      active = false
      controller.abort()
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
      }
    }
  }, [pathOrUrl])

  return Platform.OS === "web" ? webSource : nativeSource
}
