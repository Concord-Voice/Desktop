import { z } from 'zod';
import { createStore } from '../../utils/runtime/createStore';
import { apiFetch, safeJson } from '../../services/system/apiClient';
import {
  captureAuthLifecycle,
  isSameAuthLifecycle,
} from '../../services/system/postLoginHydrationLifecycle';
import {
  openBillingSheet,
  type BillingKind,
  type BillingOutcome,
} from '../../services/system/billingLauncher';
import { useSubscriptionStore } from './subscriptionStore';

// Billing state for Settings ▸ Account ▸ Subscription (#2033 PR-4, spec §13).
//
// Holds the account's subscription read (`GET /subscriptions/me`), the plan
// catalog (`GET /billing/plans`), whether a purchase is being confirmed
// (`pending`, PlanCard state P6) and whether a hosted Stripe page is being
// opened (`opening`). Entitlement itself is never decided here: only the
// server grants, through a verified webhook, and the page reads the result.
//
// Every write that follows an `await` re-checks the auth lifecycle, so a
// response for the account that just signed out can never land in the next
// account's store. `resetService.gracefulReset` calls `reset()`.

const LIVE_STATUSES = ['active', 'trialing', 'past_due'] as const;

const StripeRowSchema = z.object({
  // Null on the wire when the Stripe price is not one Concord recognises.
  plan: z.enum(['supersonic', 'wing']).nullable().catch(null),
  interval: z.enum(['month', 'year']).nullable().catch(null),
  // The server only describes a live row here. A row in any other state fails
  // the whole read closed (the degraded-read page), never reads as live.
  status: z.enum(LIVE_STATUSES),
  current_period_end: z.string(),
  canceling: z.boolean(),
  ends_at: z.string().optional(),
  founders_rate: z.boolean(),
});

const MeSchema = z.object({
  tier: z.string(),
  status: z.string(),
  source: z.enum(['code', 'stripe']).optional().catch(undefined),
  current_period_end: z.string().optional(),
  // An older server sends no `billing`. Reading that as `not_configured` hides
  // every paid control, which is the page as it was before billing existed.
  billing: z.enum(['self_hosted', 'not_configured', 'available']).catch('not_configured'),
  trial_available: z.boolean().optional().catch(false),
  stripe: StripeRowSchema.optional(),
  code: z.object({ current_period_end: z.string().nullable() }).optional(),
});

const PlanPriceSchema = z.object({
  plan: z.enum(['supersonic', 'wing']),
  interval: z.enum(['month', 'year']),
  currency: z.literal('usd'),
  unit_amount: z.number().int().nonnegative(),
  founders_unit_amount: z.number().int().nonnegative().optional(),
});

const PlansSchema = z.object({
  purchase_available: z.boolean(),
  founders: z.object({ active: z.boolean(), ends_at: z.string().optional() }),
  // Entries this client does not know (a new plan, interval or currency) are
  // dropped rather than failing the catalog; all four known prices must remain.
  plans: z
    .array(z.unknown())
    .transform((rows) =>
      rows.flatMap((row) => {
        const parsed = PlanPriceSchema.safeParse(row);
        return parsed.success ? [parsed.data] : [];
      })
    )
    .refine(
      (rows) =>
        (['supersonic', 'wing'] as const).every((plan) =>
          (['month', 'year'] as const).every((interval) =>
            rows.some((r) => r.plan === plan && r.interval === interval)
          )
        ),
      'catalog is missing a known price'
    ),
});

const SessionUrlSchema = z.object({ url: z.string().min(1) });
const ErrorBodySchema = z.object({ error: z.string() });

export type BillingMe = z.infer<typeof MeSchema>;
export type StripeRow = z.infer<typeof StripeRowSchema>;
export type BillingPlans = z.infer<typeof PlansSchema>;
export type PlanPrice = z.infer<typeof PlanPriceSchema>;
export type PlanId = PlanPrice['plan'];
export type PlanInterval = PlanPrice['interval'];
export type PortalFlow = 'payment_method_update' | 'subscription_cancel';

/** Messages the page shows after a launcher outcome or a failed request. */
export type BillingNotice =
  | 'manage_existing'
  | 'checkout_failed'
  | 'portal_failed'
  | 'rate_limited'
  | 'offline'
  | 'checkout_closed'
  | 'checkout_load_failed'
  | 'portal_load_failed';

/** How long Confirming waits before its one silent refetch (spec §13 P6). */
export const CONFIRMING_STALL_MS = 45_000;
/** How long a Checkout or Portal session request may take (spec §13 error copy). */
export const SESSION_REQUEST_TIMEOUT_MS = 8_000;

interface BillingState {
  me: BillingMe | null;
  meError: boolean;
  plans: BillingPlans | null;
  plansLoading: boolean;
  plansError: boolean;
  /** A completed Checkout is waiting for the server to confirm it (P6). */
  pending: boolean;
  /** P6 has waited CONFIRMING_STALL_MS without a confirmation. */
  pendingStalled: boolean;
  /** Set once when P6 ends on a live Stripe row; cleared by the next action or on leaving the page. */
  activated: boolean;
  opening: BillingKind | null;
  notice: BillingNotice | null;
  fetchMe: () => Promise<void>;
  fetchPlans: () => Promise<void>;
  startCheckout: (plan: PlanId, interval: PlanInterval) => Promise<BillingOutcome | null>;
  openPortal: (flow?: PortalFlow) => Promise<BillingOutcome | null>;
  checkAgain: () => Promise<void>;
  /** Clears the one-shot activation and the last notice when the page closes. */
  dismissTransient: () => void;
  reset: () => void;
}

// A typed Pick, not `satisfies`: the CI Semgrep TypeScript parser rejects `satisfies`.
type BillingData = Pick<
  BillingState,
  | 'me'
  | 'meError'
  | 'plans'
  | 'plansLoading'
  | 'plansError'
  | 'pending'
  | 'pendingStalled'
  | 'activated'
  | 'opening'
  | 'notice'
>;

const INITIAL: BillingData = {
  me: null,
  meError: false,
  plans: null,
  plansLoading: false,
  plansError: false,
  pending: false,
  pendingStalled: false,
  activated: false,
  opening: null,
  notice: null,
};

// Each read takes a ticket and commits only while it is still the newest one,
// so an older response arriving last never replaces a newer one.
let meTicket = 0;
let plansTicket = 0;
// One Checkout or Portal launch at a time; reset() retires the one in flight.
let launchTicket = 0;
// Bumped whenever Confirming starts or ends, so a stale stall timer is inert.
let pendingTicket = 0;
let stallTimer: ReturnType<typeof setTimeout> | null = null;

function clearStallTimer(): void {
  if (stallTimer !== null) {
    clearTimeout(stallTimer);
    stallTimer = null;
  }
}

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

type SessionResult = { ok: true; url: string } | { ok: false; notice: BillingNotice };

async function readErrorCode(res: Response): Promise<string | null> {
  try {
    const parsed = ErrorBodySchema.safeParse(await safeJson<unknown>(res));
    return parsed.success ? parsed.data.error : null;
  } catch {
    return null;
  }
}

/**
 * POST a session request and return its hosted-page URL, or the notice to show.
 * Covers the spec's error table: 409 `manage_existing`, 429, and every other
 * failure (503, a network error, or the 8 s timeout) as the generic copy.
 */
async function requestSessionUrl(
  path: string,
  body: Record<string, string>,
  failed: BillingNotice
): Promise<SessionResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SESSION_REQUEST_TIMEOUT_MS);
  try {
    const res = await apiFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (res.ok) {
      const parsed = SessionUrlSchema.safeParse(await safeJson<unknown>(res));
      return parsed.success ? { ok: true, url: parsed.data.url } : { ok: false, notice: failed };
    }
    if (res.status === 429) return { ok: false, notice: 'rate_limited' };
    if (res.status === 409 && (await readErrorCode(res)) === 'manage_existing') {
      return { ok: false, notice: 'manage_existing' };
    }
    return { ok: false, notice: failed };
  } catch {
    return { ok: false, notice: failed };
  } finally {
    clearTimeout(timer);
  }
}

export const useBillingStore = createStore<BillingState>()((set, get) => {
  const enterConfirming = (): void => {
    clearStallTimer();
    const ticket = ++pendingTicket;
    set({ pending: true, pendingStalled: false, activated: false });
    stallTimer = setTimeout(() => {
      stallTimer = null;
      // Owned by the pending ticket alone: reset() bumps it on an account
      // change, and a same-account auth change must not drop the deadline.
      if (ticket !== pendingTicket) return;
      // The stalled copy shows at the deadline even if a read below hangs;
      // a read that finds the live row still ends Confirming.
      if (get().pending) set({ pendingStalled: true });
      void get().fetchMe();
      void useSubscriptionStore.getState().hydrate();
    }, CONFIRMING_STALL_MS);
    // One read now covers a confirmation that was pushed while the sheet was
    // still open, before Confirming started listening for it.
    void get().fetchMe();
  };

  const applyOutcome = (kind: BillingKind, outcome: BillingOutcome): void => {
    switch (outcome) {
      case 'success':
        if (kind === 'checkout') {
          enterConfirming();
        } else {
          void get().fetchMe();
        }
        return;
      case 'already_subscribed':
        set({ notice: 'manage_existing' });
        void get().fetchMe();
        return;
      case 'closed':
      case 'returned':
        if (kind === 'checkout') set({ notice: 'checkout_closed' });
        void get().fetchMe();
        return;
      case 'load_failed':
        set({ notice: kind === 'checkout' ? 'checkout_load_failed' : 'portal_load_failed' });
        return;
      case 'cancel':
      case 'busy':
        return;
    }
  };

  const launch = async (
    kind: BillingKind,
    path: string,
    body: Record<string, string>
  ): Promise<BillingOutcome | null> => {
    if (get().opening !== null) return null;
    const ticket = ++launchTicket;
    const lifecycle = captureAuthLifecycle();
    const current = (): boolean => ticket === launchTicket && isSameAuthLifecycle(lifecycle);
    set({ opening: kind, notice: null, activated: false });
    try {
      if (isOffline()) {
        set({ notice: 'offline' });
        return null;
      }
      const session = await requestSessionUrl(
        path,
        body,
        kind === 'checkout' ? 'checkout_failed' : 'portal_failed'
      );
      if (!current()) return null;
      if (!session.ok) {
        set({ notice: session.notice });
        if (session.notice === 'manage_existing') void get().fetchMe();
        return null;
      }
      const outcome = await openBillingSheet(kind, session.url);
      if (!current()) return null;
      applyOutcome(kind, outcome);
      return outcome;
    } finally {
      // Release on the ticket alone: reset() retires a launch by bumping it, and
      // a same-account generation advance (password change) must not strand it.
      if (ticket === launchTicket) set({ opening: null });
    }
  };

  return {
    ...INITIAL,

    fetchMe: async () => {
      const ticket = ++meTicket;
      const lifecycle = captureAuthLifecycle();
      const current = (): boolean => ticket === meTicket && isSameAuthLifecycle(lifecycle);
      set({ meError: false });
      try {
        const res = await apiFetch('/api/v1/subscriptions/me');
        if (!current()) return;
        if (!res.ok) throw new Error(`subscriptions/me ${res.status}`);
        const raw = await safeJson<unknown>(res);
        if (!current()) return;
        // A 200 is not proof of access when required fields are missing, so a
        // partial body fails closed rather than reading as the free plan.
        const me = MeSchema.parse(raw);
        // Confirming ends only on a live Stripe row; a push that carries an
        // unchanged tier (a buyer already covered by a code) does not end it.
        const confirmed = get().pending && me.stripe !== undefined;
        if (confirmed) {
          clearStallTimer();
          pendingTicket += 1;
          set({ me, meError: false, pending: false, pendingStalled: false, activated: true });
        } else {
          set({ me, meError: false });
        }
      } catch {
        if (current()) set({ meError: true });
      }
    },

    fetchPlans: async () => {
      if (get().plansLoading) return;
      const ticket = ++plansTicket;
      const lifecycle = captureAuthLifecycle();
      const current = (): boolean => ticket === plansTicket && isSameAuthLifecycle(lifecycle);
      set({ plansLoading: true, plansError: false });
      try {
        const res = await apiFetch('/api/v1/billing/plans');
        if (!current()) return;
        if (!res.ok) throw new Error(`billing/plans ${res.status}`);
        const raw = await safeJson<unknown>(res);
        if (!current()) return;
        set({ plans: PlansSchema.parse(raw), plansLoading: false, plansError: false });
      } catch {
        if (current()) set({ plansLoading: false, plansError: true });
      } finally {
        // The in-flight latch belongs to this ticket, not to the auth lifecycle.
        if (ticket === plansTicket && get().plansLoading) set({ plansLoading: false });
      }
    },

    startCheckout: (plan, interval) => {
      if (get().pending) return Promise.resolve(null);
      return launch('checkout', '/api/v1/billing/checkout-session', { plan, interval });
    },

    openPortal: (flow) => launch('portal', '/api/v1/billing/portal-session', flow ? { flow } : {}),

    checkAgain: () => get().fetchMe(),

    dismissTransient: () => set({ activated: false, notice: null }),

    reset: () => {
      meTicket += 1;
      plansTicket += 1;
      launchTicket += 1;
      pendingTicket += 1;
      clearStallTimer();
      set({ ...INITIAL });
    },
  };
});

/** The catalog entry for a plan and interval, when the catalog has loaded. */
export function findPlanPrice(
  plans: BillingPlans | null,
  plan: PlanId,
  interval: PlanInterval
): PlanPrice | undefined {
  return plans?.plans.find((p) => p.plan === plan && p.interval === interval);
}
