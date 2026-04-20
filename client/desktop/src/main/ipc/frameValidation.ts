/**
 * Frame-origin validation for main-process IPC handlers.
 *
 * Every main-process IPC handler that performs sensitive work (reading the
 * clientId, opening the browser, touching the keychain, ...) MUST validate
 * `event.senderFrame.url` against this allowlist before acting. Accepting an
 * IPC call from an attacker-controlled frame undoes context isolation.
 *
 * The three legitimate renderer frame origins are:
 *   - file://           packaged bundled build (BrowserWindow.loadFile)
 *   - http://localhost: dev server (Vite)
 *   - https://<validated-remote-spa-origin>  packaged remote SPA (dynamic)
 *
 * file:// with any path is acceptable here because Electron's scheme gating
 * prevents a renderer from loading arbitrary file:// origins at runtime —
 * loadFile only serves from the packaged app bundle.
 *
 * The localhost regex anchors on a numeric port followed by `/` or end-of-
 * string to close scheme-injection bypasses like http://localhost:3000@evil/
 * or http://localhost:3000.evil.com/.
 */

const LOCAL_DEV_PATTERN = /^http:\/\/localhost:\d+(\/|$)/;
const BUNDLED_PREFIX = 'file://';

/** True if the frame URL matches any permitted origin. */
export function isPermittedFrameUrl(url: string, remoteSpaOrigin: string | null): boolean {
  if (url.startsWith(BUNDLED_PREFIX)) return true;
  if (LOCAL_DEV_PATTERN.test(url)) return true;
  if (remoteSpaOrigin && url.startsWith(remoteSpaOrigin + '/')) return true;
  return false;
}
