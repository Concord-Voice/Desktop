import React, { useEffect, useRef, useState } from 'react';
import {
  CalendarClock,
  CircleCheck,
  Clock,
  CreditCard,
  LoaderCircle,
  Ticket,
  type LucideIcon,
} from 'lucide-react';
import type { SubscriptionInfo } from '../../../hooks/ui/useSubscription';
import { useSubscriptionStore } from '../../../stores/auth/subscriptionStore';
import {
  findPlanPrice,
  useBillingStore,
  type PortalFlow,
  type StripeRow,
} from '../../../stores/auth/billingStore';
import { isBillingLauncherAvailable } from '../../../services/system/billingLauncher';
import {
  BILLING_COPY,
  alsoFromCode,
  formatExpiry,
  formatPrice,
  foundersAmount,
  intervalSuffix,
  planDisplayName,
  sourceDisplay,
  tierDisplayName,
} from './subscriptionCopy';

// The plan card at the top of Settings ▸ Account ▸ Subscription (#1304, with the
// Stripe states of #2033 PR-4, spec §13). Every state names itself with a glyph
// AND a word, never a glyph or a colour alone:
//   P0 loading · P1 free · P2 code · P3 active · P4 canceling · P5 past due ·
//   trialing ·
//   P6 confirming · P8 shell too old · P10 degraded read · P12 self-hosted.
// The headline is the Stripe row when there is one, then the code; a code that
// also runs under a subscription shows as a second line.

interface PlanCardProps {
  info: SubscriptionInfo;
}

const STATUS_DISPLAY: Record<string, string> = {
  active: 'Active',
  trialing: 'Trial',
  past_due: 'Payment past due',
  canceled: 'Canceled',
  expired: 'Expired',
};

interface StateWordProps {
  icon?: LucideIcon;
  children: React.ReactNode;
}

const StateWord: React.FC<StateWordProps> = ({ icon: Icon, children }) => (
  <span className="subscription-plan-state">
    {Icon && <Icon size={16} className="subscription-plan-state-icon" aria-hidden="true" />}
    {children}
  </span>
);

interface PlanHeaderProps {
  name: string;
  children: React.ReactNode;
}

const PlanHeader: React.FC<PlanHeaderProps> = ({ name, children }) => (
  <div className="subscription-plan-header">
    <h3 className="subscription-plan-name">{name}</h3>
    {children}
  </div>
);

function stripePriceLine(
  stripe: StripeRow,
  price: ReturnType<typeof findPlanPrice>,
  renews: string | undefined
): string | undefined {
  const renewal = renews ? `Renews ${renews}.` : undefined;
  if (!price || !stripe.interval) return renewal;
  const amount = stripe.founders_rate ? foundersAmount(price.unit_amount) : price.unit_amount;
  const charge = `${formatPrice(amount, price.currency)}${intervalSuffix(stripe.interval)}.`;
  return renewal ? `${charge} ${renewal}` : charge;
}

const PlanCard: React.FC<PlanCardProps> = ({ info }) => {
  const entitlementHydrated = useSubscriptionStore((s) => s.hydrated);
  const entitlementTier = useSubscriptionStore((s) => s.entitlement.tier);
  const pending = useBillingStore((s) => s.pending);
  const pendingStalled = useBillingStore((s) => s.pendingStalled);
  const activated = useBillingStore((s) => s.activated);
  const opening = useBillingStore((s) => s.opening);
  const plans = useBillingStore((s) => s.plans);
  const openPortal = useBillingStore((s) => s.openPortal);
  const checkAgain = useBillingStore((s) => s.checkAgain);
  const manageRef = useRef<HTMLButtonElement>(null);
  const [clicked, setClicked] = useState<string | null>(null);

  // When Confirming ends, the picker unmounts. Focus that was inside it falls to
  // <body>; move it to Manage. Focus the user put anywhere else stays put.
  useEffect(() => {
    if (!activated) return;
    const active = document.activeElement;
    if (active === null || active === document.body) manageRef.current?.focus();
  }, [activated]);

  const bridge = isBillingLauncherAvailable();
  const paidControls = info.billing === 'available' && bridge;
  const shellTooOld =
    info.billing === 'available' &&
    !bridge &&
    (info.stripe !== undefined || plans?.purchase_available === true);

  const launchPortal = async (
    key: string,
    flow: PortalFlow | undefined,
    e: React.MouseEvent<HTMLButtonElement>
  ): Promise<void> => {
    if (opening !== null) return;
    const trigger = e.currentTarget;
    setClicked(key);
    await openPortal(flow);
    setClicked(null);
    // The sheet hands focus back to the window; put it back on the trigger.
    if (trigger.isConnected) trigger.focus();
  };

  const portalButton = (
    key: string,
    label: string,
    flow: PortalFlow | undefined,
    className: string,
    ref?: React.Ref<HTMLButtonElement>
  ): React.ReactNode => (
    <button
      type="button"
      ref={ref}
      className={className}
      aria-disabled={opening !== null}
      onClick={(e) => {
        void launchPortal(key, flow, e);
      }}
    >
      {opening === 'portal' && clicked === key ? BILLING_COPY.openingPortal : label}
    </button>
  );

  const knownTier = info.tier === 'free' || info.tier === 'premium';
  let stateLabel: string | undefined;
  if (info.tier === 'free' && info.status === 'none') {
    stateLabel = 'Free plan';
  } else if (knownTier && Object.hasOwn(STATUS_DISPLAY, info.status)) {
    stateLabel = STATUS_DISPLAY[info.status];
  }

  const shellNote = shellTooOld ? (
    <p className="subscription-plan-blurb">{BILLING_COPY.shellTooOld}</p>
  ) : null;

  const renderStripe = (stripe: StripeRow): React.ReactNode => {
    const name = planDisplayName(stripe.plan) ?? tierDisplayName(info.tier);
    const periodEnd = formatExpiry(stripe.current_period_end);
    const codeLine =
      info.codeExpiry === undefined ? null : (
        <p className="subscription-plan-blurb">
          {alsoFromCode(formatExpiry(info.codeExpiry ?? undefined))}
        </p>
      );

    if (stripe.status === 'past_due') {
      return (
        <>
          <PlanHeader name={name}>
            <StateWord icon={CreditCard}>{BILLING_COPY.pastDueTitle}</StateWord>
          </PlanHeader>
          <div className="subscription-plan-details">
            <p className="subscription-plan-blurb">{BILLING_COPY.pastDueBody}</p>
            {codeLine}
            {shellNote}
          </div>
          {paidControls && (
            <div className="subscription-plan-actions">
              {portalButton(
                'update-card',
                'Update card',
                'payment_method_update',
                'subscription-button',
                manageRef
              )}
            </div>
          )}
        </>
      );
    }

    if (stripe.status === 'trialing') {
      const ends = formatExpiry(stripe.ends_at ?? stripe.current_period_end);
      const price = stripe.plan
        ? findPlanPrice(plans, stripe.plan, stripe.interval ?? 'month')
        : undefined;
      const amount = price
        ? formatPrice(
            stripe.founders_rate ? foundersAmount(price.unit_amount) : price.unit_amount,
            price.currency
          ) + intervalSuffix(stripe.interval ?? 'month')
        : undefined;
      return (
        <>
          <PlanHeader name={name}>
            <StateWord icon={CalendarClock}>{ends ? `Trial ends ${ends}` : 'Free trial'}</StateWord>
          </PlanHeader>
          {activated && <span className="subscription-activation-rule" aria-hidden="true" />}
          <div className="subscription-plan-details">
            <p className="subscription-plan-blurb">
              {stripe.canceling
                ? `Your free trial ends ${ends ?? 'soon'}. You won't be charged.`
                : ends
                  ? `Paid billing begins on ${ends}${amount ? ` at ${amount}` : ''} unless you cancel before then. Any redeemed code credit reduces the first paid charge.`
                  : 'Your chosen plan starts billing when the trial ends unless you cancel before then. Any redeemed code credit reduces the first paid charge.'}
            </p>
            {stripe.founders_rate && !stripe.canceling && (
              <p className="subscription-plan-blurb">
                {BILLING_COPY.foundersChip} applies after the trial.
              </p>
            )}
            {codeLine}
            {shellNote}
          </div>
          {paidControls && (
            <div className="subscription-plan-actions">
              {portalButton(
                stripe.canceling ? 'resume' : 'manage',
                stripe.canceling ? 'Resume subscription' : 'Manage subscription',
                undefined,
                'subscription-button',
                manageRef
              )}
              {!stripe.canceling &&
                portalButton(
                  'cancel',
                  'Cancel subscription',
                  'subscription_cancel',
                  'subscription-text-button'
                )}
            </div>
          )}
        </>
      );
    }

    if (stripe.canceling) {
      const ends = formatExpiry(stripe.ends_at ?? stripe.current_period_end);
      return (
        <>
          <PlanHeader name={name}>
            <StateWord icon={CalendarClock}>{ends ? `Ends ${ends}` : 'Ending'}</StateWord>
          </PlanHeader>
          <div className="subscription-plan-details">
            {ends && (
              <p className="subscription-plan-blurb">
                You keep {name} until {ends}.
              </p>
            )}
            {stripe.founders_rate && (
              <p className="subscription-plan-blurb">{BILLING_COPY.foundersEnds}</p>
            )}
            {codeLine}
            {shellNote}
          </div>
          {paidControls && (
            <div className="subscription-plan-actions">
              {portalButton(
                'resume',
                'Resume subscription',
                undefined,
                'subscription-button',
                manageRef
              )}
            </div>
          )}
        </>
      );
    }

    const priceLine = stripePriceLine(
      stripe,
      stripe.plan ? findPlanPrice(plans, stripe.plan, stripe.interval ?? 'month') : undefined,
      periodEnd
    );
    return (
      <>
        <PlanHeader name={name}>
          <StateWord icon={CircleCheck}>Active</StateWord>
        </PlanHeader>
        {activated && <span className="subscription-activation-rule" aria-hidden="true" />}
        <div className="subscription-plan-details">
          {(priceLine || stripe.founders_rate) && (
            <p className="subscription-plan-blurb">
              {priceLine}
              {stripe.founders_rate && (
                <span className="subscription-founders-chip">{BILLING_COPY.foundersChip}</span>
              )}
            </p>
          )}
          {codeLine}
          {shellNote}
        </div>
        {paidControls && (
          <>
            <div className="subscription-plan-actions">
              {portalButton(
                'manage',
                'Manage subscription',
                undefined,
                'subscription-button',
                manageRef
              )}
              {portalButton(
                'cancel',
                'Cancel subscription',
                'subscription_cancel',
                'subscription-text-button'
              )}
            </div>
            <p className="subscription-plan-hint">{BILLING_COPY.manageHint}</p>
          </>
        )}
      </>
    );
  };

  let body: React.ReactNode;
  if (info.loading) {
    body = (
      <p className="subscription-plan-blurb" aria-live="polite">
        Checking your subscription access…
      </p>
    );
  } else if (pending) {
    body = (
      <>
        <PlanHeader name={tierDisplayName(info.tier)}>
          <span className="subscription-plan-state">
            <LoaderCircle
              size={16}
              className="subscription-plan-state-icon subscription-confirming-spinner"
              aria-hidden="true"
            />
            <Clock
              size={16}
              className="subscription-plan-state-icon subscription-confirming-still"
              aria-hidden="true"
            />
            Confirming
          </span>
        </PlanHeader>
      </>
    );
  } else if (info.error || !stateLabel) {
    body = (
      <>
        <p className="subscription-plan-blurb" role={info.error ? 'alert' : undefined}>
          {info.error
            ? 'Could not check your subscription status.'
            : 'Subscription status not confirmed.'}
        </p>
        {entitlementHydrated && (
          <p className="subscription-plan-known-access">
            Last-known access: <strong>{tierDisplayName(entitlementTier)}</strong>
          </p>
        )}
        <button type="button" className="subscription-plan-retry" onClick={info.refetch}>
          Retry
        </button>
      </>
    );
  } else if (info.billing === 'self_hosted') {
    body = <p className="subscription-plan-blurb">{BILLING_COPY.selfHosted}</p>;
  } else if (info.stripe) {
    body = renderStripe(info.stripe);
  } else if (info.tier === 'premium' && info.source === 'code') {
    const expiry = formatExpiry(info.expiry);
    body = (
      <>
        <PlanHeader name={tierDisplayName(info.tier)}>
          <StateWord icon={Ticket}>{sourceDisplay('code')}</StateWord>
        </PlanHeader>
        <div className="subscription-plan-details">
          {expiry && (
            <p className="subscription-plan-expiry">
              Access ends <strong>{expiry}</strong>
            </p>
          )}
          {shellNote}
        </div>
      </>
    );
  } else if (info.tier === 'free' && info.status === 'none') {
    body = (
      <>
        <PlanHeader name={tierDisplayName(info.tier)}>
          <StateWord>{stateLabel}</StateWord>
        </PlanHeader>
        <div className="subscription-plan-details">
          <p className="subscription-plan-blurb">You&rsquo;re on Sonic, the free plan.</p>
          {shellNote}
        </div>
      </>
    );
  } else {
    // A status this card has no dedicated state for, such as a Stripe source
    // from a server that sends no `stripe` detail: name it without inventing
    // renewal or management.
    const source =
      info.source === 'stripe' && info.status !== 'active'
        ? 'Stripe subscription'
        : sourceDisplay(info.source);
    const expiry = formatExpiry(info.expiry);
    body = (
      <>
        <PlanHeader name={tierDisplayName(info.tier)}>
          <StateWord>{stateLabel}</StateWord>
        </PlanHeader>
        <div className="subscription-plan-details">
          {source && <p className="subscription-plan-source">{source}</p>}
          {expiry && info.source && (
            <p className="subscription-plan-expiry">
              {info.source === 'stripe' ? 'Current period ends' : 'Access ends'}{' '}
              <strong>{expiry}</strong>
            </p>
          )}
        </div>
      </>
    );
  }

  let live = '';
  if (pending) {
    live = pendingStalled ? BILLING_COPY.confirmingStalled : BILLING_COPY.confirming;
  } else if (activated) {
    live =
      info.stripe?.status === 'trialing' ? BILLING_COPY.trialActivated : BILLING_COPY.activated;
  }

  const pastDue = !pending && info.stripe?.status === 'past_due' && !info.error;

  return (
    <div
      className={
        pastDue ? 'subscription-plan-card subscription-plan-card-alert' : 'subscription-plan-card'
      }
      data-tier={info.loading ? undefined : info.tier}
    >
      {body}
      {/* Always mounted, so the change from Confirming to Active is announced. */}
      <output className={pending ? 'subscription-plan-live' : 'subscription-sr-only'}>
        {live}
      </output>
      {/* After the output, so Check again follows the message it answers. */}
      {pending && pendingStalled && (
        <div className="subscription-plan-actions">
          <button
            type="button"
            className="subscription-button"
            onClick={() => {
              void checkAgain();
            }}
          >
            {BILLING_COPY.checkAgain}
          </button>
        </div>
      )}
    </div>
  );
};

export default PlanCard;
