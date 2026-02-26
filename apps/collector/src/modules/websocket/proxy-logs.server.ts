
import { WebSocketServer, WebSocket } from 'ws';
import { ProxyManagerService } from '../proxy-manager/proxy-manager.service.js';

export interface LogMessage {
  time: string;
  level: string;
  msg: string;
}

export class ProxyLogsWebSocketServer {
  private wss: WebSocketServer;
  private proxyManager: ProxyManagerService;
  private clients: Set<WebSocket> = new Set();

  // Keep a buffer of recent logs for new connections
  private recentLogs: LogMessage[] = [];
  private static MAX_RECENT_LOGS = 100;

  constructor(port: number, proxyManager: ProxyManagerService) {
    this.wss = new WebSocketServer({
      port,
      host: '0.0.0.0',
    });
    this.proxyManager = proxyManager;

    this.wss.on('connection', (ws: WebSocket) => {
      this.clients.add(ws);

      // Send recent logs immediately
      if (this.recentLogs.length > 0) {
        ws.send(JSON.stringify({ type: 'history', data: this.recentLogs }));
      }

      ws.on('close', () => {
        this.clients.delete(ws);
      });

      ws.on('error', (err) => {
        console.error('[ProxyLogsWebSocket] Client error:', err);
        this.clients.delete(ws);
      });
    });

    console.log(`[ProxyLogsWebSocket] Server running at ws://0.0.0.0:${port}`);

    // Bind to proxy manager log events
    this.proxyManager.on('log', (logLine: string) => {
      this.broadcastLog(logLine);
    });
  }

  public broadcastLog(rawLog: string) {
    const log = this.parseLog(rawLog);
    if (!log) return;

    this.recentLogs.push(log);
    if (this.recentLogs.length > ProxyLogsWebSocketServer.MAX_RECENT_LOGS) {
      this.recentLogs.shift();
    }

    const payload = JSON.stringify({ type: 'log', data: log });
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  private parseLog(line: string): LogMessage | null {
    if (!line || !line.trim()) return null;

    // Example: time="2023-10-27T10:00:00.123Z" level=info msg="Start..."
    const timeMatch = line.match(/time="([^"]+)"/);
    const levelMatch = line.match(/level=([a-zA-Z]+)/);
    const msgMatch = line.match(/msg="([^"]+)"/);

    if (timeMatch && levelMatch && msgMatch) {
      return {
        time: timeMatch[1],
        level: levelMatch[1],
        msg: msgMatch[1],
      };
    }

    // Fallback for unstructured logs
    return {
      time: new Date().toISOString(),
      level: 'info',
      msg: line,
    };
  }

  public stop() {
    this.clients.forEach(c => c.close());
    this.clients.clear();
    this.wss.close();
  }
}
