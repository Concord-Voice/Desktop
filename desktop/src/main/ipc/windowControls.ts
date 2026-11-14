import { app, type BaseWindow } from 'electron';
import { DEFAULT_CLIENT_BEHAVIOR, type ClientBehavior } from '../../shared/clientBehavior';
import type { ServiceId } from '../../shared/connectionIdentity';
import { foreground } from '../connectionRegistry';
import { CHANNEL_CLASSES } from './channelClassification';
import { registerIpc } from './registry';

/**
 * #86 C7: each service's view keeps its settings in its own session's storage, so the
 * close/minimize choice is per service. The intercepts read the FOREGROUND service's
 * value, else the default, so [X] does what the visible connection's settings say.
 * Keyed by service, not connection: a reopened connection of the same service reads
 * the same storage. What breaks it: one shared value, which follows whichever
 * connection wrote last.
 */
const clientBehaviorByService = new Map<ServiceId, ClientBehavior>();

const VALID_TO_TRAY = new Set(['close', 'minimize', 'none']);
const VALID_TO_TOOLBAR = new Set(['minimize', 'close']);
// CSS color allowlist: #hex (3/4/6/8 chars) or rgb()/rgba(). The renderer
// only ever sends hex values resolved from theme tokens, so a strict
// allowlist costs nothing at the IPC boundary. CWE-20 defense.
const CSS_COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\))$/;

function isValidClientBehavior(value: unknown): value is ClientBehavior {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.toTray === 'string' &&
    VALID_TO_TRAY.has(v.toTray) &&
    typeof v.toToolbar === 'string' &&
    VALID_TO_TOOLBAR.has(v.toToolbar)
  );
}

/** The foreground service's close/minimize choice, else the default. */
export function getCachedClientBehavior(): ClientBehavior {
  const fg = foreground();
  return (fg && clientBehaviorByService.get(fg.serviceId)) ?? DEFAULT_CLIENT_BEHAVIOR;
}

/**
 * #86 Task 7B: every channel goes through `registerIpc`. `window:setTitleBarOverlayColor`
 * is `exempt-low-stakes` (the foreground primary only; any other sender is a silent
 * `undefined` with no warn and no effect, so a background view cannot repaint the shared
 * window). `window:setClientBehavior` is `connection-bound` (#86 C7): any bound primary
 * writes its OWN service's value, which applies only while that service is in front, so a
 * background view still cannot re-arm the visible connection's [X]/[-].
 * `window:quit` is `app-global-mutate`.
 */
export function registerWindowControlsIpc(getWindow: () => BaseWindow | null): void {
  const channel = (name: string) => CHANNEL_CLASSES[name];
  registerIpc(
    'window:setClientBehavior',
    channel('window:setClientBehavior'),
    (sender, _e, value: unknown) => {
      // Runtime input validation at the IPC trust boundary. A compromised
      // renderer could send arbitrary shapes; reject silently and keep the
      // existing cache so [X]/[-] intercept fall-through remains sane.
      if (!isValidClientBehavior(value)) {
        console.warn('[windowControls] setClientBehavior rejected: invalid shape from renderer');
        return;
      }
      // The service comes from the sender's binding, never from the payload.
      clientBehaviorByService.set(sender.service.serviceId, {
        toTray: value.toTray,
        toToolbar: value.toToolbar,
      });
    }
  );

  registerIpc('window:quit', channel('window:quit'), () => {
    app.quit();
  });

  registerIpc(
    'window:setTitleBarOverlayColor',
    channel('window:setTitleBarOverlayColor'),
    (_s, _e, options: unknown) => {
      // CSS color allowlist guard at the IPC trust boundary. Electron's
      // setTitleBarOverlay accepts a CSS color string; non-color input
      // throws or paints garbage. CWE-20 defense.
      if (
        options === null ||
        typeof options !== 'object' ||
        typeof (options as { color?: unknown }).color !== 'string' ||
        typeof (options as { symbolColor?: unknown }).symbolColor !== 'string' ||
        !CSS_COLOR_RE.test((options as { color: string }).color) ||
        !CSS_COLOR_RE.test((options as { symbolColor: string }).symbolColor)
      ) {
        console.warn('[windowControls] setTitleBarOverlayColor rejected: invalid CSS color');
        return;
      }
      const win = getWindow();
      if (!win || win.isDestroyed()) return;
      const opts = options as { color: string; symbolColor: string };
      win.setTitleBarOverlay({
        color: opts.color,
        symbolColor: opts.symbolColor,
        height: 32,
      });
    }
  );
}

export function _resetWindowControlsForTesting(): void {
  clientBehaviorByService.clear();
}
