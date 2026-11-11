import { app, type BaseWindow } from 'electron';
import { DEFAULT_CLIENT_BEHAVIOR, type ClientBehavior } from '../../shared/clientBehavior';
import { CHANNEL_CLASSES } from './channelClassification';
import { registerIpc } from './registry';

let cachedClientBehavior: ClientBehavior = DEFAULT_CLIENT_BEHAVIOR;

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

export function getCachedClientBehavior(): ClientBehavior {
  return cachedClientBehavior;
}

/**
 * #86 Task 7B: every channel goes through `registerIpc`. The two chrome channels are
 * `exempt-low-stakes` (the foreground primary only; any other sender is a silent
 * `undefined` with no warn and no effect, so a background view cannot repaint or re-arm
 * the shared window's [X]/[-]); `window:quit` is `app-global-mutate`.
 */
export function registerWindowControlsIpc(getWindow: () => BaseWindow | null): void {
  const channel = (name: string) => CHANNEL_CLASSES[name];
  registerIpc(
    'window:setClientBehavior',
    channel('window:setClientBehavior'),
    (_s, _e, value: unknown) => {
      // Runtime input validation at the IPC trust boundary. A compromised
      // renderer could send arbitrary shapes; reject silently and keep the
      // existing cache so [X]/[-] intercept fall-through remains sane.
      if (!isValidClientBehavior(value)) {
        console.warn('[windowControls] setClientBehavior rejected: invalid shape from renderer');
        return;
      }
      cachedClientBehavior = value;
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
