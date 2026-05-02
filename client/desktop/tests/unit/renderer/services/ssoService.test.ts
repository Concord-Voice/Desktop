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

  // ── Apple appleUserData threading (#271) ────────────────────────────────
  // The loopback resolves with an optional `appleUserData` string on Apple's
  // first authentication. ssoService threads it into the /callback POST
  // body as `apple_user_data` so the backend AppleProvider can parse the
  // user's first/last name JSON and persist a display-name suggestion. On
  // Apple subsequent auths and on Google's GET path, appleUserData is
  // undefined and the field MUST be omitted (not sent as null/empty) so
  // the Go backend's omitempty contract holds.

  it('threads appleUserData into /sso/apple/callback POST body when present', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    server.use(
      http.get(`${API_BASE}/api/v1/auth/sso/apple`, () =>
        HttpResponse.json({
          auth_url: 'https://appleid.apple.com/auth/authorize?state=apple-state',
          state: 'apple-state',
        })
      ),
      http.post(`${API_BASE}/api/v1/auth/sso/apple/callback`, async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ access_token: 'apple-token' });
      })
    );
    const userJson = '{"name":{"firstName":"Jane","lastName":"Doe"},"email":"jane@example.com"}';
    electron.sso.awaitCallback.mockResolvedValueOnce({
      code: 'apple-code',
      state: 'apple-state',
      appleUserData: userJson,
    });

    const result = await startSSOFlow('apple');
    expect(result.kind).toBe('logged_in');
    expect(capturedBody).not.toBeNull();
    expect(capturedBody).toMatchObject({
      code: 'apple-code',
      state: 'apple-state',
      apple_user_data: userJson,
    });
  });

  it('omits apple_user_data field on /callback POST body when loopback returned undefined', async () => {
    // Apple subsequent auth: the user field is absent on the second+ auth
    // for a Services ID (per spec §7.3 Scenario C). The renderer must NOT
    // include apple_user_data — the backend's omitempty contract relies on
    // missing field ≡ no first-auth name carriage.
    let capturedBody: Record<string, unknown> | null = null;
    server.use(
      http.get(`${API_BASE}/api/v1/auth/sso/apple`, () =>
        HttpResponse.json({
          auth_url: 'https://appleid.apple.com/auth/authorize?state=apple-state-2',
          state: 'apple-state-2',
        })
      ),
      http.post(`${API_BASE}/api/v1/auth/sso/apple/callback`, async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ access_token: 'apple-token-2' });
      })
    );
    electron.sso.awaitCallback.mockResolvedValueOnce({
      code: 'apple-code-2',
      state: 'apple-state-2',
      // no appleUserData field — subsequent-auth path
    });

    const result = await startSSOFlow('apple');
    expect(result.kind).toBe('logged_in');
    expect(capturedBody).not.toBeNull();
    expect(capturedBody).toMatchObject({
      code: 'apple-code-2',
      state: 'apple-state-2',
    });
    expect(capturedBody).not.toHaveProperty('apple_user_data');
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
