// The local HTTP server: JSON API, Server Sent Events and the built dashboard (web/dist) if it exists.
// It listens on 127.0.0.1 only. Every response carries the security headers; the Host header and method are checked first.
import { existsSync, realpathSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, extname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ApiError } from '../api/types.ts';
import { isInside } from '../config/paths.ts';
import { createQueryCache, type QueryCache } from '../metrics/cache.ts';
import type { SyncStatus } from '../ingest/scheduler.ts';
import type { Db } from '../store/db.ts';
import { handleApi } from './routes.ts';
import { applySecurityHeaders, refuse } from './security.ts';
import { createSseHub, type SseHub } from './sse.ts';

export const LOOPBACK = '127.0.0.1';

export interface ServerOptions {
  db: Db;
  tz: string;
  port: number; // 0 picks a free port (tests); the Host check then uses the port that was given by the system
  syncStatus: () => SyncStatus;
  now?: () => number;
  hub?: SseHub;
  // Answer cache for the queries that scan the fact tables. Default: a new one. It is cleared whenever the hub
  // announces a synced event (handlePass sends one after every pass that changed something, once the rollups are fresh).
  cache?: QueryCache;
  // Folder with the built dashboard. Defaults to web/dist next to the sources.
  webRoot?: string;
}

export interface RunningServer {
  host: string; // the address the socket is bound to, always the loopback address
  port: number;
  url: string;
  hub: SseHub;
  cache: QueryCache;
  close(): Promise<void>;
}

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_WEB_ROOT = resolve(here, '..', '..', 'web', 'dist');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const PLACEHOLDER = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Usage Ledger</title></head>
<body>
<h1>Usage Ledger</h1>
<p>The dashboard has not been built yet. The data is already available as JSON, for example at <a href="/api/summary">/api/summary</a>.</p>
</body>
</html>
`;

function sendJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(req.method === 'HEAD' ? undefined : text);
}

function sendText(req: IncomingMessage, res: ServerResponse, status: number, type: string, text: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(text), ...extra });
  res.end(req.method === 'HEAD' ? undefined : text);
}

// Maps a URL path to a file inside `root`, or null. Refuses encoded traversal, hidden files and symlinks that leave the root.
export function resolveStatic(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const parts = decoded.split('/').filter((s) => s !== '');
  if (parts.some((s) => s === '..' || s.startsWith('.'))) return null;
  const rel = posix.normalize('/' + parts.join('/'));
  const full = join(root, rel);
  let real: string;
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
    real = realpathSync(full);
  } catch {
    return null;
  }
  if (!isInside(realRoot, real)) return null;
  try {
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, root: string, pathname: string): Promise<void> {
  const hasIndex = existsSync(join(root, 'index.html'));
  if (!hasIndex) {
    if (pathname === '/') sendText(req, res, 200, 'text/html; charset=utf-8', PLACEHOLDER, { 'Cache-Control': 'no-store' });
    else sendJson(req, res, 404, { error: 'There is nothing at this address.' } satisfies ApiError);
    return;
  }
  const wantsFile = extname(pathname) !== '';
  let file = resolveStatic(root, pathname === '/' ? '/index.html' : pathname);
  // A path without an extension belongs to the single page app, which routes it itself.
  if (file === null && !wantsFile) file = resolveStatic(root, '/index.html');
  if (file === null) {
    sendJson(req, res, 404, { error: 'There is nothing at this address.' } satisfies ApiError);
    return;
  }
  const body = await readFile(file);
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

export function startServer(opts: ServerOptions): Promise<RunningServer> {
  const hub = opts.hub ?? createSseHub();
  const cache = opts.cache ?? createQueryCache();
  const announce = hub.broadcast.bind(hub);
  hub.broadcast = (event) => {
    cache.clear(); // before anyone is told, so no later request reads an answer from before the pass
    announce(event);
  };
  const now = opts.now ?? Date.now;
  const root = opts.webRoot ?? DEFAULT_WEB_ROOT;
  let boundPort = opts.port;

  const server: Server = createServer((req, res) => {
    applySecurityHeaders(res);
    const refusal = refuse(req, boundPort);
    if (refusal !== null) {
      if (refusal.status === 405) res.setHeader('Allow', 'GET, HEAD');
      sendJson(req, res, refusal.status, { error: refusal.error } satisfies ApiError);
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${LOOPBACK}`);
    } catch {
      sendJson(req, res, 400, { error: 'The request address is not valid.' } satisfies ApiError);
      return;
    }
    if (url.pathname === '/api/events') {
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end();
      } else hub.add(res);
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      const r = handleApi({ db: opts.db, tz: opts.tz, now, syncStatus: opts.syncStatus, cache }, url.pathname, url.searchParams);
      if (r.file !== undefined) {
        // The file name is built from the period and two dates, so it holds only letters, digits and hyphens.
        sendText(req, res, r.status, r.file.type, r.file.text, {
          'Content-Disposition': `attachment; filename="${r.file.filename}"`,
          'Cache-Control': 'no-store',
        });
      } else sendJson(req, res, r.status, r.body);
      return;
    }
    serveStatic(req, res, root, url.pathname).catch(() => {
      if (!res.headersSent) sendJson(req, res, 500, { error: 'Something went wrong while answering this request.' } satisfies ApiError);
      else res.destroy();
    });
  });

  return new Promise<RunningServer>((resolveStart, rejectStart) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        rejectStart(new Error(`Port ${opts.port} is already in use. Stop the other program or set LEDGER_PORT to another port.`));
      } else rejectStart(err);
    });
    server.listen(opts.port, LOOPBACK, () => {
      // From now on a stray socket error must not take the process down.
      server.removeAllListeners('error');
      server.on('error', () => undefined);
      const addr = server.address();
      boundPort = typeof addr === 'object' && addr !== null ? addr.port : opts.port;
      resolveStart({
        host: typeof addr === 'object' && addr !== null ? addr.address : LOOPBACK,
        port: boundPort,
        url: `http://${LOOPBACK}:${boundPort}`,
        hub,
        cache,
        close: () =>
          new Promise<void>((done) => {
            hub.close();
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}
