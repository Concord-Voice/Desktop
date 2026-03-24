import { useMFAChallengeStore } from '@/renderer/stores/mfaChallengeStore';
import { resetAllStores } from '../../helpers/store-helpers';

beforeEach(() => {
  resetAllStores();
});

describe('mfaChallengeStore', () => {
  it('starts with no challenge', () => {
    const state = useMFAChallengeStore.getState();
    expect(state.challengeToken).toBeNull();
    expect(state.methods).toEqual([]);
    expect(state.recoveryOnlyMethods).toEqual([]);
    expect(state.purpose).toBeNull();
    expect(state.resolve).toBeNull();
  });

  it('showChallenge resolves true on completeChallenge(true)', async () => {
    const promise = useMFAChallengeStore
      .getState()
      .showChallenge('token-1', ['totp', 'webauthn'], 'suspicious_refresh');

    const state = useMFAChallengeStore.getState();
    expect(state.challengeToken).toBe('token-1');
    expect(state.methods).toEqual(['totp', 'webauthn']);
    expect(state.purpose).toBe('suspicious_refresh');
    expect(state.resolve).not.toBeNull();

    useMFAChallengeStore.getState().completeChallenge(true);

    const result = await promise;
    expect(result).toBe(true);

    // State should be cleared
    const cleared = useMFAChallengeStore.getState();
    expect(cleared.challengeToken).toBeNull();
    expect(cleared.methods).toEqual([]);
    expect(cleared.resolve).toBeNull();
  });

  it('showChallenge resolves false on completeChallenge(false)', async () => {
    const promise = useMFAChallengeStore
      .getState()
      .showChallenge('token-2', ['totp'], 'suspicious_refresh');

    useMFAChallengeStore.getState().completeChallenge(false);

    const result = await promise;
    expect(result).toBe(false);
  });

  it('clearChallenge resolves false (rejects challenge)', async () => {
    const promise = useMFAChallengeStore
      .getState()
      .showChallenge('token-3', ['totp'], 'suspicious_refresh');

    useMFAChallengeStore.getState().clearChallenge();

    const result = await promise;
    expect(result).toBe(false);

    const state = useMFAChallengeStore.getState();
    expect(state.challengeToken).toBeNull();
  });

  it('handles recoveryOnlyMethods', async () => {
    const promise = useMFAChallengeStore
      .getState()
      .showChallenge('token-4', ['totp', 'recovery'], 'suspicious_refresh', ['recovery']);

    const state = useMFAChallengeStore.getState();
    expect(state.recoveryOnlyMethods).toEqual(['recovery']);

    useMFAChallengeStore.getState().completeChallenge(true);
    await promise;
  });
});
