// The two exported contract numbers, pinned (#3394 PR 2 introduced this file at 30;
// v31 adds `RefreshResult.mfaWebauthnOptions`; v32 adds `billing:open`, #1305; v33 adds
// `tray:setStatus` + the `tray:action` push; v34 lets SSO `complete-link` return an MFA
// challenge; v35 adds the `connection:*` channels and admission classes, #86; v36 adds
// the capture lease, #87).
//
// This is deliberately its own file rather than folded into `main.test.ts`: the two
// exported numbers are the whole contract, and pinning them beside the 5,000-line
// suite would bury a one-line regression under unrelated noise. See
// `internal-reference` § "The two contract numbers" for what each governs.
import { describe, expect, it } from 'vitest';

import { IPC_CONTRACT_VERSION, SPA_MIN_CONTRACT } from '../../../src/main/ipcContract';

describe('IPC contract numbers', () => {
  it('ships contract 37 and still demands only 19', () => {
    // v36 (`electron.capture.*`) is feature-detected by the renderer
    // (`typeof globalThis.electron?.capture?.acquire === 'function'`), so a shell below
    // 36 keeps today's capture behaviour: capability, not demand.
    // v37 (account-erasure deep link) is a main-to-renderer event; an older SPA ignores it.
    // v33 (`tray:setStatus` / `tray:action`) is feature-detected by the renderer
    // (`typeof globalThis.electron?.traySetStatus === 'function'`), so an older shell
    // just keeps a static tray: capability, not demand.
    // `mfaWebauthnOptions` is optional (a shell without it leaves the refresh
    // challenge without a security key, as before), so the SPA's own minimum demand
    // does not move even though the shell's own capability does.
    expect(IPC_CONTRACT_VERSION).toBe(37);
    expect(SPA_MIN_CONTRACT).toBe(19);
  });
});
