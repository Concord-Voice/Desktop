import { act, render, screen, userEvent, waitFor, within } from '../../../test-utils';
import { afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import type { ComponentProps } from 'react';
import { server } from '../../../mocks/server';
import { resetAllStores } from '../../../helpers/store-helpers';
import { deferred } from '../../../helpers/deferred';
import PrivacySection from '@/renderer/components/Settings/PrivacySection';
import { useAuthStore } from '@/renderer/stores/auth/authStore';
import { useUserStore } from '@/renderer/stores/auth/userStore';
import { useClientConfigStore } from '@/renderer/stores/ui/clientConfigStore';
import { useServerStore } from '@/renderer/stores/chat/serverStore';

vi.mock('@/renderer/components/Settings/AccountErasureStepUpDialog', () => ({
  default: ({
    onResult,
    onStaleOwnedServers,
    onStaleEmailConfirmation,
    confirmedOwnedServerIds,
  }: {
    onResult: (result: { kind: 'erased' } | { kind: 'email_confirmation_required' }) => void;
    onStaleOwnedServers: () => void;
    onStaleEmailConfirmation: () => void;
    confirmedOwnedServerIds: string[];
  }) => (
    <div data-testid="account-erasure-dialog">
      <output data-testid="confirmed-owned-server-ids">{confirmedOwnedServerIds.join(',')}</output>
      <button type="button" onClick={() => onResult({ kind: 'email_confirmation_required' })}>
        Request confirmation
      </button>
      <button type="button" onClick={() => onResult({ kind: 'erased' })}>
        Complete erasure
      </button>
      <button type="button" onClick={onStaleOwnedServers}>
        Refresh affected servers
      </button>
      <button type="button" onClick={onStaleEmailConfirmation}>
        Reject stale email confirmation
      </button>
    </div>
  ),
}));

const API_BASE = 'http://localhost:8080/api/v1';
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterAll(() => server.close());
afterEach(() => server.resetHandlers());
afterEach(() => vi.useRealTimers());
beforeEach(() => {
  resetAllStores();
  useAuthStore.getState().setAccessToken('mock-token');
  useUserStore.setState({
    user: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', username: 'pilot' },
  });
  useClientConfigStore.getState().setActivityHistoryCapability({ status: 'confirmed-unsupported' });
  server.use(
    http.post(`${API_BASE}/klipy/customer-id`, () =>
      HttpResponse.json({ customer_id: 'mock-klipy-customer-id' })
    ),
    http.get(`${API_BASE}/friends`, () => HttpResponse.json({ friends: [] })),
    http.get(`${API_BASE}/users/me/privacy`, () => HttpResponse.json({ privacy: {} })),
    http.get(`${API_BASE}/users/me/presence-settings`, () =>
      HttpResponse.json({ custom_text_tier: 0, custom_text: '', custom_text_emoji: '' })
    ),
    http.get(
      `${API_BASE}/users/me/presence-history/settings`,
      () => new HttpResponse(null, { status: 404 })
    ),
    http.get(`${API_BASE}/users/me/presence-history`, () => new HttpResponse(null, { status: 404 }))
  );
});

it('groups privacy choices, Rich Presence and Activity History without credential or OS permission settings', async () => {
  render(<PrivacySection />);
  const privacy = document.getElementById('section-privacy-settings') as HTMLDetailsElement;
  expect(privacy).toBeInstanceOf(HTMLDetailsElement);
  await userEvent.setup().click(within(privacy).getByText('Privacy Controls'));
  expect(
    await screen.findByRole('switch', { name: /require authentication before purging/i })
  ).toBeInTheDocument();
  expect(document.getElementById('section-presence-settings')).toBeInstanceOf(HTMLDetailsElement);
  expect(document.getElementById('section-presence-history')).toBeInstanceOf(HTMLDetailsElement);
  expect(document.getElementById('section-password')).toBeNull();
  expect(document.getElementById('section-mfa')).toBeNull();
  expect(document.getElementById('section-active-sessions')).toBeNull();
  expect(document.getElementById('section-system-permissions')).toBeNull();
});

it('requires explicit acknowledgements for known multi-member owned servers before erasure', async () => {
  useServerStore.setState({
    servers: [
      {
        id: '00000000-0000-4000-8000-000000000002',
        name: 'Second server',
        owner_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        role: 'owner',
        member_count: 2,
        online_count: 0,
        allow_embedded_content: false,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
      {
        id: '00000000-0000-4000-8000-000000000001',
        name: 'First server',
        owner_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        role: 'owner',
        member_count: 3,
        online_count: 0,
        allow_embedded_content: false,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ],
  });
  render(<PrivacySection />);
  const danger = document.getElementById('section-account-erasure') as HTMLDetailsElement;
  await userEvent.setup().click(within(danger).getByText('Danger Zone'));
  const erase = within(danger).getByRole('button', { name: 'Erase account' });
  expect(erase).toBeDisabled();
  const acknowledgements = within(danger).getAllByRole('checkbox');
  expect(acknowledgements).toHaveLength(2);
  expect(acknowledgements[0]).not.toBeChecked();
  await userEvent.setup().click(acknowledgements[0]);
  expect(erase).toBeDisabled();
  await userEvent.setup().click(acknowledgements[1]);
  expect(erase).toBeEnabled();
  expect(within(danger).getByText(/direct-message conversations/i)).toBeInTheDocument();

  // The server store removes deleted servers while the pane remains mounted.
  act(() => useServerStore.setState({ servers: [] }));
  expect(within(danger).queryAllByRole('checkbox')).toHaveLength(0);
  expect(erase).toBeEnabled();
  await userEvent.setup().click(erase);
  expect(screen.getByTestId('confirmed-owned-server-ids')).toBeEmptyDOMElement();
});

it('loads owned servers before enabling restricted erasure', async () => {
  const response = deferred<HttpResponse>();
  server.use(http.get(`${API_BASE}/privacy/erase-account/owned-servers`, () => response.promise));
  render(<PrivacySection erasureOnly />);

  expect(document.getElementById('section-privacy-settings')).toBeNull();
  expect(document.getElementById('section-presence-settings')).toBeNull();
  const danger = document.getElementById('section-account-erasure') as HTMLDetailsElement;
  await userEvent.setup().click(within(danger).getByText('Danger Zone'));
  const erase = within(danger).getByRole('button', { name: 'Erase account' });
  expect(erase).toBeDisabled();

  await act(async () => {
    response.resolve(
      HttpResponse.json({
        servers: [
          {
            id: '00000000-0000-4000-8000-000000000001',
            name: 'Protected server',
            member_count: 2,
          },
        ],
      })
    );
    await response.promise;
  });

  const acknowledgement = await within(danger).findByRole('checkbox');
  expect(erase).toBeDisabled();
  await userEvent.setup().click(acknowledgement);
  expect(erase).toBeEnabled();
});

it('keeps restricted erasure blocked when the owned-server read fails, then retries', async () => {
  server.use(
    http.get(
      `${API_BASE}/privacy/erase-account/owned-servers`,
      () => new HttpResponse(null, { status: 503 })
    )
  );
  render(<PrivacySection erasureOnly />);
  const danger = document.getElementById('section-account-erasure') as HTMLDetailsElement;
  await userEvent.setup().click(within(danger).getByText('Danger Zone'));
  const erase = within(danger).getByRole('button', { name: 'Erase account' });

  expect(await within(danger).findByText(/Could not load owned servers/)).toBeInTheDocument();
  expect(erase).toBeDisabled();

  server.use(
    http.get(`${API_BASE}/privacy/erase-account/owned-servers`, () =>
      HttpResponse.json({ servers: [] })
    )
  );
  await userEvent.setup().click(within(danger).getByRole('button', { name: 'Retry' }));

  await waitFor(() => expect(erase).toBeEnabled());
});

it('loads the profile before restricted erasure after a restored session', async () => {
  useUserStore.setState({ user: null });
  const profile = deferred<HttpResponse>();
  server.use(
    http.get(`${API_BASE}/users/me`, () => profile.promise),
    http.get(`${API_BASE}/privacy/erase-account/owned-servers`, () =>
      HttpResponse.json({ servers: [] })
    )
  );
  render(<PrivacySection erasureOnly />);
  const danger = document.getElementById('section-account-erasure') as HTMLDetailsElement;
  await userEvent.setup().click(within(danger).getByText('Danger Zone'));
  const erase = within(danger).getByRole('button', { name: 'Erase account' });
  expect(erase).toBeDisabled();

  await act(async () => {
    profile.resolve(
      HttpResponse.json({
        user: {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          username: 'pilot',
          email_verified: false,
        },
      })
    );
    await profile.promise;
  });

  await waitFor(() => expect(erase).toBeEnabled());
});

async function openErasureDialog(
  props: ComponentProps<typeof PrivacySection> = {}
): Promise<ReturnType<typeof render>> {
  const result = render(<PrivacySection {...props} />);
  const danger = document.getElementById('section-account-erasure') as HTMLDetailsElement;
  await userEvent.setup().click(within(danger).getByText('Danger Zone'));
  await userEvent.setup().click(within(danger).getByRole('button', { name: /erase account/i }));
  await screen.findByTestId('account-erasure-dialog');
  return result;
}

it('clears a consumed email confirmation before requesting another link', async () => {
  const clear = vi.fn();
  await openErasureDialog({
    accountErasureConfirmation: {
      requestId: 'request-1',
      token: 'confirmation-token',
      expiresAt: Date.now() + 60_000,
    },
    onClearAccountErasureConfirmation: clear,
  });

  expect(await screen.findByRole('button', { name: 'Review and erase account' })).toBeEnabled();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Request confirmation' }));

  expect(clear).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Check your email for a confirmation link.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Erase account' })).toBeEnabled();
});

it('retains a restored-session confirmation through initial profile hydration', async () => {
  const clear = vi.fn();
  const confirmation = {
    requestId: 'request-1',
    token: 'confirmation-token',
    expiresAt: Date.now() + 60_000,
  };
  useUserStore.setState({ user: null, fetchUser: vi.fn().mockResolvedValue(undefined) });
  server.use(
    http.get(`${API_BASE}/privacy/erase-account/owned-servers`, () =>
      HttpResponse.json({ servers: [] })
    )
  );
  render(
    <PrivacySection
      erasureOnly
      accountErasureConfirmation={confirmation}
      onClearAccountErasureConfirmation={clear}
    />
  );
  expect(
    await screen.findByText(/Email confirmed\. Review your acknowledgements/)
  ).toBeInTheDocument();

  act(() =>
    useUserStore.setState({
      user: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', username: 'pilot' },
    })
  );

  expect(clear).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Review and erase account' })).toBeInTheDocument();
});

it('clears the confirmation and logs out after erasure succeeds', async () => {
  const clear = vi.fn();
  const logout = vi.fn().mockResolvedValue(undefined);
  useUserStore.setState({ logout });
  await openErasureDialog({
    accountErasureConfirmation: {
      requestId: 'request-1',
      token: 'confirmation-token',
      expiresAt: Date.now() + 60_000,
    },
    onClearAccountErasureConfirmation: clear,
  });

  await userEvent.setup().click(screen.getByRole('button', { name: 'Complete erasure' }));

  await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
  expect(clear).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId('account-erasure-dialog')).not.toBeInTheDocument();
});

it('discards an expired email confirmation and tells the user to start over', async () => {
  const clear = vi.fn();
  const result = render(
    <PrivacySection
      accountErasureConfirmation={{
        requestId: 'request-1',
        token: 'confirmation-token',
        expiresAt: Date.now() + 1_000,
      }}
      onClearAccountErasureConfirmation={clear}
    />
  );

  expect(
    await screen.findByText('Email confirmed. Review your acknowledgements and erase your account.')
  ).toBeInTheDocument();
  vi.useFakeTimers();
  result.rerender(
    <PrivacySection
      accountErasureConfirmation={{
        requestId: 'request-1',
        token: 'confirmation-token',
        expiresAt: Date.now() + 1_000,
      }}
      onClearAccountErasureConfirmation={clear}
    />
  );

  act(() => vi.advanceTimersByTime(1_000));

  expect(clear).toHaveBeenCalledTimes(1);
  expect(
    screen.getByText('The email confirmation expired. Start over to request another link.')
  ).toBeInTheDocument();
  const danger = document.getElementById('section-account-erasure') as HTMLDetailsElement;
  expect(within(danger).getByRole('button', { name: 'Erase account' })).toBeEnabled();
});

it('clears a confirmation and acknowledgements when the account changes', async () => {
  const clear = vi.fn();
  const result = await openErasureDialog({
    accountErasureConfirmation: {
      requestId: 'request-1',
      token: 'confirmation-token',
      expiresAt: Date.now() + 60_000,
    },
    onClearAccountErasureConfirmation: clear,
  });

  useUserStore.setState({
    user: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', username: 'second-pilot' },
  });
  result.rerender(
    <PrivacySection
      accountErasureConfirmation={{
        requestId: 'request-1',
        token: 'confirmation-token',
        expiresAt: Date.now() + 60_000,
      }}
      onClearAccountErasureConfirmation={clear}
    />
  );

  expect(clear).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Erase account' })).toBeEnabled();
});

it('drops the confirmation before refreshing a stale owned-server list', async () => {
  const clear = vi.fn();
  await openErasureDialog({
    accountErasureConfirmation: {
      requestId: 'request-1',
      token: 'confirmation-token',
      expiresAt: Date.now() + 60_000,
    },
    onClearAccountErasureConfirmation: clear,
  });

  await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh affected servers' }));

  expect(clear).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Erase account' })).toBeEnabled();
});

it('clears rejected email confirmation in the pane and its host', async () => {
  const clear = vi.fn();
  await openErasureDialog({
    accountErasureConfirmation: {
      requestId: 'request-1',
      token: 'stale-token',
      expiresAt: Date.now() + 60_000,
    },
    onClearAccountErasureConfirmation: clear,
  });

  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Reject stale email confirmation' }));

  expect(clear).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId('account-erasure-dialog')).not.toBeInTheDocument();
  expect(
    screen.getByText('The email confirmation expired. Start over to request another link.')
  ).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Erase account' })).toBeEnabled();
});
