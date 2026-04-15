import { ipcMain } from 'electron';
import { getClientId } from '../sentry';

const CHANNEL = 'sentry:getClientId';

// Anchored patterns for the three legitimate renderer frame origins:
//   - file://           packaged bundled build (BrowserWindow.loadFile)
//   - http://localhost: dev server (Vite)
//   - https://<validated-remote-spa-origin>  packaged remote SPA
//
// file:// with any path is acceptable here because Electron's scheme gating
// prevents a renderer from loading arbitrary file:// origins at runtime —
// loadFile only serves from the packaged app bundle.
//
// The localhost regex anchors on a numeric port followed by `/` or end-of-
// string to close scheme-injection bypasses like http://localhost:3000@evil/
// or http://localhost:3000.evil.com/.
const LOCAL_DEV_PATTERN = /^http:\/\/localhost:\d+(\/|$)/;
const BUNDLED_PREFIX = 'file://';

/** True if the frame URL matches any permitted origin. Exported for tests. */
export function isPermittedFrameUrl(url: string, remoteSpaOrigin: string | null): boolean {
  if (url.startsWith(BUNDLED_PREFIX)) return true;
  if (LOCAL_DEV_PATTERN.test(url)) return true;
  if (remoteSpaOrigin && url.startsWith(remoteSpaOrigin + '/')) return true;
  return false;
}

/**
 * Register the sentry:getClientId IPC handler with sender-frame validation.
 *
 * `remoteSpaOriginProvider` returns the currently-active validated remote
 * SPA origin (e.g. `https://app.concordvoice.chat`), or null if the bundled
 * build is loaded. It is injected so main.ts can wire the live value after
 * the SPA loader decides which build to serve.
 */
export function registerClientIdHandler(remoteSpaOriginProvider: () => string | null): void {
  ipcMain.handle(CHANNEL, (event) => {
    const url = event.senderFrame?.url ?? '';
    const origin = remoteSpaOriginProvider();
    if (!isPermittedFrameUrl(url, origin)) {
      throw new Error('sender frame not permitted');
    }
    return getClientId().id;
  });
}
