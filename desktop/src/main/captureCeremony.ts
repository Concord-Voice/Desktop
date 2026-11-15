/**
 * The native capture-move ceremony (#87 §3.3): "Join voice on B?" when connection B
 * asks for the microphone, camera or screen while connection A holds the capture lease.
 *
 * Same dependency-injection shape as `requestSelfHostedApproval` (`main.ts`): the
 * dialog is injected for tests, and the default parents it on the shell `BaseWindow`.
 * Copy is the spec's verbatim; English only, like the approval ceremony (main has no
 * i18n path).
 *
 * Labels come only from main, never from a renderer: the hosted service is
 * "Concord Voice", a self-hosted one is the punycode `URL.host` of its canonical
 * origin (a non-default port included, never IDN-rendered, so no homograph label).
 *
 * Stay is the default AND the cancel, so Return and Escape both keep the current call.
 * Only an explicit Join resolves 'join'; any other response, a dialog that throws, and
 * an aborted signal all resolve 'stay'. There is no timer (WCAG 2.2.1): the caller's
 * signal, aborted on the requester's generation advance or at quit, is the only thing
 * that closes the box for the user.
 */
import { dialog, type BaseWindow } from 'electron';
import type { ServiceRecord } from './connectionRegistry';

export type ShowMessageBox = (
  w: BaseWindow,
  o: Electron.MessageBoxOptions
) => Promise<{ response: number }>;

export type CeremonyAnswer = 'join' | 'stay';

/** The fields a label is derived from. `ServiceRecord` satisfies it. */
export type LabelledService = Pick<ServiceRecord, 'kind' | 'origin'>;

/** Button labels only; `message` and `detail` keep the full label. */
export const LABEL_MAX = 28;
/** Replaces the current label when both connections would read the same. */
export const OTHER_CONNECTION_LABEL = 'your other connection';

const SAAS_LABEL = 'Concord Voice';
const ELLIPSIS = '…';

const defaultShowMessageBox: ShowMessageBox = (w, o) => dialog.showMessageBox(w, o);
let showMessageBoxOverride: ShowMessageBox | null = null;

export function connectionLabel(service: LabelledService): string {
  if (service.kind === 'saas') return SAAS_LABEL;
  // WHATWG URL serialises the host as ASCII (punycode) and drops a default port.
  // Host only: a path, query or userinfo in the stored value never reaches the dialog.
  return new URL(service.origin).host;
}

/** Cuts `label` to `max` characters with an ellipsis in the middle. */
export function truncateLabel(label: string, max = LABEL_MAX): string {
  const chars = Array.from(label);
  if (chars.length <= max) return label;
  const kept = max - 1;
  const head = Math.ceil(kept / 2);
  const tail = kept - head;
  return chars.slice(0, head).join('') + ELLIPSIS + chars.slice(chars.length - tail).join('');
}

/**
 * `normalizeAccessKeys` reads every `&` in a button label as an access-key marker, so
 * a literal one in a host is doubled; each platform renders `&&` as a single `&`.
 */
function buttonLabel(label: string): string {
  return truncateLabel(label).replaceAll('&', '&&');
}

export function buildCeremonyOptions(
  currentLabel: string,
  requestedLabel: string,
  signal: AbortSignal
): Electron.MessageBoxOptions {
  const a = currentLabel === requestedLabel ? OTHER_CONNECTION_LABEL : currentLabel;
  const b = requestedLabel;
  return {
    type: 'question',
    noLink: true,
    normalizeAccessKeys: true,
    signal,
    title: SAAS_LABEL,
    message: `Join voice on ${b}?`,
    detail:
      `You're in a call on ${a}. Joining on ${b} ends that call, and people on ${a} will see ` +
      `you leave. Concord Voice can use your microphone, camera and screen sharing on one ` +
      `connection at a time.`,
    buttons: [`&Stay on ${buttonLabel(a)}`, `&Join on ${buttonLabel(b)}`],
    defaultId: 0,
    cancelId: 0,
  };
}

/** Shows the ceremony for moving capture from `from` to `to`. Never rejects. */
export async function runCaptureCeremony(
  win: BaseWindow,
  from: LabelledService,
  to: LabelledService,
  signal: AbortSignal,
  deps: { showMessageBox?: ShowMessageBox } = {}
): Promise<CeremonyAnswer> {
  if (signal.aborted) return 'stay';
  const show = deps.showMessageBox ?? showMessageBoxOverride ?? defaultShowMessageBox;
  try {
    const options = buildCeremonyOptions(connectionLabel(from), connectionLabel(to), signal);
    const { response } = await show(win, options);
    // An abort resolves as Stay whatever the box answered.
    if (signal.aborted) return 'stay';
    return response === 1 ? 'join' : 'stay';
  } catch {
    // Fail closed: a dialog that could not be shown or answered moves nothing.
    return 'stay';
  }
}

/** e2e seam (Task 8, via `app.evaluate` + `require`); null restores the native dialog. */
export function _setShowMessageBoxForTesting(fn: ShowMessageBox | null): void {
  showMessageBoxOverride = fn;
}
