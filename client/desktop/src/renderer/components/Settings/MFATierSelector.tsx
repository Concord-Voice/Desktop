import React, { useState } from 'react';
import ToggleSwitch from './ToggleSwitch';
import MFAVerifyPrompt from '../Auth/MFAVerifyPrompt';

export interface WebAuthnCredential {
  id: string;
  credential_name: string;
  credential_type: string; // 'hardware' | 'platform'
  created_at: string;
  last_used_at?: string | null;
}

interface MFATier {
  level: string;
  name: string;
  methodKey?: string;
  methods: string[];
  description: string;
  locked?: boolean;
  lockReason?: string;
  recoveryOnlyEligible?: boolean;
}

const tiers: MFATier[] = [
  {
    level: 'maximum',
    name: 'Maximum — Hardware Keys',
    methodKey: 'webauthn',
    methods: ['YubiKey', 'Google Titan', 'SoloKeys', 'Nitrokey', 'Any FIDO2 security key'],
    description:
      'Fort Knox mode. A dedicated physical device you carry separately. Hackers need to literally steal it from you.',
  },
  {
    level: 'strong',
    name: 'Strong — Platform Authenticator',
    methodKey: 'webauthn',
    methods: ['Windows Hello', 'Apple Touch ID / Face ID', 'Android biometrics', 'Chrome OS'],
    description:
      'Your device IS the key. Built-in biometrics + secure hardware. Very solid, and nothing extra to carry.',
  },
  {
    level: 'standard',
    name: 'Standard — Authenticator App',
    methodKey: 'totp',
    methods: [
      'Google Authenticator',
      'Microsoft Authenticator',
      'Authy',
      'Proton Pass',
      'Bitwarden',
      '1Password',
      'Any TOTP app',
    ],
    description:
      'The classic. 6 digits, 30 seconds. Works with any app that supports TOTP. A tried-and-true workhorse.',
  },
  {
    level: 'last-resort',
    name: 'Last Resort — Email / SMS',
    methodKey: 'email',
    methods: ['Email code', 'SMS code'],
    description:
      'Better than nothing, but phone numbers get SIM-swapped and emails get phished. Requires a real MFA method first.',
    locked: true,
    lockReason: 'Enable a Standard or higher MFA method first',
    recoveryOnlyEligible: true,
  },
];

type ActionType =
  | 'reset-totp'
  | 'revoke-webauthn'
  | 'disable-emailsms'
  | 'toggle-recovery-only'
  | 'toggle-hardened';

interface MFATierSelectorProps {
  activeMethods: string[];
  recoveryOnlyMethods?: string[];
  recoveryHardened?: boolean;
  backupCodesRemaining?: number;
  webauthnCredentials?: WebAuthnCredential[];
  backupEmail?: string;
  onSetupTOTP: () => void;
  onSetupWebAuthn: (credentialType: 'hardware' | 'platform') => void;
  onSetupEmailSms?: () => void;
  onToggleRecoveryOnly?: (
    method: string,
    recoveryOnly: boolean,
    password: string,
    mfaCode: string
  ) => Promise<boolean>;
  onToggleRecoveryHardened?: (
    enabled: boolean,
    password: string,
    mfaCode: string
  ) => Promise<boolean>;
  onResetTOTP?: (password: string, code: string) => Promise<boolean>;
  onRevokeWebAuthnKey?: (credentialId: string, password: string) => Promise<boolean>;
  onDisableEmailSms?: (password: string) => Promise<boolean>;
  onSetBackupEmail?: (email: string) => Promise<boolean>;
}

const MFATierSelector: React.FC<MFATierSelectorProps> = ({
  activeMethods,
  recoveryOnlyMethods = [],
  recoveryHardened = true,
  backupCodesRemaining,
  webauthnCredentials = [],
  backupEmail,
  onSetupTOTP,
  onSetupWebAuthn,
  onSetupEmailSms,
  onToggleRecoveryOnly,
  onToggleRecoveryHardened,
  onResetTOTP,
  onRevokeWebAuthnKey,
  onDisableEmailSms,
  onSetBackupEmail,
}) => {
  const hasTotp = activeMethods.includes('totp');
  const hasWebauthn = activeMethods.includes('webauthn');
  const hasEmail = activeMethods.includes('email');
  const hasSms = activeMethods.includes('sms');
  const hasEmailOrSms = hasEmail || hasSms;
  const hasRealMFA = hasTotp || hasWebauthn;
  const hasAnyMFA = activeMethods.length > 0;

  // Count distinct "real" MFA types (not email/sms)
  const realMFATypeCount = (hasTotp ? 1 : 0) + (hasWebauthn ? 1 : 0);
  // Sole-MFA protection: if only one real MFA type and Email/SMS is also on,
  // disabling that sole MFA type would leave only Email/SMS (which isn't real MFA).
  const soleRealMFAWithEmailSms = realMFATypeCount === 1 && hasEmailOrSms;

  // Action modal state
  const [actionModal, setActionModal] = useState<{
    type: ActionType;
    credentialId?: string;
    credentialName?: string;
    // For toggle actions: store the pending new value
    toggleMethod?: string;
    toggleValue?: boolean;
  } | null>(null);
  const [actionPassword, setActionPassword] = useState('');
  const [actionMfaCode, setActionMfaCode] = useState('');
  const [actionError, setActionError] = useState('');
  const [actionLoading, setActionLoading] = useState(false);

  // Backup email state
  const [editingBackupEmail, setEditingBackupEmail] = useState(false);
  const [backupEmailDraft, setBackupEmailDraft] = useState(backupEmail || '');
  const [backupEmailError, setBackupEmailError] = useState('');

  const handleAction = async () => {
    if (!actionModal) return;
    setActionError('');
    setActionLoading(true);

    try {
      let success = false;
      switch (actionModal.type) {
        case 'reset-totp':
          if (onResetTOTP) success = await onResetTOTP(actionPassword, actionMfaCode);
          break;
        case 'revoke-webauthn':
          if (onRevokeWebAuthnKey && actionModal.credentialId)
            success = await onRevokeWebAuthnKey(actionModal.credentialId, actionPassword);
          break;
        case 'disable-emailsms':
          if (onDisableEmailSms) success = await onDisableEmailSms(actionPassword);
          break;
        case 'toggle-recovery-only':
          if (
            onToggleRecoveryOnly &&
            actionModal.toggleMethod !== undefined &&
            actionModal.toggleValue !== undefined
          )
            success = await onToggleRecoveryOnly(
              actionModal.toggleMethod,
              actionModal.toggleValue,
              actionPassword,
              actionMfaCode
            );
          break;
        case 'toggle-hardened':
          if (onToggleRecoveryHardened && actionModal.toggleValue !== undefined)
            success = await onToggleRecoveryHardened(
              actionModal.toggleValue,
              actionPassword,
              actionMfaCode
            );
          break;
      }
      if (success) {
        setActionModal(null);
        setActionPassword('');
        setActionMfaCode('');
      } else {
        setActionError('Verification failed. Check your password and try again.');
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'An error occurred. Please try again.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleSaveBackupEmail = async () => {
    const trimmed = backupEmailDraft.trim();
    if (trimmed && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setBackupEmailError('Please enter a valid email address.');
      return;
    }
    setBackupEmailError('');
    if (onSetBackupEmail) {
      const ok = await onSetBackupEmail(trimmed);
      if (ok) setEditingBackupEmail(false);
      else setBackupEmailError('Failed to save. Please try again.');
    }
  };

  const actionTitle =
    actionModal?.type === 'reset-totp'
      ? 'Reset TOTP'
      : actionModal?.type === 'revoke-webauthn'
        ? `Revoke "${actionModal.credentialName || 'Key'}"`
        : actionModal?.type === 'toggle-recovery-only'
          ? actionModal.toggleValue
            ? 'Enable Recovery Only'
            : 'Disable Recovery Only'
          : actionModal?.type === 'toggle-hardened'
            ? actionModal.toggleValue
              ? 'Enable Hardened Mode'
              : 'Disable Hardened Mode'
            : 'Disable Email/SMS';

  const actionDesc =
    actionModal?.type === 'reset-totp'
      ? 'This will remove your authenticator app enrollment. You will need to set it up again.'
      : actionModal?.type === 'revoke-webauthn'
        ? 'This will permanently remove this security key. It will no longer work for authentication.'
        : actionModal?.type === 'toggle-recovery-only'
          ? actionModal.toggleValue
            ? 'This method will only be usable for account recovery, not for login or sensitive actions.'
            : 'This method will be usable for login and sensitive actions again.'
          : actionModal?.type === 'toggle-hardened'
            ? actionModal.toggleValue
              ? 'Recovery will require BOTH email and SMS codes simultaneously.'
              : 'Recovery will accept either an email code or an SMS code individually.'
            : 'This will disable email and SMS verification methods.';

  return (
    <div className="mfa-tier-selector">
      {tiers.map((tier) => {
        const isLocked = tier.locked && !hasRealMFA;
        // For WebAuthn tiers, check if there are actually credentials of that type
        const hasHardwareKeys = webauthnCredentials.some((c) => c.credential_type === 'hardware');
        const hasPlatformKeys = webauthnCredentials.some((c) => c.credential_type === 'platform');
        const isActive =
          (tier.level === 'standard' && hasTotp) ||
          (tier.level === 'maximum' && hasWebauthn && hasHardwareKeys) ||
          (tier.level === 'strong' && hasWebauthn && hasPlatformKeys) ||
          (tier.level === 'last-resort' && hasEmailOrSms);
        const isRecoveryOnly =
          tier.level === 'last-resort'
            ? recoveryOnlyMethods.includes('email') || recoveryOnlyMethods.includes('sms')
            : tier.methodKey
              ? recoveryOnlyMethods.includes(tier.methodKey)
              : false;

        // Filter WebAuthn credentials by tier
        const tierCredentials =
          tier.methodKey === 'webauthn' && isActive
            ? webauthnCredentials.filter((c) =>
                tier.level === 'maximum'
                  ? c.credential_type === 'hardware'
                  : c.credential_type === 'platform'
              )
            : [];

        return (
          <div
            key={tier.level}
            className={`mfa-tier-card ${isLocked ? 'mfa-tier-locked' : ''} ${isActive ? 'mfa-tier-active' : ''}`}
          >
            <div className="mfa-tier-header">
              <h4 className="mfa-tier-name">{tier.name}</h4>
              {isActive && !isRecoveryOnly && <span className="mfa-tier-badge">Configured</span>}
              {isActive && isRecoveryOnly && (
                <span className="mfa-tier-badge mfa-tier-badge-recovery">Recovery Only</span>
              )}
            </div>
            <p className="mfa-tier-desc">{tier.description}</p>
            <div className="mfa-tier-methods">
              {tier.methods.map((m) => (
                <span key={m} className="mfa-tier-method">
                  {m}
                </span>
              ))}
            </div>

            {/* TOTP Reset button */}
            {tier.level === 'standard' && isActive && onResetTOTP && (
              <div className="mfa-tier-actions">
                {soleRealMFAWithEmailSms && hasTotp && !hasWebauthn && (
                  <span className="mfa-action-hint">
                    Disable Email/SMS before resetting your only MFA method
                  </span>
                )}
                <button
                  type="button"
                  className="btn btn-uniform btn-danger"
                  disabled={soleRealMFAWithEmailSms && hasTotp && !hasWebauthn}
                  title={
                    soleRealMFAWithEmailSms && hasTotp && !hasWebauthn
                      ? 'Disable Email/SMS first — this is your only real MFA method'
                      : 'Reset TOTP enrollment'
                  }
                  onClick={() => {
                    setActionModal({ type: 'reset-totp' });
                    setActionPassword('');
                    setActionMfaCode('');
                    setActionError('');
                  }}
                >
                  Reset
                </button>
              </div>
            )}

            {/* WebAuthn credential list with per-key Revoke + Add Key */}
            {tier.methodKey === 'webauthn' && isActive && tierCredentials.length > 0 && (
              <div className="mfa-credential-list">
                {tierCredentials.map((cred) => (
                  <div key={cred.id} className="mfa-credential-row">
                    <div className="mfa-credential-info">
                      <span className="mfa-credential-name">{cred.credential_name}</span>
                      <span className="mfa-credential-meta">
                        Added {new Date(cred.created_at).toLocaleDateString()}
                        {cred.last_used_at &&
                          ` · Last used ${new Date(cred.last_used_at).toLocaleDateString()}`}
                      </span>
                    </div>
                    {onRevokeWebAuthnKey && (
                      <button
                        type="button"
                        className="btn btn-uniform btn-danger"
                        disabled={
                          soleRealMFAWithEmailSms &&
                          hasWebauthn &&
                          !hasTotp &&
                          webauthnCredentials.length === 1
                        }
                        title={
                          soleRealMFAWithEmailSms &&
                          hasWebauthn &&
                          !hasTotp &&
                          webauthnCredentials.length === 1
                            ? 'Disable Email/SMS first — this is your only real MFA method'
                            : 'Revoke this key'
                        }
                        onClick={() => {
                          setActionModal({
                            type: 'revoke-webauthn',
                            credentialId: cred.id,
                            credentialName: cred.credential_name,
                          });
                          setActionPassword('');
                          setActionMfaCode('');
                          setActionError('');
                        }}
                      >
                        Revoke
                      </button>
                    )}
                  </div>
                ))}
                {soleRealMFAWithEmailSms &&
                  hasWebauthn &&
                  !hasTotp &&
                  webauthnCredentials.length === 1 && (
                    <span className="mfa-action-hint">
                      Disable Email/SMS before revoking your only MFA method
                    </span>
                  )}
                {webauthnCredentials.length < 10 && (
                  <button
                    type="button"
                    className="btn btn-uniform btn-secondary mfa-add-key-btn"
                    onClick={() =>
                      onSetupWebAuthn(tier.level === 'maximum' ? 'hardware' : 'platform')
                    }
                  >
                    + Add Another Key
                  </button>
                )}
              </div>
            )}

            {/* Email/SMS Disable button */}
            {tier.level === 'last-resort' && isActive && onDisableEmailSms && (
              <div className="mfa-tier-actions">
                <button
                  type="button"
                  className="btn btn-uniform btn-danger"
                  onClick={() => {
                    setActionModal({ type: 'disable-emailsms' });
                    setActionPassword('');
                    setActionMfaCode('');
                    setActionError('');
                  }}
                >
                  Disable
                </button>
              </div>
            )}

            {/* Recovery-Only toggle */}
            {tier.recoveryOnlyEligible && isActive && onToggleRecoveryOnly && (
              <div className="mfa-toggle-row">
                <div className="mfa-toggle-text">
                  <span className="mfa-recovery-only-label">Recovery only</span>
                  <span className="mfa-recovery-only-hint">
                    Can verify your identity for account recovery, but won&apos;t be accepted for
                    login or sensitive actions. Like a spare key that unlocks the door but
                    doesn&apos;t start the engine.
                  </span>
                </div>
                <ToggleSwitch
                  checked={isRecoveryOnly}
                  onChange={(checked) => {
                    // Determine which method to toggle
                    const method =
                      tier.level === 'last-resort'
                        ? hasEmail
                          ? 'email'
                          : 'sms'
                        : tier.methodKey || '';
                    setActionModal({
                      type: 'toggle-recovery-only',
                      toggleMethod: method,
                      toggleValue: checked,
                    });
                    setActionPassword('');
                    setActionMfaCode('');
                    setActionError('');
                  }}
                />
              </div>
            )}

            {/* Hardened mode toggle — shown whenever Email/SMS is active */}
            {tier.level === 'last-resort' && isActive && onToggleRecoveryHardened && (
              <div className="mfa-toggle-row mfa-hardened-toggle">
                <div className="mfa-toggle-text">
                  <span className="mfa-recovery-only-label">Hardened mode</span>
                  <span className="mfa-recovery-only-hint">
                    Require BOTH an email code AND an SMS code for recovery. An attacker must
                    compromise both your email and your phone — neither alone is sufficient.
                  </span>
                </div>
                <ToggleSwitch
                  checked={recoveryHardened}
                  onChange={(checked) => {
                    setActionModal({
                      type: 'toggle-hardened',
                      toggleValue: checked,
                    });
                    setActionPassword('');
                    setActionMfaCode('');
                    setActionError('');
                  }}
                />
              </div>
            )}

            {/* Backup Email — under Email/SMS tier */}
            {tier.level === 'last-resort' && isActive && onSetBackupEmail && (
              <div className="mfa-backup-email-section">
                <label className="mfa-backup-email-label">Backup Email</label>
                <span className="mfa-backup-email-hint">
                  A secondary email for recovery if your primary email is compromised.
                </span>
                {editingBackupEmail ? (
                  <div className="mfa-backup-email-edit">
                    <input
                      type="email"
                      className="mfa-backup-email-input"
                      value={backupEmailDraft}
                      onChange={(e) => {
                        setBackupEmailDraft(e.target.value);
                        setBackupEmailError('');
                      }}
                      placeholder="backup@example.com"
                    />
                    {backupEmailError && (
                      <span className="mfa-backup-email-error">{backupEmailError}</span>
                    )}
                    <div className="mfa-backup-email-actions">
                      <button
                        type="button"
                        className="btn btn-xs btn-primary"
                        onClick={handleSaveBackupEmail}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        className="btn btn-xs btn-secondary"
                        onClick={() => {
                          setEditingBackupEmail(false);
                          setBackupEmailDraft(backupEmail || '');
                          setBackupEmailError('');
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="mfa-backup-email-display">
                    <button
                      type="button"
                      className="btn btn-xs btn-secondary"
                      onClick={() => {
                        setEditingBackupEmail(true);
                        setBackupEmailDraft(backupEmail || '');
                      }}
                    >
                      {backupEmail ? 'Change' : 'Add'}
                    </button>
                    <span className="mfa-backup-email-value">{backupEmail || 'Not set'}</span>
                  </div>
                )}
              </div>
            )}

            {/* Recovery-Only description for eligible but inactive tiers */}
            {tier.recoveryOnlyEligible && !isActive && !isLocked && (
              <p className="mfa-recovery-only-preview">
                Once set up, this method can be restricted to account recovery only.
              </p>
            )}

            {isLocked && (
              <div className="mfa-tier-lock-overlay">
                <span>{tier.lockReason}</span>
              </div>
            )}
            {!isLocked && !isActive && (
              <div className="mfa-tier-actions mfa-tier-actions-left">
                {tier.level === 'standard' && (
                  <button
                    type="button"
                    className="btn btn-uniform btn-primary"
                    onClick={onSetupTOTP}
                  >
                    Set Up
                  </button>
                )}
                {(tier.level === 'maximum' || tier.level === 'strong') && (
                  <button
                    type="button"
                    className="btn btn-uniform btn-primary"
                    onClick={() =>
                      onSetupWebAuthn(tier.level === 'maximum' ? 'hardware' : 'platform')
                    }
                  >
                    Set Up
                  </button>
                )}
                {tier.level === 'last-resort' && onSetupEmailSms && (
                  <button
                    type="button"
                    className="btn btn-uniform btn-primary"
                    onClick={onSetupEmailSms}
                  >
                    Set Up
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* Action confirmation modal */}
      {actionModal && (
        <div className="mfa-modal-overlay">
          <div className="mfa-modal">
            <h3>{actionTitle}</h3>
            <p className="mfa-modal-desc">{actionDesc}</p>

            <div className="mfa-verify-field">
              <label>Password</label>
              <input
                type="password"
                value={actionPassword}
                onChange={(e) => setActionPassword(e.target.value)}
                placeholder="Enter your password"
                disabled={actionLoading}
              />
            </div>

            {hasRealMFA && (
              <MFAVerifyPrompt
                methods={activeMethods}
                recoveryOnlyMethods={recoveryOnlyMethods}
                onVerify={(code) => setActionMfaCode(code)}
                disabled={actionLoading}
                error={actionError || undefined}
              />
            )}

            {actionError && !hasRealMFA && <p className="mfa-setup-error">{actionError}</p>}

            <div className="mfa-setup-actions">
              <button
                type="button"
                className={
                  actionModal.type === 'toggle-recovery-only' ||
                  actionModal.type === 'toggle-hardened'
                    ? 'btn btn-sm btn-primary'
                    : 'btn btn-sm btn-danger'
                }
                onClick={handleAction}
                disabled={actionLoading || !actionPassword}
              >
                {actionLoading ? 'Processing...' : 'Confirm'}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                onClick={() => {
                  setActionModal(null);
                  setActionPassword('');
                  setActionMfaCode('');
                  setActionError('');
                }}
                disabled={actionLoading}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MFATierSelector;
