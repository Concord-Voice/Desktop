/**
 * Unit tests for the sso:* IPC handlers (#270 review).
 *
 * Coverage:
 *   - sender-frame validation rejects untrusted origins on all three channels
 *   - active-map cleanup removes entries on awaitCallback / cancelLoopback /
 *     promise-settle
 *   - awaitCallback against an unknown port throws a stable error rather than
 *     hanging
 *
 * The loopback server itself is mocked — these tests exercise the IPC plumbing,
 * not the HTTP listener (that's covered by ssoLoopback.test.ts). The mock lets
 * us verify the cleanup contract deterministically without binding real ports.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// vi.mock is hoisted above ALL `const` declarations, so any references to
// outer-scope state from inside a vi.mock factory must come from vi.hoisted —
// regular module-scope values are not yet initialized when the factory runs.
const mocked = vi.hoisted(() => {
  interface FakeHandle {
    port: number;
    redirectURI: string;
    bindAddress: string;
    promise: Promise<{ code: string; state: string }>;
    close: () => void;
    __resolve: (v: { code: string; state: string }) => void;
    __reject: (e: Error) => void;
    __closeCalls: number;
  }
  const handleSpy = vi.fn();
  const onSpy = vi.fn();
  const fakeHandles: FakeHandle[] = [];
  let nextPort = 51000;
  const startLoopback = vi.fn(async () => {
    let resolveFn!: (v: { code: string; state: string }) => void;
    let rejectFn!: (e: Error) => void;
    const promise = new Promise<{ code: string; state: string }>((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    });
    // Suppress unhandled-rejection noise — close() may reject, and tests
    // that don't await the promise would otherwise pollute test output.
    promise.catch(() => undefined);
    const port = nextPort++;
    const handle: FakeHandle = {
      port,
      redirectURI: `http://127.0.0.1:${port}/oauth/callback`,
      bindAddress: '127.0.0.1',
      promise,
      close: () => {
        handle.__closeCalls += 1;
        rejectFn(new Error('oauth_cancelled'));
      },
      __resolve: resolveFn,
      __reject: rejectFn,
      __closeCalls: 0,
    };
    fakeHandles.push(handle);
    return handle;
  });
  return { handleSpy, onSpy, fakeHandles, startLoopback };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: mocked.handleSpy,
    on: mocked.onSpy,
  },
}));

vi.mock('../../../../src/main/ssoLoopback', () => ({
  startLoopback: mocked.startLoopback,
}));

import { registerSSOIPC } from '@/main/ipc/sso';

interface FakeInvokeEvent {
  senderFrame: { url: string };
}

const TRUSTED = 'http://localhost:3001';
const UNTRUSTED = 'https://attacker.example';

const getSpaBaseUrl = () => null;

describe('sso IPC handlers', () => {
  let startLoopbackHandler: (event: FakeInvokeEvent) => Promise<{
    port: number;
    redirectURI: string;
  }>;
  let awaitCallbackHandler: (
    event: FakeInvokeEvent,
    port: number
  ) => Promise<{ code: string; state: string }>;
  let cancelLoopbackHandler: (event: FakeInvokeEvent, port: number) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    mocked.fakeHandles.length = 0;
    registerSSOIPC(getSpaBaseUrl);

    // Pull each handler out of the mocked ipcMain.handle / on calls.
    const startCall = mocked.handleSpy.mock.calls.find((c) => c[0] === 'sso:startLoopback');
    const awaitCall = mocked.handleSpy.mock.calls.find((c) => c[0] === 'sso:awaitCallback');
    const cancelCall = mocked.onSpy.mock.calls.find((c) => c[0] === 'sso:cancelLoopback');
    if (!startCall || !awaitCall || !cancelCall) {
      throw new Error('IPC handlers not registered');
    }
    startLoopbackHandler = startCall[1];
    awaitCallbackHandler = awaitCall[1];
    cancelLoopbackHandler = cancelCall[1];
  });

  describe('sender-frame validation', () => {
    it('sso:startLoopback rejects untrusted sender frames', async () => {
      await expect(startLoopbackHandler({ senderFrame: { url: UNTRUSTED } })).rejects.toThrow(
        /untrusted/i
      );
      // Loopback must not even be started — the active map is empty.
      expect(mocked.fakeHandles.length).toBe(0);
    });

    it('sso:awaitCallback rejects untrusted sender frames', async () => {
      // Need a real entry in `active` first so we can prove the rejection
      // happens before the lookup; start a trusted loopback then attack
      // awaitCallback from a different frame URL.
      const { port } = await startLoopbackHandler({ senderFrame: { url: TRUSTED } });
      await expect(awaitCallbackHandler({ senderFrame: { url: UNTRUSTED } }, port)).rejects.toThrow(
        /untrusted/i
      );
    });

    it('sso:cancelLoopback silently no-ops for untrusted sender frames', async () => {
      const { port } = await startLoopbackHandler({ senderFrame: { url: TRUSTED } });
      // Capture pre-call state.
      const before = mocked.fakeHandles[0].__closeCalls;
      cancelLoopbackHandler({ senderFrame: { url: UNTRUSTED } }, port);
      // Untrusted cancel must not call close() on the active handle.
      expect(mocked.fakeHandles[0].__closeCalls).toBe(before);
    });
  });

  describe('active-map lifecycle', () => {
    it('sso:awaitCallback returns the loopback result and removes the active entry', async () => {
      const { port } = await startLoopbackHandler({ senderFrame: { url: TRUSTED } });
      const handle = mocked.fakeHandles[0];

      // Simulate the OAuth provider redirect resolving the loopback promise.
      handle.__resolve({ code: 'auth-code', state: 'state-x' });

      const result = await awaitCallbackHandler({ senderFrame: { url: TRUSTED } }, port);
      expect(result).toEqual({ code: 'auth-code', state: 'state-x' });

      // After awaitCallback returns, a second await on the same port should
      // fail with "unknown port" — the active map entry is gone. (Re-issuing
      // a fresh attempt would create a new entry under a new ephemeral port.)
      await expect(awaitCallbackHandler({ senderFrame: { url: TRUSTED } }, port)).rejects.toThrow(
        /unknown port/i
      );
    });

    it('sso:cancelLoopback closes the handle and removes the active entry', async () => {
      const { port } = await startLoopbackHandler({ senderFrame: { url: TRUSTED } });
      cancelLoopbackHandler({ senderFrame: { url: TRUSTED } }, port);
      expect(mocked.fakeHandles[0].__closeCalls).toBe(1);
      // Subsequent await on the cancelled port → unknown.
      await expect(awaitCallbackHandler({ senderFrame: { url: TRUSTED } }, port)).rejects.toThrow(
        /unknown port/i
      );
    });

    it('cancelLoopback for an unknown port is a silent no-op', () => {
      // No-op behavior matters: a renderer that races cancel after the
      // promise has auto-cleaned up must not crash the main process.
      expect(() => cancelLoopbackHandler({ senderFrame: { url: TRUSTED } }, 99999)).not.toThrow();
    });

    it('auto-cleans the active entry when the loopback promise settles outside awaitCallback', async () => {
      const { port } = await startLoopbackHandler({ senderFrame: { url: TRUSTED } });
      const handle = mocked.fakeHandles[0];

      // Reject the loopback promise (e.g. timeout) before awaitCallback is invoked.
      handle.__reject(new Error('oauth_timeout'));
      // Allow the .finally on the handler's auto-cleanup to flush.
      await new Promise((r) => setImmediate(r));

      // The active map entry must have been removed.
      await expect(awaitCallbackHandler({ senderFrame: { url: TRUSTED } }, port)).rejects.toThrow(
        /unknown port/i
      );
    });
  });

  describe('unknown-port rejection', () => {
    it('sso:awaitCallback throws for a port that was never started', async () => {
      await expect(awaitCallbackHandler({ senderFrame: { url: TRUSTED } }, 12345)).rejects.toThrow(
        /unknown port/i
      );
    });
  });
});
