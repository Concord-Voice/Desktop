import { describe, it, expect } from 'vitest';
// Use relative import (not @/ alias) so Istanbul coverage instrumentation tracks the file correctly
import {
  scrubEvent,
  scrubBreadcrumb,
  redactSensitivePatterns,
} from '../../../src/shared/sentry-scrubbers';

describe('scrubEvent', () => {
  it('strips unknown contexts', () => {
    const event = {
      contexts: {
        os: { name: 'macOS' },
        e2ee: { channelKey: 'secret' },
        customThing: { data: 'value' },
      },
    };
    const result = scrubEvent(event as any);
    expect(result!.contexts).toHaveProperty('os');
    expect(result!.contexts).not.toHaveProperty('e2ee');
    expect(result!.contexts).not.toHaveProperty('customThing');
  });

  it('preserves all allowed contexts', () => {
    const event = {
      contexts: {
        os: { name: 'macOS' },
        browser: { name: 'Chrome' },
        electron: { version: '41' },
        device: { family: 'Desktop' },
        runtime: { name: 'node' },
        app: { version: '0.1.12' },
      },
    };
    const result = scrubEvent(event as any);
    expect(Object.keys(result!.contexts!)).toHaveLength(6);
  });

  it('strips extra completely', () => {
    const event = { extra: { sensitiveState: 'leaked' } };
    const result = scrubEvent(event as any);
    expect(result!.extra).toBeUndefined();
  });

  it('strips user fields except id', () => {
    const event = {
      user: { id: 'anon-123', email: 'user@example.com', username: 'alice', ip_address: '1.2.3.4' },
    };
    const result = scrubEvent(event as any);
    expect(result!.user).toEqual({ id: 'anon-123' });
  });

  it('handles null input gracefully', () => {
    const result = scrubEvent(null as any);
    expect(result).toBeNull();
  });

  it('redacts sensitive patterns in user.id', () => {
    const event = {
      user: { id: 'alice@example.com', email: 'alice@example.com' },
    };
    const result = scrubEvent(event as any);
    expect(result!.user.id).not.toContain('alice@example.com');
    expect(result!.user.id).toContain('[REDACTED]');
  });

  it('handles event with no user field', () => {
    const event = { extra: { data: 'value' } };
    const result = scrubEvent(event as any);
    expect(result).not.toBeNull();
    expect(result!.user).toBeUndefined();
  });

  it('strips request data completely', () => {
    const event = {
      request: {
        url: 'https://api.concordvoice.chat/v1/channels/123?token=secret',
        headers: { authorization: 'Bearer xxx' },
      },
    };
    const result = scrubEvent(event as any);
    expect(result!.request).toBeUndefined();
  });

  it('strips unknown tags', () => {
    const event = {
      tags: {
        environment: 'production',
        release: 'v1',
        customTag: 'leaked',
      },
    };
    const result = scrubEvent(event as any);
    expect(result!.tags).toHaveProperty('environment');
    expect(result!.tags).toHaveProperty('release');
    expect(result!.tags).not.toHaveProperty('customTag');
  });
});

describe('redactSensitivePatterns', () => {
  it('catches JWTs in messages', () => {
    // Build a fake JWT-shaped string at runtime to avoid Semgrep flagging test fixtures
    const fakeJwt = `${btoa('{"alg":"HS256"}').replace(/=/g, '')}.${btoa('{"sub":"test"}').replace(/=/g, '')}`;
    const msg = `Error: token ${fakeJwt} is expired`;
    const result = redactSensitivePatterns(msg);
    expect(result).not.toContain('eyJ');
    expect(result).toContain('[REDACTED]');
  });

  it('catches base64 blobs over 64 chars', () => {
    const blob = 'A'.repeat(70);
    const msg = `Key material: ${blob}`;
    const result = redactSensitivePatterns(msg);
    expect(result).not.toContain(blob);
    expect(result).toContain('[REDACTED]');
  });

  it('catches email addresses', () => {
    const msg = 'User alice@example.com failed to authenticate';
    const result = redactSensitivePatterns(msg);
    expect(result).not.toContain('alice@example.com');
    expect(result).toContain('[REDACTED]');
  });

  it('passes through clean messages unchanged', () => {
    const msg = 'TypeError: Cannot read properties of undefined';
    expect(redactSensitivePatterns(msg)).toBe(msg);
  });

  it('handles non-string input', () => {
    expect(redactSensitivePatterns(undefined as any)).toBe('');
    expect(redactSensitivePatterns(null as any)).toBe('');
    expect(redactSensitivePatterns(42 as any)).toBe('42');
  });
});

describe('scrubBreadcrumb', () => {
  it('handles null input gracefully', () => {
    const result = scrubBreadcrumb(null as any);
    expect(result).toBeNull();
  });

  it('drops console breadcrumbs entirely', () => {
    const breadcrumb = { category: 'console', message: 'debug log', data: { key: 'secret' } };
    expect(scrubBreadcrumb(breadcrumb as any)).toBeNull();
  });

  it('strips data from navigation breadcrumbs', () => {
    const breadcrumb = {
      category: 'navigation',
      message: 'navigated to /settings',
      data: { from: '/chat', to: '/settings', params: { userId: '123' } },
    };
    const result = scrubBreadcrumb(breadcrumb as any);
    expect(result).not.toBeNull();
    expect(result!.data).toBeUndefined();
    expect(result!.category).toBe('navigation');
  });

  it('redacts sensitive patterns in breadcrumb messages', () => {
    const breadcrumb = {
      category: 'http',
      // Build fake JWT at runtime to avoid Semgrep flagging test fixtures
      message: `POST /api/auth token=${btoa('{"alg":"HS256"}').replace(/=/g, '')}.${btoa('{"sub":"1"}').replace(/=/g, '')}`,
    };
    const result = scrubBreadcrumb(breadcrumb as any);
    expect(result!.message).toContain('[REDACTED]');
    expect(result!.message).not.toContain('eyJ');
  });
});
