import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import { useUserStore } from '../../stores/userStore';
import { usePrivacyStore } from '../../stores/privacyStore';
import { apiFetch } from '../../services/apiClient';
import LoadingSpinner from '../Auth/LoadingSpinner';
import Modal from '../ui/Modal';
import ToggleSwitch from './ToggleSwitch';

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
  const [revokePasswordError, setRevokePasswordError] = useState('');

  // Revocation mode (Simple / Secure toggle)
  const [revocationMode, setRevocationMode] = useState<'simple' | 'secure'>('secure');
  const [showModeChangeModal, setShowModeChangeModal] = useState(false);
  const [pendingMode, setPendingMode] = useState<'simple' | 'secure' | null>(null);
  const [modeChangePassword, setModeChangePassword] = useState('');
  const [modeChangeError, setModeChangeError] = useState('');
  const [isChangingMode, setIsChangingMode] = useState(false);

  // Individual session revoke password modal
  const [showSessionPasswordModal, setShowSessionPasswordModal] = useState(false);
  const [sessionPasswordTarget, setSessionPasswordTarget] = useState<string | null>(null);
  const [sessionPassword, setSessionPassword] = useState('');
  const [sessionPasswordError, setSessionPasswordError] = useState('');

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

  useEffect(() => {
    fetchSessions();
    fetchPrivacy();
  }, [fetchSessions, fetchPrivacy]);

  // Sort sessions: current session always first, then by last_used descending
  const sortedSessions = useMemo(() => {
    return [...sessions].sort((a, b) => {
      if (a.is_current && !b.is_current) return -1;
      if (!a.is_current && b.is_current) return 1;
      return new Date(b.last_used).getTime() - new Date(a.last_used).getTime();
    });
  }, [sessions]);

  const handleRevoke = async (sessionId: string, password?: string) => {
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
      if (password) {
        fetchOpts.headers = { 'Content-Type': 'application/json' };
        fetchOpts.body = JSON.stringify({ password });
      }

      const response = await apiFetch(`/api/v1/sessions/${sessionId}`, fetchOpts);

      if (!response.ok) {
        const data = await response.json();

        if (response.status === 403 && data.error === 'password_required') {
          // Server says password needed — open password modal
          setSessionPasswordTarget(sessionId);
          setSessionPassword('');
          setSessionPasswordError('');
          setShowSessionPasswordModal(true);
          setRevokingId(null);
          return;
        }

        if (response.status === 403 && data.error === 'Incorrect password') {
          // Wrong password — show error in modal
          setSessionPasswordError('Incorrect password');
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

      // Move to past sessions and re-fetch for updated state
      setSessions((prev) => {
        const revoked = prev.find((s) => s.id === sessionId);
        if (revoked) {
          setPastSessions((past) => [
            {
              id: revoked.id,
              device_name: revoked.device_name,
              ip_address: revoked.ip_address,
              user_agent: revoked.user_agent,
              created_at: revoked.created_at,
              last_used: revoked.last_used,
              revoked_at: new Date().toISOString(),
            },
            ...past,
          ]);
        }
        return prev.filter((s) => s.id !== sessionId);
      });

      // Re-fetch to get updated server state
      fetchSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke session');
    } finally {
      setRevokingId(null);
    }
  };

  const openRevokeAllModal = () => {
    setRevokePassword('');
    setRevokePasswordError('');
    setShowRevokeAllModal(true);
  };

  const closeRevokeAllModal = () => {
    setShowRevokeAllModal(false);
    setRevokePassword('');
    setRevokePasswordError('');
  };

  const openModeChangeModal = (mode: 'simple' | 'secure') => {
    setPendingMode(mode);
    setModeChangePassword('');
    setModeChangeError('');
    setShowModeChangeModal(true);
  };

  const closeModeChangeModal = () => {
    setShowModeChangeModal(false);
    setPendingMode(null);
    setModeChangePassword('');
    setModeChangeError('');
  };

  const handleModeChange = async () => {
    if (!accessToken || !pendingMode || !modeChangePassword) return;

    setIsChangingMode(true);

    try {
      const response = await apiFetch('/api/v1/sessions/revocation-mode', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: pendingMode,
          password: modeChangePassword,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        if (response.status === 403) {
          setModeChangeError(
            data.error === 'Incorrect password'
              ? 'Incorrect password'
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
    setSessionPasswordError('');
  };

  const handleRevokeAll = async () => {
    if (!accessToken) return;

    if (!revokePassword) {
      setRevokePasswordError('Password is required');
      return;
    }

    setIsRevokingAll(true);

    try {
      const response = await apiFetch('/api/v1/sessions/revoke-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password: revokePassword,
          include_current: true,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        if (response.status === 403) {
          setRevokePasswordError(data.error || 'Incorrect password');
          setIsRevokingAll(false);
          return;
        }
        throw new Error(data.error || 'Failed to revoke sessions');
      }

      setRevokePassword('');
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
      <div className="settings-section" id="section-privacy-settings">
        <h2 className="settings-section-title">Privacy</h2>
        <p className="settings-section-description">
          Control who can message you and how others can find you.
        </p>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Messages from Friends Only</span>
            <span className="settings-row-hint">Only friends can send you direct messages</span>
          </div>
          <ToggleSwitch
            checked={privacySettings.messagesFriendsOnly}
            onChange={(v) => updatePrivacy({ messagesFriendsOnly: v })}
          />
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Messages from Server Members</span>
            <span className="settings-row-hint">
              Allow DMs from people who share a server with you
            </span>
          </div>
          <ToggleSwitch
            checked={privacySettings.messagesServerMembers}
            onChange={(v) => updatePrivacy({ messagesServerMembers: v })}
          />
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Auto-Accept Friend Codes</span>
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
      </div>

      <div className="settings-section" id="section-active-sessions">
        <h2 className="settings-section-title">Active Sessions</h2>
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
              of all sessions, including this one. In order to continue, please input your password.
            </p>
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
            <div className="revoke-all-modal-actions">
              <button className="revoke-all-modal-cancel-btn" onClick={closeRevokeAllModal}>
                No, Cancel
              </button>
              <button
                className="revoke-all-modal-confirm-btn"
                onClick={handleRevokeAll}
                disabled={isRevokingAll || !revokePassword}
              >
                {isRevokingAll ? 'Revoking...' : 'Yes, Revoke All Sessions'}
              </button>
            </div>
          </div>
        </Modal>

        {/* Individual session revoke password modal */}
        <Modal
          isOpen={showSessionPasswordModal}
          onClose={closeSessionPasswordModal}
          title="Verify Your Identity"
          width="small"
        >
          <div className="revoke-all-modal-content">
            <p className="revoke-all-modal-description">
              For your security, please enter your password to revoke this session.
            </p>
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
            {/* TODO: Add MFA input field here when MFA is implemented */}
            <div className="revoke-all-modal-actions">
              <button className="revoke-all-modal-cancel-btn" onClick={closeSessionPasswordModal}>
                Cancel
              </button>
              <button
                className="revoke-all-modal-confirm-btn"
                onClick={() =>
                  sessionPasswordTarget && handleRevoke(sessionPasswordTarget, sessionPassword)
                }
                disabled={!sessionPassword || revokingId === sessionPasswordTarget}
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
              {modeChangeError && <span className="revoke-password-error">{modeChangeError}</span>}
            </div>
            {/* TODO: Add MFA input field here when MFA is implemented */}
            <div className="revoke-all-modal-actions">
              <button className="revoke-all-modal-cancel-btn" onClick={closeModeChangeModal}>
                Cancel
              </button>
              <button
                className="revoke-all-modal-confirm-btn"
                onClick={handleModeChange}
                disabled={isChangingMode || !modeChangePassword}
              >
                {isChangingMode ? 'Changing...' : 'Confirm'}
              </button>
            </div>
          </div>
        </Modal>
      </div>

      {pastSessions.length > 0 && (
        <div className="settings-section" id="section-past-sessions">
          <h2 className="settings-section-title">Past Sessions</h2>
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
        </div>
      )}
    </>
  );
};

export default PrivacySecuritySection;
