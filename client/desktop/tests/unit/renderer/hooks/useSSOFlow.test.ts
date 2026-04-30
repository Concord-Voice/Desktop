import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSSOFlow } from '@/renderer/hooks/useSSOFlow';
import { useSSOStore } from '@/renderer/stores/ssoStore';
import { useAuthStore } from '@/renderer/stores/authStore';
import { useE2EEStore } from '@/renderer/stores/e2eeStore';

// Mock the service so we drive the hook through every SSOResult shape
// without exercising the network or window.electron loopback.
vi.mock('@/renderer/services/ssoService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/renderer/services/ssoService')>();
  return {
    ...actual,
    startSSOFlow: vi.fn(),
  };
});

import { startSSOFlow } from '@/renderer/services/ssoService';
const mockedStartSSOFlow = startSSOFlow as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  // Reset stores between tests so phase transitions don't leak.
  useSSOStore.getState().reset();
  useAuthStore.getState().clearAccessToken();
  useE2EEStore.getState().reset();
  mockedStartSSOFlow.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useSSOFlow', () => {
  it('logged_in: sets access token and returns store to idle', async () => {
    mockedStartSSOFlow.mockResolvedValueOnce({
      kind: 'logged_in',
      accessToken: 'jwt-token-abc',
    });

    const { result } = renderHook(() => useSSOFlow());
    await act(async () => {
      await result.current.begin('google');
    });

    expect(useAuthStore.getState().accessToken).toBe('jwt-token-abc');
    expect(useSSOStore.getState().state).toEqual({ phase: 'idle' });
    expect(mockedStartSSOFlow).toHaveBeenCalledWith('google');
  });

  it('logged_in: arms the SSO eager-unlock gate (#270 Task 21b)', async () => {
    mockedStartSSOFlow.mockResolvedValueOnce({
      kind: 'logged_in',
      accessToken: 'jwt-token-abc',
    });
    expect(useE2EEStore.getState().needsSSOUnlock).toBe(false);

    const { result } = renderHook(() => useSSOFlow());
    await act(async () => {
      await result.current.begin('google');
    });

    // The SSO callback completed but no E2EE keys are unwrapped on this
    // device — the gate flag tells AuthenticatedLayout to mount
    // SSOEagerUnlock until e2eeService.initialize flips ready=true.
    expect(useE2EEStore.getState().needsSSOUnlock).toBe(true);
    expect(useE2EEStore.getState().ready).toBe(false);
  });

  it('register_required: dispatches register_required phase with ssoToken and email', async () => {
    mockedStartSSOFlow.mockResolvedValueOnce({
      kind: 'register_required',
      ssoToken: 'sso-tok-1',
      email: 'new@example.test',
      name: 'New User',
    });

    const { result } = renderHook(() => useSSOFlow());
    await act(async () => {
      await result.current.begin('google');
    });

    const state = useSSOStore.getState().state;
    expect(state.phase).toBe('register_required');
    if (state.phase === 'register_required') {
      expect(state.provider).toBe('google');
      expect(state.ssoToken).toBe('sso-tok-1');
      expect(state.email).toBe('new@example.test');
      expect(state.name).toBe('New User');
    }
    // No access token should be set yet — registration is incomplete.
    expect(useAuthStore.getState().accessToken).toBeNull();
  });

  it('link_available: dispatches link_required phase with maskedEmail', async () => {
    mockedStartSSOFlow.mockResolvedValueOnce({
      kind: 'link_available',
      ssoToken: 'sso-tok-2',
      maskedEmail: 'm***@example.test',
    });

    const { result } = renderHook(() => useSSOFlow());
    await act(async () => {
      await result.current.begin('google');
    });

    const state = useSSOStore.getState().state;
    expect(state.phase).toBe('link_required');
    if (state.phase === 'link_required') {
      expect(state.maskedEmail).toBe('m***@example.test');
      expect(state.ssoToken).toBe('sso-tok-2');
    }
  });

  it('mfa_required: dispatches mfa_required phase with challenge token', async () => {
    mockedStartSSOFlow.mockResolvedValueOnce({
      kind: 'mfa_required',
      mfaChallengeToken: 'mfa-chal-1',
    });

    const { result } = renderHook(() => useSSOFlow());
    await act(async () => {
      await result.current.begin('google');
    });

    const state = useSSOStore.getState().state;
    expect(state.phase).toBe('mfa_required');
    if (state.phase === 'mfa_required') {
      expect(state.mfaChallengeToken).toBe('mfa-chal-1');
    }
    expect(useAuthStore.getState().accessToken).toBeNull();
  });

  it('error: sets phase to error with message when service throws', async () => {
    mockedStartSSOFlow.mockRejectedValueOnce(new Error('oauth_state_mismatch'));

    const { result } = renderHook(() => useSSOFlow());
    await act(async () => {
      await result.current.begin('google');
    });

    const state = useSSOStore.getState().state;
    expect(state.phase).toBe('error');
    if (state.phase === 'error') {
      expect(state.message).toBe('oauth_state_mismatch');
    }
  });

  it('error: handles non-Error throws with default message', async () => {
    mockedStartSSOFlow.mockRejectedValueOnce('plain string');

    const { result } = renderHook(() => useSSOFlow());
    await act(async () => {
      await result.current.begin('google');
    });

    const state = useSSOStore.getState().state;
    expect(state.phase).toBe('error');
    if (state.phase === 'error') {
      expect(state.message).toBe('sso_failed');
    }
  });
});
