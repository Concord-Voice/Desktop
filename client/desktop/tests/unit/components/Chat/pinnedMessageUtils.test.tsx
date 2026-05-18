import { render } from '../../../test-utils';
import { screen } from '@testing-library/react';
import { vi } from 'vitest';
import type { MessageWithUser } from '@/renderer/types/chat';

// Mock e2eeService before importing the module under test
const mockGetChannelKey = vi.fn();
const mockGetChannelKeyByVersion = vi.fn();
const mockDecryptWithKey = vi.fn();
const mockDecryptForChannel = vi.fn();
const mockDecryptForChannelWithVersion = vi.fn();

vi.mock('@/renderer/services/e2eeService', () => ({
  e2eeService: {
    isInitialized: false,
    getChannelKey: (...args: unknown[]) => mockGetChannelKey(...args),
    getChannelKeyByVersion: (...args: unknown[]) => mockGetChannelKeyByVersion(...args),
    decryptWithKey: (...args: unknown[]) => mockDecryptWithKey(...args),
    decryptForChannel: (...args: unknown[]) => mockDecryptForChannel(...args),
    decryptForChannelWithVersion: (...args: unknown[]) => mockDecryptForChannelWithVersion(...args),
  },
}));

import { renderPinContent, decryptPins } from '@/renderer/components/Chat/pinnedMessageUtils';

async function setE2EEInitialized(value: boolean) {
  const { e2eeService } = await import('@/renderer/services/e2eeService');
  Object.defineProperty(e2eeService, 'isInitialized', { value, writable: true });
}

const baseMsg: MessageWithUser = {
  id: 'msg-1',
  channel_id: 'ctx-1',
  user_id: 'user-1',
  content: 'hello',
  username: 'alice',
  display_name: 'Alice',
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-01T00:00:00Z',
  pinned_at: '2025-01-01T01:00:00Z',
  pinned_by: 'user-1',
};

// ---------------------------------------------------------------------------
// renderPinContent
// ---------------------------------------------------------------------------
describe('renderPinContent', () => {
  it('returns "Unable to decrypt" span when decryptFailed is true', () => {
    render(<>{renderPinContent('anything', false, true)}</>);
    expect(screen.getByText('Unable to decrypt')).toBeInTheDocument();
  });

  it('returns "Encrypted message" span when not yet decrypted', () => {
    render(<>{renderPinContent('ciphertext', false, false)}</>);
    expect(screen.getByText('Encrypted message')).toBeInTheDocument();
  });

  it('returns "Encrypted message" span when decrypted is undefined', () => {
    render(<>{renderPinContent('ciphertext', undefined, undefined)}</>);
    expect(screen.getByText('Encrypted message')).toBeInTheDocument();
  });

  it('truncates content longer than 200 characters', () => {
    const long = 'B'.repeat(250);
    const result = renderPinContent(long, true, false);
    expect(typeof result).toBe('string');
    expect((result as string).length).toBe(203); // 200 + '...'
    expect((result as string).endsWith('...')).toBe(true);
  });

  it('returns content as-is when short and decrypted', () => {
    const result = renderPinContent('short message', true, false);
    expect(result).toBe('short message');
  });

  it('returns decrypted content as-is when decrypted flag is true', () => {
    const result = renderPinContent('plaintext', true, false);
    expect(result).toBe('plaintext');
  });

  it('decryptFailed takes priority over not-yet-decrypted', () => {
    render(<>{renderPinContent('x', false, true)}</>);
    expect(screen.getByText('Unable to decrypt')).toBeInTheDocument();
    expect(screen.queryByText('Encrypted message')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// decryptPins
// ---------------------------------------------------------------------------
describe('decryptPins', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await setE2EEInitialized(false);
  });

  it('passes messages through unchanged when e2ee not initialized', async () => {
    const msgs = [baseMsg, { ...baseMsg, id: 'msg-2' }];
    const result = await decryptPins('ctx-1', msgs);
    expect(result).toBe(msgs); // same reference — no processing
    expect(mockGetChannelKey).not.toHaveBeenCalled();
  });

  it('passes messages through unchanged when e2eeService is not initialized (with content)', async () => {
    const msg = { ...baseMsg, content: 'ciphertext' };
    const result = await decryptPins('ctx-1', [msg]);
    expect(result).toStrictEqual([msg]);
    expect(mockGetChannelKey).not.toHaveBeenCalled();
  });

  it('decrypts a message successfully', async () => {
    await setE2EEInitialized(true);
    const mockKey = {} as CryptoKey;
    mockGetChannelKey.mockResolvedValue(mockKey);
    mockDecryptWithKey.mockResolvedValue('decrypted text');

    const msg = { ...baseMsg, content: 'ciphertext' };
    const result = await decryptPins('ctx-1', [msg]);

    expect(result[0].content).toBe('decrypted text');
    expect(result[0].decrypted).toBe(true);
    expect(result[0].decryptFailed).toBeUndefined();
    expect(mockGetChannelKey).toHaveBeenCalledWith('ctx-1');
    expect(mockDecryptWithKey).toHaveBeenCalledWith('ciphertext', mockKey);
  });

  it('sets decryptFailed when decryption throws', async () => {
    await setE2EEInitialized(true);
    mockGetChannelKey.mockResolvedValue({} as CryptoKey);
    mockDecryptWithKey.mockRejectedValue(new Error('bad tag'));

    const msg = { ...baseMsg, content: 'ciphertext' };
    const result = await decryptPins('ctx-1', [msg]);

    expect(result[0].decryptFailed).toBe(true);
    expect(result[0].content).toBe('');
    expect(result[0].decrypted).toBeUndefined();
  });

  it('falls back to decryptForChannel when key fetch fails', async () => {
    await setE2EEInitialized(true);
    mockGetChannelKey.mockRejectedValue(new Error('no key'));
    mockDecryptForChannel.mockResolvedValue('fallback plaintext');

    const msg = { ...baseMsg, content: 'ciphertext' };
    const result = await decryptPins('ctx-1', [msg]);

    expect(result[0].content).toBe('fallback plaintext');
    expect(result[0].decrypted).toBe(true);
    expect(mockDecryptForChannel).toHaveBeenCalledWith('ctx-1', 'ciphertext');
  });

  it('uses versioned key for messages with key_version > 1', async () => {
    await setE2EEInitialized(true);
    mockGetChannelKey.mockResolvedValue({} as CryptoKey);
    const vKey = {} as CryptoKey;
    mockGetChannelKeyByVersion.mockResolvedValue(vKey);
    mockDecryptWithKey.mockResolvedValue('versioned plaintext');

    const versioned = { ...baseMsg, content: 'ct-v3', key_version: 3 };
    const result = await decryptPins('ctx-1', [versioned]);

    expect(result[0].content).toBe('versioned plaintext');
    expect(mockGetChannelKeyByVersion).toHaveBeenCalledWith('ctx-1', 3);
    expect(mockDecryptWithKey).toHaveBeenCalledWith('ct-v3', vKey);
  });

  it('falls back to decryptForChannelWithVersion when versioned key fetch fails', async () => {
    await setE2EEInitialized(true);
    mockGetChannelKey.mockResolvedValue({} as CryptoKey);
    mockGetChannelKeyByVersion.mockRejectedValue(new Error('no versioned key'));
    mockDecryptForChannelWithVersion.mockResolvedValue('version fallback');

    const versioned = { ...baseMsg, content: 'ct-v2', key_version: 2 };
    const result = await decryptPins('ctx-1', [versioned]);

    expect(result[0].content).toBe('version fallback');
    expect(mockDecryptForChannelWithVersion).toHaveBeenCalledWith('ctx-1', 'ct-v2', 2);
  });
});
