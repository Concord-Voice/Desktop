/**
 * Pure helpers for the PiP child-window IPC handler. Extracted from main.ts
 * for unit-testability without BrowserWindow / Electron mocks (mirrors the
 * spaSelfHealMainFrame.ts pattern, #753 reconciliation finding TA3).
 */

/**
 * Build the URL the PiP child window should load.
 *
 * Critical: this MUST receive the full SPA URL (origin + `/spa/<sha>/index.html`),
 * not the origin alone. Origin-only would cause nginx to fall through to the
 * catch-all `location /` block and redirect to the marketing site (#802).
 */
export function buildRemotePipUrl(spaUrl: string, pipId: string): string {
  return `${spaUrl}#/pip/${pipId}`;
}

/**
 * Validate that a `pip:open` IPC sender frame is allowed to open PiP windows.
 *
 * Defense-in-depth — the renderer is already sandboxed and bound by the
 * preload bridge, but a compromised SPA frame should not be able to spawn
 * arbitrary PiP windows. The accepted contexts are:
 *
 * - **Dev mode** (`!isPackaged`): the Vite dev server at `http://localhost:*`.
 * - **Packaged + remote SPA active** (`remoteSpaUrl` non-null): the sender's
 *   origin must match the SPA's origin.
 * - **Packaged + bundled fallback** (`remoteSpaUrl` null): the sender must
 *   load via `file://` (the bundled renderer index.html).
 *
 * Returns `false` for empty / malformed sender URLs (fail-closed).
 */
export function isValidPipOpenSender(
  senderFrameUrl: string,
  isPackaged: boolean,
  remoteSpaUrl: string | null
): boolean {
  if (!senderFrameUrl) return false;
  let sender: URL;
  try {
    sender = new URL(senderFrameUrl);
  } catch {
    return false;
  }

  if (!isPackaged) {
    return sender.hostname === 'localhost';
  }

  if (remoteSpaUrl) {
    let remote: URL;
    try {
      remote = new URL(remoteSpaUrl);
    } catch {
      return false;
    }
    return sender.origin === remote.origin;
  }

  return sender.protocol === 'file:';
}
