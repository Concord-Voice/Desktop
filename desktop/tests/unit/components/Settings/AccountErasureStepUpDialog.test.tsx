import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, userEvent } from '../../../test-utils';
import { deferred } from '../../../helpers/deferred';
import { server } from '../../../mocks/server';
import { resetAllStores } from '../../../helpers/store-helpers';
import { http, HttpResponse } from 'msw';
import AccountErasureStepUpDialog from '@/renderer/components/Settings/AccountErasureStepUpDialog';
import { useAuthStore } from '@/renderer/stores/auth/authStore';
import { useUserStore } from '@/renderer/stores/auth/userStore';

const API_BASE = 'http://localhost:8080/api/v1';
const onResult = vi.fn();
const onStaleOwnedServers = vi.fn();
const onClose = vi.fn();

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterAll(() => server.close());
afterEach(() => server.resetHandlers());

beforeEach(() => {
  resetAllStores();
  vi.clearAllMocks();
  useAuthStore.getState().setAccessToken('mock-token');
  useUserStore.setState({
    user: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', username: 'pilot' },
  });
  server.use(
    http.get(`${API_BASE}/mfa/step-up`, () =>
      HttpResponse.json({ methods: ['totp'], default_method: 'totp', backup_code_available: false })
    )
  );
});

function renderDialog() {
  render(
    <AccountErasureStepUpDialog
      confirmedOwnedServerIds={[]}
      emailConfirmation={null}
      onResult={onResult}
      onStaleOwnedServers={onStaleOwnedServers}
      onClose={onClose}
    />
  );
}

describe('AccountErasureStepUpDialog', () => {
  // Mutant: dropping the post-await context fence lets a stale response clear
  // the successor account's owned-server acknowledgements.
  it('drops a stale owned-server refusal after an account switch', async () => {
    const started = deferred<void>();
    const response = deferred<HttpResponse>();
    server.use(
      http.post(`${API_BASE}/privacy/erase-account`, async () => {
        started.resolve();
        return response.promise;
      })
    );
    renderDialog();

    await userEvent.type(await screen.findByLabelText('Password'), 'password');
    await userEvent.type(await screen.findByLabelText('Authenticator app code'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Erase account' }));
    await started.promise;

    useAuthStore.setState({ authGeneration: useAuthStore.getState().authGeneration + 1 });
    await act(async () => {
      response.resolve(
        HttpResponse.json({ error_code: 'owned_server_confirmation_stale' }, { status: 409 })
      );
      await response.promise;
    });

    expect(await screen.findByText('Sign in again to continue.')).toBeInTheDocument();
    expect(onStaleOwnedServers).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
    expect(screen.queryByText(/owned-server list changed/i)).not.toBeInTheDocument();
  });
});
