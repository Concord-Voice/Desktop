import type { BillingNotice } from '../../../stores/auth/billingStore';

// Marketing tier names + display copy for Account's Subscription section.
// The WIRE tier is 'free' | 'premium' (the entitlement contract); the USER sees
// the marketing names Sonic / Supersonic. This map is the single translation
// point — never render the raw wire tier in the UI.

// Wire tier → marketing display name. Unknown tiers never establish free access.
const TIER_DISPLAY_NAME: Record<string, string> = {
  free: 'Sonic',
  premium: 'Supersonic',
};

export function tierDisplayName(tier: string): string {
  return Object.hasOwn(TIER_DISPLAY_NAME, tier) ? TIER_DISPLAY_NAME[tier] : 'Plan unavailable';
}

// Wire subscription source → human sentence for the PlanCard "how you got this".
const SOURCE_DISPLAY: Record<string, string> = {
  code: 'Redeemed via code',
  stripe: 'Active subscription',
};

export function sourceDisplay(source: string | undefined): string | undefined {
  return source ? SOURCE_DISPLAY[source] : undefined;
}

// Format an RFC 3339 UTC expiry into a short human date. Returns undefined for a
// missing/unparseable value so the caller simply omits the "expires" line.
export function formatExpiry(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

// ── Paid plans (#2033 PR-4, spec §13) ────────────────────────────────────

// Sold plan id → display name. Both are user-axis plans; Wing pays for one
// Supersonic seat for the payer plus one for a friend.
const PLAN_DISPLAY_NAME: Record<string, string> = {
  supersonic: 'Supersonic',
  wing: 'Wing',
};

export function planDisplayName(plan: string | null | undefined): string | undefined {
  return plan && Object.hasOwn(PLAN_DISPLAY_NAME, plan) ? PLAN_DISPLAY_NAME[plan] : undefined;
}

export const PLAN_VALUE_LINE: Record<'supersonic' | 'wing', string> = {
  supersonic: 'All Supersonic features for your account.',
  wing: 'Supersonic for you and one friend you choose.',
};

// Format an integer amount in minor units (cents) for display. Prices arrive
// as integers and are formatted here, never on the server (spec R17).
export function formatPrice(minorUnits: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(minorUnits / 100);
}

// The founders price, matching the server's rounding: half the unit amount,
// rounded down to a whole cent, so the price shown never exceeds the charge.
export function foundersAmount(unitAmount: number): number {
  return Math.floor((unitAmount * 50) / 100);
}

export function intervalSuffix(interval: 'month' | 'year'): string {
  return interval === 'month' ? '/month' : '/year';
}

export const BILLING_COPY = {
  confirming: 'Confirming your subscription…',
  confirmingStalled:
    "We haven't received confirmation yet. If you were charged, your subscription will appear here shortly. You don't need to pay again.",
  activated: 'Your subscription is active.',
  checkAgain: 'Check again',
  shellTooOld: 'Update Concord to subscribe or manage billing.',
  selfHosted: 'Your server provides premium features.',
  manageHint: 'Change plan, update your card, or see invoices.',
  pastDueTitle: "Payment didn't go through",
  pastDueBody: "We'll keep trying, and you keep Supersonic meanwhile. Update your card to keep it.",
  foundersEnds: 'Your Founders rate ends with it.',
  foundersChip: 'Founders rate',
  foundersDiscount: '50% off while you stay subscribed. Canceling ends it.',
  renewsAutomatically: 'Renews automatically until you cancel.',
  stripePage: "You'll pay on Stripe's secure page. Concord never sees your card.",
  openingCheckout: 'Opening secure checkout…',
  openingPortal: 'Opening billing…',
  plansUnavailable: "Couldn't load plans.",
} as const;

export const BILLING_NOTICE_COPY: Record<BillingNotice, string> = {
  manage_existing: 'You already have a subscription.',
  checkout_failed: "Couldn't open checkout. Nothing was charged. Try again.",
  portal_failed: "Couldn't open billing. Try again.",
  rate_limited: 'Too many tries. Wait a few minutes, then try again.',
  offline: "You're offline. Reconnect to continue.",
  checkout_closed: 'Checkout closed. If you finished paying, this page updates on its own.',
  checkout_load_failed: "Couldn't load checkout. Check your connection and try again.",
  portal_load_failed: "Couldn't load billing. Check your connection and try again.",
};

export function codeOverlapNote(date: string | undefined): string {
  return date
    ? `Your code already covers Supersonic until ${date}. Subscribing starts billing today.`
    : 'Your code already covers Supersonic. Subscribing starts billing today.';
}

export function foundersTerms(date: string): string {
  return `Founders rate: 50% off for as long as you stay subscribed. If you cancel, you lose it. Available for subscriptions started before ${date}.`;
}

export function alsoFromCode(date: string | undefined): string {
  return date ? `Also Supersonic from a code until ${date}.` : 'Also Supersonic from a code.';
}
