import React, { useEffect, useState, useCallback } from 'react';
import { apiFetch, safeJson } from '../../services/system/apiClient';
import SessionStepUpDialog, {
  sessionStepUpKey,
  type SessionStepUpAction,
} from './SessionStepUpDialog';
import './LinkedAccountsList.css';

interface SSOIdentity {
  provider: string;
  provider_email: string;
  is_relay_email: boolean;
  linked_at: string;
  last_used_at: string | null;
}

/**
 * Returns a Title-Cased provider label for display (e.g. "google" -> "Google").
 * Defensive against the empty string.
 */
function titleCase(s: string): string {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Best-effort relative-time string ("today", "3 days ago", "2 weeks ago", "5 months ago").
 * Returns the empty string when the input is null or unparseable so callers can render "Never used".
 */
function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return '';
  const days = Math.floor((Date.now() - ts) / 86_400_000);
  if (days < 1) return 'today';
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
  }
  const months = Math.floor(days / 30);
  return `${months} month${months === 1 ? '' : 's'} ago`;
}

/**
 * LinkedAccountsList — Settings view for managing SSO providers.
 *
 * Renders one row per linked identity with provider, email (or relay-email
 * placeholder), last-used time, and an Unlink button. Unlink calls
 * DELETE /users/me/sso-identities/:provider; the server refuses with
 * `would_lock_out` if removing the identity would leave the user with no
 * authentication method. We surface that error inline instead of
 * silently failing.
 */
const LinkedAccountsList: React.FC = () => {
  const [identities, setIdentities] = useState<SSOIdentity[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stepUpAction, setStepUpAction] = useState<SessionStepUpAction | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await apiFetch('/api/v1/users/me/sso-identities');
      if (!res.ok) {
        throw new Error(await res.text());
      }
      const data = await safeJson<{ identities: SSOIdentity[] }>(res);
      setIdentities(data.identities);
    } catch {
      setError('Failed to load linked accounts.');
      setIdentities([]);
    }
  }, []);

  useEffect(() => {
    load().catch(() => {
      // load() catches its own errors and stamps state; this swallow
      // exists only to satisfy no-floating-promises without using `void`.
    });
  }, [load]);

  if (identities === null) {
    return (
      <div className="linked-accounts">
        <p className="linked-accounts__loading">Loading linked accounts...</p>
      </div>
    );
  }

  return (
    <div className="linked-accounts">
      {error && (
        <p className="linked-accounts__error" role="alert">
          {error}
        </p>
      )}

      {identities.length === 0 ? (
        <p className="linked-accounts__empty">No linked accounts.</p>
      ) : (
        <ul className="linked-accounts__list">
          {identities.map((identity) => {
            const lastUsed = relativeTime(identity.last_used_at);
            return (
              <li key={identity.provider} className="linked-accounts__row">
                <div className="linked-accounts__info">
                  <span className="linked-accounts__provider">{titleCase(identity.provider)}</span>
                  <span className="linked-accounts__email">
                    {identity.is_relay_email ? 'Hidden via Apple Privacy' : identity.provider_email}
                  </span>
                  <span className="linked-accounts__last-used">
                    {lastUsed ? `Last used ${lastUsed}` : 'Never used'}
                  </span>
                </div>
                <button
                  type="button"
                  className="linked-accounts__unlink-btn"
                  onClick={() =>
                    setStepUpAction({ kind: 'ssoUnlink', provider: identity.provider })
                  }
                  disabled={stepUpAction?.kind === 'ssoUnlink'}
                >
                  {stepUpAction?.kind === 'ssoUnlink' ? 'Unlinking...' : 'Unlink'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {stepUpAction?.kind === 'ssoUnlink' && (
        <SessionStepUpDialog
          key={sessionStepUpKey(stepUpAction)}
          action={stepUpAction}
          onClose={() => setStepUpAction(null)}
          onAccepted={(action) => {
            if (action.kind !== 'ssoUnlink') return;
            setStepUpAction(null);
            void load();
          }}
        />
      )}
    </div>
  );
};

export default LinkedAccountsList;
