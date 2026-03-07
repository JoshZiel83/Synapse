'use client';
import { useEffect, useRef, useState } from 'react';

export function useWebSocket(workspaceId: string | null) {
  const ws = useRef<WebSocket | null>(null);
  const [lastEvent, setLastEvent] = useState<any>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!workspaceId) return;
    const url = `${(process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:3001')}/ws`;
    const socket = new WebSocket(url);
    ws.current = socket;
    socket.onopen = () => {
      const token = localStorage.getItem('token');
      socket.send(JSON.stringify({ type: 'auth', userId: '', workspaceId }));
      setConnected(true);
    };
    socket.onmessage = (e) => { try { setLastEvent(JSON.parse(e.data)); } catch {} };
    socket.onclose = () => setConnected(false);
    return () => { socket.close(); };
  }, [workspaceId]);

  return { lastEvent, connected };
}
