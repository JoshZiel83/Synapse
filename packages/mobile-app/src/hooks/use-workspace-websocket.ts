import { useCallback, useEffect, useRef } from "react";

import { getWebSocketUrl } from "@/lib/config";
import { useSession } from "@/providers/session-provider";
import type { ChatSocketEvent } from "@shared";

interface UseWorkspaceWebSocketOptions {
  workspaceId: string | null;
  enabled?: boolean;
  onEvent?: (event: ChatSocketEvent | Record<string, unknown>) => void;
  onConnected?: (payload: {
    workspaceId: string;
    lastWorkspaceSequence: number;
  }) => void;
  onGap?: (payload?: {
    expectedWorkspaceSequence?: number;
    actualWorkspaceSequence?: number;
  }) => void;
}

export function useWorkspaceWebSocket({
  workspaceId,
  enabled = true,
  onEvent,
  onConnected,
  onGap,
}: UseWorkspaceWebSocketOptions) {
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const mountedRef = useRef(true);
  const manuallyClosedRef = useRef(false);
  const workspaceSequenceRef = useRef(0);
  const { token } = useSession();
  const onEventRef = useRef(onEvent);
  const onConnectedRef = useRef(onConnected);
  const onGapRef = useRef(onGap);

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    onConnectedRef.current = onConnected;
  }, [onConnected]);

  useEffect(() => {
    onGapRef.current = onGap;
  }, [onGap]);

  const cleanup = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    if (socketRef.current) {
      socketRef.current.onopen = null;
      socketRef.current.onmessage = null;
      socketRef.current.onclose = null;
      socketRef.current.onerror = null;
      socketRef.current.close();
      socketRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    if (!mountedRef.current || !enabled || !workspaceId || !token) return;

    manuallyClosedRef.current = false;
    cleanup();

    const socket = new WebSocket(getWebSocketUrl());
    socketRef.current = socket;

    socket.onopen = () => {
      reconnectAttemptsRef.current = 0;
      socket.send(
        JSON.stringify({
          type: "auth",
          workspaceId,
          token,
          lastWorkspaceSequence: workspaceSequenceRef.current,
        }),
      );
    };

    socket.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as Record<string, unknown>;
        const rawType = typeof parsed.type === "string" ? parsed.type : "";
        const normalizedType =
          rawType === "auth_ok"
            ? "auth.ok"
            : rawType === "auth_error"
              ? "auth.error"
              : rawType === "server_shutdown"
                ? "server.shutdown"
                : rawType;

        const normalized = {
          ...parsed,
          type: normalizedType,
        } as ChatSocketEvent | Record<string, unknown>;

        if (normalizedType === "auth.ok") {
          const payload = (normalized as ChatSocketEvent<"auth.ok">).payload;
          workspaceSequenceRef.current = Number(
            payload.lastWorkspaceSequence || workspaceSequenceRef.current || 0,
          );
          onConnectedRef.current?.({
            workspaceId,
            lastWorkspaceSequence: workspaceSequenceRef.current,
          });
          return;
        }

        if (normalizedType === "auth.error") {
          manuallyClosedRef.current = true;
          cleanup();
          return;
        }

        if (normalizedType === "ping") {
          socket.send(JSON.stringify({ type: "pong" }));
          return;
        }

        if (normalizedType === "feed.resync.required") {
          const payload = (
            normalized as ChatSocketEvent<"feed.resync.required">
          ).payload;
          onGapRef.current?.({
            expectedWorkspaceSequence: payload.expectedWorkspaceSequence,
            actualWorkspaceSequence: payload.actualWorkspaceSequence,
          });
          return;
        }

        if (normalizedType === "feed.item.created") {
          const payload = (normalized as ChatSocketEvent<"feed.item.created">)
            .payload;
          const nextSequence = Number(payload.workspaceSequence || 0);
          const currentSequence = workspaceSequenceRef.current;

          if (
            !Number.isFinite(nextSequence) ||
            nextSequence <= currentSequence
          ) {
            return;
          }

          if (nextSequence > currentSequence + 1) {
            workspaceSequenceRef.current = nextSequence;
            onGapRef.current?.({
              expectedWorkspaceSequence: currentSequence + 1,
              actualWorkspaceSequence: nextSequence,
            });
            return;
          }

          workspaceSequenceRef.current = nextSequence;
          onEventRef.current?.(
            normalized as ChatSocketEvent<"feed.item.created">,
          );
          return;
        }

        onEventRef.current?.(normalized);
      } catch {
        // Ignore malformed websocket frames.
      }
    };

    socket.onclose = () => {
      if (!mountedRef.current || manuallyClosedRef.current) {
        return;
      }

      reconnectAttemptsRef.current += 1;
      const delay = Math.min(5000, 1000 * reconnectAttemptsRef.current);
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        connect();
      }, delay);
    };

    socket.onerror = () => {
      // Let the close handler schedule reconnects.
    };
  }, [cleanup, enabled, token, workspaceId]);

  useEffect(() => {
    mountedRef.current = true;
    workspaceSequenceRef.current = 0;

    if (enabled && workspaceId && token) {
      connect();
    }

    return () => {
      mountedRef.current = false;
      manuallyClosedRef.current = true;
      cleanup();
    };
  }, [cleanup, connect, enabled, token, workspaceId]);
}
