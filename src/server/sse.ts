// Server Sent Events for GET /api/events: a `synced` event after a pass that changed something, and a comment line as a
// heartbeat every 25 seconds so a dead connection is noticed. Closed clients are dropped at once.
import type { ServerResponse } from 'node:http';
import type { SyncedEvent } from '../api/types.ts';

export const HEARTBEAT_MS = 25_000;

export interface SseHub {
  add(res: ServerResponse): void;
  broadcast(event: SyncedEvent): void;
  size(): number;
  close(): void;
}

export interface SseOptions {
  heartbeatMs?: number;
}

export function createSseHub(opts: SseOptions = {}): SseHub {
  const clients = new Set<ServerResponse>();

  const send = (text: string): void => {
    for (const res of [...clients]) {
      if (res.destroyed || res.writableEnded) {
        clients.delete(res);
        continue;
      }
      try {
        res.write(text);
      } catch {
        clients.delete(res);
      }
    }
  };

  const timer = setInterval(() => send(': heartbeat\n\n'), opts.heartbeatMs ?? HEARTBEAT_MS);
  timer.unref();

  return {
    add(res) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      res.socket?.setNoDelay(true);
      res.socket?.setTimeout(0);
      res.write('retry: 3000\n\n: connected\n\n');
      clients.add(res);
      res.on('close', () => clients.delete(res));
    },
    broadcast(event) {
      send(`event: synced\ndata: ${JSON.stringify(event)}\n\n`);
    },
    size() {
      return clients.size;
    },
    close() {
      clearInterval(timer);
      for (const res of clients) {
        try {
          res.end();
        } catch {
          // already closed
        }
      }
      clients.clear();
    },
  };
}
