import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const IDENTITY = {
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

async function loadFresh() {
  vi.resetModules();
  const boot = await import('@/renderer/services/system/bootConnection');
  boot._resetBootConnectionForTesting();
  const base = await import('@/renderer/services/system/runtimeServerBase');
  const config = await import('@/renderer/config');
  return { base, config };
}

describe('runtimeServerBase in connection mode', () => {
  beforeEach(() => {
    electron().connection = { whoAmI: vi.fn(() => ({ ...IDENTITY })) };
  });

  afterEach(() => {
    delete electron().connection;
  });

  it('getApiBase() is the boot identity apiOrigin', async () => {
    const { base } = await loadFresh();

    expect(base.getApiBase()).toBe('https://api.example.com');
  });

  it('setRuntimeServerBase throws and getApiBase is unchanged', async () => {
    const { base } = await loadFresh();

    expect(() => base.setRuntimeServerBase('https://x')).toThrow(
      'runtimeServerBase is boot-immutable in connection mode'
    );
    expect(base.getApiBase()).toBe('https://api.example.com');
  });

  it('resetRuntimeServerBase throws and getApiBase is unchanged', async () => {
    const { base } = await loadFresh();

    expect(() => base.resetRuntimeServerBase()).toThrow(
      'runtimeServerBase is boot-immutable in connection mode'
    );
    expect(base.getApiBase()).toBe('https://api.example.com');
  });
});

describe('runtimeServerBase in legacy mode', () => {
  it('keeps the build-time base and still allows set/reset', async () => {
    delete electron().connection;
    const { base, config } = await loadFresh();

    expect(base.getApiBase()).toBe(config.API_BASE);
    base.setRuntimeServerBase('https://homelab.lan:8443');
    expect(base.getApiBase()).toBe('https://homelab.lan:8443');
    base.resetRuntimeServerBase();
    expect(base.getApiBase()).toBe(config.API_BASE);
  });
});
