import { render, screen, fireEvent, waitFor } from '../../../test-utils';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import SSOPassphraseSetup from '@/renderer/components/Auth/SSOPassphraseSetup';
import { useSSOStore } from '@/renderer/stores/ssoStore';
import { useAuthStore } from '@/renderer/stores/authStore';
import { resetAllStores } from '../../../helpers/store-helpers';

// Mock global fetch (matches Register.test.tsx pattern)
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock crypto utilities so the test does not actually run RSA-4096 keygen
vi.mock('@/renderer/utils/crypto', () => ({
  generateRegistrationKeys: vi.fn().mockResolvedValue({
    wrappedPrivateKey: 'bW9jay13cmFwcGVkLXByaXZhdGUta2V5', // pragma: allowlist secret
    keyDerivationSalt: 'bW9jay1zYWx0', // pragma: allowlist secret
    keyDerivationAlg: 'argon2id',
    publicKey: { __mockKey: 'public' },
    privateKey: { __mockKey: 'private' },
  }),
  exportPublicKey: vi.fn().mockResolvedValue('bW9jay1wdWJsaWMta2V5'), // pragma: allowlist secret
}));

beforeEach(() => {
  vi.clearAllMocks();
  resetAllStores();
  useSSOStore.getState().setState({
    phase: 'register_required',
    provider: 'google',
    ssoToken: 'tok-fake',
    email: 'new@example.test',
    name: 'New User',
  });
});

describe('SSOPassphraseSetup', () => {
  it('shows the email and asks for a passphrase', () => {
    render(<SSOPassphraseSetup />);
    expect(screen.getByText('new@example.test')).toBeInTheDocument();
    expect(screen.getByLabelText(/^passphrase$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/confirm passphrase/i)).toBeInTheDocument();
  });

  it('disables submit until passphrases match and meet strength', () => {
    render(<SSOPassphraseSetup />);
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: 'newcomer' } });

    fireEvent.change(screen.getByLabelText(/^passphrase$/i), { target: { value: 'short' } });
    expect(screen.getByRole('button', { name: /create account/i })).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/^passphrase$/i), {
      target: { value: 'StrongPassphrase!12345' },
    });
    fireEvent.change(screen.getByLabelText(/confirm passphrase/i), {
      target: { value: 'mismatch' },
    });
    expect(screen.getByRole('button', { name: /create account/i })).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/confirm passphrase/i), {
      target: { value: 'StrongPassphrase!12345' },
    });
    expect(screen.getByRole('button', { name: /create account/i })).toBeEnabled();
  });

  it('posts complete-registration with wrapped key material on submit', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: async () => ({ access_token: 'access-xyz' }),
      text: async () => JSON.stringify({ access_token: 'access-xyz' }),
    });

    render(<SSOPassphraseSetup />);
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: 'newcomer' } });
    fireEvent.change(screen.getByLabelText(/^passphrase$/i), {
      target: { value: 'StrongPassphrase!12345' },
    });
    fireEvent.change(screen.getByLabelText(/confirm passphrase/i), {
      target: { value: 'StrongPassphrase!12345' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toContain('/api/v1/auth/sso/google/complete-registration');
    expect(init?.method).toBe('POST');

    const body = JSON.parse(init.body as string);
    expect(body.sso_token).toBe('tok-fake');
    expect(body.username).toBe('newcomer');
    expect(body.password).toBe('StrongPassphrase!12345');
    // Mocked base64 strings
    expect(body.wrapped_private_key).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(body.public_key).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(body.key_derivation_salt).toMatch(/^[A-Za-z0-9+/=]+$/);

    await waitFor(() => {
      expect(useAuthStore.getState().accessToken).toBe('access-xyz');
    });
    expect(useSSOStore.getState().state.phase).toBe('idle');
  });

  it('renders nothing when phase is not register_required (defensive)', () => {
    useSSOStore.getState().reset();
    const { container } = render(<SSOPassphraseSetup />);
    expect(container).toBeEmptyDOMElement();
  });

  it('surfaces username_taken 409 with a friendly inline message', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      // ssoService now parses the body via safeJson, which requires a JSON
      // content-type header to succeed. Include it so the error_code reaches
      // the SSOPassphraseSetup mapper.
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: async () => ({ error_code: 'username_taken' }),
      text: async () => JSON.stringify({ error_code: 'username_taken' }),
    });

    render(<SSOPassphraseSetup />);
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: 'newcomer' } });
    fireEvent.change(screen.getByLabelText(/^passphrase$/i), {
      target: { value: 'StrongPassphrase!12345' },
    });
    fireEvent.change(screen.getByLabelText(/confirm passphrase/i), {
      target: { value: 'StrongPassphrase!12345' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => {
      expect(screen.getByText(/this username is already taken/i)).toBeInTheDocument();
    });
  });
});
