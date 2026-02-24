import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import { useUserStore } from '../../stores/userStore';
import { useSettingsStore, AppearanceSettings } from '../../stores/settingsStore';
import { useVoiceStore, AUDIO_QUALITY_TIERS } from '../../stores/voiceStore';
import type { AudioQualityTier } from '../../stores/voiceStore';
import { apiFetch } from '../../services/apiClient';
import LoadingSpinner from '../Auth/LoadingSpinner';
import DeviceSelector from '../Voice/DeviceSelector';
import './SettingsPage.css';

type SettingsSection =
  | 'appearance'
  | 'privacy'
  | 'account'
  | 'notifications'
  | 'voice'
  | 'accessibility';

interface Session {
  id: string;
  device_name: string;
  ip_address: string;
  user_agent: string;
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

// ─── Toggle Switch ──────────────────────────────────────────────────────────

const ToggleSwitch: React.FC<{
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}> = ({ checked, onChange, disabled }) => (
  <label className="settings-toggle">
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      disabled={disabled}
    />
    <span className="settings-toggle-track" />
    <span className="settings-toggle-thumb" />
  </label>
);

// ─── Appearance Section ─────────────────────────────────────────────────────

const AppearanceSection: React.FC = () => {
  const appearance = useSettingsStore((s) => s.appearance);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const setColorScheme = useSettingsStore((s) => s.setColorScheme);
  const setFontSize = useSettingsStore((s) => s.setFontSize);
  const setCompactMode = useSettingsStore((s) => s.setCompactMode);
  const setReduceAnimations = useSettingsStore((s) => s.setReduceAnimations);

  const colorSchemes: {
    value: AppearanceSettings['colorScheme'];
    label: string;
    gradient: string;
  }[] = [
    {
      value: 'concord',
      label: 'Concord',
      gradient: 'linear-gradient(135deg, #0d0821, #fa709a, #ffe13f)',
    },
    {
      value: 'eclipse',
      label: 'Eclipse',
      gradient: 'linear-gradient(135deg, #000000, #cc0000, #880000)',
    },
    {
      value: 'morky',
      label: '9th Circle',
      gradient: 'linear-gradient(135deg, #0a0a0a, #e63946, #ff6b35)',
    },
    {
      value: 'foxden',
      label: 'Fox Den',
      gradient: 'linear-gradient(135deg, #1a0e02, #ff6d00, #ff9100)',
    },
    {
      value: 'spooky',
      label: 'Spooky',
      gradient: 'linear-gradient(135deg, #0a0a0a, #ff6a00, #8b20aa)',
    },
    {
      value: 'driftwood',
      label: 'Driftwood',
      gradient: 'linear-gradient(135deg, #120e0a, #c8a46c, #a07848)',
    },
    {
      value: 'grassynill',
      label: 'Grassy Nill',
      gradient: 'linear-gradient(135deg, #0c0e08, #6b8e23, #8b7355)',
    },
    {
      value: 'hacker',
      label: 'Hacker',
      gradient: 'linear-gradient(135deg, #000000, #00ff41, #00ee38)',
    },
    {
      value: 'leviathan',
      label: 'Leviathan',
      gradient: 'linear-gradient(135deg, #020c14, #0ea5e9, #06b6d4)',
    },
    {
      value: 'midnightsky',
      label: 'Midnight Sky',
      gradient: 'linear-gradient(135deg, #060a18, #6d8cff, #a78bfa)',
    },
    {
      value: 'bardic',
      label: 'Bardic',
      gradient: 'linear-gradient(135deg, #120a1e, #c471ed, #f64f8e)',
    },
    {
      value: 'cottoncandy',
      label: 'Cotton Candy',
      gradient: 'linear-gradient(135deg, #0a0810, #ff6ea8, #40c8ff)',
    },
  ];

  const themes: { value: AppearanceSettings['theme']; label: string; icon: React.ReactNode }[] = [
    {
      value: 'dark',
      label: 'Dark',
      icon: (
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
          <path
            d="M21 12.79A9 9 0 119.21 1a7 7 0 0011.79 11.79z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
    },
    {
      value: 'light',
      label: 'Light',
      icon: (
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
          <circle cx="11" cy="11" r="5" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M11 1v2M11 19v2M3.22 3.22l1.42 1.42M17.36 17.36l1.42 1.42M1 11h2M19 11h2M3.22 18.78l1.42-1.42M17.36 4.64l1.42-1.42"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      ),
    },
    {
      value: 'system',
      label: 'System',
      icon: (
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
          <rect x="2" y="3" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 21h6M11 17v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      ),
    },
  ];

  const fontSizes: { value: AppearanceSettings['fontSize']; label: string }[] = [
    { value: 'small', label: 'Small' },
    { value: 'default', label: 'Default' },
    { value: 'large', label: 'Large' },
  ];

  return (
    <>
      <div className="settings-section">
        <h2 className="settings-section-title">Color Scheme</h2>
        <p className="settings-section-description">Pick a color palette for the entire app.</p>
        <span className="color-scheme-active-label">
          {colorSchemes.find((cs) => cs.value === appearance.colorScheme)?.label}
        </span>
        <div className="color-scheme-grid">
          {colorSchemes.map((cs) => (
            <button
              key={cs.value}
              className={`color-scheme-circle ${appearance.colorScheme === cs.value ? 'selected' : ''}`}
              style={{ background: cs.gradient }}
              onClick={() => setColorScheme(cs.value)}
              title={cs.label}
            />
          ))}
        </div>
      </div>

      <div className="settings-section">
        <h2 className="settings-section-title">Theme</h2>
        <p className="settings-section-description">
          Choose how Concord looks to you. Select a theme or match your system settings.
        </p>
        <div className="theme-selector">
          {themes.map((t) => (
            <button
              key={t.value}
              className={`theme-option ${appearance.theme === t.value ? 'selected' : ''}`}
              onClick={() => setTheme(t.value)}
            >
              <div className="theme-option-icon">{t.icon}</div>
              <span className="theme-option-label">{t.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="settings-section">
        <h2 className="settings-section-title">Display</h2>

        <div className="form-group">
          <label className="form-label">Font Size</label>
          <div className="font-size-selector">
            {fontSizes.map((fs) => (
              <button
                key={fs.value}
                className={`font-size-option ${fs.value} ${appearance.fontSize === fs.value ? 'selected' : ''}`}
                onClick={() => setFontSize(fs.value)}
              >
                {fs.label}
              </button>
            ))}
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Compact Mode</span>
            <span className="settings-row-hint">
              Reduce padding and spacing for a denser layout
            </span>
          </div>
          <ToggleSwitch checked={appearance.compactMode} onChange={setCompactMode} />
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Reduce Animations</span>
            <span className="settings-row-hint">
              Minimize motion and transitions for a snappier experience
            </span>
          </div>
          <ToggleSwitch checked={appearance.reduceAnimations} onChange={setReduceAnimations} />
        </div>
      </div>
    </>
  );
};

// ─── Privacy & Security Section ─────────────────────────────────────────────

const PrivacySecuritySection: React.FC = () => {
  const accessToken = useAuthStore((s) => s.accessToken);
  const logout = useUserStore((s) => s.logout);
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [pastSessions, setPastSessions] = useState<PastSession[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [isRevokingAll, setIsRevokingAll] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null); // session id or 'all'

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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch sessions');
    } finally {
      setIsLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  // Sort sessions: current session always first, then by last_used descending
  const sortedSessions = useMemo(() => {
    return [...sessions].sort((a, b) => {
      if (a.is_current && !b.is_current) return -1;
      if (!a.is_current && b.is_current) return 1;
      return new Date(b.last_used).getTime() - new Date(a.last_used).getTime();
    });
  }, [sessions]);

  const handleRevoke = async (sessionId: string) => {
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
      const response = await apiFetch(`/api/v1/sessions/${sessionId}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to revoke session');
      }

      // If we revoked the current session, log out
      if (session?.is_current) {
        await logout();
        navigate('/');
        return;
      }

      // Move to past sessions
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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke session');
    } finally {
      setRevokingId(null);
    }
  };

  const handleRevokeAll = async () => {
    if (!accessToken) return;

    // Always require confirmation since this includes the current session
    if (confirmRevoke !== 'all') {
      setConfirmRevoke('all');
      return;
    }

    setConfirmRevoke(null);
    setIsRevokingAll(true);

    try {
      const response = await apiFetch('/api/v1/sessions?include_current=true', {
        method: 'DELETE',
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to revoke sessions');
      }

      // All sessions revoked including current — log out
      await logout();
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke sessions');
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
    if (ua.includes('Electron')) return 'Concord Desktop';
    if (ua.includes('Chrome')) return 'Chrome Browser';
    if (ua.includes('Firefox')) return 'Firefox Browser';
    if (ua.includes('Safari')) return 'Safari Browser';
    return 'Unknown Device';
  };

  return (
    <>
      <div className="settings-section">
        <h2 className="settings-section-title">Active Sessions</h2>
        <p className="settings-section-description">
          These are the devices currently logged into your account. Revoke any session you
          don&apos;t recognize.
        </p>

        {error && <div className="settings-error">{error}</div>}

        {isLoading ? (
          <div className="settings-loading">
            <LoadingSpinner size="small" inline />
          </div>
        ) : (
          <>
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

            {sessions.length > 1 && (
              <div className="sessions-actions">
                {confirmRevoke === 'all' && (
                  <div className="session-confirm-warning">
                    This will revoke all sessions, including your current active session. You will
                    be logged out and must sign back in.
                  </div>
                )}
                {confirmRevoke === 'all' ? (
                  <div className="sessions-actions-buttons">
                    <button
                      className="sessions-revoke-all-btn"
                      onClick={handleRevokeAll}
                      disabled={isRevokingAll}
                    >
                      {isRevokingAll ? 'Revoking...' : 'Confirm Revoke All'}
                    </button>
                    <button className="session-cancel-btn" onClick={() => setConfirmRevoke(null)}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    className="sessions-revoke-all-btn"
                    onClick={handleRevokeAll}
                    disabled={isRevokingAll}
                  >
                    {isRevokingAll ? 'Revoking...' : `Revoke All Sessions (${sessions.length})`}
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {pastSessions.length > 0 && (
        <div className="settings-section">
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

// ─── Voice & Audio Section ──────────────────────────────────────────────────

const TIER_ORDER: AudioQualityTier[] = ['voice', 'standard', 'high', 'hifi', 'studio'];

const VoiceAudioSection: React.FC = () => {
  const qualityTier = useVoiceStore((s) => s.qualityTier);
  const setQualityTier = useVoiceStore((s) => s.setQualityTier);

  return (
    <>
      <div className="settings-section">
        <h2 className="settings-section-title">Input Device</h2>
        <p className="settings-section-description">
          Select which microphone to use for voice channels.
        </p>
        <div className="settings-device-row">
          <DeviceSelector kind="audioinput" />
        </div>
      </div>

      <div className="settings-section">
        <h2 className="settings-section-title">Output Device</h2>
        <p className="settings-section-description">
          Select which speaker or headphones to use for voice channels.
        </p>
        <div className="settings-device-row">
          <DeviceSelector kind="audiooutput" />
        </div>
      </div>

      <div className="settings-section">
        <h2 className="settings-section-title">Camera</h2>
        <p className="settings-section-description">
          Select which camera to use for video calls.
        </p>
        <div className="settings-device-row">
          <DeviceSelector kind="videoinput" />
        </div>
      </div>

      <div className="settings-section">
        <h2 className="settings-section-title">Audio Quality</h2>
        <p className="settings-section-description">
          Higher quality uses more bandwidth. Premium tiers require a subscription.
        </p>
        <div className="settings-quality-tiers">
          {TIER_ORDER.map((tier) => {
            const config = AUDIO_QUALITY_TIERS[tier];
            return (
              <button
                key={tier}
                className={`settings-quality-option ${qualityTier === tier ? 'selected' : ''}`}
                onClick={() => setQualityTier(tier)}
              >
                <div className="settings-quality-option-info">
                  <span className="settings-quality-option-label">
                    {config.label}
                    {config.premium && <span className="settings-quality-premium-badge">Premium</span>}
                  </span>
                  <span className="settings-quality-option-detail">
                    {config.maxBitrate >= 1000
                      ? `${(config.maxBitrate / 1000).toFixed(0)} kbps`
                      : `${config.maxBitrate} bps`}
                    {config.opusStereo ? ' · Stereo' : ' · Mono'}
                    {config.opusFec ? ' · FEC' : ''}
                  </span>
                </div>
                {qualityTier === tier && (
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <path
                      d="M3 8.5l3.5 3.5L13 4"
                      stroke="var(--accent-primary)"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
};

// ─── Nav Items ──────────────────────────────────────────────────────────────

interface NavItem {
  id: SettingsSection;
  label: string;
  icon: React.ReactNode;
  enabled: boolean;
}

const navItems: NavItem[] = [
  {
    id: 'appearance',
    label: 'Appearance',
    enabled: true,
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <circle cx="9" cy="9" r="4" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M9 1v2M9 15v2M2.64 2.64l1.41 1.41M13.95 13.95l1.41 1.41M1 9h2M15 9h2M2.64 15.36l1.41-1.41M13.95 4.05l1.41-1.41"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    id: 'privacy',
    label: 'Privacy & Security',
    enabled: true,
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <rect x="3" y="8" width="12" height="8" rx="2" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M6 8V5a3 3 0 016 0v3"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    id: 'account',
    label: 'Account',
    enabled: false,
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <circle cx="9" cy="6" r="3" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M3 16c0-2.76 2.69-5 6-5s6 2.24 6 5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    id: 'notifications',
    label: 'Notifications',
    enabled: false,
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <path
          d="M13.73 12.73A15.5 15.5 0 0114.5 9V7.5a5.5 5.5 0 00-11 0V9c0 1.31.26 2.56.77 3.73L3 14h12l-1.27-1.27z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M7 14v.5a2 2 0 004 0V14"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    id: 'voice',
    label: 'Voice & Audio',
    enabled: true,
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <rect x="6" y="1" width="6" height="10" rx="3" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M3 8a6 6 0 0012 0M9 14v3M6 17h6"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    id: 'accessibility',
    label: 'Accessibility',
    enabled: false,
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <circle cx="9" cy="4" r="2" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M3 8l6 1 6-1M9 9v4M6 17l3-4 3 4"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
];

// ─── Settings Page ──────────────────────────────────────────────────────────

const SettingsPage: React.FC = () => {
  const navigate = useNavigate();
  const [activeSection, setActiveSection] = useState<SettingsSection>('appearance');

  const renderSection = () => {
    switch (activeSection) {
      case 'appearance':
        return <AppearanceSection />;
      case 'privacy':
        return <PrivacySecuritySection />;
      case 'voice':
        return <VoiceAudioSection />;
      default:
        return null;
    }
  };

  return (
    <div className="view-container settings-fullpage">
      <div className="settings-page-content">
        <div className="settings-page-inner">
          {/* Back button */}
          <button className="settings-back-btn" onClick={() => navigate('/app')}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path
                d="M10 12L6 8l4-4"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Back to app
          </button>

          <h1 className="settings-page-title">Settings</h1>

          <div className="settings-layout">
            {/* Left navigation */}
            <nav className="settings-nav">
              {navItems.map((item) => (
                <button
                  key={item.id}
                  className={`settings-nav-item ${activeSection === item.id ? 'active' : ''}`}
                  onClick={() => item.enabled && setActiveSection(item.id)}
                  disabled={!item.enabled}
                >
                  <span className="settings-nav-item-icon">{item.icon}</span>
                  {item.label}
                  {!item.enabled && <span className="settings-nav-badge">Soon</span>}
                </button>
              ))}
            </nav>

            {/* Right content */}
            <div className="settings-content">{renderSection()}</div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SettingsPage;
