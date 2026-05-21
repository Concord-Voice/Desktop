import { describe, it, expect } from 'vitest';
import {
  deriveCloseAction,
  deriveMinimizeAction,
  isOptionDisabled,
  DEFAULT_CLIENT_BEHAVIOR,
  type ClientBehavior,
} from '@/shared/clientBehavior';

const defaultCB: ClientBehavior = { toTray: 'close', toToolbar: 'minimize' };
const swapCB: ClientBehavior = { toTray: 'minimize', toToolbar: 'close' };
const quitCB: ClientBehavior = { toTray: 'none', toToolbar: 'minimize' };

describe('deriveCloseAction', () => {
  it('returns "tray" when [X] is the To-Tray button', () => {
    expect(deriveCloseAction(defaultCB)).toBe('tray');
  });

  it('returns "toolbar" when [X] is the To-Toolbar button', () => {
    expect(deriveCloseAction(swapCB)).toBe('toolbar');
  });

  it('returns "quit" when [X] is unclaimed (None+Minimize config)', () => {
    expect(deriveCloseAction(quitCB)).toBe('quit');
  });
});

describe('deriveMinimizeAction', () => {
  it('returns "toolbar" when [-] is the To-Toolbar button (default)', () => {
    expect(deriveMinimizeAction(defaultCB)).toBe('toolbar');
  });

  it('returns "tray" when [-] is the To-Tray button', () => {
    expect(deriveMinimizeAction(swapCB)).toBe('tray');
  });

  it('returns "toolbar" for the quit config (None+Minimize → [-] is toolbar)', () => {
    expect(deriveMinimizeAction(quitCB)).toBe('toolbar');
  });
});

describe('isOptionDisabled — mutex rule', () => {
  it('disables "close" on toTray when toToolbar is "close"', () => {
    expect(isOptionDisabled('toTray', 'close', swapCB)).toBe(true);
  });

  it('disables "minimize" on toTray when toToolbar is "minimize"', () => {
    expect(isOptionDisabled('toTray', 'minimize', defaultCB)).toBe(true);
  });

  it('disables "close" on toToolbar when toTray is "close"', () => {
    expect(isOptionDisabled('toToolbar', 'close', defaultCB)).toBe(true);
  });

  it('disables "minimize" on toToolbar when toTray is "minimize"', () => {
    expect(isOptionDisabled('toToolbar', 'minimize', swapCB)).toBe(true);
  });
});

describe('isOptionDisabled — coverage rule', () => {
  it('disables "none" on toTray when toToolbar is "close" (would leave [-] unclaimed)', () => {
    const cb: ClientBehavior = { toTray: 'close', toToolbar: 'close' };
    expect(isOptionDisabled('toTray', 'none', cb)).toBe(true);
  });

  it('disables "close" on toToolbar when toTray is "none" (same coverage rule, other direction)', () => {
    expect(isOptionDisabled('toToolbar', 'close', quitCB)).toBe(true);
  });

  it('allows "none" on toTray when toToolbar is "minimize" (no coverage violation)', () => {
    expect(isOptionDisabled('toTray', 'none', defaultCB)).toBe(false);
  });
});

describe('isOptionDisabled — no false positives', () => {
  it('does not disable currently-selected options', () => {
    expect(isOptionDisabled('toTray', 'close', defaultCB)).toBe(false);
  });
});
