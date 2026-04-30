/**
 * SSO IPC bridge — wires the loopback HTTP server in `ssoLoopback.ts` to the
 * renderer's OAuth flow.
 *
 * Channel surface (3):
 *   - `sso:startLoopback` (invoke)  — spin up a 127.0.0.1 ephemeral-port server
 *                                     and return `{port, redirectURI}` for the
 *                                     renderer to embed in the provider URL.
 *   - `sso:awaitCallback` (invoke)  — await the captured `{code, state}` for a
 *                                     previously started loopback (keyed by
 *                                     port, since the renderer already knows it).
 *   - `sso:cancelLoopback` (send)   — best-effort tear-down for a port the
 *                                     renderer abandoned (user closed the
 *                                     auth tab, switched flows, etc).
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
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';

import { startLoopback, type LoopbackHandle } from '../ssoLoopback';

import { isPermittedFrameUrl } from './frameValidation';

type RemoteSpaOriginProvider = () => string | null;

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
}
