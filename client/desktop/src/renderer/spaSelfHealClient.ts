/**
 * SPA Self-Heal — renderer-side detection (#753, ADR-0001).
 *
 * Installs two global listeners early in main.tsx, before any lazy import()
 * can fire. Both listeners filter chunk-shaped failures and IPC the main
 * process to trigger attemptSelfHeal.
 *
 * The IPC payload's `url` field is diagnostic-only — the main-process
 * recovery primitive ignores it and refetches /api/v1/client/config from
 * scratch. No client-supplied URL ever flows into webContents.loadURL().
 */

import { SPA_CHUNK_URL_PATTERN } from '../shared/spaUrlPattern';

const CHUNK_LOAD_ERROR_PATTERN =
  /Failed to fetch dynamically imported module|Loading chunk \S+ failed/;

let installed = false;

export function installSelfHealHandlers(): void {
  if (installed) return;
  installed = true;

  globalThis.addEventListener(
    'error',
    (e: Event) => {
      const target = e.target as HTMLScriptElement | HTMLLinkElement | null;
      if (!target) return;

      const url = (target as HTMLScriptElement).src ?? (target as HTMLLinkElement).href ?? '';

      if (!url || !SPA_CHUNK_URL_PATTERN.test(url)) return;

      // Cross-origin guard: SPA_CHUNK_URL_PATTERN is host-agnostic, so a
      // failing third-party script with a path that happens to match
      // `/spa/<sha>/assets/...` would otherwise trigger self-heal. Require
      // the failing URL's origin to match the page's own origin.
      try {
        if (new URL(url).origin !== globalThis.location.origin) return;
      } catch {
        return;
      }

      // Optional chaining handles missing bridge synchronously; trailing
      // ?.catch swallows the async rejection path. The bridge is exposed
      // via preload's contextBridge so it's normally present, but we guard
      // both shapes (missing object + rejected promise) to survive bundled-
      // fallback mode where the renderer may load before main is ready.
      globalThis.electron?.spa?.requestSelfHeal({ reason: 'chunk-load', url })?.catch(() => {
        /* swallow — main-process logs its own diagnostics */
      });
    },
    /* useCapture */ true
  );

  globalThis.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    const reason = e.reason;
    const message = reason instanceof Error ? reason.message : String(reason);

    if (!CHUNK_LOAD_ERROR_PATTERN.test(message)) return;

    globalThis.electron?.spa?.requestSelfHeal({ reason: 'chunk-import-rejected' })?.catch(() => {
      /* swallow — see error-listener comment above */
    });
  });
}
