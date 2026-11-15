import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetBootConnectionForTesting,
  bootConnection,
} from '@/renderer/services/system/bootConnection';

const VALID_IDENTITY = {
  connectionId: 'AAAAAAAAAAAAAAAAAAAAAA',
  generation: 1,
  serviceId: 'saas',
  kind: 'saas',
  apiOrigin: 'https://api.example.com',
};

type ElectronBridge = { connection?: unknown };

function electron(): ElectronBridge {
  return window.electron as unknown as ElectronBridge;
}

function setWhoAmI(value: unknown): void {
  electron().connection = { whoAmI: vi.fn(() => value) };
}

describe('bootConnection', () => {
  beforeEach(() => {
    _resetBootConnectionForTesting();
  });

  afterEach(() => {
    delete electron().connection;
    _resetBootConnectionForTesting();
  });

  it('is legacy when the preload exposes no connection bridge', () => {
    delete electron().connection;

    expect(bootConnection()).toEqual({ mode: 'legacy' });
  });

  it('is unavailable when whoAmI() returns null', () => {
    setWhoAmI(null);

    expect(bootConnection()).toEqual({ mode: 'unavailable' });
  });

  it('is connection mode with the identity apiOrigin for a valid identity', () => {
    setWhoAmI({ ...VALID_IDENTITY });

    const boot = bootConnection();

    expect(boot.mode).toBe('connection');
    if (boot.mode !== 'connection') throw new Error('unreachable');
    expect(boot.identity.apiOrigin).toBe('https://api.example.com');
    expect(boot.identity.serviceId).toBe('saas');
  });

  it('fails closed (unavailable) when the identity carries an extra key', () => {
    setWhoAmI({ ...VALID_IDENTITY, extra: 'x' });

    expect(bootConnection()).toEqual({ mode: 'unavailable' });
  });

  it('fails closed (unavailable) when the identity is unparsable', () => {
    setWhoAmI({ ...VALID_IDENTITY, apiOrigin: 'not a url' });

    expect(bootConnection()).toEqual({ mode: 'unavailable' });
  });

  it('is memoised: whoAmI is read once', () => {
    const whoAmI = vi.fn(() => ({ ...VALID_IDENTITY }));
    electron().connection = { whoAmI };

    bootConnection();
    bootConnection();

    expect(whoAmI).toHaveBeenCalledTimes(1);
  });
});
