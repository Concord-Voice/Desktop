import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
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

function renderDialog(overrides: Partial<ComponentProps<typeof AccountErasureStepUpDialog>> = {}) {
  render(
    <AccountErasureStepUpDialog
      confirmedOwnedServerIds={[]}
      emailConfirmation={null}
      onResult={onResult}
      onStaleOwnedServers={onStaleOwnedServers}
      onClose={onClose}
      {...overrides}
    />
  );
}

async function submitErasure() {
  await userEvent.type(await screen.findByLabelText('Password'), 'password');
  await userEvent.type(await screen.findByLabelText('Authenticator app code'), '123456');
  await userEvent.click(screen.getByRole('button', { name: 'Erase account' }));
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

    await submitErasure();
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

  it.each([
    [429, 'step_up_budget_exhausted', 'Too many attempts. Wait before trying again.'],
    [503, 'step_up_budget_unavailable', 'Verification is temporarily unavailable. Try again.'],
    [
      409,
      'owned_server_confirmation_stale',
      'Your owned-server list changed. Review every acknowledgement again.',
    ],
  ])('shows the erasure refusal for HTTP %i', async (status, errorCode, message) => {
    server.use(
      http.post(`${API_BASE}/privacy/erase-account`, () =>
        HttpResponse.json({ error_code: errorCode }, { status })
      )
    );
    renderDialog();

    await submitErasure();

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(onStaleOwnedServers).toHaveBeenCalledTimes(
      errorCode === 'owned_server_confirmation_stale' ? 1 : 0
    );
  });

  it('leaves a factor refusal to the credential stage', async () => {
    const answered = deferred<void>();
    server.use(
      http.post(`${API_BASE}/privacy/erase-account`, () => {
        answered.resolve();
        return HttpResponse.json({ error_code: 'invalid_factor' }, { status: 403 });
      })
    );
    renderDialog();

    await submitErasure();
    await answered.promise;

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(onResult).not.toHaveBeenCalled();
    expect(onStaleOwnedServers).not.toHaveBeenCalled();
  });

  it('sends the current factor, confirmations, and email capability without retaining it', async () => {
    const confirmation = { requestId: 'request-1', token: 'secret-capability' };
    const received = deferred<unknown>();
    server.use(
      http.post(`${API_BASE}/privacy/erase-account`, async ({ request }) => {
        received.resolve(await request.json());
        return new HttpResponse(null, { status: 204 });
      })
    );
    renderDialog({
      confirmedOwnedServerIds: ['server-a'],
      emailConfirmation: confirmation,
    });

    await submitErasure();

    await expect(received.promise).resolves.toEqual({
      password: 'password',
      mfa_code: '123456',
      confirmed_owned_server_ids: ['server-a'],
      email_confirmation: { request_id: 'request-1', token: 'secret-capability' },
    });
    expect(onResult).toHaveBeenCalledWith({ kind: 'erased' });
  });
});
