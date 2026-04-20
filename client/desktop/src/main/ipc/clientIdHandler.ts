import { ipcMain } from 'electron';
import { getClientId } from '../sentry';
import { isPermittedFrameUrl } from './frameValidation';

const CHANNEL = 'sentry:getClientId';

// Re-export for back-compat with existing tests that imported from this module.
// Using `export...from` rather than re-exporting the local binding per Sonar rule.
export { isPermittedFrameUrl } from './frameValidation';

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
