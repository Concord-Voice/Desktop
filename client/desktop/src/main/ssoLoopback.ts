/**
 * Loopback HTTP server for SSO OAuth callback capture.
 *
 * The Electron main process opens a short-lived HTTP listener bound to
 * 127.0.0.1 on an OS-assigned ephemeral port. The user's OS browser is
 * redirected to `http://127.0.0.1:<port>/oauth/callback?code=...&state=...`
 * by the OAuth provider after consent. This server captures the
 * `{code, state}` pair, returns a friendly success page to the browser
 * tab, and shuts down.
 *
 * Security posture:
 *   - 127.0.0.1 binding (not 0.0.0.0) — no external reachability.
 *   - Ephemeral port (`listen(0, ...)`) — no fixed-port collision surface.
 *   - 60s default timeout — abandoned flows do not leak listeners.
 *   - Path is exact-match `/oauth/callback`; everything else returns 404.
 *   - On any terminal outcome (success, provider error, timeout, manual
 *     cancel) the timer AND server are closed; no double-resolution.
 *
 * The renderer never talks to this server directly — it talks to the
 * IPC bridge in `ipc/sso.ts`, which forwards `code+state` after the
 * server has captured them.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';

export interface LoopbackResult {
  code: string;
  state: string;
}

export interface LoopbackHandle {
  port: number;
  redirectURI: string;
  bindAddress: string;
  promise: Promise<LoopbackResult>;
  close: () => void;
}

export interface LoopbackOptions {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const BIND_ADDRESS = '127.0.0.1';
const CALLBACK_PATH = '/oauth/callback';

const SUCCESS_HTML =
  '<!doctype html><html><body><h1>Signed in</h1>' +
  '<p>You can close this tab and return to Concord.</p></body></html>';
const ERROR_HTML =
  '<!doctype html><html><body><h1>Sign-in failed</h1>' +
  '<p>Please return to Concord and try again.</p></body></html>';

/**
 * Start a loopback HTTP server and return a handle once it has bound a port.
 *
 * Async because `server.address()` only returns the OS-assigned ephemeral
 * port after the `'listening'` event fires (Node returns null synchronously
 * after `listen(0, host)`). Awaiting bind in here keeps every field on the
 * returned handle (`port`, `redirectURI`) safely non-null at the boundary.
 */
export function startLoopback(opts: LoopbackOptions = {}): Promise<LoopbackHandle> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let resolveResult!: (r: LoopbackResult) => void;
  let rejectResult!: (e: Error) => void;
  const promise = new Promise<LoopbackResult>((res, rej) => {
    resolveResult = res;
    rejectResult = rej;
  });

  // Track whether the promise has been settled to make cleanup idempotent —
  // a manual close() after success/error must not reject the already-resolved
  // promise, and the timeout firing concurrently with a callback hit must not
  // double-resolve. The HTTP request handler and the timeout each guard their
  // resolve/reject calls behind this flag.
  let settled = false;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Wrap the entire handler in a try/catch to defend against an
    // uncaughtException tearing down the main process. URL parsing on
    // hostile input can throw; downstream res.writeHead can throw if the
    // socket has already closed. Either way, fall back to a 500 + reject
    // the awaiting promise so the renderer surfaces a stable error code
    // rather than the desktop client dying.
    try {
      const url = new URL(req.url ?? '/', `http://${BIND_ADDRESS}`);
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(200, { 'content-type': 'text/html' }).end(ERROR_HTML);
        if (!settled) {
          settled = true;
          cleanup();
          rejectResult(new Error(`oauth_provider_error:${error}`));
        }
        return;
      }
      if (!code || !state) {
        // Malformed callback — respond 400 but DO NOT settle the promise.
        // Lets the timeout fire if no further valid hit arrives, instead of
        // letting a probe request to /oauth/callback (no params) stall the flow.
        res.writeHead(400).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' }).end(SUCCESS_HTML);
      if (!settled) {
        settled = true;
        cleanup();
        resolveResult({ code, state });
      }
    } catch (handlerErr) {
      // Best-effort 500. The socket may already be closed; ignore secondary
      // failures during error reporting.
      try {
        res.writeHead(500).end();
      } catch {
        /* ignore — connection already torn down */
      }
      if (!settled) {
        settled = true;
        cleanup();
        const message = handlerErr instanceof Error ? handlerErr.message : 'request_handler_failed';
        rejectResult(new Error(`oauth_request_handler_failed:${message}`));
      }
    }
  });

  // Catch post-bind socket errors (the original `once('error', ...)` only
  // fires before listen succeeds; once the server is up, an error event on
  // the listening socket would otherwise crash the main process).
  server.on('error', (err) => {
    if (!settled) {
      settled = true;
      cleanup();
      rejectResult(err);
    }
  });

  // Suppress unhandled-rejection noise when callers do not await the
  // returned promise before the timer fires (legitimate in tests that
  // assert rejection synchronously via `await expect(...).rejects`).
  promise.catch(() => undefined);

  let timer: NodeJS.Timeout | null = null;

  function cleanup() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    server.close();
  }

  /**
   * close — caller-driven cancel path. Without rejecting a still-pending
   * `promise`, a renderer that calls `cancelLoopback` (e.g. user backed out
   * of SSO) would leave any awaiter hanging forever. Settle with a stable
   * `oauth_cancelled` code so the renderer's catch maps to "user cancelled
   * sign-in" rather than the generic `sso_failed`.
   */
  function close() {
    if (!settled) {
      settled = true;
      cleanup();
      rejectResult(new Error('oauth_cancelled'));
      return;
    }
    cleanup();
  }

  return new Promise<LoopbackHandle>((resolve, reject) => {
    server.once('error', (err) => {
      cleanup();
      reject(err);
    });
    server.listen(0, BIND_ADDRESS, () => {
      // server.address() returns AddressInfo | string | null. We bind on
      // 127.0.0.1:0 (TCP), so the string variant (named pipe / Unix socket)
      // cannot occur; the typeof guard narrows to AddressInfo without
      // requiring a type assertion.
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        cleanup();
        reject(new Error('loopback_bind_failed'));
        return;
      }
      const port = addr.port;
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectResult(new Error('oauth_timeout'));
      }, timeoutMs);
      resolve({
        port,
        redirectURI: `http://${BIND_ADDRESS}:${port}${CALLBACK_PATH}`,
        bindAddress: BIND_ADDRESS,
        promise,
        // close routes through the settling helper so renderer-driven cancel
        // doesn't leave the awaiter hanging.
        close,
      });
    });
  });
}
