'use client';
import { useEffect, useRef, useState, useCallback } from 'react';

interface UseWebSocketOptions {
  workspaceId: string | null;
  onEvent?: (event: any) => void;
}

export function useWebSocket({ workspaceId, onEvent }: UseWebSocketOptions) {
  const ws = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const onEventRef = useRef(onEvent);
  const reconnectAttempts = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingCheckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxReconnectAttempts = 20;
  const mountedRef = useRef(true);

  // Keep onEvent ref updated without causing reconnects
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  const cleanup = useCallback(() => {
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    if (pingCheckTimer.current) {
      clearTimeout(pingCheckTimer.current);
      pingCheckTimer.current = null;
    }
    if (ws.current) {
      ws.current.onopen = null;
      ws.current.onmessage = null;
      ws.current.onclose = null;
      ws.current.onerror = null;
      ws.current.close();
      ws.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    if (!workspaceId || !mountedRef.current) return;

    cleanup();
    setConnecting(true);

    const wsUrl = process.env.NEXT_PUBLIC_WS_URL;
    let url: string;
    if (wsUrl) {
      url = `${wsUrl}/ws`;
    } else if (typeof window !== 'undefined') {
      // Auto-detect: use wss:// for https, ws:// for http
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      url = `${proto}//${window.location.host}/ws`;
    } else {
      url = 'ws://localhost:3001/ws';
    }
    const socket = new WebSocket(url);
    ws.current = socket;

    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'auth', workspaceId }));
    };

    socket.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);

        if (msg.type === 'auth_ok') {
          setConnected(true);
          setConnecting(false);
          reconnectAttempts.current = 0;

          // Start ping watchdog — expect a ping within 45s
          resetPingWatchdog();
          return;
        }

        if (msg.type === 'auth_error') {
          setConnecting(false);
          reconnectAttempts.current = maxReconnectAttempts;
          socket.close();
          return;
        }

        if (msg.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong' }));
          resetPingWatchdog();
          return;
        }

        // Forward all other events to the handler
        onEventRef.current?.(msg);
      } catch {
        // ignore parse errors
      }
    };

    socket.onclose = () => {
      setConnected(false);
      setConnecting(false);
      if (pingCheckTimer.current) {
        clearTimeout(pingCheckTimer.current);
        pingCheckTimer.current = null;
      }

      // Reconnect with exponential backoff
      if (mountedRef.current && reconnectAttempts.current < maxReconnectAttempts) {
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 30000);
        const jitter = Math.random() * 1000;
        reconnectAttempts.current++;
        reconnectTimer.current = setTimeout(() => {
          if (mountedRef.current) connect();
        }, delay + jitter);
      }
    };

    socket.onerror = () => {
      // onclose will fire after this
    };

    function resetPingWatchdog() {
      if (pingCheckTimer.current) clearTimeout(pingCheckTimer.current);
      pingCheckTimer.current = setTimeout(() => {
        // No ping for 45s, force reconnect
        if (mountedRef.current) {
          socket.close();
        }
      }, 45000);
    }
  }, [workspaceId, cleanup]);

  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      cleanup();
    };
  }, [connect, cleanup]);

  return { connected, connecting };
}
