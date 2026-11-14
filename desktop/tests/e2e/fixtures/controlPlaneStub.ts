/**
 * In-process control-plane stub for the Electron connection-isolation e2e (#86 Task 10).
 *
 * Two of these stand in for two self-hosted servers. They are deliberately twins: both
 * answer with the SAME `userId` and `username`, so the only thing that can tell their
 * data apart is the connection it arrived on (acceptance A2). Every response carries
 * `Set-Cookie: plane=<port>` so a test can read which plane wrote into which jar.
 *
 * The planes listen on `localhost`. Cookies are not port-scoped, so if two connections
 * shared a cookie jar, plane B's cookie would land on top of plane A's — the exact
 * collision the per-service session prevents.
 *
 * Surface (all under `/api/v1`): `client-config`, `auth/login`, `auth/refresh`,
 * `auth/logout`, `users/me`, plus a websocket echo at `/ws`. Anything else is a 404
 * that still carries the cookie and the CORS headers.
 */
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

/** Identical on both planes by design — the duplicate-id fixture. */
export const STUB_USER_ID = '00000000-0000-4000-8000-000000000086';
export const STUB_USERNAME = 'isolation-twin';

/** The renderer origin the unpackaged shell loads every view from. */
export const RENDERER_ORIGIN = 'http://localhost:3001';

export interface StubRequest {
  method: string;
  path: string;
  /** The `X-Refresh-Token` header, when present. */
  refreshToken: string | null;
}

export interface StubPlane {
  readonly port: number;
  /** Canonical `new URL(x).origin` form: `http://localhost:<port>`. */
  readonly origin: string;
  readonly requests: StubRequest[];
  /** Open websocket count, as the server sees it. */
  openSockets(): number;
  /** Outage: drop every socket and stop listening. Idempotent. */
  stop(): Promise<void>;
}

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function corsHeaders(req: http.IncomingMessage): Record<string, string> {
  const origin = req.headers.origin;
  // Only the shell's renderer origin is reflected; credentials need an exact origin.
  if (origin !== RENDERER_ORIGIN) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Refresh-Token',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    Vary: 'Origin',
  };
}

function tokenPair(port: number, n: number): { access_token: string; refresh_token: string } {
  return { access_token: `access-${port}-${n}`, refresh_token: `refresh-${port}-${n}` };
}

function route(port: number, method: string, path: string, n: number): [number, unknown] {
  if (method === 'GET' && path === '/api/v1/client-config') {
    return [200, { version: 1 }];
  }
  if (method === 'POST' && path === '/api/v1/auth/login') {
    return [200, { ...tokenPair(port, n), user: { id: STUB_USER_ID, username: STUB_USERNAME } }];
  }
  if (method === 'POST' && path === '/api/v1/auth/refresh') {
    return [200, tokenPair(port, n)];
  }
  if (method === 'POST' && path === '/api/v1/auth/logout') {
    return [204, null];
  }
  if (method === 'GET' && path === '/api/v1/users/me') {
    return [200, { id: STUB_USER_ID, username: STUB_USERNAME }];
  }
  return [404, { error: 'not stubbed' }];
}

/** Minimal RFC 6455 server side: unmasks client text frames and echoes them back. */
function acceptWebSocket(req: http.IncomingMessage, socket: Duplex, track: Set<Duplex>): void {
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || req.url !== '/ws') {
    socket.destroy();
    return;
  }
  const accept = createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  track.add(socket);
  socket.on('close', () => track.delete(socket));
  socket.on('error', () => track.delete(socket));
  let buffered = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 2) {
      const opcode = buffered[0] & 0x0f;
      let len = buffered[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buffered.length < 4) return;
        len = buffered.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        socket.destroy(); // the echo never needs frames this large
        return;
      }
      const masked = (buffered[1] & 0x80) !== 0;
      const maskOffset = offset;
      if (masked) offset += 4;
      if (buffered.length < offset + len) return;
      const payload = Buffer.from(buffered.subarray(offset, offset + len));
      if (masked) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= buffered[maskOffset + (i % 4)];
      }
      buffered = buffered.subarray(offset + len);
      if (opcode === 0x8) {
        socket.end(Buffer.from([0x88, 0x00]));
        return;
      }
      if (opcode === 0x1 && payload.length < 126) {
        socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
      }
    }
  });
}

export async function startStubPlane(port = 0): Promise<StubPlane> {
  const requests: StubRequest[] = [];
  const sockets = new Set<Duplex>();
  const connections = new Set<Duplex>();
  let counter = 0;

  const server = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const method = req.method ?? 'GET';
    const header = req.headers['x-refresh-token'];
    requests.push({ method, path, refreshToken: typeof header === 'string' ? header : null });
    req.resume();
    const listenPort = (server.address() as AddressInfo).port;
    const base = {
      ...corsHeaders(req),
      'Set-Cookie': `plane=${listenPort}; Path=/; SameSite=Lax`,
      'Cache-Control': 'no-store',
    };
    if (method === 'OPTIONS') {
      res.writeHead(204, base).end();
      return;
    }
    counter += 1;
    const [status, body] = route(listenPort, method, path, counter);
    if (body === null) {
      res.writeHead(status, base).end();
      return;
    }
    res
      .writeHead(status, { ...base, 'Content-Type': 'application/json' })
      .end(JSON.stringify(body));
  });
  server.on('connection', (socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
  });
  server.on('upgrade', (req, socket) => acceptWebSocket(req, socket, sockets));

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Loopback only; Chromium resolves `localhost` to the loopback addresses.
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const bound = (server.address() as AddressInfo).port;

  let stopped: Promise<void> | null = null;
  return {
    port: bound,
    origin: `http://localhost:${bound}`,
    requests,
    openSockets: () => sockets.size,
    stop: () => {
      stopped ??= new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        for (const s of connections) s.destroy();
        server.close(() => resolve());
      });
      return stopped;
    },
  };
}
