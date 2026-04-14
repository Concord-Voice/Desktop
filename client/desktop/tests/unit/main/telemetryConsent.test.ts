// @vitest-environment node
//
// telemetryConsent — consent file I/O tests (read, write, IPC handlers)

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Hoisted mocks ────────────────────────────────────────────────────────

const { mockGetPath, mockIpcMainHandle, mockWebContentsSend, mockGetClient, mockGetAllWindows } =
  vi.hoisted(() => ({
    mockGetPath: vi.fn(),
    mockIpcMainHandle: vi.fn(),
    mockWebContentsSend: vi.fn(),
    mockGetClient: vi.fn(),
    mockGetAllWindows: vi.fn(),
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

      it('consent:setState writes updates and notifies renderer via getAllWindows', () => {
        handlers['consent:setState']({}, { telemetryOptIn: true, firstPromptCompleted: true });

        // Renderer must receive the changed event with the new state
        expect(mockWebContentsSend).toHaveBeenCalledWith(
          'consent:changed',
          expect.objectContaining({
            telemetryOptIn: true,
            firstPromptCompleted: true,
          })
        );
      });

      it('consent:setState skips destroyed windows', () => {
        const liveWindow = makeMockWindow(false);
        const deadWindow = makeMockWindow(true);
        const deadSend = vi.fn();
        deadWindow.webContents.send = deadSend;
        mockGetAllWindows.mockReturnValue([liveWindow, deadWindow]);
        mockWebContentsSend.mockReset();

        handlers['consent:setState']({}, { telemetryOptIn: true });

        expect(mockWebContentsSend).toHaveBeenCalledTimes(1);
        expect(deadSend).not.toHaveBeenCalled();
      });

      it('consent:setState strips unexpected keys and updatedAt', () => {
        handlers['consent:setState'](
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

      it('consent:setState ignores fields with wrong types', () => {
        // None of the fields should be accepted — all wrong types
        handlers['consent:setState'](
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

      it('consent:setState toggles Sentry when client is available', () => {
        const options = { enabled: false };
        mockGetClient.mockReturnValue({
          getOptions: () => options,
        });

        handlers['consent:setState']({}, { telemetryOptIn: true });

        expect(mockGetClient).toHaveBeenCalled();
        expect(options.enabled).toBe(true);
      });

      it('consent:setState does not throw when Sentry client is unavailable', () => {
        mockGetClient.mockReturnValue(undefined);
        expect(() => {
          handlers['consent:setState']({}, { telemetryOptIn: false });
        }).not.toThrow();
      });

      it('consent:setState propagates write errors via IPC rejection', async () => {
        // Make the consent file path a directory to force a write error
        const consentFile = path.join(tmpDir, 'telemetry-consent.json');
        fs.mkdirSync(consentFile, { recursive: true });

        await expect(
          Promise.resolve().then(() => handlers['consent:setState']({}, { telemetryOptIn: true }))
        ).rejects.toThrow();
      });
    });
  });
});
