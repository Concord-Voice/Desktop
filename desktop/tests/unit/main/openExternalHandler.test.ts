import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron before importing
vi.mock('electron', () => {
  const openExternal = vi.fn().mockResolvedValue(undefined);
  return {
    shell: { openExternal },
    ipcMain: {
      handle: vi.fn(),
    },
    __mocks__: { openExternal },
  };
});

import { shell, ipcMain } from 'electron';
import { bindSender, setForeground } from '@/main/connectionRegistry';
import { registerOpenExternalHandler } from '@/main/ipc/openExternal';
import { bindTestSender, type BoundSenderFixture } from './ipc/boundSenderFixture';

const mockShell = shell as unknown as { openExternal: ReturnType<typeof vi.fn> };
const mockIpcMain = ipcMain as unknown as { handle: ReturnType<typeof vi.fn> };

interface FakeEvent {
  senderFrame: { url: string };
}

describe('openExternal IPC handler', () => {
  let handler: (event: FakeEvent, url: string) => Promise<{ ok: boolean; reason?: string }>;

  // #86 Task 7B: events come from a bound saas primary; only the frame URL varies.
  let fx: BoundSenderFixture;

  beforeEach(() => {
    vi.clearAllMocks();
    fx = bindTestSender();
    registerOpenExternalHandler();
    expect(mockIpcMain.handle).toHaveBeenCalledWith('open-external', expect.any(Function));
    handler = mockIpcMain.handle.mock.calls[0][1];
  });

  it('opens https URLs from a trusted sender frame', async () => {
    const result = await handler(fx.event('http://localhost:3001'), 'https://example.com');
    expect(result.ok).toBe(true);
    expect(mockShell.openExternal).toHaveBeenCalledWith('https://example.com');
  });

  it('opens http URLs', async () => {
    const result = await handler(fx.event('http://localhost:3001'), 'http://example.com');
    expect(result.ok).toBe(true);
    expect(mockShell.openExternal).toHaveBeenCalledWith('http://example.com');
  });

  it('opens mailto URLs', async () => {
    const result = await handler(fx.event('http://localhost:3001'), 'mailto:a@b.com');
    expect(result.ok).toBe(true);
    expect(mockShell.openExternal).toHaveBeenCalledWith('mailto:a@b.com');
  });

  it('rejects javascript: URLs', async () => {
    const result = await handler(fx.event('http://localhost:3001'), 'javascript:alert(1)');
    expect(result.ok).toBe(false);
    expect(mockShell.openExternal).not.toHaveBeenCalled();
  });

  it('rejects data: URLs', async () => {
    const result = await handler(fx.event('http://localhost:3001'), 'data:text/html,abc');
    expect(result.ok).toBe(false);
    expect(mockShell.openExternal).not.toHaveBeenCalled();
  });

  it('rejects file: URLs', async () => {
    const result = await handler(fx.event('http://localhost:3001'), 'file:///etc/passwd');
    expect(result.ok).toBe(false);
    expect(mockShell.openExternal).not.toHaveBeenCalled();
  });

  it('rejects blob: URLs', async () => {
    const result = await handler(fx.event('http://localhost:3001'), 'blob:http://x/1');
    expect(result.ok).toBe(false);
    expect(mockShell.openExternal).not.toHaveBeenCalled();
  });

  it('rejects vbscript: URLs', async () => {
    const result = await handler(fx.event('http://localhost:3001'), 'vbscript:msgbox(1)');
    expect(result.ok).toBe(false);
    expect(mockShell.openExternal).not.toHaveBeenCalled();
  });

  it('rejects URLs with non-http/https/mailto protocol even if well-formed', async () => {
    const result = await handler(fx.event('http://localhost:3001'), 'ftp://example.com');
    expect(result.ok).toBe(false);
    expect(mockShell.openExternal).not.toHaveBeenCalled();
  });

  it('rejects senders from non-trusted origins', async () => {
    const result = await handler(fx.event('https://attacker.com'), 'https://example.com');
    expect(result.ok).toBe(false);
    expect(mockShell.openExternal).not.toHaveBeenCalled();
  });

  // #86 (C6): the OS browser opens over every connection, so a hidden connection must not
  // launch one while another is visible. The refusal keeps the existing result shape.
  describe('foreground connection only (app-global-mutate)', () => {
    let background: BoundSenderFixture;
    beforeEach(() => {
      background = bindTestSender({
        origin: 'https://voice.example',
        id: 9,
        reset: false,
        foreground: false,
      });
    });

    it.each(['https://phish.example/login', 'http://phish.example', 'mailto:x@phish.example'])(
      'refuses a background connection before shell.openExternal (%s)',
      async (url) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const result = await handler(background.event(), url);
        expect(result).toEqual({ ok: false, reason: 'untrusted-sender' });
        expect(mockShell.openExternal).not.toHaveBeenCalled();
        expect(warn.mock.calls.flat().join(' ')).toContain(
          'open-external refused (not-foreground)'
        );
        warn.mockRestore();
      }
    );

    it('still opens for the foreground connection while a background one is open', async () => {
      const result = await handler(fx.event(), 'https://example.com');
      expect(result).toEqual({ ok: true });
      expect(mockShell.openExternal).toHaveBeenCalledWith('https://example.com');
    });

    it('follows the foreground: the switched-to connection opens, the old one is refused', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      setForeground(background.connectionId);
      expect(await handler(background.event(), 'https://example.com/a')).toEqual({ ok: true });
      mockShell.openExternal.mockClear();
      expect(await handler(fx.event(), 'https://example.com/b')).toEqual({
        ok: false,
        reason: 'untrusted-sender',
      });
      expect(mockShell.openExternal).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    // Pins the PiP decision: a PiP was refused under connection-bound (primary only) and
    // stays refused, even the foreground connection's own PiP.
    it("refuses the foreground connection's PiP", async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const pipWc = { id: 11, mainFrame: { frameTreeNodeId: 11 } } as never;
      bindSender(pipWc, fx.connectionId, 'pip');
      const pipEvent = {
        sender: pipWc,
        senderFrame: {
          url: 'app://concord/pip.html',
          parent: null,
          frameTreeNodeId: 11,
          detached: false,
        },
      } as never;
      expect(await handler(pipEvent, 'https://example.com')).toEqual({
        ok: false,
        reason: 'untrusted-sender',
      });
      expect(mockShell.openExternal).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });
});
