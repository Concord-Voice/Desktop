export type ToTrayChoice = 'close' | 'minimize' | 'none';
export type ToToolbarChoice = 'minimize' | 'close';

export interface ClientBehavior {
  toTray: ToTrayChoice;
  toToolbar: ToToolbarChoice;
}

export type CloseAction = 'tray' | 'toolbar' | 'quit';
export type MinimizeAction = 'tray' | 'toolbar';

export const DEFAULT_CLIENT_BEHAVIOR: ClientBehavior = {
  toTray: 'close',
  toToolbar: 'minimize',
};

export function deriveCloseAction(cb: ClientBehavior): CloseAction {
  if (cb.toTray === 'close') return 'tray';
  if (cb.toToolbar === 'close') return 'toolbar';
  return 'quit';
}

export function deriveMinimizeAction(cb: ClientBehavior): MinimizeAction {
  if (cb.toTray === 'minimize') return 'tray';
  return 'toolbar';
}

// Mutex: the same button cannot be assigned to both destinations.
// Coverage: every visible button must have a destination, EXCEPT [×] which
// can legally fall through to graceful Quit (handled by deriveCloseAction).
// The two rules are orthogonal — Cognitive Complexity stays below 15 per
// SonarQube typescript:S3776 by splitting into single-responsibility helpers.

function isMutexConflict(
  setting: 'toTray' | 'toToolbar',
  option: string,
  currentCB: ClientBehavior
): boolean {
  const otherValue = setting === 'toTray' ? currentCB.toToolbar : currentCB.toTray;
  return option === otherValue;
}

function isCoverageViolation(
  setting: 'toTray' | 'toToolbar',
  option: string,
  currentCB: ClientBehavior
): boolean {
  // Picking 'none' for toTray when toToolbar='close' leaves the [—] button
  // with no destination.
  if (setting === 'toTray' && option === 'none' && currentCB.toToolbar === 'close') {
    return true;
  }
  // Picking 'close' for toToolbar when toTray='none' is the symmetric case:
  // [—] has no destination because toToolbar is now also 'close'.
  if (setting === 'toToolbar' && option === 'close' && currentCB.toTray === 'none') {
    return true;
  }
  return false;
}

export function isOptionDisabled(
  setting: 'toTray' | 'toToolbar',
  option: string,
  currentCB: ClientBehavior
): boolean {
  return (
    isMutexConflict(setting, option, currentCB) || isCoverageViolation(setting, option, currentCB)
  );
}
