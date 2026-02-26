import { useEffect, useRef, useState, useCallback } from "react";

export interface LogMessage {
  time: string;
  level: string;
  msg: string;
}

export function useProxyLogs(enabled: boolean) {
  const [logs, setLogs] = useState<LogMessage[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!enabled) {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      return;
    }

    let isMounted = true;

    const connect = () => {
      if (!isMounted) return;

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = window.location.hostname;
      const port = '3003';
      const url = `${protocol}//${host}:${port}`;

      console.log(`[useProxyLogs] Connecting to ${url}`);

      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[useProxyLogs] Connected');
      };

      ws.onmessage = (event) => {
        if (!isMounted) return;
        try {
          const payload = JSON.parse(event.data);
          if (payload.type === 'history') {
            setLogs(payload.data);
          } else if (payload.type === 'log') {
            setLogs(prev => [...prev, payload.data].slice(-1000));
          }
        } catch (e) {
          console.error('[useProxyLogs] Failed to parse message', e);
        }
      };

      ws.onclose = () => {
        console.log('[useProxyLogs] Disconnected');
        wsRef.current = null;
        if (isMounted && enabled) {
          reconnectTimeoutRef.current = setTimeout(connect, 3000);
        }
      };

      ws.onerror = (err) => {
        console.error('[useProxyLogs] Error', err);
        ws.close();
      };
    };

    connect();

    return () => {
      isMounted = false;
      if (wsRef.current) {
        // Remove listener to prevent reconnection attempt on cleanup
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [enabled]);

  const clearLogs = useCallback(() => {
    setLogs([]);
  }, []);

  return { logs, clearLogs };
}
