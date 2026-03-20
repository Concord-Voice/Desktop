import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import { useUserStore } from '../../stores/userStore';
import { usePrivacyStore, DMPrivacyLevel } from '../../stores/privacyStore';
import { apiFetch, API_BASE } from '../../services/apiClient';
import LoadingSpinner from '../Auth/LoadingSpinner';
import Modal from '../ui/Modal';
import ToggleSwitch from './ToggleSwitch';
import MFATierSelector, { WebAuthnCredential } from './MFATierSelector';
import MFASetup from './MFASetup';
import MFAVerifyPrompt from '../Auth/MFAVerifyPrompt';
import BackupCodeDisplay from './BackupCodeDisplay';
import EmailSmsSetup from './EmailSmsSetup';
import CollapsibleSection from './CollapsibleSection';
import {
  useOsPermissionStore,
  type OsPermissionType,
  type OsPermissionStatus,
} from '../../stores/osPermissionStore';
import './MFA.css';

interface Session {
  id: string;
  device_name: string;
  ip_address: string;
  user_agent: string;
  machine_id?: string;
  expires_at: string;
  created_at: string;
  last_used: string;
  is_current: boolean;
}

interface PastSession {
  id: string;
  device_name: string;
  ip_address: string;
  user_agent: string;
  created_at: string;
  last_used: string;
  revoked_at: string;
}

// ─── System Permissions Sub-section (#197) ─────────────────────────────

const PERMISSION_ROWS: {
  type: OsPermissionType;
  label: string;
  description: string;
  critical?: boolean;
}[] = [
  {
    type: 'secureStorage',
    label: 'Secure Storage (Keychain)',
    description: 'Required to safely store authentication tokens and encryption keys.',
    critical: true,
  },
  {
    type: 'microphone',
    label: 'Microphone',
    description: 'Used for voice channels and calls.',
  },
  {
    type: 'camera',
    label: 'Camera',
    description: 'Used for video in voice channels and calls.',
  },
  {
    type: 'screen',
    label: 'Screen Recording',
    description: 'Used for screen sharing in voice channels.',
  },
  {
    type: 'notifications',
    label: 'Notifications',
    description: 'Used for desktop notifications and incoming call alerts.',
  },
];

function permissionStatusBadge(status: OsPermissionStatus): {
  className: string;
  label: string;
} {
  switch (status) {
    case 'granted':
      return { className: 'os-perm-badge os-perm-badge--granted', label: 'Granted' };
    case 'denied':
      return { className: 'os-perm-badge os-perm-badge--denied', label: 'Denied' };
    case 'restricted':
      return { className: 'os-perm-badge os-perm-badge--denied', label: 'Restricted' };
    case 'not-determined':
      return { className: 'os-perm-badge os-perm-badge--pending', label: 'Not Requested' };
    case 'unavailable':
      return { className: 'os-perm-badge os-perm-badge--unavailable', label: 'Unavailable' };
    default:
      return { className: 'os-perm-badge', label: 'Unknown' };
  }
}

const SystemPermissionsSection: React.FC = () => {
  const fetchAll = useOsPermissionStore((s) => s.fetchAll);
  const requestOne = useOsPermissionStore((s) => s.requestOne);
  const openSettings = useOsPermissionStore((s) => s.openSettings);
  const isLoaded = useOsPermissionStore((s) => s.isLoaded);
  const [platform, setPlatform] = useState('');

  // Fetch fresh permission statuses when Settings is opened
  useEffect(() => {
    fetchAll();
    window.electron?.getPlatform?.().then(setPlatform);
  }, [fetchAll]);

  // On non-macOS, mic/camera/screen are always 'granted' (Chromium handles them).
  // Hide request/fix buttons for those since there's no OS-level gate.
  const hasMacOsGate = (type: OsPermissionType): boolean => {
    if (platform !== 'darwin') return false;
    return type === 'microphone' || type === 'camera' || type === 'screen';
  };

  const showActionButton = (type: OsPermissionType, status: OsPermissionStatus): boolean => {
    // secureStorage: show "Fix" if unavailable (all platforms)
    if (type === 'secureStorage') return status === 'unavailable';
    // notifications: show "Request" if not-determined (all platforms)
    if (type === 'notifications') return status === 'not-determined';
    // mic/camera/screen: only actionable on macOS
    if (!hasMacOsGate(type)) return false;
    return status === 'not-determined' || status === 'denied' || status === 'restricted';
  };

  return (
    <CollapsibleSection id="section-system-permissions" title="System Permissions" defaultOpen>
      <p className="settings-section-description">
        Concord requests system permissions only when needed. If a permission is denied, you can
        grant it in your operating system&apos;s settings.
      </p>

      {!isLoaded ? (
        <div className="settings-row">
          <span className="settings-row-label">Loading permission statuses...</span>
        </div>
      ) : (
        PERMISSION_ROWS.map((row) => (
          <PermissionRow
            key={row.type}
            type={row.type}
            label={row.label}
            description={row.description}
            critical={row.critical}
            showAction={showActionButton}
            onRequest={requestOne}
            onOpenSettings={openSettings}
          />
        ))
      )}
    </CollapsibleSection>
  );
};

const PermissionRow: React.FC<{
  type: OsPermissionType;
  label: string;
  description: string;
  critical?: boolean;
  showAction: (type: OsPermissionType, status: OsPermissionStatus) => boolean;
  onRequest: (type: OsPermissionType) => Promise<OsPermissionStatus>;
  onOpenSettings: (type: OsPermissionType) => Promise<void>;
}> = ({ type, label, description, critical, showAction, onRequest, onOpenSettings }) => {
  const status = useOsPermissionStore((s) => s[type]);
  const badge = permissionStatusBadge(status);
  const [isRequesting, setIsRequesting] = useState(false);

  const handleRequest = async () => {
    setIsRequesting(true);
    try {
      await onRequest(type);
    } finally {
      setIsRequesting(false);
    }
  };

  const handleOpenSettings = () => {
    onOpenSettings(type);
  };

  return (
    <div
      className={`settings-row ${critical && status !== 'granted' ? 'settings-row--warning' : ''}`}
    >
      <div className="settings-row-info">
        <span className="settings-row-label">
          {label}
          {critical && <span className="os-perm-critical"> (Required)</span>}
        </span>
        <span className="settings-row-hint">{description}</span>
        {critical && status !== 'granted' && (
          <span className="settings-row-hint os-perm-warning">
            Secure storage is required for login. Please enable keychain / credential manager
            access.
          </span>
        )}
      </div>
      <div className="os-perm-actions">
        <span className={badge.className}>{badge.label}</span>
        {showAction(type, status) && (
          <>
            {status === 'not-determined' ? (
              <button
                className="btn btn-sm btn-primary"
                onClick={handleRequest}
                disabled={isRequesting}
              >
                {isRequesting ? 'Requesting...' : 'Request'}
              </button>
            ) : (
              <button className="btn btn-sm btn-secondary" onClick={handleOpenSettings}>
                Fix
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
};

const PrivacySecuritySection: React.FC = () => {
  const accessToken = useAuthStore((s) => s.accessToken);
  const logout = useUserStore((s) => s.logout);
  const navigate = useNavigate();
  const privacySettings = usePrivacyStore((s) => s.settings);
  const fetchPrivacy = usePrivacyStore((s) => s.fetchPrivacy);
  const updatePrivacy = usePrivacyStore((s) => s.updatePrivacy);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [pastSessions, setPastSessions] = useState<PastSession[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [isRevokingAll, setIsRevokingAll] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null); // session id for individual confirm
  const [showRevokeAllModal, setShowRevokeAllModal] = useState(false);
  const [revokePassword, setRevokePassword] = useState('');
  const [revokeMfaCode, setRevokeMfaCode] = useState('');
  const [revokePasswordError, setRevokePasswordError] = useState('');

  // Revocation mode (Simple / Secure toggle)
  const [revocationMode, setRevocationMode] = useState<'simple' | 'secure'>('secure');
  const [showModeChangeModal, setShowModeChangeModal] = useState(false);
  const [pendingMode, setPendingMode] = useState<'simple' | 'secure' | null>(null);
  const [modeChangePassword, setModeChangePassword] = useState('');
  const [modeChangeMfaCode, setModeChangeMfaCode] = useState('');
  const [modeChangeError, setModeChangeError] = useState('');
  const [isChangingMode, setIsChangingMode] = useState(false);

  // Individual session revoke auth modal
  const [showSessionPasswordModal, setShowSessionPasswordModal] = useState(false);
  const [sessionPasswordTarget, setSessionPasswordTarget] = useState<string | null>(null);
  const [sessionMfaCode, setSessionMfaCode] = useState('');

  // MFA state
  const [mfaMethods, setMfaMethods] = useState<string[]>([]);
  const [mfaRecoveryOnly, setMfaRecoveryOnly] = useState<string[]>([]);
  const [mfaRecoveryHardened, setMfaRecoveryHardened] = useState(false);
  const [mfaBackupRemaining, setMfaBackupRemaining] = useState<number | undefined>();
  const [mfaWebauthnCredentials, setMfaWebauthnCredentials] = useState<WebAuthnCredential[]>([]);
  const [mfaBackupEmail, setMfaBackupEmail] = useState('');
  const [mfaSetupMethod, setMfaSetupMethod] = useState<'totp' | 'webauthn' | 'email-sms' | null>(
    null
  );
  const [webauthnCredentialType, setWebauthnCredentialType] = useState<'hardware' | 'platform'>(
    'hardware'
  );
  const [sessionPassword, setSessionPassword] = useState('');
  const [sessionPasswordError, setSessionPasswordError] = useState('');

  // Backup code reset modal
  const [showBackupReset, setShowBackupReset] = useState(false);
  const [backupResetPassword, setBackupResetPassword] = useState('');
  const [backupResetMfaCode, setBackupResetMfaCode] = useState('');
  const [backupResetError, setBackupResetError] = useState('');
  const [backupResetLoading, setBackupResetLoading] = useState(false);
  const [backupResetCodes, setBackupResetCodes] = useState<string[] | null>(null);

  // Local DM privacy level for responsive slider (debounces API calls)
  const [localDmLevel, setLocalDmLevel] = useState<DMPrivacyLevel>(privacySettings.dmPrivacyLevel);
  const dmDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync local state when store updates (e.g., after fetch)
  useEffect(() => {
    setLocalDmLevel(privacySettings.dmPrivacyLevel);
  }, [privacySettings.dmPrivacyLevel]);

  const setDmPrivacyLevel = useCallback(
    (level: DMPrivacyLevel) => {
      setLocalDmLevel(level);
      if (dmDebounceRef.current) clearTimeout(dmDebounceRef.current);
      dmDebounceRef.current = setTimeout(() => {
        updatePrivacy({ dmPrivacyLevel: level });
      }, 300);
    },
    [updatePrivacy]
  );

  // Cleanup debounce timer
  useEffect(() => {
    return () => {
      if (dmDebounceRef.current) clearTimeout(dmDebounceRef.current);
    };
  }, []);

  const fetchSessions = useCallback(async () => {
    if (!accessToken) return;
    setIsLoading(true);
    setError(null);

    try {
      const response = await apiFetch('/api/v1/sessions');

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to fetch sessions');
      }

      const data = await response.json();
      setSessions(data.sessions || []);
      setPastSessions(data.past_sessions || []);
      if (data.revocation_mode) setRevocationMode(data.revocation_mode);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch sessions');
    } finally {
      setIsLoading(false);
    }
  }, [accessToken]);

  const fetchMFAStatus = useCallback(async () => {
    if (!accessToken) return;
    try {
      const res = await apiFetch('/api/v1/mfa/status');
      if (res.ok) {
        const data = await res.json();
        setMfaMethods(data.methods || []);
        setMfaRecoveryOnly(data.recovery_only_methods || []);
        setMfaRecoveryHardened(data.recovery_hardened || false);
        setMfaBackupRemaining(data.backup_codes_remaining);
        setMfaBackupEmail(data.backup_email || '');
      }
      // Fetch WebAuthn credentials list
      const credRes = await apiFetch('/api/v1/mfa/webauthn/credentials');
      if (credRes.ok) {
        const credData = await credRes.json();
        setMfaWebauthnCredentials(credData.credentials || []);
      }
    } catch {
      // Non-critical — MFA status fetch failure doesn't block the page
    }
  }, [accessToken]);

  useEffect(() => {
    fetchSessions();
    fetchPrivacy();
    fetchMFAStatus();
  }, [fetchSessions, fetchPrivacy, fetchMFAStatus]);

  const handleBackupReset = async () => {
    setBackupResetError('');
    setBackupResetLoading(true);
    try {
      const res = await apiFetch('/api/v1/mfa/backup-codes/regenerate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: backupResetPassword, mfa_code: backupResetMfaCode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to regenerate backup codes');
      setBackupResetCodes(data.backup_codes || []);
      fetchMFAStatus();
    } catch (err) {
      setBackupResetError(err instanceof Error ? err.message : 'Failed to regenerate codes');
    } finally {
      setBackupResetLoading(false);
    }
  };

  // Sort sessions: current session always first, then by last_used descending
  const sortedSessions = useMemo(() => {
    return [...sessions].sort((a, b) => {
      if (a.is_current && !b.is_current) return -1;
      if (!a.is_current && b.is_current) return 1;
      return new Date(b.last_used).getTime() - new Date(a.last_used).getTime();
    });
  }, [sessions]);

  const handleRevoke = async (sessionId: string, password?: string, mfaCode?: string) => {
    if (!accessToken) return;

    // Check if this is the current session — requires confirmation
    const session = sessions.find((s) => s.id === sessionId);
    if (session?.is_current && confirmRevoke !== sessionId) {
      setConfirmRevoke(sessionId);
      return;
    }

    setConfirmRevoke(null);
    setRevokingId(sessionId);

    try {
      const fetchOpts: RequestInit = { method: 'DELETE' };
      if (password || mfaCode) {
        fetchOpts.headers = { 'Content-Type': 'application/json' };
        const body: Record<string, string> = {};
        if (password) body.password = password;
        if (mfaCode) body.mfa_code = mfaCode;
        fetchOpts.body = JSON.stringify(body);
      }

      const response = await apiFetch(`/api/v1/sessions/${sessionId}`, fetchOpts);

      if (!response.ok) {
        const data = await response.json();

        if (
          response.status === 403 &&
          (data.error === 'password_required' || data.error === 'auth_required')
        ) {
          // Server says authentication needed — open auth modal
          setSessionPasswordTarget(sessionId);
          setSessionPassword('');
          setSessionMfaCode('');
          setSessionPasswordError('');
          setShowSessionPasswordModal(true);
          setRevokingId(null);
          return;
        }

        if (response.status === 403 && data.error === 'Incorrect password') {
          setSessionPasswordError('Incorrect password');
          setRevokingId(null);
          return;
        }

        if (response.status === 403 && data.error === 'Invalid MFA code') {
          setSessionPasswordError('Invalid MFA code');
          setRevokingId(null);
          return;
        }

        throw new Error(data.error || 'Failed to revoke session');
      }

      // Success — close password modal if open
      setShowSessionPasswordModal(false);
      setSessionPasswordTarget(null);
      setSessionPassword('');
      setSessionPasswordError('');

      // If we revoked the current session, log out
      if (session?.is_current) {
        await logout();
        navigate('/');
        return;
      }

      // Remove from active list immediately, then re-fetch for accurate server state
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      fetchSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke session');
    } finally {
      setRevokingId(null);
    }
  };

  const openRevokeAllModal = () => {
    setRevokePassword('');
    setRevokeMfaCode('');
    setRevokePasswordError('');
    setShowRevokeAllModal(true);
  };

  const closeRevokeAllModal = () => {
    setShowRevokeAllModal(false);
    setRevokePassword('');
    setRevokeMfaCode('');
    setRevokePasswordError('');
  };

  const openModeChangeModal = (mode: 'simple' | 'secure') => {
    setPendingMode(mode);
    setModeChangePassword('');
    setModeChangeMfaCode('');
    setModeChangeError('');
    setShowModeChangeModal(true);
  };

  const closeModeChangeModal = () => {
    setShowModeChangeModal(false);
    setPendingMode(null);
    setModeChangePassword('');
    setModeChangeMfaCode('');
    setModeChangeError('');
  };

  const handleModeChange = async () => {
    if (!accessToken || !pendingMode) return;
    if (hasMFA ? !modeChangeMfaCode : !modeChangePassword) return;

    setIsChangingMode(true);

    try {
      const body: Record<string, string> = { mode: pendingMode };
      if (hasMFA) {
        body.mfa_code = modeChangeMfaCode;
      } else {
        body.password = modeChangePassword;
      }

      const response = await apiFetch('/api/v1/sessions/revocation-mode', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const data = await response.json();
        if (response.status === 403) {
          setModeChangeError(
            data.error === 'Incorrect password'
              ? 'Incorrect password'
              : data.error === 'Invalid MFA code'
                ? 'Invalid MFA code'
                : data.error || 'Authentication failed'
          );
          setIsChangingMode(false);
          return;
        }
        throw new Error(data.error || 'Failed to change revocation mode');
      }

      const data = await response.json();
      setRevocationMode(data.revocation_mode);
      closeModeChangeModal();
    } catch (err) {
      setModeChangeError(err instanceof Error ? err.message : 'Failed to change revocation mode');
    } finally {
      setIsChangingMode(false);
    }
  };

  const closeSessionPasswordModal = () => {
    setShowSessionPasswordModal(false);
    setSessionPasswordTarget(null);
    setSessionPassword('');
    setSessionMfaCode('');
    setSessionPasswordError('');
  };

  const hasMFA = mfaMethods.length > 0;

  const handleRevokeAll = async () => {
    if (!accessToken) return;

    if (hasMFA) {
      if (!revokeMfaCode) {
        setRevokePasswordError('MFA verification is required');
        return;
      }
    } else {
      if (!revokePassword) {
        setRevokePasswordError('Password is required');
        return;
      }
    }

    setIsRevokingAll(true);

    try {
      const body: Record<string, unknown> = { include_current: true };
      if (hasMFA) {
        body.mfa_code = revokeMfaCode;
      } else {
        body.password = revokePassword;
      }

      const response = await apiFetch('/api/v1/sessions/revoke-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const data = await response.json();
        if (response.status === 403) {
          setRevokePasswordError(
            data.error === 'Invalid MFA code'
              ? 'Invalid MFA code'
              : data.error === 'Incorrect password'
                ? 'Incorrect password'
                : data.error || 'Authentication failed'
          );
          setIsRevokingAll(false);
          return;
        }
        throw new Error(data.error || 'Failed to revoke sessions');
      }

      setRevokePassword('');
      setRevokeMfaCode('');
      setShowRevokeAllModal(false);
      // All sessions revoked including current — log out
      await logout();
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke sessions');
      setShowRevokeAllModal(false);
    } finally {
      setIsRevokingAll(false);
    }
  };

  const formatRelativeTime = (dateStr: string): string => {
    const now = new Date();
    const date = new Date(dateStr);
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    const diffHr = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHr / 24);

    if (diffMin < 1) return 'Just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHr < 24) return `${diffHr}h ago`;
    if (diffDay < 30) return `${diffDay}d ago`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const parseUserAgent = (ua: string): string => {
    if (!ua) return 'Unknown Device';
    if (ua.includes('Electron')) return 'Concord Voice Desktop';
    if (ua.includes('Chrome')) return 'Chrome Browser';
    if (ua.includes('Firefox')) return 'Firefox Browser';
    if (ua.includes('Safari')) return 'Safari Browser';
    return 'Unknown Device';
  };

  return (
    <>
      <CollapsibleSection id="section-privacy-settings" title="Privacy">
        <p className="settings-section-description">
          Control who can message you and how others can find you.
        </p>

        <div className="settings-tier-slider-container">
          <span className="settings-row-label">Who Can DM You</span>
          <div className="settings-tier-labels">
            {(['No One', 'Friends', 'Friends + Server', 'Everyone'] as const).map((label, i) => (
              <span
                key={label}
                className={`settings-tier-label ${localDmLevel === i ? 'active' : ''}`}
                onClick={() => setDmPrivacyLevel(i as DMPrivacyLevel)}
              >
                {label}
              </span>
            ))}
          </div>
          <div className="settings-tier-track dm-privacy-track">
            <div className="settings-tier-ticks">
              {[0, 1, 2, 3].map((i) => (
                <span
                  key={i}
                  className={`settings-tier-tick ${localDmLevel === i ? 'active' : ''}`}
                />
              ))}
            </div>
            <input
              type="range"
              className="settings-tier-slider"
              min={0}
              max={3}
              step={1}
              value={localDmLevel}
              onChange={(e) => setDmPrivacyLevel(Number(e.target.value) as DMPrivacyLevel)}
            />
          </div>
          <div className="settings-tier-description">
            <span>
              {localDmLevel === 0
                ? 'No One'
                : localDmLevel === 1
                  ? 'Friends Only'
                  : localDmLevel === 2
                    ? 'Friends + Server Members'
                    : 'Allow All'}
            </span>
            <span>
              {localDmLevel === 0
                ? "Hermit mode. Nobody can DM you. You've chosen peace and silence. Existing DMs are frozen solid."
                : localDmLevel === 1
                  ? "Inner circle only. If they're not on your friends list, they're talking to a wall."
                  : localDmLevel === 2
                    ? 'The social butterfly. Friends and anyone you share a server with can slide into your DMs.'
                    : 'Open season. Anyone on the platform can message you. Bold move.'}
            </span>
          </div>
        </div>

        <div
          className={`settings-row ${localDmLevel === 0 || localDmLevel === 3 ? 'settings-row-disabled' : ''}`}
        >
          <div className="settings-row-info">
            <span className="settings-row-label">Allow Friends-of-Friends</span>
            <span className="settings-row-hint">
              {localDmLevel === 0
                ? 'DMs are disabled — this setting has no effect.'
                : localDmLevel === 3
                  ? 'Everyone can already DM you — friends-of-friends is included.'
                  : 'Also allow DMs from people who share a mutual friend with you'}
            </span>
          </div>
          <ToggleSwitch
            checked={
              localDmLevel === 3
                ? true
                : localDmLevel === 0
                  ? false
                  : privacySettings.dmFriendsOfFriends
            }
            onChange={(v) => {
              if (localDmLevel !== 0 && localDmLevel !== 3) {
                updatePrivacy({ dmFriendsOfFriends: v });
              }
            }}
            disabled={localDmLevel === 0 || localDmLevel === 3}
          />
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Auto-Accept Friend Requests from Codes</span>
            <span className="settings-row-hint">
              Automatically accept when someone uses your friend code
            </span>
          </div>
          <ToggleSwitch
            checked={privacySettings.autoAcceptFriendCodes}
            onChange={(v) => updatePrivacy({ autoAcceptFriendCodes: v })}
          />
        </div>

        <h3 className="settings-subsection-title" style={{ marginTop: 20 }}>
          Content Safety
        </h3>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Allow Embedded Content</span>
            <span className="settings-row-hint">
              Render link previews, image thumbnails, and other embedded content in messages. When
              disabled, only the raw message text is shown — no external requests are made,
              protecting your IP address from off-app tracking beacons. Server moderators with the
              Manage All Messages permission can also suppress embeds on individual messages
              regardless of this setting.
            </span>
          </div>
          <ToggleSwitch
            checked={privacySettings.allowEmbeddedContent}
            onChange={(v) => updatePrivacy({ allowEmbeddedContent: v })}
          />
        </div>

        <h3 className="settings-subsection-title" style={{ marginTop: 20 }}>
          Search Visibility
        </h3>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Searchable by Username</span>
            <span className="settings-row-hint">
              Allow others to find you by searching your username
            </span>
          </div>
          <ToggleSwitch
            checked={privacySettings.searchableByUsername}
            onChange={(v) => updatePrivacy({ searchableByUsername: v })}
          />
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Searchable by Email</span>
            <span className="settings-row-hint">Allow others to find you by email address</span>
          </div>
          <ToggleSwitch
            checked={privacySettings.searchableByEmail}
            onChange={(v) => updatePrivacy({ searchableByEmail: v })}
          />
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Searchable by Phone Number</span>
            <span className="settings-row-hint">Allow others to find you by phone number</span>
          </div>
          <ToggleSwitch
            checked={privacySettings.searchableByPhone}
            onChange={(v) => updatePrivacy({ searchableByPhone: v })}
          />
        </div>
      </CollapsibleSection>

      <SystemPermissionsSection />

      <CollapsibleSection id="section-mfa" title="Multi-Factor Authentication">
        <p className="settings-section-description">
          Add an extra layer of security to your account. When enabled, you&apos;ll need both your
          password and a second factor to sign in.
        </p>

        <div className="mfa-status-bar">
          <div className="mfa-status-item">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              style={{ flexShrink: 0 }}
            >
              <path d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
            </svg>
            <span>
              Security Keys: <strong>{mfaWebauthnCredentials.length}</strong> / 10
            </span>
          </div>
          <div className="mfa-status-item mfa-status-item-right">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              style={{ flexShrink: 0 }}
            >
              <path d="M9 12h6m-3-3v6m-7 4h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
            <span>
              Backup Codes:{' '}
              {mfaMethods.length === 0 ? (
                <em className="mfa-status-muted">Requires MFA</em>
              ) : (
                <>
                  <strong className={(mfaBackupRemaining ?? 0) <= 2 ? 'mfa-status-warn' : ''}>
                    {mfaBackupRemaining}
                  </strong>{' '}
                  / 8
                </>
              )}
            </span>
            <button
              type="button"
              className="btn btn-xs btn-reset-danger"
              disabled={!mfaBackupRemaining || mfaMethods.length === 0}
              onClick={() => {
                setShowBackupReset(true);
                setBackupResetPassword('');
                setBackupResetMfaCode('');
                setBackupResetError('');
                setBackupResetCodes(null);
              }}
            >
              Reset
              <br />
              Codes
            </button>
          </div>
        </div>

        {mfaSetupMethod === 'email-sms' ? (
          <EmailSmsSetup
            mfaActive={mfaMethods.length > 0}
            onComplete={() => {
              setMfaSetupMethod(null);
              fetchMFAStatus();
            }}
            onCancel={() => setMfaSetupMethod(null)}
          />
        ) : mfaSetupMethod ? (
          <MFASetup
            method={mfaSetupMethod}
            credentialType={mfaSetupMethod === 'webauthn' ? webauthnCredentialType : undefined}
            mfaActive={mfaMethods.length > 0}
            activeMethods={mfaMethods}
            recoveryOnlyMethods={mfaRecoveryOnly}
            onComplete={() => {
              setMfaSetupMethod(null);
              fetchMFAStatus();
            }}
            onCancel={() => setMfaSetupMethod(null)}
          />
        ) : (
          <MFATierSelector
            activeMethods={mfaMethods}
            recoveryOnlyMethods={mfaRecoveryOnly}
            recoveryHardened={mfaRecoveryHardened}
            backupCodesRemaining={mfaBackupRemaining}
            webauthnCredentials={mfaWebauthnCredentials}
            backupEmail={mfaBackupEmail}
            onSetupTOTP={() => setMfaSetupMethod('totp')}
            onSetupWebAuthn={(credType) => {
              setWebauthnCredentialType(credType);
              setMfaSetupMethod('webauthn');
            }}
            onSetupEmailSms={() => setMfaSetupMethod('email-sms')}
            onResetTOTP={async (password, code) => {
              const res = await apiFetch('/api/v1/mfa/totp/disable', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password, code }),
              });
              if (res.ok) {
                fetchMFAStatus();
                return true;
              }
              const data = await res.json().catch(() => ({}));
              throw new Error(data.error || 'Failed to disable TOTP');
            }}
            onRevokeWebAuthnKey={async (credentialId, password) => {
              const res = await apiFetch(`/api/v1/mfa/webauthn/credentials/${credentialId}`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password }),
              });
              if (res.ok) {
                const data = await res.json();
                // Signal the authenticator to clean up the deleted credential (best-effort).
                // Uses the WebAuthn Signal API (Chrome 132+) to hint that removed credentials
                // are no longer accepted, so platform/hardware authenticators can purge them.
                try {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const PKC = PublicKeyCredential as any;
                  if (
                    typeof PublicKeyCredential !== 'undefined' &&
                    typeof PKC.signalAllAcceptedCredentialIds === 'function' &&
                    data.remaining_credential_ids &&
                    data.user_id
                  ) {
                    const rpId = new URL(API_BASE).hostname;
                    const toBuffer = (b64url: string): ArrayBuffer => {
                      const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
                      const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
                      const bin = atob(b64 + pad);
                      const bytes = new Uint8Array(bin.length);
                      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                      return bytes.buffer;
                    };
                    // WebAuthn user ID is the UUID string as raw bytes
                    const encoder = new TextEncoder();
                    const userId = encoder.encode(data.user_id).buffer;
                    const remaining = (data.remaining_credential_ids as string[]).map(toBuffer);
                    await PKC.signalAllAcceptedCredentialIds({
                      rpId,
                      userId,
                      allAcceptedCredentialIds: remaining,
                    });
                  }
                } catch {
                  // Signal API is best-effort — don't block on failure
                }
                fetchMFAStatus();
                return true;
              }
              const errData = await res.json().catch(() => ({}));
              throw new Error(errData.error || 'Failed to revoke credential');
            }}
            onDisableEmailSms={async () => {
              const res = await apiFetch('/api/v1/mfa/email-sms/disable', {
                method: 'POST',
              });
              if (res.ok) {
                fetchMFAStatus();
                return true;
              }
              const errData = await res.json().catch(() => ({}));
              throw new Error(errData.error || 'Failed to disable Email/SMS');
            }}
            onSetBackupEmail={async (email) => {
              const res = await apiFetch('/api/v1/mfa/backup-email', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email }),
              });
              if (res.ok) {
                const data = await res.json();
                setMfaBackupEmail(data.backup_email || '');
                return true;
              }
              return false;
            }}
            onToggleRecoveryHardened={async (enabled, password, mfaCode) => {
              try {
                const res = await apiFetch('/api/v1/mfa/recovery-hardened', {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ enabled, password, mfa_code: mfaCode || undefined }),
                });
                if (res.ok) {
                  const data = await res.json();
                  setMfaRecoveryHardened(data.recovery_hardened);
                  return true;
                }
                return false;
              } catch {
                return false;
              }
            }}
            onToggleRecoveryOnly={async (method, recoveryOnly, password, mfaCode) => {
              const newList = recoveryOnly
                ? [...mfaRecoveryOnly, method]
                : mfaRecoveryOnly.filter((m) => m !== method);
              try {
                const res = await apiFetch('/api/v1/mfa/recovery-only', {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    methods: newList,
                    password,
                    mfa_code: mfaCode || undefined,
                  }),
                });
                if (res.ok) {
                  const data = await res.json();
                  setMfaRecoveryOnly(data.recovery_only_methods || []);
                  if (data.recovery_hardened !== undefined) {
                    setMfaRecoveryHardened(data.recovery_hardened);
                  }
                  return true;
                }
                return false;
              } catch {
                return false;
              }
            }}
          />
        )}

        {/* Backup code reset modal */}
        {showBackupReset && (
          <div className="mfa-modal-overlay">
            <div className="mfa-modal">
              <h3>Reset Backup Codes</h3>
              <p className="mfa-modal-desc">
                This will invalidate all existing backup codes and generate new ones.
              </p>

              {backupResetCodes ? (
                <BackupCodeDisplay
                  codes={backupResetCodes}
                  onConfirm={() => {
                    setShowBackupReset(false);
                    setBackupResetCodes(null);
                  }}
                  disabled={false}
                />
              ) : (
                <>
                  <div className="mfa-verify-field">
                    <label>Password</label>
                    <input
                      type="password"
                      value={backupResetPassword}
                      onChange={(e) => setBackupResetPassword(e.target.value)}
                      placeholder="Enter your password"
                      disabled={backupResetLoading}
                    />
                  </div>

                  <MFAVerifyPrompt
                    methods={mfaMethods}
                    recoveryOnlyMethods={mfaRecoveryOnly}
                    onVerify={(code) => setBackupResetMfaCode(code)}
                    disabled={backupResetLoading}
                    error={backupResetError || undefined}
                  />

                  <div className="mfa-setup-actions">
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      onClick={handleBackupReset}
                      disabled={backupResetLoading || !backupResetPassword || !backupResetMfaCode}
                    >
                      {backupResetLoading ? 'Regenerating...' : 'Regenerate Codes'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-secondary"
                      onClick={() => setShowBackupReset(false)}
                      disabled={backupResetLoading}
                    >
                      Cancel
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </CollapsibleSection>

      <CollapsibleSection id="section-active-sessions" title="Active Sessions">
        <p className="settings-section-description">
          These are the devices currently logged into your account. Revoke any session you
          don&apos;t recognize.
        </p>

        {!isLoading && (
          <div className="session-revocation-mode">
            <div className="session-revocation-mode-info">
              <span className="session-revocation-mode-label">Session Revocation</span>
              <span className="session-revocation-mode-description">
                {revocationMode === 'secure'
                  ? 'Authentication via Password or MFA is required to revoke sessions under certain circumstances.'
                  : 'Authenticate once to freely manage sessions for a short period.'}
              </span>
            </div>
            <div className="session-revocation-mode-toggle">
              <button
                className={`revocation-mode-btn ${revocationMode === 'secure' ? 'active' : ''}`}
                onClick={() => {
                  if (revocationMode !== 'secure') openModeChangeModal('secure');
                }}
              >
                Secure
              </button>
              <button
                className={`revocation-mode-btn ${revocationMode === 'simple' ? 'active' : ''}`}
                onClick={() => {
                  if (revocationMode !== 'simple') openModeChangeModal('simple');
                }}
              >
                Simple
              </button>
            </div>
          </div>
        )}

        {error && <div className="settings-error">{error}</div>}

        {isLoading ? (
          <div className="settings-loading">
            <LoadingSpinner size="small" inline />
          </div>
        ) : (
          <>
            {sessions.length > 0 && (
              <div className="sessions-actions-top">
                <button
                  className="sessions-revoke-all-btn"
                  onClick={openRevokeAllModal}
                  disabled={isRevokingAll}
                >
                  Revoke All Sessions
                </button>
              </div>
            )}

            <div className="sessions-list">
              {sortedSessions.map((session) => (
                <div
                  key={session.id}
                  className={`session-card ${session.is_current ? 'current' : ''}`}
                >
                  <div className="session-card-icon">
                    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                      <rect
                        x="2"
                        y="3"
                        width="16"
                        height="12"
                        rx="2"
                        stroke="currentColor"
                        strokeWidth="1.5"
                      />
                      <path
                        d="M7 19h6M10 15v4"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                      />
                    </svg>
                  </div>
                  <div className="session-card-info">
                    <div className="session-card-title">
                      {parseUserAgent(session.user_agent)}
                      {session.is_current && (
                        <span className="session-card-badge">This Device</span>
                      )}
                    </div>
                    <div className="session-card-details">
                      <span>{session.ip_address}</span>
                      <span>Active {formatRelativeTime(session.last_used)}</span>
                      <span>Created {formatRelativeTime(session.created_at)}</span>
                    </div>
                    {confirmRevoke === session.id && session.is_current && (
                      <div className="session-confirm-warning">
                        This is your current active session. Revoking it will log you out and you
                        must sign back in.
                      </div>
                    )}
                  </div>
                  <div className="session-card-actions">
                    {confirmRevoke === session.id ? (
                      <>
                        <button
                          className="session-revoke-btn confirm"
                          onClick={() => handleRevoke(session.id)}
                          disabled={revokingId === session.id}
                        >
                          {revokingId === session.id ? 'Revoking...' : 'Confirm'}
                        </button>
                        <button
                          className="session-cancel-btn"
                          onClick={() => setConfirmRevoke(null)}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        className="session-revoke-btn"
                        onClick={() => handleRevoke(session.id)}
                        disabled={revokingId === session.id}
                      >
                        {revokingId === session.id ? 'Revoking...' : 'Revoke'}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        <Modal
          isOpen={showRevokeAllModal}
          onClose={closeRevokeAllModal}
          title="Revoke All Sessions"
          width="small"
        >
          <div className="revoke-all-modal-content">
            <p className="revoke-all-modal-description">
              You&apos;re about to revoke all of your active session tokens, which will log you out
              of all sessions, including this one.{' '}
              {hasMFA
                ? 'Verify your identity to continue.'
                : 'In order to continue, please input your password.'}
            </p>
            {hasMFA ? (
              <>
                <MFAVerifyPrompt
                  methods={mfaMethods}
                  recoveryOnlyMethods={mfaRecoveryOnly}
                  onVerify={(code) => {
                    setRevokeMfaCode(code);
                    setRevokePasswordError('');
                  }}
                  disabled={isRevokingAll}
                  error={revokePasswordError || undefined}
                />
              </>
            ) : (
              <div className="revoke-password-input">
                <label htmlFor="revoke-all-password">Password</label>
                <input
                  id="revoke-all-password"
                  type="password"
                  value={revokePassword}
                  onChange={(e) => {
                    setRevokePassword(e.target.value);
                    setRevokePasswordError('');
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && revokePassword) handleRevokeAll();
                  }}
                  placeholder="Enter your password"
                  autoFocus
                />
                {revokePasswordError && (
                  <span className="revoke-password-error">{revokePasswordError}</span>
                )}
              </div>
            )}
            <div className="revoke-all-modal-actions">
              <button className="revoke-all-modal-cancel-btn" onClick={closeRevokeAllModal}>
                No, Cancel
              </button>
              <button
                className="revoke-all-modal-confirm-btn"
                onClick={handleRevokeAll}
                disabled={isRevokingAll || (hasMFA ? !revokeMfaCode : !revokePassword)}
              >
                {isRevokingAll ? 'Revoking...' : 'Yes, Revoke All Sessions'}
              </button>
            </div>
          </div>
        </Modal>

        {/* Individual session revoke auth modal */}
        <Modal
          isOpen={showSessionPasswordModal}
          onClose={closeSessionPasswordModal}
          title="Verify Your Identity"
          width="small"
        >
          <div className="revoke-all-modal-content">
            <p className="revoke-all-modal-description">
              For your security, {hasMFA ? 'verify your identity' : 'please enter your password'} to
              revoke this session.
            </p>
            {hasMFA ? (
              <>
                <MFAVerifyPrompt
                  methods={mfaMethods}
                  recoveryOnlyMethods={mfaRecoveryOnly}
                  onVerify={(code) => {
                    setSessionMfaCode(code);
                    setSessionPasswordError('');
                  }}
                  disabled={revokingId === sessionPasswordTarget}
                  error={sessionPasswordError || undefined}
                />
              </>
            ) : (
              <div className="revoke-password-input">
                <label htmlFor="session-revoke-password">Password</label>
                <input
                  id="session-revoke-password"
                  type="password"
                  value={sessionPassword}
                  onChange={(e) => {
                    setSessionPassword(e.target.value);
                    setSessionPasswordError('');
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && sessionPassword && sessionPasswordTarget) {
                      handleRevoke(sessionPasswordTarget, sessionPassword);
                    }
                  }}
                  placeholder="Enter your password"
                  autoFocus
                />
                {sessionPasswordError && (
                  <span className="revoke-password-error">{sessionPasswordError}</span>
                )}
              </div>
            )}
            <div className="revoke-all-modal-actions">
              <button className="revoke-all-modal-cancel-btn" onClick={closeSessionPasswordModal}>
                Cancel
              </button>
              <button
                className="revoke-all-modal-confirm-btn"
                onClick={() =>
                  sessionPasswordTarget &&
                  handleRevoke(
                    sessionPasswordTarget,
                    hasMFA ? undefined : sessionPassword,
                    hasMFA ? sessionMfaCode : undefined
                  )
                }
                disabled={
                  (hasMFA ? !sessionMfaCode : !sessionPassword) ||
                  revokingId === sessionPasswordTarget
                }
              >
                {revokingId === sessionPasswordTarget ? 'Revoking...' : 'Confirm & Revoke'}
              </button>
            </div>
          </div>
        </Modal>

        {/* Revocation mode change modal */}
        <Modal
          isOpen={showModeChangeModal}
          onClose={closeModeChangeModal}
          title="Change Revocation Mode"
          width="small"
        >
          <div className="revoke-all-modal-content">
            <p className="revoke-all-modal-description">
              {pendingMode === 'simple'
                ? 'Switching to Simple Revocation. You will be able to authenticate once and freely manage sessions for a short period.'
                : 'Switching to Secure Revocation. Authentication will be required to revoke sessions under certain circumstances.'}
            </p>
            {hasMFA ? (
              <MFAVerifyPrompt
                methods={mfaMethods}
                recoveryOnlyMethods={mfaRecoveryOnly}
                onVerify={(code) => {
                  setModeChangeMfaCode(code);
                  setModeChangeError('');
                }}
                disabled={isChangingMode}
                error={modeChangeError || undefined}
                excludeBackupCodes
              />
            ) : (
              <div className="revoke-password-input">
                <label htmlFor="mode-change-password">Password</label>
                <input
                  id="mode-change-password"
                  type="password"
                  value={modeChangePassword}
                  onChange={(e) => {
                    setModeChangePassword(e.target.value);
                    setModeChangeError('');
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && modeChangePassword) handleModeChange();
                  }}
                  placeholder="Enter your password"
                  autoFocus
                />
                {modeChangeError && (
                  <span className="revoke-password-error">{modeChangeError}</span>
                )}
              </div>
            )}
            <div className="revoke-all-modal-actions">
              <button className="revoke-all-modal-cancel-btn" onClick={closeModeChangeModal}>
                Cancel
              </button>
              <button
                className="revoke-all-modal-confirm-btn"
                onClick={handleModeChange}
                disabled={isChangingMode || (hasMFA ? !modeChangeMfaCode : !modeChangePassword)}
              >
                {isChangingMode ? 'Changing...' : 'Confirm'}
              </button>
            </div>
          </div>
        </Modal>
      </CollapsibleSection>

      {pastSessions.length > 0 && (
        <CollapsibleSection id="section-past-sessions" title="Past Sessions">
          <p className="settings-section-description">
            Sessions that were logged out or revoked in the last 30 days.
          </p>

          <div className="sessions-list">
            {pastSessions.map((session) => (
              <div key={session.id} className="session-card past">
                <div className="session-card-icon past">
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                    <rect
                      x="2"
                      y="3"
                      width="16"
                      height="12"
                      rx="2"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    />
                    <path
                      d="M7 19h6M10 15v4"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    />
                  </svg>
                </div>
                <div className="session-card-info">
                  <div className="session-card-title">
                    {parseUserAgent(session.user_agent)}
                    <span className="session-card-badge past">Revoked</span>
                  </div>
                  <div className="session-card-details">
                    <span>{session.ip_address}</span>
                    <span>Last active {formatRelativeTime(session.last_used)}</span>
                    <span>Revoked {formatRelativeTime(session.revoked_at)}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}
    </>
  );
};

export default PrivacySecuritySection;
