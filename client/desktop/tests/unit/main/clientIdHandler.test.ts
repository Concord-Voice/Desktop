import { describe, it, expect, vi, beforeEach } from 'vitest';

const hoist = vi.hoisted(() => ({
  registeredCallback: null as null | ((event: { senderFrame?: { url: string } }) => string),
  mockHandle: vi.fn(),
  mockGetClientId: vi.fn(),
}));

hoist.mockHandle.mockImplementation((channel: string, cb: typeof hoist.registeredCallback) => {
  if (channel === 'sentry:getClientId') hoist.registeredCallback = cb;
});

vi.mock('electron', () => ({ ipcMain: { handle: hoist.mockHandle } }));
vi.mock('../../../src/main/sentry', () => ({
  getClientId: () => hoist.mockGetClientId(),
}));

import {
  registerClientIdHandler,
  isPermittedFrameUrl,
} from '../../../src/main/ipc/clientIdHandler';

describe('isPermittedFrameUrl', () => {
  it('accepts file:// (packaged bundled build)', () => {
    expect(
      isPermittedFrameUrl(
        'file:///Applications/Concord.app/Contents/Resources/app.asar/index.html',
        null
      )
    ).toBe(true);
  });
  it('accepts http://localhost:3000/ (dev)', () => {
    expect(isPermittedFrameUrl('http://localhost:3000/', null)).toBe(true);
  });
  it('accepts http://localhost:5173 without trailing slash at end-of-string', () => {
    expect(isPermittedFrameUrl('http://localhost:5173', null)).toBe(true);
  });
  it('accepts validated remote SPA origin', () => {
    expect(
      isPermittedFrameUrl(
        'https://app.concordvoice.chat/index.html',
        'https://app.concordvoice.chat'
      )
    ).toBe(true);
  });
  it('rejects remote SPA origin when provider returns null', () => {
    expect(isPermittedFrameUrl('https://app.concordvoice.chat/', null)).toBe(false);
  });
  it('rejects arbitrary https origin', () => {
    expect(isPermittedFrameUrl('https://evil.example/', 'https://app.concordvoice.chat')).toBe(
      false
    );
  });
  it('rejects localhost with suffix subdomain injection', () => {
    expect(isPermittedFrameUrl('http://localhost:3000.evil.com/', null)).toBe(false);
  });
  it('rejects localhost with userinfo injection', () => {
    expect(isPermittedFrameUrl('http://localhost:3000@evil.com/', null)).toBe(false);
  });
  it('rejects localhost with non-numeric port', () => {
    expect(isPermittedFrameUrl('http://localhost:abc/', null)).toBe(false);
  });
  it('rejects empty url', () => {
    expect(isPermittedFrameUrl('', null)).toBe(false);
  });
  it('rejects remote SPA look-alike (substring match, not prefix)', () => {
    expect(
      isPermittedFrameUrl(
        'https://evil-app.concordvoice.chat.evil/',
        'https://app.concordvoice.chat'
      )
    ).toBe(false);
  });
  it('rejects remote SPA without slash terminator (avoids prefix-hijack)', () => {
    // https://app.concordvoice.chat.evil.com/ should NOT match even though the allowed
    // origin is 'https://app.concordvoice.chat' — the slash terminator after the
    // origin forces a proper host boundary.
    expect(
      isPermittedFrameUrl(
        'https://app.concordvoice.chat.evil.com/',
        'https://app.concordvoice.chat'
      )
    ).toBe(false);
  });
});

describe('registerClientIdHandler', () => {
  beforeEach(() => {
    hoist.registeredCallback = null;
    hoist.mockHandle.mockClear();
    hoist.mockHandle.mockImplementation((channel: string, cb: typeof hoist.registeredCallback) => {
      if (channel === 'sentry:getClientId') hoist.registeredCallback = cb;
    });
    hoist.mockGetClientId.mockReset();
  });

  it('returns cached clientId for file:// sender frame', () => {
    registerClientIdHandler(() => null);
    hoist.mockGetClientId.mockReturnValue({ kind: 'stable', id: 'abc123' });
    const cb = hoist.registeredCallback;
    if (!cb) throw new Error('callback not registered');
    const result = cb({ senderFrame: { url: 'file:///app.asar/index.html' } });
    expect(result).toBe('abc123');
  });

  it('resolves remote SPA origin from provider dynamically (not snapshot)', () => {
    let origin: string | null = null;
    registerClientIdHandler(() => origin);
    hoist.mockGetClientId.mockReturnValue({ kind: 'stable', id: 'xyz' });
    const cb = hoist.registeredCallback;
    if (!cb) throw new Error('callback not registered');
    // First call: provider returns null → rejected
    expect(() => cb({ senderFrame: { url: 'https://app.concordvoice.chat/' } })).toThrow(
      /sender frame not permitted/
    );
    // Provider value changes (simulating SPA load) → accepted on next call
    origin = 'https://app.concordvoice.chat';
    const result = cb({ senderFrame: { url: 'https://app.concordvoice.chat/' } });
    expect(result).toBe('xyz');
  });

  it('throws for disallowed scheme', () => {
    registerClientIdHandler(() => null);
    const cb = hoist.registeredCallback;
    if (!cb) throw new Error('callback not registered');
    expect(() => cb({ senderFrame: { url: 'https://evil.example/' } })).toThrow(
      /sender frame not permitted/
    );
  });

  it('throws when senderFrame is undefined', () => {
    registerClientIdHandler(() => null);
    const cb = hoist.registeredCallback;
    if (!cb) throw new Error('callback not registered');
    expect(() => cb({})).toThrow(/sender frame not permitted/);
  });
});
