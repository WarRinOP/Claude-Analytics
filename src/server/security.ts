// Request rules for the local server: loopback Host header only (DNS rebinding defence), GET and HEAD
// only, no CORS headers, and a strict Content-Security-Policy on every response.
import type { IncomingMessage, ServerResponse } from 'node:http';

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

// The Host header must be exactly 127.0.0.1:<port> or localhost:<port>. Anything else (another name, no port, a
// different port, a second value) is refused, so a page on another site that points its own name at this Mac cannot read
// the API.
export function hostAllowed(host: string | undefined, port: number): boolean {
  if (host === undefined) return false;
  return host === `127.0.0.1:${port}` || host.toLowerCase() === `localhost:${port}`;
}

export function methodAllowed(method: string | undefined): boolean {
  return method === 'GET' || method === 'HEAD';
}

export function applySecurityHeaders(res: ServerResponse): void {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
}

export type Refusal = { status: 403 | 405; error: string };

// Null when the request may go on.
export function refuse(req: IncomingMessage, port: number): Refusal | null {
  if (!hostAllowed(req.headers.host, port)) return { status: 403, error: 'This address is not allowed. Use http://127.0.0.1 with the port the ledger prints at start.' };
  if (!methodAllowed(req.method)) return { status: 405, error: 'Only GET and HEAD are allowed.' };
  return null;
}
