import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useUserStore } from '../../stores/auth/userStore';
import { useServerStore } from '../../stores/chat/serverStore';
import { usePrivacyStore } from '../../stores/ui/privacyStore';
import { useClientConfigStore } from '../../stores/ui/clientConfigStore';
import CollapsibleSection from './CollapsibleSection';
import DMPrivacyControls from './DMPrivacyControls';
import FriendRequestPrivacyControls from './FriendRequestPrivacyControls';
import ContentSafetyControls from './ContentSafetyControls';
import SearchVisibilityControls from './SearchVisibilityControls';
import PresenceSettingsSection from './PresenceSettingsSection';
import ActivityHistoryCard from './ActivityHistoryCard';
import PresenceHistorySection from '../Profile/PresenceHistorySection';
import ToggleSwitch from './ToggleSwitch';
import PurgeFenceStepUpDialog from './PurgeFenceStepUpDialog';
import AccountErasureStepUpDialog from './AccountErasureStepUpDialog';
import type { AccountErasureResult } from '../../api/privacy';
import {
  setDraftContentProtection,
  useDraftContentProtection,
  useDraftContentProtectionApplying,
  useDraftContentProtectionLoaded,
} from '../../hooks/ui/useDraftSettings';

// #1354: the purge dead-end card navigates here by control id
// (`settingsNavStore.requestFocus('privacy', 'requireAuthBeforePurge')`),
// so the switch id and the label it points at are a cross-component contract.
const PURGE_AUTH_LABEL_ID = 'requireAuthBeforePurge-label';
const CONTENT_PROTECTION_LABEL_ID = 'contentProtection-label';
const CONTENT_PROTECTION_HINT_ID = 'contentProtection-hint';

export interface AccountErasureConfirmation {
  requestId: string;
  token: string;
  expiresAt: number;
}

interface PrivacySectionProps {
  onActivityHistoryAvailabilityChange?: (available: boolean) => void;
  accountErasureConfirmation?: AccountErasureConfirmation | null;
  onClearAccountErasureConfirmation?: () => void;
}

const PrivacySection: React.FC<PrivacySectionProps> = ({
  onActivityHistoryAvailabilityChange,
  accountErasureConfirmation = null,
  onClearAccountErasureConfirmation,
}) => {
  const userId = useUserStore((s) => s.user?.id ?? null);
  const logout = useUserStore((s) => s.logout);
  const servers = useServerStore((s) => s.servers);
  const fetchServers = useServerStore((s) => s.fetchServers);
  const activityHistoryCapability = useClientConfigStore(
    (state) => state.activityHistoryCapability
  );
  const privacySettings = usePrivacyStore((s) => s.settings);
  const fetchPrivacy = usePrivacyStore((s) => s.fetchPrivacy);
  const updatePrivacy = usePrivacyStore((s) => s.updatePrivacy);
  const privacyLoaded = usePrivacyStore((s) => s.loaded);
  const localDmLevel = usePrivacyStore((s) => s.pendingDmPrivacyLevel ?? s.settings.dmPrivacyLevel);
  const localFriendRequestMode = usePrivacyStore(
    (s) => s.pendingFriendRequestMode ?? s.settings.allowFriendRequestsFrom
  );
  const setDmPrivacyLevel = usePrivacyStore((s) => s.scheduleDMPrivacy);
  const setFriendRequestMode = usePrivacyStore((s) => s.scheduleFriendRequestPrivacy);
  const dmSaveError = usePrivacyStore((s) => s.dmSaveError);
  const friendRequestError = usePrivacyStore((s) => s.friendRequestError);
  const contentProtection = useDraftContentProtection();
  const contentProtectionLoaded = useDraftContentProtectionLoaded();
  const contentProtectionApplying = useDraftContentProtectionApplying();
  const [contentProtectionPlatform, setContentProtectionPlatform] = useState<string | null>(null);
  const [activityHistoryControlsVisible, setActivityHistoryControlsVisible] = useState(false);
  const [presenceHistoryVisible, setPresenceHistoryVisible] = useState(false);
  const [activityHistoryControlsAvailable, setActivityHistoryControlsAvailable] = useState(false);
  const [presenceHistoryAvailable, setPresenceHistoryAvailable] = useState(false);
  const activityHistoryAvailable = activityHistoryControlsAvailable || presenceHistoryAvailable;
  const activityHistoryVisible =
    activityHistoryCapability.status !== 'confirmed-unsupported' ||
    activityHistoryControlsVisible ||
    presenceHistoryVisible;
  useEffect(() => {
    onActivityHistoryAvailabilityChange?.(activityHistoryAvailable);
  }, [activityHistoryAvailable, onActivityHistoryAvailabilityChange]);
  useEffect(() => {
    let mounted = true;
    void globalThis.electron
      ?.getPlatform?.()
      .then((platform) => {
        if (mounted) setContentProtectionPlatform(platform);
      })
      .catch(() => {
        if (mounted) setContentProtectionPlatform(null);
      });
    return () => {
      mounted = false;
    };
  }, []);

  // #1354: a toggle-only PATCH against a control-plane that predates the field
  // comes back 400. The store maps that one shape to the skew copy; surfacing it
  // here is what stops the flip from failing silently.
  const [purgeAuthError, setPurgeAuthError] = useState<string | null>(null);
  const [purgeFenceStepUpOpen, setPurgeFenceStepUpOpen] = useState(false);
  const [acknowledgedServerIds, setAcknowledgedServerIds] = useState<Set<string>>(() => new Set());
  const [erasureDialogOpen, setErasureDialogOpen] = useState(false);
  const [emailConfirmation, setEmailConfirmation] = useState<{
    requestId: string;
    token: string;
    expiresAt: number;
  } | null>(null);
  const [erasureNotice, setErasureNotice] = useState<string | null>(null);
  const erasureUserIdRef = useRef(userId);
  const protectedOwnedServers = useMemo(
    () => servers.filter((server) => server.owner_id === userId && server.member_count > 1),
    [servers, userId]
  );
  const confirmedOwnedServerIds = useMemo(
    () => [...acknowledgedServerIds].sort((left, right) => left.localeCompare(right)),
    [acknowledgedServerIds]
  );

  useEffect(() => {
    if (accountErasureConfirmation === null) return;
    /* eslint-disable @eslint-react/set-state-in-effect -- transient bearer handoff from the authenticated host */
    setEmailConfirmation(accountErasureConfirmation);
    setErasureNotice('Email confirmed. Review your acknowledgements and erase your account.');
    /* eslint-enable @eslint-react/set-state-in-effect -- transient bearer handoff from the authenticated host */
  }, [accountErasureConfirmation]);

  useEffect(() => {
    if (emailConfirmation === null) return;
    const timeout = window.setTimeout(
      () => {
        setEmailConfirmation(null);
        onClearAccountErasureConfirmation?.();
        setErasureNotice('The email confirmation expired. Start over to request another link.');
      },
      Math.max(0, emailConfirmation.expiresAt - Date.now())
    );
    return () => window.clearTimeout(timeout);
  }, [emailConfirmation, onClearAccountErasureConfirmation]);

  useEffect(() => {
    // Account changes, logout and renderer resets must not retain a bearer link.
    /* eslint-disable @eslint-react/set-state-in-effect -- transient bearer-secret hygiene */
    setEmailConfirmation(null);
    setAcknowledgedServerIds(new Set());
    /* eslint-enable @eslint-react/set-state-in-effect -- transient bearer-secret hygiene */
    if (erasureUserIdRef.current !== userId) onClearAccountErasureConfirmation?.();
    erasureUserIdRef.current = userId;
  }, [userId, onClearAccountErasureConfirmation]);

  const setRequireAuthBeforePurge = useCallback(
    async (next: boolean) => {
      setPurgeAuthError(null);
      // #2765: turning the fence OFF is step-up gated, so the dialog owns that
      // transition end-to-end — it collects the factors and sends the PATCH.
      // Nothing goes out from here, and the switch stays bound to the store, so
      // it does not flip until the server accepts. Turning it ON is ungated.
      if (!next) {
        setPurgeFenceStepUpOpen(true);
        return;
      }
      try {
        await updatePrivacy({ requireAuthBeforePurge: true });
      } catch (err) {
        setPurgeAuthError(err instanceof Error ? err.message : 'Failed to update privacy settings');
      }
    },
    [updatePrivacy]
  );

  const handleErasureResult = useCallback(
    async (result: AccountErasureResult) => {
      setErasureDialogOpen(false);
      if (result.kind === 'email_confirmation_required') {
        setEmailConfirmation(null);
        onClearAccountErasureConfirmation?.();
        setErasureNotice('Check your email for a confirmation link.');
        return;
      }
      setEmailConfirmation(null);
      onClearAccountErasureConfirmation?.();
      const forgetDeepLinks = globalThis.electron?.forgetDeepLinks;
      if (forgetDeepLinks) void forgetDeepLinks().catch(() => undefined);
      await logout();
    },
    [logout, onClearAccountErasureConfirmation]
  );

  const handleStaleOwnedServers = useCallback(() => {
    setAcknowledgedServerIds(new Set());
    setEmailConfirmation(null);
    onClearAccountErasureConfirmation?.();
    void fetchServers();
  }, [fetchServers, onClearAccountErasureConfirmation]);

  useEffect(() => {
    void fetchPrivacy();
  }, [fetchPrivacy]);

  const renderContentProtectionControl = () =>
    contentProtectionLoaded &&
    (contentProtectionPlatform === 'darwin' || contentProtectionPlatform === 'win32') && (
      <div className="settings-row">
        <div className="settings-row-info">
          <label
            className="settings-row-label"
            id={CONTENT_PROTECTION_LABEL_ID}
            htmlFor="contentProtection"
          >
            Protect Concord windows from screen capture
          </label>
          <span className="settings-row-hint" id={CONTENT_PROTECTION_HINT_ID}>
            When applied, Concord asks macOS or Windows to prevent its main and picture-in-picture
            call windows from being captured. Your operating system may not block every capture
            method.
          </span>
        </div>
        <ToggleSwitch
          id="contentProtection"
          checked={contentProtection}
          onChange={setDraftContentProtection}
          disabled={contentProtectionApplying}
          ariaLabelledBy={CONTENT_PROTECTION_LABEL_ID}
          aria-describedby={CONTENT_PROTECTION_HINT_ID}
          inputRole="switch"
        />
      </div>
    );

  return (
    <>
      <CollapsibleSection id="section-privacy-settings" title="Privacy Controls">
        <p className="settings-section-description">
          Control who can message you and how others can find you.
        </p>

        {renderContentProtectionControl()}

        <DMPrivacyControls
          localDmLevel={localDmLevel}
          setDmPrivacyLevel={setDmPrivacyLevel}
          saveError={dmSaveError}
          isLoaded={privacyLoaded}
        />

        <FriendRequestPrivacyControls
          localMode={localFriendRequestMode}
          setMode={setFriendRequestMode}
          saveError={friendRequestError}
          isLoaded={privacyLoaded}
        />

        <div className="settings-row">
          <div className="settings-row-info">
            <label
              className="settings-row-label"
              id={PURGE_AUTH_LABEL_ID}
              htmlFor="requireAuthBeforePurge"
            >
              Require authentication before purging
            </label>
            <span className="settings-row-hint">
              Ask for your password before purging messages in a direct message or group chat.
            </span>
            {!privacySettings.requireAuthBeforePurge && (
              <span className="settings-row-hint" role="alert">
                Without this, anyone with access to your unlocked account can permanently purge your
                message history.
              </span>
            )}
            {purgeAuthError && (
              <span className="settings-row-hint" role="alert">
                {purgeAuthError}
              </span>
            )}
          </div>
          <ToggleSwitch
            id="requireAuthBeforePurge"
            checked={privacySettings.requireAuthBeforePurge}
            onChange={(v) => void setRequireAuthBeforePurge(v)}
            ariaLabelledBy={PURGE_AUTH_LABEL_ID}
            inputRole="switch"
          />
        </div>

        <PurgeFenceStepUpDialog
          open={purgeFenceStepUpOpen}
          onClose={() => setPurgeFenceStepUpOpen(false)}
        />

        <ContentSafetyControls />
        <SearchVisibilityControls />
      </CollapsibleSection>

      <CollapsibleSection id="section-account-erasure" title="Danger Zone">
        <p className="settings-section-description">
          Account erasure is irreversible. It can remove servers you own and direct-message
          conversations that affect other people.
        </p>
        {protectedOwnedServers.length > 0 && (
          <>
            <p className="settings-section-description">
              Transfer ownership or remove other members before erasing. Acknowledge each
              multi-member server that will be affected.
            </p>
            <ul>
              {protectedOwnedServers.map((server) => (
                <li key={server.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={acknowledgedServerIds.has(server.id)}
                      onChange={(event) => {
                        setAcknowledgedServerIds((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(server.id);
                          else next.delete(server.id);
                          return next;
                        });
                      }}
                    />{' '}
                    I understand that {server.name} has other members.
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}
        {erasureNotice && <p role="alert">{erasureNotice}</p>}
        <button
          type="button"
          className="btn btn-danger"
          disabled={acknowledgedServerIds.size !== protectedOwnedServers.length}
          onClick={() => setErasureDialogOpen(true)}
        >
          {emailConfirmation ? 'Review and erase account' : 'Erase account'}
        </button>
        {erasureDialogOpen && (
          <AccountErasureStepUpDialog
            confirmedOwnedServerIds={confirmedOwnedServerIds}
            emailConfirmation={
              emailConfirmation === null
                ? null
                : { requestId: emailConfirmation.requestId, token: emailConfirmation.token }
            }
            onResult={(result) => void handleErasureResult(result)}
            onStaleOwnedServers={handleStaleOwnedServers}
            onClose={() => setErasureDialogOpen(false)}
          />
        )}
      </CollapsibleSection>

      <PresenceSettingsSection />

      <div hidden={!activityHistoryVisible}>
        <CollapsibleSection id="section-presence-history" title="Activity History">
          <ActivityHistoryCard
            onVisibilityChange={setActivityHistoryControlsVisible}
            onAvailabilityChange={setActivityHistoryControlsAvailable}
          />
          <PresenceHistorySection
            userId={userId}
            onVisibilityChange={setPresenceHistoryVisible}
            onAvailabilityChange={setPresenceHistoryAvailable}
          />
        </CollapsibleSection>
      </div>
    </>
  );
};

export default PrivacySection;
