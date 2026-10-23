import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import { resetAllStores } from '../../helpers/store-helpers';
import { useAuthStore } from '@/renderer/stores/auth/authStore';
import { useSubscriptionStore } from '@/renderer/stores/auth/subscriptionStore';
import {
  CONFIRMING_STALL_MS,
  SESSION_REQUEST_TIMEOUT_MS,
  findPlanPrice,
  useBillingStore,
} from '@/renderer/stores/auth/billingStore';

const API = 'http://localhost:8080/api/v1';
const ME = `${API}/subscriptions/me`;
const PLANS = `${API}/billing/plans`;
const CHECKOUT = `${API}/billing/checkout-session`;
const PORTAL = `${API}/billing/portal-session`;
const ENTITLEMENTS = `${API}/entitlements`;
const SHEET_URL = 'https://pay.concordvoice.com/c/pay/cs_test_1';

const ME_FREE = { tier: 'free', status: 'none', billing: 'available' };
const STRIPE_LIVE = {
  plan: 'supersonic',
  interval: 'month',
  status: 'active',
  current_period_end: '2027-01-01T00:00:00Z',
  canceling: false,
  founders_rate: true,
};
const ME_ACTIVE = {
  tier: 'premium',
  status: 'active',
  source: 'stripe',
  current_period_end: '2027-01-01T00:00:00Z',
  billing: 'available',
  stripe: STRIPE_LIVE,
};
const CATALOG = {
  purchase_available: true,
  founders: { active: true, ends_at: '2027-05-01T00:00:00Z' },
  plans: [
    {
      plan: 'supersonic',
      interval: 'month',
      currency: 'usd',
      unit_amount: 899,
      founders_unit_amount: 449,
    },
    {
      plan: 'supersonic',
      interval: 'year',
      currency: 'usd',
      unit_amount: 9889,
      founders_unit_amount: 4944,
    },
    {
      plan: 'wing',
      interval: 'month',
      currency: 'usd',
      unit_amount: 1499,
      founders_unit_amount: 749,
    },
    {
      plan: 'wing',
      interval: 'year',
      currency: 'usd',
      unit_amount: 16489,
      founders_unit_amount: 8244,
    },
  ],
};

type Bridge = { openBilling?: unknown };
const bridge = (): Bridge => globalThis.electron as unknown as Bridge;

function mockSheet(result: string) {
  const open = vi.fn().mockResolvedValue({ result });
  bridge().openBilling = open;
  return open;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const billing = () => useBillingStore.getState();

beforeAll(() => server.listen({ onUnhandledFrame: 'bypass' }));
afterAll(() => server.close());
afterEach(() => {
  server.resetHandlers();
  delete bridge().openBilling;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  resetAllStores();
  useAuthStore.getState().setAccessToken('mock-token');
});

describe('billingStore fetchMe', () => {
  it('commits a valid subscription read', async () => {
    server.use(http.get(ME, () => HttpResponse.json(ME_ACTIVE)));
    await billing().fetchMe();
    expect(billing().me?.stripe?.plan).toBe('supersonic');
    expect(billing().me?.billing).toBe('available');
    expect(billing().meError).toBe(false);
  });

  it('reads a server that sends no billing mode as not configured', async () => {
    server.use(http.get(ME, () => HttpResponse.json({ tier: 'free', status: 'none' })));
    await billing().fetchMe();
    expect(billing().me?.billing).toBe('not_configured');
  });

  it('keeps an unrecognised Stripe plan as null rather than guessing', async () => {
    server.use(
      http.get(ME, () =>
        HttpResponse.json({
          ...ME_ACTIVE,
          stripe: { ...STRIPE_LIVE, plan: null, interval: 'week' },
        })
      )
    );
    await billing().fetchMe();
    expect(billing().me?.stripe?.plan).toBeNull();
    expect(billing().me?.stripe?.interval).toBeNull();
  });

  it.each([
    ['a partial body', { tier: 'free' }],
    [
      'a Stripe row that is not live',
      { ...ME_ACTIVE, stripe: { ...STRIPE_LIVE, status: 'canceled' } },
    ],
  ])('fails closed on %s', async (_label, body) => {
    server.use(http.get(ME, () => HttpResponse.json(body)));
    await billing().fetchMe();
    expect(billing().me).toBeNull();
    expect(billing().meError).toBe(true);
  });

  it('fails closed on an HTTP error', async () => {
    server.use(http.get(ME, () => new HttpResponse(null, { status: 503 })));
    await billing().fetchMe();
    expect(billing().meError).toBe(true);
  });

  it('never lets an older read replace a newer one', async () => {
    const first = deferred<void>();
    let calls = 0;
    server.use(
      http.get(ME, async () => {
        calls += 1;
        if (calls === 1) {
          await first.promise;
          return HttpResponse.json(ME_FREE);
        }
        return HttpResponse.json(ME_ACTIVE);
      })
    );
    const older = billing().fetchMe();
    await vi.waitFor(() => expect(calls).toBe(1));
    await billing().fetchMe();
    first.resolve();
    await older;
    expect(billing().me?.tier).toBe('premium');
  });

  it('discards a read that resolves after the account changed', async () => {
    server.use(
      http.get(ME, () => {
        useAuthStore.setState((s) => ({ authGeneration: s.authGeneration + 1 }));
        return HttpResponse.json(ME_ACTIVE);
      })
    );
    await billing().fetchMe();
    expect(billing().me).toBeNull();
    expect(billing().meError).toBe(false);
  });
});

describe('billingStore fetchPlans', () => {
  it('commits the catalog and finds a price', async () => {
    server.use(http.get(PLANS, () => HttpResponse.json(CATALOG)));
    await billing().fetchPlans();
    expect(billing().plans?.purchase_available).toBe(true);
    expect(findPlanPrice(billing().plans, 'wing', 'year')?.unit_amount).toBe(16489);
    expect(findPlanPrice(null, 'wing', 'year')).toBeUndefined();
  });

  it('treats a partial catalog as a failure, never as a smaller catalog', async () => {
    server.use(
      http.get(PLANS, () => HttpResponse.json({ ...CATALOG, plans: CATALOG.plans.slice(0, 3) }))
    );
    await billing().fetchPlans();
    expect(billing().plans).toBeNull();
    expect(billing().plansError).toBe(true);
  });

  it('drops entries it does not know and keeps the four it does', async () => {
    const extra = { plan: 'orbit', interval: 'month', currency: 'eur', unit_amount: 1 };
    server.use(
      http.get(PLANS, () => HttpResponse.json({ ...CATALOG, plans: [...CATALOG.plans, extra] }))
    );
    await billing().fetchPlans();
    expect(billing().plansError).toBe(false);
    expect(billing().plans?.plans).toHaveLength(4);
  });

  it('can read again after a same-account auth change lands mid-read', async () => {
    let calls = 0;
    server.use(
      http.get(PLANS, () => {
        calls += 1;
        if (calls === 1) useAuthStore.setState((s) => ({ authGeneration: s.authGeneration + 1 }));
        return HttpResponse.json(CATALOG);
      })
    );
    await billing().fetchPlans();
    expect(billing().plansLoading).toBe(false);
    await billing().fetchPlans();
    expect(calls).toBe(2);
    expect(billing().plans).not.toBeNull();
  });

  it('records catalog_unavailable as a failure', async () => {
    server.use(
      http.get(PLANS, () => HttpResponse.json({ error: 'catalog_unavailable' }, { status: 503 }))
    );
    await billing().fetchPlans();
    expect(billing().plansError).toBe(true);
    expect(billing().plansLoading).toBe(false);
  });

  it('does not start a second read while one is loading', async () => {
    const gate = deferred<void>();
    let calls = 0;
    server.use(
      http.get(PLANS, async () => {
        calls += 1;
        await gate.promise;
        return HttpResponse.json(CATALOG);
      })
    );
    const first = billing().fetchPlans();
    await billing().fetchPlans();
    gate.resolve();
    await first;
    expect(calls).toBe(1);
  });
});

describe('billingStore startCheckout', () => {
  it('sends the plan and interval, opens the sheet and enters Confirming on success', async () => {
    let body: unknown;
    server.use(
      http.post(CHECKOUT, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(
          { url: SHEET_URL, expires_at: '2026-10-23T12:35:00Z' },
          { status: 201 }
        );
      }),
      http.get(ME, () => HttpResponse.json(ME_FREE))
    );
    const open = mockSheet('success');
    const run = billing().startCheckout('wing', 'year');
    expect(billing().opening).toBe('checkout');
    await expect(run).resolves.toBe('success');
    expect(body).toEqual({ plan: 'wing', interval: 'year' });
    expect(open).toHaveBeenCalledWith({ kind: 'checkout', url: SHEET_URL });
    expect(billing().opening).toBeNull();
    expect(billing().pending).toBe(true);
    billing().reset();
  });

  it('ignores a second launch while one is opening', async () => {
    const gate = deferred<void>();
    server.use(
      http.post(CHECKOUT, async () => {
        await gate.promise;
        return HttpResponse.json({ url: SHEET_URL }, { status: 201 });
      })
    );
    mockSheet('cancel');
    const first = billing().startCheckout('supersonic', 'month');
    await expect(billing().startCheckout('wing', 'month')).resolves.toBeNull();
    await expect(billing().openPortal()).resolves.toBeNull();
    gate.resolve();
    await expect(first).resolves.toBe('cancel');
  });

  it('shows the manage copy and re-reads on 409 manage_existing', async () => {
    let meReads = 0;
    server.use(
      http.post(CHECKOUT, () => HttpResponse.json({ error: 'manage_existing' }, { status: 409 })),
      http.get(ME, () => {
        meReads += 1;
        return HttpResponse.json(ME_ACTIVE);
      })
    );
    const open = mockSheet('success');
    await expect(billing().startCheckout('supersonic', 'month')).resolves.toBeNull();
    expect(billing().notice).toBe('manage_existing');
    expect(open).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(meReads).toBe(1));
  });

  it.each([
    [429, {}, 'rate_limited'],
    [503, { error: 'purchase_unavailable' }, 'checkout_failed'],
    [409, { error: 'seat_member' }, 'checkout_failed'],
    [201, { nope: true }, 'checkout_failed'],
  ])('maps HTTP %s to the %s notice', async (status, payload, notice) => {
    server.use(http.post(CHECKOUT, () => HttpResponse.json(payload, { status: status as number })));
    await billing().startCheckout('supersonic', 'month');
    expect(billing().notice).toBe(notice);
    expect(billing().pending).toBe(false);
  });

  it('maps a network error to the generic copy', async () => {
    server.use(http.post(CHECKOUT, () => HttpResponse.error()));
    await billing().startCheckout('supersonic', 'month');
    expect(billing().notice).toBe('checkout_failed');
  });

  it('says so when offline and sends nothing', async () => {
    let calls = 0;
    server.use(
      http.post(CHECKOUT, () => {
        calls += 1;
        return HttpResponse.json({ url: SHEET_URL }, { status: 201 });
      })
    );
    vi.stubGlobal('navigator', { ...navigator, onLine: false });
    await billing().startCheckout('supersonic', 'month');
    expect(billing().notice).toBe('offline');
    expect(calls).toBe(0);
    expect(billing().opening).toBeNull();
  });

  it('gives up after the session request timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    server.use(
      http.post(CHECKOUT, async ({ request }) => {
        await new Promise((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
        return HttpResponse.json({ url: SHEET_URL }, { status: 201 });
      })
    );
    const run = billing().startCheckout('supersonic', 'month');
    await vi.advanceTimersByTimeAsync(SESSION_REQUEST_TIMEOUT_MS + 10);
    await run;
    expect(billing().notice).toBe('checkout_failed');
  });

  it.each([
    ['cancel', null],
    ['busy', null],
    ['load_failed', 'checkout_load_failed'],
    ['closed', 'checkout_closed'],
    ['returned', 'checkout_closed'],
    ['already_subscribed', 'manage_existing'],
  ])('handles the %s outcome', async (outcome, notice) => {
    let meReads = 0;
    server.use(
      http.post(CHECKOUT, () => HttpResponse.json({ url: SHEET_URL }, { status: 201 })),
      http.get(ME, () => {
        meReads += 1;
        return HttpResponse.json(ME_FREE);
      })
    );
    mockSheet(outcome);
    await billing().startCheckout('supersonic', 'month');
    expect(billing().notice).toBe(notice);
    expect(billing().pending).toBe(false);
    const refetches = ['closed', 'returned', 'already_subscribed'].includes(outcome) ? 1 : 0;
    await vi.waitFor(() => expect(meReads).toBe(refetches));
  });

  it('does not start Checkout while a purchase is still Confirming', async () => {
    useBillingStore.setState({ pending: true });
    await expect(billing().startCheckout('supersonic', 'month')).resolves.toBeNull();
    expect(billing().opening).toBeNull();
  });

  it('writes nothing when the account changes while the sheet is open', async () => {
    server.use(http.post(CHECKOUT, () => HttpResponse.json({ url: SHEET_URL }, { status: 201 })));
    bridge().openBilling = vi.fn().mockImplementation(async () => {
      useAuthStore.setState((s) => ({ authGeneration: s.authGeneration + 1 }));
      return { result: 'load_failed' };
    });
    await expect(billing().startCheckout('supersonic', 'month')).resolves.toBeNull();
    expect(billing().notice).toBeNull();
  });

  it('releases its busy latch after a same-account auth change (password change)', async () => {
    server.use(http.post(CHECKOUT, () => HttpResponse.json({ url: SHEET_URL }, { status: 201 })));
    bridge().openBilling = vi.fn().mockImplementation(async () => {
      useAuthStore.setState((s) => ({ authGeneration: s.authGeneration + 1 }));
      return { result: 'closed' };
    });
    await billing().startCheckout('supersonic', 'month');
    expect(billing().opening).toBeNull();
    const open = mockSheet('cancel');
    await billing().startCheckout('wing', 'year');
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('is retired by reset while in flight', async () => {
    const gate = deferred<void>();
    server.use(
      http.post(CHECKOUT, async () => {
        await gate.promise;
        return HttpResponse.json({ error: 'x' }, { status: 503 });
      })
    );
    const run = billing().startCheckout('supersonic', 'month');
    billing().reset();
    gate.resolve();
    await expect(run).resolves.toBeNull();
    expect(billing().notice).toBeNull();
    expect(billing().opening).toBeNull();
  });
});

describe('billingStore openPortal', () => {
  it('sends the deep-link flow and re-reads silently on return', async () => {
    let body: unknown;
    let meReads = 0;
    server.use(
      http.post(PORTAL, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ url: SHEET_URL }, { status: 201 });
      }),
      http.get(ME, () => {
        meReads += 1;
        return HttpResponse.json(ME_ACTIVE);
      })
    );
    const open = mockSheet('returned');
    await expect(billing().openPortal('subscription_cancel')).resolves.toBe('returned');
    expect(body).toEqual({ flow: 'subscription_cancel' });
    expect(open).toHaveBeenCalledWith({ kind: 'portal', url: SHEET_URL });
    expect(billing().notice).toBeNull();
    await vi.waitFor(() => expect(meReads).toBe(1));
  });

  it('opens the Portal home with an empty body and re-reads on success', async () => {
    let body: unknown;
    let meReads = 0;
    server.use(
      http.post(PORTAL, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ url: SHEET_URL }, { status: 201 });
      }),
      http.get(ME, () => {
        meReads += 1;
        return HttpResponse.json(ME_ACTIVE);
      })
    );
    mockSheet('success');
    await billing().openPortal();
    expect(body).toEqual({});
    expect(billing().pending).toBe(false);
    await vi.waitFor(() => expect(meReads).toBe(1));
  });

  it('shows no closed notice when the Portal is closed', async () => {
    let meReads = 0;
    server.use(
      http.post(PORTAL, () => HttpResponse.json({ url: SHEET_URL }, { status: 201 })),
      http.get(ME, () => {
        meReads += 1;
        return HttpResponse.json(ME_ACTIVE);
      })
    );
    mockSheet('closed');
    await billing().openPortal();
    expect(billing().notice).toBeNull();
    await vi.waitFor(() => expect(meReads).toBe(1));
  });

  it('reports a Portal that would not load or open', async () => {
    server.use(http.post(PORTAL, () => HttpResponse.json({ url: SHEET_URL }, { status: 201 })));
    mockSheet('load_failed');
    await billing().openPortal();
    expect(billing().notice).toBe('portal_load_failed');

    server.use(
      http.post(PORTAL, () => HttpResponse.json({ error: 'no_billing_account' }, { status: 404 }))
    );
    await billing().openPortal();
    expect(billing().notice).toBe('portal_failed');
  });
});

describe('billingStore dismissTransient', () => {
  it('clears the activation cue and the notice, and nothing else', () => {
    useBillingStore.setState({ activated: true, notice: 'checkout_failed', pending: true });
    billing().dismissTransient();
    expect(billing().activated).toBe(false);
    expect(billing().notice).toBeNull();
    expect(billing().pending).toBe(true);
  });
});

describe('billingStore Confirming (P6)', () => {
  it('waits silently, refetches once at 45 s, then shows the stalled state until Check again confirms', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let live = false;
    let meReads = 0;
    let entitlementReads = 0;
    server.use(
      http.post(CHECKOUT, () => HttpResponse.json({ url: SHEET_URL }, { status: 201 })),
      http.get(ME, () => {
        meReads += 1;
        return HttpResponse.json(live ? ME_ACTIVE : ME_FREE);
      }),
      http.get(ENTITLEMENTS, () => {
        entitlementReads += 1;
        return HttpResponse.json({ error: 'x' }, { status: 503 });
      })
    );
    mockSheet('success');
    await billing().startCheckout('supersonic', 'month');
    await vi.waitFor(() => expect(meReads).toBe(1));
    expect(billing().pending).toBe(true);
    expect(billing().pendingStalled).toBe(false);

    await vi.advanceTimersByTimeAsync(CONFIRMING_STALL_MS - 1000);
    expect(meReads).toBe(1);
    expect(billing().pendingStalled).toBe(false);

    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(billing().pendingStalled).toBe(true));
    expect(meReads).toBe(2);
    expect(entitlementReads).toBe(1);
    expect(billing().pending).toBe(true);

    await billing().checkAgain();
    expect(meReads).toBe(3);
    expect(billing().pending).toBe(true);

    live = true;
    await billing().checkAgain();
    expect(billing().pending).toBe(false);
    expect(billing().pendingStalled).toBe(false);
    expect(billing().activated).toBe(true);

    // Nothing else fires after the exit.
    await vi.advanceTimersByTimeAsync(CONFIRMING_STALL_MS * 2);
    expect(meReads).toBe(4);
  });

  it('exits before the stall when a read shows the live row, and never stalls afterwards', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    server.use(
      http.post(CHECKOUT, () => HttpResponse.json({ url: SHEET_URL }, { status: 201 })),
      http.get(ME, () => HttpResponse.json(ME_ACTIVE))
    );
    mockSheet('success');
    await billing().startCheckout('supersonic', 'month');
    await vi.waitFor(() => expect(billing().activated).toBe(true));
    expect(billing().pending).toBe(false);
    await vi.advanceTimersByTimeAsync(CONFIRMING_STALL_MS + 10);
    expect(billing().pendingStalled).toBe(false);
  });

  it('does not exit on a read that only shows a code grant', async () => {
    useBillingStore.setState({ pending: true });
    server.use(
      http.get(ME, () =>
        HttpResponse.json({
          tier: 'premium',
          status: 'active',
          source: 'code',
          billing: 'available',
          code: { current_period_end: '2027-02-01T00:00:00Z' },
        })
      )
    );
    await billing().fetchMe();
    expect(billing().pending).toBe(true);
    expect(billing().activated).toBe(false);
  });

  it('keeps the deadline across a same-account auth change (password change)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let meReads = 0;
    server.use(
      http.post(CHECKOUT, () => HttpResponse.json({ url: SHEET_URL }, { status: 201 })),
      http.get(ME, () => {
        meReads += 1;
        return HttpResponse.json(ME_FREE);
      }),
      http.get(ENTITLEMENTS, () => new Promise<never>(() => {}))
    );
    mockSheet('success');
    await billing().startCheckout('supersonic', 'month');
    await vi.waitFor(() => expect(meReads).toBe(1));
    useAuthStore.setState((s) => ({ authGeneration: s.authGeneration + 1 }));
    await vi.advanceTimersByTimeAsync(CONFIRMING_STALL_MS);
    expect(billing().pendingStalled).toBe(true);
  });

  it('shows the stalled state at the deadline even when the refetch hangs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let meReads = 0;
    server.use(
      http.post(CHECKOUT, () => HttpResponse.json({ url: SHEET_URL }, { status: 201 })),
      http.get(ME, () => {
        meReads += 1;
        // The read at the deadline never answers.
        return meReads === 1 ? HttpResponse.json(ME_FREE) : new Promise<never>(() => {});
      }),
      http.get(ENTITLEMENTS, () => new Promise<never>(() => {}))
    );
    mockSheet('success');
    await billing().startCheckout('supersonic', 'month');
    await vi.waitFor(() => expect(meReads).toBe(1));
    await vi.advanceTimersByTimeAsync(CONFIRMING_STALL_MS);
    expect(billing().pendingStalled).toBe(true);
    expect(billing().pending).toBe(true);
  });

  it('stops the stall timer on reset', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const hydrate = vi.spyOn(useSubscriptionStore.getState(), 'hydrate');
    server.use(
      http.post(CHECKOUT, () => HttpResponse.json({ url: SHEET_URL }, { status: 201 })),
      http.get(ME, () => HttpResponse.json(ME_FREE))
    );
    mockSheet('success');
    await billing().startCheckout('supersonic', 'month');
    billing().reset();
    await vi.advanceTimersByTimeAsync(CONFIRMING_STALL_MS + 10);
    expect(hydrate).not.toHaveBeenCalled();
    expect(billing().pending).toBe(false);
    expect(billing().pendingStalled).toBe(false);
  });
});
