// @vitest-environment node
/**
 * Main-process API base resolution tests (#974, plan deviation D1).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({
  isPackaged: false,
  persistedApiBase: null as string | null,
}));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return mocked.isPackaged;
    },
  },
}));

vi.mock('../../../src/main/tokenManager', () => ({
  getPersistedApiBase: () => mocked.persistedApiBase,
}));

import {
  _resetFirstPartyApiOriginForTesting,
  firstPartyApiOrigin,
  getApiBaseUrl,
  pinFirstPartyApiOrigin,
} from '@/main/apiBaseUrl';
import { serviceIdForApiBase } from '@/main/selfHostedProfile';

describe('getApiBaseUrl', () => {
  beforeEach(() => {
    mocked.isPackaged = false;
    mocked.persistedApiBase = null;
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // #86 Task 7B: the app-wide "last signed in" base is gone. A stored credential's
  // base never selects the server; the sender's service origin does.
  it('never resolves to a persisted apiBase, even when one exists', () => {
    mocked.persistedApiBase = 'https://staging.concordvoice.chat';
    mocked.isPackaged = true;
    expect(getApiBaseUrl()).toBe('https://api.concordvoice.chat');
  });

  it('falls back to the production SaaS endpoint in packaged builds', () => {
    mocked.isPackaged = true;
    expect(getApiBaseUrl()).toBe('https://api.concordvoice.chat');
  });

  it('falls back to the local control plane in dev', () => {
    expect(getApiBaseUrl()).toBe('http://localhost:8080');
  });

  it('honors the CONCORD_DEV_API_BASE override in dev only', () => {
    vi.stubEnv('CONCORD_DEV_API_BASE', 'http://192.0.2.19:8080');
    expect(getApiBaseUrl()).toBe('http://192.0.2.19:8080');
    mocked.isPackaged = true;
    expect(getApiBaseUrl()).toBe('https://api.concordvoice.chat');
  });
});

// #86 Task 7B ruling, DEV-BUILD ORIGIN: the saas service's origin is the first-party base
// main pins once at startup. Nothing a renderer sends reaches it: the pin takes no input.
describe('pinFirstPartyApiOrigin', () => {
  beforeEach(() => {
    mocked.isPackaged = false;
    vi.unstubAllEnvs();
    _resetFirstPartyApiOriginForTesting();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    _resetFirstPartyApiOriginForTesting();
  });

  it('a packaged build pins production regardless of env, and later input cannot move it', () => {
    mocked.isPackaged = true;
    vi.stubEnv('CONCORD_DEV_API_BASE', 'https://evil.example');
    expect(pinFirstPartyApiOrigin()).toBe('https://api.concordvoice.chat');
    expect(serviceIdForApiBase('https://api.concordvoice.chat')).toBe('saas');
    expect(serviceIdForApiBase('https://evil.example')).not.toBe('saas');
    expect(serviceIdForApiBase('http://localhost:8080')).not.toBe('saas');
    // Fixed for the process: an env change or an unpackaged read afterwards changes nothing.
    vi.stubEnv('CONCORD_DEV_API_BASE', 'http://localhost:9999');
    mocked.isPackaged = false;
    expect(pinFirstPartyApiOrigin()).toBe('https://api.concordvoice.chat');
    expect(firstPartyApiOrigin()).toBe('https://api.concordvoice.chat');
    expect(serviceIdForApiBase('http://localhost:9999')).not.toBe('saas');
  });

  it('an unpackaged build admits the dev base as saas and no other origin', () => {
    expect(pinFirstPartyApiOrigin()).toBe('http://localhost:8080');
    expect(serviceIdForApiBase('http://localhost:8080/api')).toBe('saas');
    expect(serviceIdForApiBase('http://localhost:8081')).not.toBe('saas');
    expect(serviceIdForApiBase('https://evil.example')).not.toBe('saas');
  });

  it('an unpackaged build pins the CONCORD_DEV_API_BASE origin, never its path', () => {
    vi.stubEnv('CONCORD_DEV_API_BASE', 'http://192.0.2.19:8080/some/path');
    expect(pinFirstPartyApiOrigin()).toBe('http://192.0.2.19:8080');
  });

  it('a malformed or non-http dev override fails closed to production', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('CONCORD_DEV_API_BASE', 'javascript:alert(1)');
    expect(pinFirstPartyApiOrigin()).toBe('https://api.concordvoice.chat');
  });

  it('reports production before main has pinned anything', () => {
    expect(firstPartyApiOrigin()).toBe('https://api.concordvoice.chat');
    expect(serviceIdForApiBase('http://localhost:8080')).not.toBe('saas');
  });
});
