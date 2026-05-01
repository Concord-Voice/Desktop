import { describe, it, expect, beforeEach } from 'vitest';

import { getRemoteSpaBaseUrl, getRemoteSpaUrl, setRemoteSpaState } from '@/main/spaState';

describe('spaState — atomic lockstep invariant', () => {
  beforeEach(() => {
    // Reset module-scope state between tests.
    setRemoteSpaState(null);
  });

  it('starts with both variables null', () => {
    expect(getRemoteSpaBaseUrl()).toBeNull();
    expect(getRemoteSpaUrl()).toBeNull();
  });

  it('setRemoteSpaState(url) sets both atomically', () => {
    setRemoteSpaState('https://api.concordvoice.chat/spa/abc1234/index.html');
    expect(getRemoteSpaBaseUrl()).toBe('https://api.concordvoice.chat');
    expect(getRemoteSpaUrl()).toBe('https://api.concordvoice.chat/spa/abc1234/index.html');
  });

  it('setRemoteSpaState(null) clears both atomically', () => {
    setRemoteSpaState('https://api.concordvoice.chat/spa/abc/index.html');
    setRemoteSpaState(null);
    expect(getRemoteSpaBaseUrl()).toBeNull();
    expect(getRemoteSpaUrl()).toBeNull();
  });

  it('setRemoteSpaState(malformed) clears both (fail-closed)', () => {
    // Pre-populate so the failure path is observable.
    setRemoteSpaState('https://api.concordvoice.chat/spa/abc/index.html');
    setRemoteSpaState('not a url');
    expect(getRemoteSpaBaseUrl()).toBeNull();
    expect(getRemoteSpaUrl()).toBeNull();
  });

  it('successive sets preserve lockstep (regression for #815 reconciliation)', () => {
    setRemoteSpaState('https://api.concordvoice.chat/spa/abc/index.html');
    setRemoteSpaState('https://api.concordvoice.chat/spa/def5678/index.html');
    expect(getRemoteSpaBaseUrl()).toBe('https://api.concordvoice.chat');
    expect(getRemoteSpaUrl()).toBe('https://api.concordvoice.chat/spa/def5678/index.html');
  });
});
