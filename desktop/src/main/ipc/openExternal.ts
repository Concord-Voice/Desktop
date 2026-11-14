import { shell } from 'electron';
import { registerIpc } from './registry';

/**
 * open-external IPC handler — routes renderer link clicks to `shell.openExternal`
 * after enforcing BOTH sender admission AND protocol allowlisting. Admission is
 * `app-global-mutate` (#86): only the foreground connection's bound primary main
 * frame, at a permitted frame URL, may launch the OS browser.
 *
 * This is defense-in-depth layer 3 for the Markdown pipeline:
 *   1. rehype-sanitize rejects unsafe hrefs at the hast level.
 *   2. SafeLink.tsx re-validates the href before emitting the anchor.
 *   3. This handler re-validates in the main process, the only layer the
 *      renderer cannot bypass.
 *
 * The protocol allowlist (http:, https:, mailto:) MUST stay in sync with
 * SafeLink's `SAFE_PROTOCOLS` regex. Widening it here without widening the
 * renderer check is a security regression — and vice-versa.
 */

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

function isAllowedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ALLOWED_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

export interface OpenExternalResult {
  ok: boolean;
  reason?: 'untrusted-sender' | 'invalid-protocol' | 'invalid-url' | 'open-failed';
}

/**
 * Register the open-external IPC handler with sender-frame + protocol validation.
 *
 * `remoteSpaOriginProvider` returns the currently-active validated remote SPA
 * origin (or null when the bundled build is loaded). Injected so main.ts can
 * wire the live value after the SPA loader decides which build to serve. Left
 * undefined in unit tests that only exercise the bundled/localhost frame paths.
 */
export function registerOpenExternalHandler(): void {
  // #86 (C6): `app-global-mutate`. The OS browser opens over every connection, so a
  // background connection must not launch it while another one is visible. Written here
  // as well as in CHANNEL_CLASSES so registerIpc throws if the table is widened alone.
  // Admission is synchronous and nothing below awaits before shell.openExternal, so the
  // foreground cannot change between the check and the launch. Every refusal,
  // `not-foreground` included, gets the existing `untrusted-sender` result.
  registerIpc(
    'open-external',
    'app-global-mutate',
    async (_sender, _event, url: unknown): Promise<OpenExternalResult> => {
      if (typeof url !== 'string') {
        return { ok: false, reason: 'invalid-url' };
      }
      if (!isAllowedUrl(url)) {
        return { ok: false, reason: 'invalid-protocol' };
      }
      try {
        await shell.openExternal(url);
        return { ok: true };
      } catch {
        return { ok: false, reason: 'open-failed' };
      }
    },
    {
      refusal: (): Promise<OpenExternalResult> =>
        Promise.resolve({ ok: false, reason: 'untrusted-sender' }),
    }
  );
}
