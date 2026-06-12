/**
 * SSO IPC bridge — wires the loopback HTTP server in `ssoLoopback.ts` to the
 * renderer's OAuth flow.
 *
 * Channel surface (5):
 *   - `sso:startLoopback` (invoke)  — spin up a 127.0.0.1 ephemeral-port server
 *                                     and return `{port, redirectURI}` for the
 *                                     renderer to embed in the provider URL.
 *   - `sso:awaitCallback` (invoke)  — await the captured `{code, state}` for a
 *                                     previously started loopback (keyed by
 *                                     port, since the renderer already knows it).
 *   - `sso:cancelLoopback` (send)   — best-effort tear-down for a port the
 *                                     renderer abandoned (user closed the
 *                                     auth tab, switched flows, etc).
 *   - `sso:appleSignIn` (invoke)    — run the FULL client-driven Apple flow
 *                                     (#974) in the main process: PKCE,
 *                                     loopback, broker client_secret, Apple
 *                                     /auth/token, local jose verification,
 *                                     /session POST. Resolves to the
 *                                     discriminated AppleSignInResult; no
 *                                     OAuth material crosses IPC.
 *   - `sso:appleCancel` (send)      — tear down the in-flight Apple flow.
 *
 * Sender-frame validation (the only layer the renderer cannot bypass) is
 * enforced via `isPermittedFrameUrl` — the same helper `openExternal.ts` uses,
 * which keeps the trust boundary consistent across IPC handlers. An untrusted
 * frame causes the invoke handlers to throw (renderer sees a rejected promise)
 * and the send handler to silently no-op.
 *
 * Per-port handle accounting lets `sso:cancelLoopback` and `sso:awaitCallback`
 * find the running server. We also auto-clean the entry once the loopback
 * promise settles — if the renderer never calls awaitCallback the active map
 * does not leak forever.
 */
import { ipcMain, net, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';

import { getApiBaseUrl } from '../apiBaseUrl';
import { cancelActiveAppleFlow, runAppleSignIn } from '../oauth/apple/appleFlow';
import { appleTokenCall } from '../oauth/apple/appleTokenCall';
import { verifyAppleIDToken } from '../oauth/apple/idTokenVerifier';
import { signClientSecret } from '../oauth/apple/signClientSecret';
import { startLoopback, type LoopbackHandle } from '../ssoLoopback';

import { isPermittedFrameUrl } from './frameValidation';

type RemoteSpaOriginProvider = () => string | null;

/**
 * Resolves any fetch-input shape to its URL string — String(input) on a
 * Request would coerce to '[object Request]' (sonar S6551). Typed via
 * Parameters<typeof fetch>[0] instead of naming RequestInfo: the
 * main-process build (tsconfig.main.json) has no DOM lib, so the
 * RequestInfo alias doesn't exist there — CI's build:main rejects it
 * while the root tsconfig's typecheck accepts it.
 */
function resolveFetchUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

const active = new Map<number, LoopbackHandle>();

/** Validates the IPC sender frame matches a permitted SPA origin. */
function checkFrame(
  event: IpcMainInvokeEvent | IpcMainEvent,
  getSpaBaseUrl: RemoteSpaOriginProvider
): boolean {
  const url = event.senderFrame?.url ?? '';
  return isPermittedFrameUrl(url, getSpaBaseUrl());
}

/**
 * registerSSOIPC wires the three sso:* IPC channels used by the renderer's
 * SSO flow. The Electron main process owns the ephemeral loopback HTTP
 * server; the renderer drives the OAuth provider redirect via the system
 * browser and then awaits the captured code+state via awaitCallback.
 *
 * `getSpaBaseUrl` returns the currently-active validated remote SPA origin
 * (or null when the bundled build is loaded). The accessor is injected so
 * main.ts can wire the live value once the SPA loader has decided which
 * build to serve.
 */
export function registerSSOIPC(getSpaBaseUrl: RemoteSpaOriginProvider): void {
  ipcMain.handle('sso:startLoopback', async (event) => {
    if (!checkFrame(event, getSpaBaseUrl)) {
      throw new Error('sso:startLoopback rejected: untrusted sender frame');
    }
    const handle = await startLoopback();
    active.set(handle.port, handle);
    // Auto-cleanup if the promise settles outside an awaitCallback call —
    // e.g. the loopback timed out before the renderer wired up the await,
    // or a stale entry from a flow the renderer abandoned without sending
    // sso:cancelLoopback. Without this the active map would leak forever.
    handle.promise
      .catch(() => {})
      .finally(() => {
        active.delete(handle.port);
      });
    return { port: handle.port, redirectURI: handle.redirectURI };
  });

  ipcMain.handle('sso:awaitCallback', async (event, port: number) => {
    if (!checkFrame(event, getSpaBaseUrl)) {
      throw new Error('sso:awaitCallback rejected: untrusted sender frame');
    }
    const handle = active.get(port);
    if (!handle) throw new Error('sso:awaitCallback: unknown port');
    try {
      return await handle.promise;
    } finally {
      active.delete(port);
    }
  });

  ipcMain.on('sso:cancelLoopback', (event, port: number) => {
    if (!checkFrame(event, getSpaBaseUrl)) return;
    const handle = active.get(port);
    if (!handle) return;
    handle.close();
    active.delete(port);
  });

  ipcMain.handle('sso:appleSignIn', async (event) => {
    if (!checkFrame(event, getSpaBaseUrl)) {
      throw new Error('sso:appleSignIn rejected: untrusted sender frame');
    }
    return runAppleSignIn({
      apiBase: getApiBaseUrl(),
      // Electron net.fetch + credentials:'include' (NOT Node's fetch): the
      // /session response sets the refresh-token cookie, which must land in
      // the default-session jar — the SAME jar the renderer's /auth/refresh
      // reads. Node's fetch would silently drop it and strand the session at
      // access-token expiry (15 min). Plan deviation D2.
      controlPlaneFetch: ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        net.fetch(resolveFetchUrl(input), { ...init, credentials: 'include' })) as typeof fetch,
      // Apple endpoints are cookie-less by design — plain global fetch.
      appleFetch: fetch,
      openExternal: async (url: string) => {
        // Defense-in-depth: the authorize URL comes from our own server, but
        // an https-only gate keeps a tampered response from launching
        // arbitrary schemes (passive-nav posture, internal-reference
        // §External-link scheme policy).
        if (!url.startsWith('https://')) {
          throw new Error('sso_initiate_failed');
        }
        await shell.openExternal(url);
      },
      startLoopback,
      signClientSecret,
      appleTokenCall,
      verifyIdToken: verifyAppleIDToken,
    });
  });

  ipcMain.on('sso:appleCancel', (event) => {
    if (!checkFrame(event, getSpaBaseUrl)) return;
    cancelActiveAppleFlow();
  });
}
