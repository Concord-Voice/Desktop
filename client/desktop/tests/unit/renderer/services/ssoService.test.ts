import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../../mocks/server';
import {
  startSSOFlow,
  completeSSORegistration,
  completeSSOLink,
} from '@/renderer/services/ssoService';
import { useAuthStore } from '@/renderer/stores/authStore';

const API_BASE = 'http://localhost:8080';

interface ElectronSSO {
  startLoopback: ReturnType<typeof vi.fn>;
  awaitCallback: ReturnType<typeof vi.fn>;
  cancelLoopback: ReturnType<typeof vi.fn>;
  appleSignIn: ReturnType<typeof vi.fn>;
  appleCancel: ReturnType<typeof vi.fn>;
}

interface ElectronTestSurface {
  sso: ElectronSSO;
  openExternal: ReturnType<typeof vi.fn>;
}

function installElectronMock(): ElectronTestSurface {
  const surface: ElectronTestSurface = {
    sso: {
      startLoopback: vi
        .fn()
        .mockResolvedValue({ port: 65432, redirectURI: 'http://127.0.0.1:65432/oauth/callback' }),
      awaitCallback: vi.fn().mockResolvedValue({ code: 'fake-code', state: 'returned-state' }),
      cancelLoopback: vi.fn(),
      appleSignIn: vi.fn().mockResolvedValue({ kind: 'tokens', accessToken: 'apple-at' }),
      appleCancel: vi.fn(),
    },
    openExternal: vi.fn().mockResolvedValue({ ok: true }),
  };
  // setup.ts installs `window.electron` as writable but not configurable, so we
  // assign rather than redefine. Cast through `unknown` because the test surface
  // is intentionally narrower than the full ElectronAPI.
  (window as unknown as { electron: ElectronTestSurface }).electron = surface;
  return surface;
}

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

let electron: ElectronTestSurface;

beforeEach(() => {
  // The shared MSW server has handlers for /api/v1/auth/register etc. but no
  // SSO routes — we register them per-test via server.use().
  server.resetHandlers();
  // Auth token must be present for apiFetch to attach Authorization header.
  // The SSO start endpoint itself does not require auth, but apiFetch is shared.
  useAuthStore.getState().clearAccessToken();
  electron = installElectronMock();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('startSSOFlow', () => {
  it('returns logged_in for existing-SSO tokens response', async () => {
    server.use(
      http.get(`${API_BASE}/api/v1/auth/sso/google`, () =>
        HttpResponse.json({
          auth_url: 'https://accounts.google.com/o/oauth2/v2/auth?state=abc123',
          state: 'abc123',
        })
      ),
      http.post(`${API_BASE}/api/v1/auth/sso/google/callback`, () =>
        HttpResponse.json({ access_token: 'token-xyz' })
      )
    );
    electron.sso.awaitCallback.mockResolvedValueOnce({ code: 'good-code', state: 'abc123' });

    const result = await startSSOFlow('google');
    expect(result.kind).toBe('logged_in');
    if (result.kind === 'logged_in') {
      expect(result.accessToken).toBe('token-xyz');
    }
    expect(electron.openExternal).toHaveBeenCalledWith(
      'https://accounts.google.com/o/oauth2/v2/auth?state=abc123'
    );
    expect(electron.sso.cancelLoopback).toHaveBeenCalledWith(65432);
  });

  it('returns register_required when server says sso_registration_required', async () => {
    server.use(
      http.get(`${API_BASE}/api/v1/auth/sso/google`, () =>
        HttpResponse.json({
          auth_url: 'https://accounts.google.com/o/oauth2/v2/auth?state=s2',
          state: 's2',
        })
      ),
      http.post(`${API_BASE}/api/v1/auth/sso/google/callback`, () =>
        HttpResponse.json({
          sso_registration_required: true,
          sso_token: 'tok-1',
          email: 'new@example.test',
        })
      )
    );
    electron.sso.awaitCallback.mockResolvedValueOnce({ code: 'c', state: 's2' });

    const result = await startSSOFlow('google');
    expect(result.kind).toBe('register_required');
    if (result.kind === 'register_required') {
      expect(result.ssoToken).toBe('tok-1');
      expect(result.email).toBe('new@example.test');
    }
    expect(electron.sso.cancelLoopback).toHaveBeenCalledWith(65432);
  });

  it('throws on state mismatch and still cancels loopback', async () => {
    server.use(
      http.get(`${API_BASE}/api/v1/auth/sso/google`, () =>
        HttpResponse.json({ auth_url: 'https://accounts.google.com/x', state: 'expected' })
      )
    );
    electron.sso.awaitCallback.mockResolvedValueOnce({ code: 'c', state: 'wrong' });

    // State mismatch is a TypeError (shape/contract violation), not a generic Error.
    await expect(startSSOFlow('google')).rejects.toBeInstanceOf(TypeError);
    // Verify finally-block ran even on error path
    expect(electron.sso.cancelLoopback).toHaveBeenCalledWith(65432);
  });

  it('throws sso_start_failed_<status> when the start endpoint returns non-2xx', async () => {
    server.use(
      http.get(`${API_BASE}/api/v1/auth/sso/google`, () =>
        HttpResponse.json({ error_code: 'redis_unavailable' }, { status: 500 })
      )
    );

    await expect(startSSOFlow('google')).rejects.toThrow(/sso_start_failed_500/);
    // Loopback must still be cancelled even though the start step failed.
    expect(electron.sso.cancelLoopback).toHaveBeenCalledWith(65432);
  });

  it('throws sso_callback_failed_<status> when the callback endpoint returns non-2xx', async () => {
    server.use(
      http.get(`${API_BASE}/api/v1/auth/sso/google`, () =>
        HttpResponse.json({ auth_url: 'https://accounts.google.com/x', state: 's3' })
      ),
      http.post(`${API_BASE}/api/v1/auth/sso/google/callback`, () =>
        HttpResponse.json({ error_code: 'oauth_token_invalid' }, { status: 401 })
      )
    );
    electron.sso.awaitCallback.mockResolvedValueOnce({ code: 'c', state: 's3' });

    await expect(startSSOFlow('google')).rejects.toThrow(/sso_callback_failed_401/);
    expect(electron.sso.cancelLoopback).toHaveBeenCalledWith(65432);
  });

  it('returns mfa_required for mfa_challenge_token responses', async () => {
    server.use(
      http.get(`${API_BASE}/api/v1/auth/sso/google`, () =>
        HttpResponse.json({ auth_url: 'https://accounts.google.com/x', state: 's4' })
      ),
      http.post(`${API_BASE}/api/v1/auth/sso/google/callback`, () =>
        HttpResponse.json({ mfa_challenge_token: 'mfa-tok-1' })
      )
    );
    electron.sso.awaitCallback.mockResolvedValueOnce({ code: 'c', state: 's4' });

    const result = await startSSOFlow('google');
    expect(result.kind).toBe('mfa_required');
    if (result.kind === 'mfa_required') {
      expect(result.mfaChallengeToken).toBe('mfa-tok-1');
    }
  });

  it('returns link_available for account_link_available responses', async () => {
    server.use(
      http.get(`${API_BASE}/api/v1/auth/sso/google`, () =>
        HttpResponse.json({ auth_url: 'https://accounts.google.com/x', state: 's5' })
      ),
      http.post(`${API_BASE}/api/v1/auth/sso/google/callback`, () =>
        HttpResponse.json({
          account_link_available: true,
          sso_token: 'link-tok-1',
          masked_email: 'a***@example.test',
        })
      )
    );
    electron.sso.awaitCallback.mockResolvedValueOnce({ code: 'c', state: 's5' });

    const result = await startSSOFlow('google');
    expect(result.kind).toBe('link_available');
    if (result.kind === 'link_available') {
      expect(result.ssoToken).toBe('link-tok-1');
      expect(result.maskedEmail).toBe('a***@example.test');
    }
  });

  it('throws TypeError when register_required response is malformed (missing email)', async () => {
    server.use(
      http.get(`${API_BASE}/api/v1/auth/sso/google`, () =>
        HttpResponse.json({ auth_url: 'https://accounts.google.com/x', state: 's6' })
      ),
      http.post(`${API_BASE}/api/v1/auth/sso/google/callback`, () =>
        // sso_registration_required=true but email is missing — shape violation.
        HttpResponse.json({ sso_registration_required: true, sso_token: 'tok' })
      )
    );
    electron.sso.awaitCallback.mockResolvedValueOnce({ code: 'c', state: 's6' });

    await expect(startSSOFlow('google')).rejects.toBeInstanceOf(TypeError);
  });

  it('throws TypeError when link_available response is malformed (missing masked_email)', async () => {
    server.use(
      http.get(`${API_BASE}/api/v1/auth/sso/google`, () =>
        HttpResponse.json({ auth_url: 'https://accounts.google.com/x', state: 's7' })
      ),
      http.post(`${API_BASE}/api/v1/auth/sso/google/callback`, () =>
        // account_link_available=true but masked_email is missing — shape violation.
        HttpResponse.json({ account_link_available: true, sso_token: 'tok' })
      )
    );
    electron.sso.awaitCallback.mockResolvedValueOnce({ code: 'c', state: 's7' });

    await expect(startSSOFlow('google')).rejects.toBeInstanceOf(TypeError);
  });

  it('throws sso_response_unrecognized when the callback returns an unknown shape', async () => {
    server.use(
      http.get(`${API_BASE}/api/v1/auth/sso/google`, () =>
        HttpResponse.json({ auth_url: 'https://accounts.google.com/x', state: 's8' })
      ),
      http.post(`${API_BASE}/api/v1/auth/sso/google/callback`, () =>
        // No matching discriminator field — neither access_token, mfa, register, nor link.
        HttpResponse.json({ unexpected_field: true })
      )
    );
    electron.sso.awaitCallback.mockResolvedValueOnce({ code: 'c', state: 's8' });

    await expect(startSSOFlow('google')).rejects.toThrow(/sso_response_unrecognized/);
  });

  // ── Apple — main-driven flow (#974) ─────────────────────────────────────
  // The renderer no longer drives loopback/callback for apple: one IPC
  // invoke returns the discriminated AppleSignInResult, which maps onto the
  // existing SSOResult union. appleUserData threading is covered by the
  // main-process appleFlow suite; the server-side parse by the Go
  // AppleSession matrix.

  describe('startSSOFlow — apple (#974 main-driven)', () => {
    it('maps tokens → logged_in without touching the loopback IPC trio', async () => {
      const result = await startSSOFlow('apple');
      expect(result).toEqual({ kind: 'logged_in', accessToken: 'apple-at' });
      expect(electron.sso.appleSignIn).toHaveBeenCalledTimes(1);
      expect(electron.sso.startLoopback).not.toHaveBeenCalled();
      expect(electron.sso.awaitCallback).not.toHaveBeenCalled();
      expect(electron.openExternal).not.toHaveBeenCalled();
    });

    it('maps mfa_challenge → mfa_required with method passthrough', async () => {
      electron.sso.appleSignIn.mockResolvedValueOnce({
        kind: 'mfa_challenge',
        mfaChallengeToken: 'mfa-1',
        methods: ['totp'],
        recoveryOnlyMethods: ['backup_code'],
        webauthnOptions: { rpId: 'x' },
      });
      const result = await startSSOFlow('apple');
      expect(result).toEqual({
        kind: 'mfa_required',
        mfaChallengeToken: 'mfa-1',
        methods: ['totp'],
        recoveryOnlyMethods: ['backup_code'],
        webauthnOptions: { rpId: 'x' },
      });
    });

    it('maps sso_token/new_user → register_required', async () => {
      electron.sso.appleSignIn.mockResolvedValueOnce({
        kind: 'sso_token',
        branch: 'new_user',
        ssoToken: 'tok-n',
        email: 'new@example.test',
        name: 'Jane Doe',
      });
      const result = await startSSOFlow('apple');
      expect(result).toEqual({
        kind: 'register_required',
        ssoToken: 'tok-n',
        email: 'new@example.test',
        name: 'Jane Doe',
      });
    });

    it('maps sso_token/account_link → link_available', async () => {
      electron.sso.appleSignIn.mockResolvedValueOnce({
        kind: 'sso_token',
        branch: 'account_link',
        ssoToken: 'tok-l',
        maskedEmail: 'j***@example.test',
      });
      const result = await startSSOFlow('apple');
      expect(result).toEqual({
        kind: 'link_available',
        ssoToken: 'tok-l',
        maskedEmail: 'j***@example.test',
      });
    });

    it('throws the stable taxonomy code on the error kind', async () => {
      electron.sso.appleSignIn.mockResolvedValueOnce({
        kind: 'error',
        code: 'apple_id_token_invalid',
      });
      await expect(startSSOFlow('apple')).rejects.toThrow('apple_id_token_invalid');
    });
  });

  it('never includes apple_user_data on Google /callback POST body (regression)', async () => {
    // Defense in depth: even if the loopback IPC erroneously surfaced an
    // appleUserData field on a Google flow, the service must still gate
    // inclusion on provider === 'apple' OR on the field's presence. We
    // assert the simpler contract: a loopback resolution without
    // appleUserData yields no apple_user_data on the wire, on either
    // provider. (Loopback POST is only reachable for Apple in practice
    // because Google uses GET, but the renderer treats provider as
    // an opaque label.)
    let capturedBody: Record<string, unknown> | null = null;
    server.use(
      http.get(`${API_BASE}/api/v1/auth/sso/google`, () =>
        HttpResponse.json({ auth_url: 'https://accounts.google.com/x', state: 'g-state' })
      ),
      http.post(`${API_BASE}/api/v1/auth/sso/google/callback`, async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ access_token: 'google-token' });
      })
    );
    electron.sso.awaitCallback.mockResolvedValueOnce({
      code: 'g-code',
      state: 'g-state',
    });

    await startSSOFlow('google');
    expect(capturedBody).not.toBeNull();
    expect(capturedBody).not.toHaveProperty('apple_user_data');
  });
});

describe('completeSSORegistration', () => {
  it('returns an access token on 2xx', async () => {
    server.use(
      http.post(`${API_BASE}/api/v1/auth/sso/google/complete-registration`, () =>
        HttpResponse.json({ access_token: 'reg-token-1' }, { status: 201 })
      )
    );

    const { accessToken } = await completeSSORegistration({
      provider: 'google',
      ssoToken: 'tok',
      username: 'newuser',
      passphrase: 'StrongPassphrase123!', // pragma: allowlist secret
      wrappedPrivateKey: 'd3JhcHBlZA==', // pragma: allowlist secret
      keyDerivationSalt: 'c2FsdA==',
      publicKey: 'cHViLWtleQ==',
    });

    expect(accessToken).toBe('reg-token-1');
  });

  it('throws sso_complete_registration_failed_<status> on non-2xx', async () => {
    server.use(
      http.post(`${API_BASE}/api/v1/auth/sso/google/complete-registration`, () =>
        HttpResponse.json({ error_code: 'username_taken' }, { status: 409 })
      )
    );

    await expect(
      completeSSORegistration({
        provider: 'google',
        ssoToken: 'tok',
        username: 'taken',
        passphrase: 'StrongPassphrase123!', // pragma: allowlist secret
        wrappedPrivateKey: 'd3JhcHBlZA==', // pragma: allowlist secret
        keyDerivationSalt: 'c2FsdA==',
        publicKey: 'cHViLWtleQ==',
      })
    ).rejects.toThrow(/sso_complete_registration_failed_409/);
  });
});

describe('completeSSOLink', () => {
  it('returns an access token on 2xx', async () => {
    server.use(
      http.post(`${API_BASE}/api/v1/auth/sso/google/complete-link`, () =>
        HttpResponse.json({ access_token: 'link-token-1' })
      )
    );

    const { accessToken } = await completeSSOLink({
      provider: 'google',
      ssoToken: 'link-tok',
      password: 'CorrectPW!', // pragma: allowlist secret
    });

    expect(accessToken).toBe('link-token-1');
  });

  it('throws sso_complete_link_failed_<status> on non-2xx', async () => {
    server.use(
      http.post(`${API_BASE}/api/v1/auth/sso/google/complete-link`, () =>
        HttpResponse.json({ error_code: 'invalid_credentials' }, { status: 401 })
      )
    );

    await expect(
      completeSSOLink({
        provider: 'google',
        ssoToken: 'link-tok',
        password: 'wrong', // pragma: allowlist secret
      })
    ).rejects.toThrow(/sso_complete_link_failed_401/);
  });
});
