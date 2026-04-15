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

  it('preserves the boundary tag set by ErrorBoundary beforeCapture', () => {
    const event = {
      tags: {
        environment: 'production',
        boundary: 'app-root',
      },
    };
    const result = scrubEvent(event as any);
    expect(result!.tags).toHaveProperty('boundary', 'app-root');
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

  it('drops navigation breadcrumbs entirely', () => {
    const breadcrumb = {
      category: 'navigation',
      message: '/dm/user-abc123',
      data: { from: '/app', to: '/dm/user-abc123' },
    };
    expect(scrubBreadcrumb(breadcrumb as any)).toBeNull();
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

describe('path prefix scrubbing', () => {
  it('rewrites /Users/{username}/ to $HOME/ in frame filenames', () => {
    const event = {
      exception: {
        values: [
          {
            stacktrace: {
              frames: [
                {
                  filename: '/Users/alice/Concord/src/main.ts',
                  abs_path: '/Users/alice/Concord/src/main.ts',
                },
              ],
            },
          },
        ],
      },
    };
    const scrubbed = scrubEvent(event);
    expect(scrubbed.exception.values[0].stacktrace.frames[0].filename).toBe(
      '$HOME/Concord/src/main.ts'
    );
    expect(scrubbed.exception.values[0].stacktrace.frames[0].abs_path).toBe(
      '$HOME/Concord/src/main.ts'
    );
  });

  it('rewrites /home/{username}/ to $HOME/ in frame filenames', () => {
    const event = {
      exception: {
        values: [
          {
            stacktrace: { frames: [{ filename: '/home/bob/app/index.js' }] },
          },
        ],
      },
    };
    const scrubbed = scrubEvent(event);
    expect(scrubbed.exception.values[0].stacktrace.frames[0].filename).toBe('$HOME/app/index.js');
  });

  it('rewrites C:\\Users\\{username}\\ to %USERPROFILE%\\ in frame filenames', () => {
    const event = {
      exception: {
        values: [
          {
            stacktrace: { frames: [{ filename: 'C:\\Users\\charlie\\app\\index.js' }] },
          },
        ],
      },
    };
    const scrubbed = scrubEvent(event);
    expect(scrubbed.exception.values[0].stacktrace.frames[0].filename).toBe(
      '%USERPROFILE%\\app\\index.js'
    );
  });

  it('rewrites user-prefixed paths in exception values', () => {
    const event = {
      exception: {
        values: [{ value: 'ENOENT at /Users/dan/secret/keys.json line 42' }],
      },
    };
    const scrubbed = scrubEvent(event);
    expect(scrubbed.exception.values[0].value).toBe('ENOENT at $HOME/secret/keys.json line 42');
  });

  it('leaves non-user paths untouched', () => {
    const event = {
      exception: {
        values: [
          {
            stacktrace: { frames: [{ filename: '/usr/local/lib/node/foo.js' }] },
          },
        ],
      },
    };
    const scrubbed = scrubEvent(event);
    expect(scrubbed.exception.values[0].stacktrace.frames[0].filename).toBe(
      '/usr/local/lib/node/foo.js'
    );
  });
});

describe('device context subfield drops', () => {
  const DROPPED_DEVICE_FIELDS = [
    'model',
    'model_id',
    'cpu_description',
    'processor_frequency',
    'boot_time',
    'screen_resolution',
    'screen_density',
    'timezone',
    'locale',
  ];

  it.each(DROPPED_DEVICE_FIELDS)('drops device.%s', (field) => {
    const event: any = { contexts: { device: { [field]: 'sensitive-value' } } };
    const scrubbed = scrubEvent(event);
    expect(scrubbed.contexts.device[field]).toBeUndefined();
  });

  it('preserves device context object itself', () => {
    const event = { contexts: { device: { family: 'Mac', model: 'MacBookPro18,1' } } };
    const scrubbed = scrubEvent(event);
    expect(scrubbed.contexts.device).toBeDefined();
    expect(scrubbed.contexts.device.family).toBe('Mac');
    expect(scrubbed.contexts.device.model).toBeUndefined();
  });
});

describe('OS version coarsening', () => {
  it('coarsens 15.4.1 to 15.4', () => {
    const event = { contexts: { os: { version: '15.4.1' } } };
    const scrubbed = scrubEvent(event);
    expect(scrubbed.contexts.os.version).toBe('15.4');
  });

  it('coarsens 10.0.22621 to 10.0', () => {
    const event = { contexts: { os: { version: '10.0.22621' } } };
    const scrubbed = scrubEvent(event);
    expect(scrubbed.contexts.os.version).toBe('10.0');
  });

  it('leaves single-segment versions untouched', () => {
    const event = { contexts: { os: { version: '22' } } };
    const scrubbed = scrubEvent(event);
    expect(scrubbed.contexts.os.version).toBe('22');
  });

  it('drops os.build', () => {
    const event = { contexts: { os: { version: '15.4', build: '24E263' } } };
    const scrubbed = scrubEvent(event);
    expect(scrubbed.contexts.os.build).toBeUndefined();
  });

  it('drops os.kernel_version', () => {
    const event = { contexts: { os: { kernel_version: 'Darwin 24.5.0 ...' } } };
    const scrubbed = scrubEvent(event);
    expect(scrubbed.contexts.os.kernel_version).toBeUndefined();
  });

  it('drops os.raw_description', () => {
    const event = { contexts: { os: { raw_description: 'macOS 15.4.1 (24E263)' } } };
    const scrubbed = scrubEvent(event);
    expect(scrubbed.contexts.os.raw_description).toBeUndefined();
  });
});
