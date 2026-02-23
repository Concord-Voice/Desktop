import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  generateRegistrationKeys,
  generateChannelKey,
  exportChannelKey,
  wrapChannelKey,
  exportPublicKey,
  arrayBufferToBase64,
  encryptMessage,
} from '@/renderer/utils/crypto';

// We need a fresh E2EEService instance for each test, not the singleton
// Import the class by re-importing the module
let E2EEServiceClass: new () => InstanceType<typeof import('@/renderer/services/e2eeService')['e2eeService'] extends infer T ? { new(): T }['prototype'] extends never ? never : any : never>;

// Actually, let's just test the singleton and clear between tests
import { e2eeService } from '@/renderer/services/e2eeService';

// Mock apiFetch for channel key fetching
vi.mock('@/renderer/services/apiClient', () => ({
  apiFetch: vi.fn(),
  API_BASE: 'http://localhost:8080',
}));

import { apiFetch } from '@/renderer/services/apiClient';
const mockApiFetch = vi.mocked(apiFetch);

describe('e2eeService', () => {
  const testPassword = 'TestPassword123!';
  let regKeys: Awaited<ReturnType<typeof generateRegistrationKeys>>;

  beforeEach(async () => {
    e2eeService.clearKeys();
    vi.clearAllMocks();
    // Generate fresh keys for each test
    regKeys = await generateRegistrationKeys(testPassword);
  });

  afterEach(() => {
    e2eeService.clearKeys();
  });

  describe('initialize', () => {
    it('initializes the service', async () => {
      expect(e2eeService.isInitialized).toBe(false);
      await e2eeService.initialize(
        testPassword,
        regKeys.wrappedPrivateKey,
        regKeys.keyDerivationSalt
      );
      expect(e2eeService.isInitialized).toBe(true);
    });
  });

  describe('clearKeys', () => {
    it('clears all keys and resets state', async () => {
      await e2eeService.initialize(
        testPassword,
        regKeys.wrappedPrivateKey,
        regKeys.keyDerivationSalt
      );
      expect(e2eeService.isInitialized).toBe(true);

      e2eeService.clearKeys();
      expect(e2eeService.isInitialized).toBe(false);
    });
  });

  describe('encryptPreferences / decryptPreferences', () => {
    it('round-trips preferences data', async () => {
      await e2eeService.initialize(
        testPassword,
        regKeys.wrappedPrivateKey,
        regKeys.keyDerivationSalt
      );

      const prefs = { theme: 'dark', fontSize: 14 };
      const encrypted = await e2eeService.encryptPreferences(prefs);
      expect(typeof encrypted).toBe('string');

      const decrypted = await e2eeService.decryptPreferences<typeof prefs>(encrypted);
      expect(decrypted).toEqual(prefs);
    });

    it('throws when not initialized', async () => {
      await expect(e2eeService.encryptPreferences({ test: true })).rejects.toThrow(
        'E2EE service not initialized'
      );
    });
  });

  describe('getChannelKey', () => {
    it('fetches and unwraps channel key from server', async () => {
      await e2eeService.initialize(
        testPassword,
        regKeys.wrappedPrivateKey,
        regKeys.keyDerivationSalt
      );

      // Create a channel key and wrap it for our user
      const channelKey = await generateChannelKey();
      const wrappedForUser = await wrapChannelKey(channelKey, regKeys.publicKey);

      // Mock the API response
      mockApiFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ key: { wrapped_key: wrappedForUser } }),
      } as Response);

      const unwrapped = await e2eeService.getChannelKey('channel-1');
      expect(unwrapped).toBeDefined();
      expect(unwrapped.algorithm.name).toBe('AES-GCM');
    });

    it('caches wrapped keys', async () => {
      await e2eeService.initialize(
        testPassword,
        regKeys.wrappedPrivateKey,
        regKeys.keyDerivationSalt
      );

      const channelKey = await generateChannelKey();
      const wrappedForUser = await wrapChannelKey(channelKey, regKeys.publicKey);

      mockApiFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ key: { wrapped_key: wrappedForUser } }),
      } as Response);

      // First call fetches from server
      await e2eeService.getChannelKey('channel-1');
      expect(mockApiFetch).toHaveBeenCalledTimes(1);

      // Second call uses cache
      await e2eeService.getChannelKey('channel-1');
      expect(mockApiFetch).toHaveBeenCalledTimes(1);
    });

    it('throws PENDING_KEY when server indicates pending', async () => {
      await e2eeService.initialize(
        testPassword,
        regKeys.wrappedPrivateKey,
        regKeys.keyDerivationSalt
      );

      mockApiFetch.mockResolvedValueOnce({
        ok: false,
        json: () => Promise.resolve({ pending: true }),
      } as Response);

      await expect(e2eeService.getChannelKey('channel-1')).rejects.toThrow('PENDING_KEY');
    });
  });

  describe('encryptForChannel / decryptForChannel', () => {
    it('round-trips a message', async () => {
      await e2eeService.initialize(
        testPassword,
        regKeys.wrappedPrivateKey,
        regKeys.keyDerivationSalt
      );

      const channelKey = await generateChannelKey();
      const wrappedForUser = await wrapChannelKey(channelKey, regKeys.publicKey);

      mockApiFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ key: { wrapped_key: wrappedForUser } }),
      } as Response);

      const encrypted = await e2eeService.encryptForChannel('channel-1', 'Secret message');
      expect(typeof encrypted).toBe('string');
      expect(encrypted).not.toBe('Secret message');

      const decrypted = await e2eeService.decryptForChannel('channel-1', encrypted);
      expect(decrypted).toBe('Secret message');
    });
  });

  describe('invalidateChannelKey', () => {
    it('removes cached key for a channel', async () => {
      await e2eeService.initialize(
        testPassword,
        regKeys.wrappedPrivateKey,
        regKeys.keyDerivationSalt
      );

      const channelKey = await generateChannelKey();
      const wrappedForUser = await wrapChannelKey(channelKey, regKeys.publicKey);

      mockApiFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ key: { wrapped_key: wrappedForUser } }),
      } as Response);

      await e2eeService.getChannelKey('channel-1');
      expect(mockApiFetch).toHaveBeenCalledTimes(1);

      e2eeService.invalidateChannelKey('channel-1');

      // Should fetch again after invalidation
      await e2eeService.getChannelKey('channel-1');
      expect(mockApiFetch).toHaveBeenCalledTimes(2);
    });
  });
});
