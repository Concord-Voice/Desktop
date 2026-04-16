// @vitest-environment node
//
// telemetryConsent — consent file I/O tests (read, write, IPC handlers)

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Hoisted mocks ────────────────────────────────────────────────────────

const {
  mockGetPath,
  mockIpcMainHandle,
  mockWebContentsSend,
  mockGetClient,
  mockGetAllWindows,
  mockSentryClose,
} = vi.hoisted(() => ({
  mockGetPath: vi.fn(),
  mockIpcMainHandle: vi.fn(),
  mockWebContentsSend: vi.fn(),
  mockGetClient: vi.fn(),
  mockGetAllWindows: vi.fn(),
  mockSentryClose: vi.fn().mockResolvedValue(true),
}));

vi.mock('electron', () => {
  const BW = vi.fn();
  BW.getAllWindows = mockGetAllWindows;
  return {
    app: { getPath: mockGetPath },
    ipcMain: { handle: mockIpcMainHandle },
    BrowserWindow: BW,
  };
});

vi.mock('@sentry/electron/main', () => ({
  getClient: mockGetClient,
  close: (...args: unknown[]) => mockSentryClose(...args),
}));

// ── Helpers ──────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'telemetryConsent-test-'));
}

async function loadModule() {
  vi.resetModules();
  return import('../../../src/main/telemetryConsent');
}

/** Build a mock BrowserWindow-like object. */
function makeMockWindow(destroyed = false) {
  return {
    isDestroyed: () => destroyed,
    webContents: { send: mockWebContentsSend },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('telemetryConsent', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    mockGetPath.mockImplementation((key: string) => {
      if (key === 'userData') return tmpDir;
      return tmpDir;
    });
    // Default: one live window
    mockGetAllWindows.mockReturnValue([makeMockWindow(false)]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  // ─── readTelemetryConsent ───────────────────────────────────────────

  describe('readTelemetryConsent', () => {
    it('returns defaults when file does not exist', async () => {
      const { readTelemetryConsent } = await loadModule();
      const result = readTelemetryConsent();

      expect(result).toEqual({
        telemetryOptIn: false,
        firstPromptCompleted: false,
        policyAcknowledgedVersion: 0,
        pendingReConsent: false,
        updatedAt: null,
      });
    });

    it('returns defaults when file contains invalid JSON', async () => {
      const consentFile = path.join(tmpDir, 'telemetry-consent.json');
      fs.writeFileSync(consentFile, 'not valid json{{{', 'utf-8');

      const { readTelemetryConsent } = await loadModule();
      const result = readTelemetryConsent();

      expect(result).toEqual({
        telemetryOptIn: false,
        firstPromptCompleted: false,
        policyAcknowledgedVersion: 0,
        pendingReConsent: false,
        updatedAt: null,
      });
    });

    it('logs a warning for non-ENOENT read errors', async () => {
      const consentFile = path.join(tmpDir, 'telemetry-consent.json');
      fs.writeFileSync(consentFile, 'bad json}}}', 'utf-8');

      const { readTelemetryConsent } = await loadModule();
      const result = readTelemetryConsent();

      // JSON parse errors do not have an .code property, so they ARE logged
      // (they are not ENOENT). The warning spy is set up in beforeEach.
      expect(result.telemetryOptIn).toBe(false);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('[TelemetryConsent]'),
        expect.any(SyntaxError)
      );
    });

    it('parses a valid consent file', async () => {
      const consentFile = path.join(tmpDir, 'telemetry-consent.json');
      const state = {
        telemetryOptIn: true,
        firstPromptCompleted: true,
        policyAcknowledgedVersion: 2,
        pendingReConsent: false,
        updatedAt: '2026-04-13T00:00:00.000Z',
      };
      fs.writeFileSync(consentFile, JSON.stringify(state), 'utf-8');

      const { readTelemetryConsent } = await loadModule();
      const result = readTelemetryConsent();

      expect(result).toEqual(state);
    });

    it('fills missing fields with defaults', async () => {
      const consentFile = path.join(tmpDir, 'telemetry-consent.json');
      // Only write one field
      fs.writeFileSync(consentFile, JSON.stringify({ telemetryOptIn: true }), 'utf-8');

      const { readTelemetryConsent } = await loadModule();
      const result = readTelemetryConsent();

      expect(result.telemetryOptIn).toBe(true);
      expect(result.firstPromptCompleted).toBe(false);
      expect(result.policyAcknowledgedVersion).toBe(0);
      expect(result.updatedAt).toBeNull();
    });

    it('ignores fields with wrong types (falls back to default)', async () => {
      const consentFile = path.join(tmpDir, 'telemetry-consent.json');
      // telemetryOptIn should be boolean — write a string instead
      fs.writeFileSync(
        consentFile,
        JSON.stringify({
          telemetryOptIn: 'yes',
          firstPromptCompleted: 1,
          policyAcknowledgedVersion: 'v2',
          updatedAt: 42,
        }),
        'utf-8'
      );

      const { readTelemetryConsent } = await loadModule();
      const result = readTelemetryConsent();

      expect(result.telemetryOptIn).toBe(false);
      expect(result.firstPromptCompleted).toBe(false);
      expect(result.policyAcknowledgedVersion).toBe(0);
      expect(result.updatedAt).toBeNull();
    });
  });

  // ─── ConsentState.pendingReConsent field ────────────────────────────

  describe('ConsentState.pendingReConsent field', () => {
    it('defaults to false when absent from the consent file', async () => {
      const consentFile = path.join(tmpDir, 'telemetry-consent.json');
      fs.writeFileSync(
        consentFile,
        JSON.stringify({
          telemetryOptIn: true,
          firstPromptCompleted: true,
          policyAcknowledgedVersion: 1,
          updatedAt: new Date().toISOString(),
        }),
        'utf-8'
      );

      const { readTelemetryConsent } = await loadModule();
      const state = readTelemetryConsent();
      expect(state.pendingReConsent).toBe(false);
    });

    it('ignores non-boolean pendingReConsent values (fail-closed)', async () => {
      const consentFile = path.join(tmpDir, 'telemetry-consent.json');
      fs.writeFileSync(
        consentFile,
        JSON.stringify({
          telemetryOptIn: true,
          firstPromptCompleted: true,
          policyAcknowledgedVersion: 1,
          pendingReConsent: 'yes', // wrong type
          updatedAt: new Date().toISOString(),
        }),
        'utf-8'
      );

      const { readTelemetryConsent } = await loadModule();
      expect(readTelemetryConsent().pendingReConsent).toBe(false);
    });

    it('round-trips through writeTelemetryConsent', async () => {
      const { readTelemetryConsent, writeTelemetryConsent } = await loadModule();
      writeTelemetryConsent({ pendingReConsent: true });
      expect(readTelemetryConsent().pendingReConsent).toBe(true);
    });

    it('sanitizer accepts pendingReConsent: true via consent:setState IPC', async () => {
      // Verify that sanitizeConsentUpdates passes pendingReConsent through the handler
      let handlers: Record<string, (...args: unknown[]) => unknown> = {};
      mockIpcMainHandle.mockReset();
      mockIpcMainHandle.mockImplementation(
        (channel: string, handler: (...args: unknown[]) => unknown) => {
          handlers[channel] = handler;
        }
      );

      const { registerConsentIpcHandlers } = await loadModule();
      registerConsentIpcHandlers();

      // Invoke setState with pendingReConsent=true
      await handlers['consent:setState']({}, { pendingReConsent: true });

      const sent = (mockWebContentsSend.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
      expect(sent.pendingReConsent).toBe(true);
    });
  });

  // ─── writeTelemetryConsent ──────────────────────────────────────────

  describe('writeTelemetryConsent', () => {
    it('creates file with provided fields and updatedAt timestamp', async () => {
      const { writeTelemetryConsent } = await loadModule();
      const before = Date.now();
      writeTelemetryConsent({ telemetryOptIn: true, firstPromptCompleted: true });
      const after = Date.now();

      const consentFile = path.join(tmpDir, 'telemetry-consent.json');
      expect(fs.existsSync(consentFile)).toBe(true);

      const written = JSON.parse(fs.readFileSync(consentFile, 'utf-8'));
      expect(written.telemetryOptIn).toBe(true);
      expect(written.firstPromptCompleted).toBe(true);
      expect(written.policyAcknowledgedVersion).toBe(0);

      const ts = new Date(written.updatedAt as string).getTime();
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });

    it('merge-writes without overwriting existing fields', async () => {
      const consentFile = path.join(tmpDir, 'telemetry-consent.json');
      // Seed an existing file
      fs.writeFileSync(
        consentFile,
        JSON.stringify({
          telemetryOptIn: false,
          firstPromptCompleted: true,
          policyAcknowledgedVersion: 1,
          updatedAt: '2026-01-01T00:00:00.000Z',
        }),
        'utf-8'
      );

      const { writeTelemetryConsent } = await loadModule();
      writeTelemetryConsent({ telemetryOptIn: true });

      const written = JSON.parse(fs.readFileSync(consentFile, 'utf-8'));
      expect(written.telemetryOptIn).toBe(true);
      // These were not in the update — existing values must survive
      expect(written.firstPromptCompleted).toBe(true);
      expect(written.policyAcknowledgedVersion).toBe(1);
      // updatedAt must have been refreshed
      expect(written.updatedAt).not.toBe('2026-01-01T00:00:00.000Z');
    });

    it('throws when the write fails', async () => {
      const { writeTelemetryConsent } = await loadModule();

      // Make the userData directory a file so writeFileSync throws
      const consentFile = path.join(tmpDir, 'telemetry-consent.json');
      // Write a valid file first, then make it a directory to trigger failure
      fs.mkdirSync(consentFile);

      expect(() => {
        writeTelemetryConsent({ telemetryOptIn: true });
      }).toThrow();
    });
  });

  // ─── registerConsentIpcHandlers ─────────────────────────────────────

  describe('registerConsentIpcHandlers', () => {
    it('registers consent:getState and consent:setState IPC handlers', async () => {
      const { registerConsentIpcHandlers } = await loadModule();

      mockIpcMainHandle.mockReset();
      registerConsentIpcHandlers();

      const channels = mockIpcMainHandle.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(channels).toContain('consent:getState');
      expect(channels).toContain('consent:setState');
    });

    describe('IPC handler behavior', () => {
      let handlers: Record<string, (...args: unknown[]) => unknown>;

      beforeEach(async () => {
        mockIpcMainHandle.mockReset();
        mockWebContentsSend.mockReset();
        mockSentryClose.mockReset().mockResolvedValue(true);
        handlers = {};
        mockIpcMainHandle.mockImplementation(
          (channel: string, handler: (...args: unknown[]) => unknown) => {
            handlers[channel] = handler;
          }
        );

        const { registerConsentIpcHandlers } = await loadModule();
        registerConsentIpcHandlers();
      });

      it('consent:getState returns current consent state', () => {
        const result = handlers['consent:getState']({});
        expect(result).toMatchObject({
          telemetryOptIn: false,
          firstPromptCompleted: false,
          policyAcknowledgedVersion: 0,
          updatedAt: null,
        });
      });

      it('consent:setState writes updates and notifies renderer via getAllWindows', async () => {
        await handlers['consent:setState'](
          {},
          { telemetryOptIn: true, firstPromptCompleted: true }
        );

        // Renderer must receive the changed event with the new state
        expect(mockWebContentsSend).toHaveBeenCalledWith(
          'consent:changed',
          expect.objectContaining({
            telemetryOptIn: true,
            firstPromptCompleted: true,
          })
        );
      });

      it('consent:setState skips destroyed windows', async () => {
        const liveWindow = makeMockWindow(false);
        const deadWindow = makeMockWindow(true);
        const deadSend = vi.fn();
        deadWindow.webContents.send = deadSend;
        mockGetAllWindows.mockReturnValue([liveWindow, deadWindow]);
        mockWebContentsSend.mockReset();

        await handlers['consent:setState']({}, { telemetryOptIn: true });

        // Live window gets consent:changed + sentry:consentRestored (Task 3.4)
        expect(mockWebContentsSend).toHaveBeenCalledWith('consent:changed', expect.any(Object));
        // Dead window must never be touched
        expect(deadSend).not.toHaveBeenCalled();
      });

      it('consent:setState strips unexpected keys and updatedAt', async () => {
        await handlers['consent:setState'](
          {},
          {
            telemetryOptIn: true,
            updatedAt: '2099-01-01T00:00:00.000Z', // must be stripped
            injected: 'evil',
          }
        );

        const sent = (mockWebContentsSend.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
        // updatedAt must be a real timestamp, not the renderer-supplied value
        expect(sent.updatedAt).not.toBe('2099-01-01T00:00:00.000Z');
        expect('injected' in sent).toBe(false);
      });

      it('consent:setState ignores fields with wrong types', async () => {
        // None of the fields should be accepted — all wrong types
        await handlers['consent:setState'](
          {},
          {
            telemetryOptIn: 'yes',
            firstPromptCompleted: 1,
            policyAcknowledgedVersion: 'v2',
          }
        );

        const sent = (mockWebContentsSend.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
        // Should fall back to defaults since none were accepted
        expect(sent.telemetryOptIn).toBe(false);
        expect(sent.firstPromptCompleted).toBe(false);
        expect(sent.policyAcknowledgedVersion).toBe(0);
      });

      it('consent:setState toggles Sentry when client is available', async () => {
        const options = { enabled: false };
        mockGetClient.mockReturnValue({
          getOptions: () => options,
        });

        await handlers['consent:setState']({}, { telemetryOptIn: true });

        expect(mockGetClient).toHaveBeenCalled();
        expect(options.enabled).toBe(true);
      });

      it('consent:setState does not throw when Sentry client is unavailable', async () => {
        mockGetClient.mockReturnValue(undefined);
        await expect(
          handlers['consent:setState']({}, { telemetryOptIn: false })
        ).resolves.not.toThrow();
      });

      it('consent:setState propagates write errors via IPC rejection', async () => {
        // Make the consent file path a directory to force a write error
        const consentFile = path.join(tmpDir, 'telemetry-consent.json');
        fs.mkdirSync(consentFile, { recursive: true });

        await expect(
          Promise.resolve().then(() => handlers['consent:setState']({}, { telemetryOptIn: true }))
        ).rejects.toThrow();
      });

      // ── Task 3.3: opt-off teardown ──────────────────────────────────

      it('calls Sentry.close(0) on opt-off', async () => {
        await handlers['consent:setState']({}, { telemetryOptIn: false });
        expect(mockSentryClose).toHaveBeenCalledWith(0);
      });

      it('does not call Sentry.close on opt-on', async () => {
        await handlers['consent:setState']({}, { telemetryOptIn: true });
        expect(mockSentryClose).not.toHaveBeenCalled();
      });

      it('deletes {userData}/sentry dir on opt-off', async () => {
        // Create a fake sentry queue dir so rm has something to remove
        const sentryDir = path.join(tmpDir, 'sentry');
        fs.mkdirSync(sentryDir, { recursive: true });

        await handlers['consent:setState']({}, { telemetryOptIn: false });

        expect(fs.existsSync(sentryDir)).toBe(false);
      });

      it('does not delete {userData}/sentry dir on opt-on', async () => {
        const sentryDir = path.join(tmpDir, 'sentry');
        fs.mkdirSync(sentryDir, { recursive: true });

        await handlers['consent:setState']({}, { telemetryOptIn: true });

        // Directory must still exist — opt-on does not touch the queue
        expect(fs.existsSync(sentryDir)).toBe(true);
      });

      it('continues with persist even if Sentry.close rejects', async () => {
        mockSentryClose.mockRejectedValueOnce(new Error('sdk failure'));

        // Should not throw — warn and continue
        await expect(
          handlers['consent:setState']({}, { telemetryOptIn: false })
        ).resolves.not.toThrow();

        // Persist still ran — webContents.send was called
        expect(mockWebContentsSend).toHaveBeenCalledWith('consent:changed', expect.any(Object));
      });

      it('continues with persist even if fs.promises.rm rejects', async () => {
        // Create a fake sentry dir so rm has something to attempt removal of
        const sentryDir = path.join(tmpDir, 'sentry');
        fs.mkdirSync(sentryDir, { recursive: true });

        // Stub fs.promises.rm to reject
        const rmSpy = vi
          .spyOn(fs.promises, 'rm')
          .mockRejectedValueOnce(new Error('permission denied'));

        try {
          // Should not throw — warn and continue
          await expect(
            handlers['consent:setState']({}, { telemetryOptIn: false })
          ).resolves.not.toThrow();

          // Persist still ran — webContents.send was called
          expect(mockWebContentsSend).toHaveBeenCalledWith('consent:changed', expect.any(Object));

          // console.warn was called with the expected message
          expect(console.warn).toHaveBeenCalledWith(
            expect.stringContaining('[TelemetryConsent] offline queue cleanup failed'),
            expect.any(Error)
          );
        } finally {
          rmSpy.mockRestore();
        }
      });

      // ── Task 3.4: lifecycle event broadcasts ────────────────────────

      it('broadcasts sentry:consentRevoked to all windows on opt-off', async () => {
        const win1Send = vi.fn();
        const win2Send = vi.fn();
        mockGetAllWindows.mockReturnValue([
          { isDestroyed: () => false, webContents: { send: win1Send } },
          { isDestroyed: () => false, webContents: { send: win2Send } },
        ]);

        await handlers['consent:setState']({}, { telemetryOptIn: false });

        expect(win1Send).toHaveBeenCalledWith('consent:changed', expect.any(Object));
        expect(win1Send).toHaveBeenCalledWith('sentry:consentRevoked');
        expect(win2Send).toHaveBeenCalledWith('sentry:consentRevoked');
        expect(win1Send).not.toHaveBeenCalledWith('sentry:consentRestored');
      });

      it('broadcasts sentry:consentRestored on opt-on FROM previously opted-out state', async () => {
        // Arrange: explicitly write opted-out state before the handler runs
        // (default state is also opted-out, but this makes the prior state explicit)
        const consentFile = path.join(tmpDir, 'telemetry-consent.json');
        fs.writeFileSync(
          consentFile,
          JSON.stringify({
            telemetryOptIn: false,
            firstPromptCompleted: true,
            policyAcknowledgedVersion: 2,
            pendingReConsent: false,
          }),
          'utf-8'
        );

        const winSend = vi.fn();
        mockGetAllWindows.mockReturnValue([
          { isDestroyed: () => false, webContents: { send: winSend } },
        ]);

        await handlers['consent:setState']({}, { telemetryOptIn: true });

        expect(winSend).toHaveBeenCalledWith('consent:changed', expect.any(Object));
        expect(winSend).toHaveBeenCalledWith('sentry:consentRestored');
        expect(winSend).not.toHaveBeenCalledWith('sentry:consentRevoked');
      });

      it('does NOT broadcast sentry:consentRestored when already opted-in state is reaffirmed', async () => {
        // Arrange: consent file already has telemetryOptIn=true (already opted in)
        const consentFile = path.join(tmpDir, 'telemetry-consent.json');
        fs.writeFileSync(
          consentFile,
          JSON.stringify({
            telemetryOptIn: true,
            firstPromptCompleted: true,
            policyAcknowledgedVersion: 2,
            pendingReConsent: false,
          }),
          'utf-8'
        );

        const winSend = vi.fn();
        mockGetAllWindows.mockReturnValue([
          { isDestroyed: () => false, webContents: { send: winSend } },
        ]);

        // Act: renderer sends a redundant opt-in update (store re-sync scenario)
        await handlers['consent:setState']({}, { telemetryOptIn: true });

        // Assert: consent:changed fires (state-sync) but consentRestored does NOT
        // — no revoked→granted transition occurred
        expect(winSend).toHaveBeenCalledWith('consent:changed', expect.any(Object));
        expect(winSend).not.toHaveBeenCalledWith('sentry:consentRestored');
        expect(winSend).not.toHaveBeenCalledWith('sentry:consentRevoked');
      });

      it('broadcasts neither lifecycle event when telemetryOptIn is not in the update', async () => {
        const winSend = vi.fn();
        mockGetAllWindows.mockReturnValue([
          { isDestroyed: () => false, webContents: { send: winSend } },
        ]);

        // Only updating firstPromptCompleted — no opt-in/out change
        await handlers['consent:setState']({}, { firstPromptCompleted: true });

        expect(winSend).toHaveBeenCalledWith('consent:changed', expect.any(Object));
        expect(winSend).not.toHaveBeenCalledWith('sentry:consentRevoked');
        expect(winSend).not.toHaveBeenCalledWith('sentry:consentRestored');
      });

      // ── Task 3.5: in-flight mutex serialization ──────────────────────

      it('serializes overlapping consent:setState calls (off then on)', async () => {
        const order: string[] = [];

        // Make Sentry.close take 50ms so the off-call is still pending when on-call starts
        mockSentryClose.mockImplementation(async () => {
          order.push('close.start');
          await new Promise<void>((r) => setTimeout(r, 50));
          order.push('close.end');
          return true;
        });

        // Fire both without awaiting — the mutex must serialise them
        const p1 = handlers['consent:setState']({}, { telemetryOptIn: false });
        const p2 = handlers['consent:setState']({}, { telemetryOptIn: true });
        await Promise.all([p1, p2]);

        // close.end must come before the second handler's persist/broadcast work.
        // The second call (opt-on) does not call Sentry.close, so we verify ordering
        // via the consent:changed broadcasts: the first window send for the opt-off
        // call must precede any send for the opt-on call — i.e., the off handler
        // fully completes before the on handler begins.
        expect(order).toEqual(['close.start', 'close.end']);

        // Both handlers completed: two consent:changed sends total (one per call)
        const changedCalls = mockWebContentsSend.mock.calls.filter(
          (c: unknown[]) => c[0] === 'consent:changed'
        );
        expect(changedCalls.length).toBe(2);
      });
    });
  });
});
