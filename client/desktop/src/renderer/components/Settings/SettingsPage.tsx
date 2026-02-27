import React, { useState, useEffect, useCallback, useMemo, useRef, useTransition } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import { useUserStore } from '../../stores/userStore';
import { useSettingsStore, AppearanceSettings } from '../../stores/settingsStore';
import { useVoiceStore, AUDIO_QUALITY_TIERS } from '../../stores/voiceStore';
import type { AudioQualityTier } from '../../stores/voiceStore';
import { useAudioSettingsStore } from '../../stores/audioSettingsStore';
import type { AudioPriority } from '../../stores/audioSettingsStore';
import { useVideoSettingsStore, VIDEO_QUALITY_PRESETS } from '../../stores/videoSettingsStore';
import type { ScreenContentType, DegradationPreference, VideoPriority } from '../../stores/videoSettingsStore';
import { useTTSSettingsStore } from '../../stores/ttsSettingsStore';
import { detectCodecCapabilities } from '../../services/mediaCapabilities';
import type { CodecCapability } from '../../services/mediaCapabilities';
import { isValidHex } from '../../utils/colorUtils';
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
  const setCustomColors = useSettingsStore((s) => s.setCustomColors);
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
      <div className="settings-section" id="section-color-scheme">
        <h2 className="settings-section-title">Color Scheme</h2>
        <p className="settings-section-description">Pick a color palette for the entire app.</p>
        <span className="color-scheme-active-label">
          {appearance.colorScheme === 'custom'
            ? 'Custom'
            : colorSchemes.find((cs) => cs.value === appearance.colorScheme)?.label}
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
          {/* Custom theme circle */}
          <button
            className={`color-scheme-circle custom-add ${appearance.colorScheme === 'custom' ? 'selected' : ''}`}
            style={
              appearance.customColors
                ? {
                    background: `linear-gradient(135deg, ${appearance.customColors.background}, ${appearance.customColors.accentPrimary}, ${appearance.customColors.accentSecondary})`,
                  }
                : undefined
            }
            onClick={() => {
              if (appearance.customColors) {
                setCustomColors(appearance.customColors);
              } else {
                setCustomColors({
                  background: '#0d0821',
                  accentPrimary: '#fa709a',
                  accentSecondary: '#ffe13f',
                });
              }
            }}
            title="Custom"
          >
            {!appearance.customColors && (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path
                  d="M8 2v12M2 8h12"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            )}
          </button>
        </div>

        {/* Custom theme color picker panel */}
        {appearance.colorScheme === 'custom' && appearance.customColors && (
          <div className="custom-theme-picker">
            {([
              { key: 'background' as const, label: 'Background' },
              { key: 'accentPrimary' as const, label: 'Primary Accent' },
              { key: 'accentSecondary' as const, label: 'Secondary Accent' },
            ]).map(({ key, label }) => (
              <div key={key} className="custom-theme-picker-row">
                <label className="custom-theme-picker-label">{label}</label>
                <div className="custom-theme-picker-input-group">
                  <input
                    type="color"
                    value={appearance.customColors![key]}
                    onChange={(e) =>
                      setCustomColors({
                        ...appearance.customColors!,
                        [key]: e.target.value,
                      })
                    }
                    className="custom-theme-color-input"
                  />
                  <input
                    type="text"
                    value={appearance.customColors![key]}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (isValidHex(val)) {
                        setCustomColors({
                          ...appearance.customColors!,
                          [key]: val,
                        });
                      }
                    }}
                    className="custom-theme-hex-input"
                    maxLength={7}
                    spellCheck={false}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="settings-section" id="section-theme">
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

      <div className="settings-section" id="section-display">
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
  const [revokePassword, setRevokePassword] = useState('');
  const [revokePasswordError, setRevokePasswordError] = useState('');

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

    // First click: show confirmation with password input
    if (confirmRevoke !== 'all') {
      setConfirmRevoke('all');
      setRevokePassword('');
      setRevokePasswordError('');
      return;
    }

    // Require password before proceeding
    if (!revokePassword) {
      setRevokePasswordError('Password is required');
      return;
    }

    setConfirmRevoke(null);
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
          // Wrong password — re-show confirmation with error
          setConfirmRevoke('all');
          setRevokePasswordError(data.error || 'Incorrect password');
          setIsRevokingAll(false);
          return;
        }
        throw new Error(data.error || 'Failed to revoke sessions');
      }

      setRevokePassword('');
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
      <div className="settings-section" id="section-active-sessions">
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
                    <div className="revoke-password-input">
                      <label>Enter your password to confirm:</label>
                      <input
                        type="password"
                        value={revokePassword}
                        onChange={(e) => {
                          setRevokePassword(e.target.value);
                          setRevokePasswordError('');
                        }}
                        placeholder="Password"
                        autoFocus
                      />
                      {revokePasswordError && (
                        <span className="revoke-password-error">{revokePasswordError}</span>
                      )}
                    </div>
                  </div>
                )}
                {confirmRevoke === 'all' ? (
                  <div className="sessions-actions-buttons">
                    <button
                      className="sessions-revoke-all-btn"
                      onClick={handleRevokeAll}
                      disabled={isRevokingAll || !revokePassword}
                    >
                      {isRevokingAll ? 'Revoking...' : 'Confirm Revoke All'}
                    </button>
                    <button
                      className="session-cancel-btn"
                      onClick={() => {
                        setConfirmRevoke(null);
                        setRevokePassword('');
                        setRevokePasswordError('');
                      }}
                    >
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

// ─── GPU Vendor Icon ────────────────────────────────────────────────────────

const GpuVendorIcon: React.FC<{ vendor: string }> = ({ vendor }) => {
  const v = vendor.toLowerCase();
  // Apple
  if (v.includes('apple')) return (
    <svg width="13" height="16" viewBox="0 0 256 315" fill="none" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M213.8 167.1c-.4-39.2 32-58.1 33.5-59.1-18.2-26.7-46.6-30.3-56.7-30.7-24.2-2.4-47.2 14.2-59.5 14.2-12.3 0-31.3-13.9-51.4-13.5-26.5.4-50.9 15.4-64.5 39.1-27.5 47.7-7 118.4 19.8 157.1 13.1 18.9 28.7 40.2 49.2 39.4 19.7-.8 27.2-12.8 51-12.8 23.9 0 30.6 12.8 51.5 12.4 21.2-.4 34.7-19.3 47.7-38.3 15.1-22 21.3-43.2 21.7-44.3-.5-.2-41.6-16-42.1-63.5zM175 64.2C185.8 51.1 193.1 33.4 191 15.8c-15.2.6-33.7 10.2-44.6 23-9.8 11.3-18.4 29.5-16.1 46.9 17 1.3 34.3-8.6 44.7-21.5z" fill="currentColor"/>
    </svg>
  );
  // NVIDIA
  if (v.includes('nvidia')) return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ verticalAlign: 'middle' }}>
      <rect x="1" y="3" width="14" height="10" rx="2" fill="#76B900" />
      <text x="8" y="10.5" textAnchor="middle" fill="white" fontSize="7" fontWeight="bold" fontFamily="sans-serif">N</text>
    </svg>
  );
  // Intel
  if (v.includes('intel')) return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ verticalAlign: 'middle' }}>
      <circle cx="8" cy="8" r="7" fill="#0071C5" />
      <text x="8" y="11" textAnchor="middle" fill="white" fontSize="8" fontWeight="bold" fontFamily="sans-serif">i</text>
    </svg>
  );
  // AMD
  if (v.includes('amd')) return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ verticalAlign: 'middle' }}>
      <rect x="1" y="3" width="14" height="10" rx="2" fill="#ED1C24" />
      <text x="8" y="10.5" textAnchor="middle" fill="white" fontSize="6" fontWeight="bold" fontFamily="sans-serif">AMD</text>
    </svg>
  );
  // Qualcomm
  if (v.includes('qualcomm')) return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ verticalAlign: 'middle' }}>
      <circle cx="8" cy="8" r="7" fill="#3253DC" />
      <text x="8" y="11" textAnchor="middle" fill="white" fontSize="8" fontWeight="bold" fontFamily="sans-serif">Q</text>
    </svg>
  );
  // ARM
  if (v.includes('arm')) return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ verticalAlign: 'middle' }}>
      <rect x="1" y="3" width="14" height="10" rx="2" fill="#0091BD" />
      <text x="8" y="10.5" textAnchor="middle" fill="white" fontSize="6" fontWeight="bold" fontFamily="sans-serif">ARM</text>
    </svg>
  );
  return null;
};

// ─── Voice & Audio Section ──────────────────────────────────────────────────

const TIER_ORDER: AudioQualityTier[] = ['voice', 'standard', 'high', 'hifi', 'studio'];

const TIER_DESCRIPTIONS: Record<AudioQualityTier, string> = {
  voice: '24 kbps · Mono · FEC · DTX\nOptimized for speech. Minimal bandwidth with silence detection and error correction.',
  standard: '64 kbps · Stereo · FEC\nClear voice for general use. Good balance of quality and bandwidth.',
  high: '128 kbps · Stereo\nStreaming quality. Music-friendly with wide stereo field.',
  hifi: '320 kbps · Stereo · 10ms frames\nNear-lossless audio. Low latency with perceptually transparent encoding.',
  studio: '510 kbps · Stereo · 10ms frames\nMaximum Opus quality. 48 kHz full-bandwidth stereo at Opus ceiling.',
};

const VoiceAudioSection: React.FC = () => {
  const qualityTier = useVoiceStore((s) => s.qualityTier);
  const setQualityTier = useVoiceStore((s) => s.setQualityTier);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Audio processing settings
  const noiseCancellation = useAudioSettingsStore((s) => s.noiseCancellation);
  const echoCancellation = useAudioSettingsStore((s) => s.echoCancellation);
  const autoGainControl = useAudioSettingsStore((s) => s.autoGainControl);
  const noiseGateMode = useAudioSettingsStore((s) => s.noiseGateMode);
  const noiseGateLevel = useAudioSettingsStore((s) => s.noiseGateLevel);
  const inputVolume = useAudioSettingsStore((s) => s.inputVolume);
  const outputVolume = useAudioSettingsStore((s) => s.outputVolume);
  const quietBoost = useAudioSettingsStore((s) => s.quietBoost);
  const quietBoostThreshold = useAudioSettingsStore((s) => s.quietBoostThreshold);

  // Video settings
  const cameraPreset = useVideoSettingsStore((s) => s.cameraPreset);
  const screenResolution = useVideoSettingsStore((s) => s.screenResolution);
  const screenFrameRate = useVideoSettingsStore((s) => s.screenFrameRate);
  const screenContentType = useVideoSettingsStore((s) => s.screenContentType);
  const preferredVideoCodec = useVideoSettingsStore((s) => s.preferredVideoCodec);
  const preferredScreenCodec = useVideoSettingsStore((s) => s.preferredScreenCodec);
  const screenSharePriority = useVideoSettingsStore((s) => s.screenSharePriority);
  const screenShareBitrate = useVideoSettingsStore((s) => s.screenShareBitrate);
  const cameraPriority = useVideoSettingsStore((s) => s.cameraPriority);
  const degradationPreference = useVideoSettingsStore((s) => s.degradationPreference);
  const scalabilityMode = useVideoSettingsStore((s) => s.scalabilityMode);
  const hardwareAcceleration = useVideoSettingsStore((s) => s.hardwareAcceleration);
  const codecCapabilities = useVideoSettingsStore((s) => s.codecCapabilities);
  const gpuInfo = useVideoSettingsStore((s) => s.gpuInfo);

  const [initialHwAccel, setInitialHwAccel] = useState<boolean | null>(null);
  const [showVideoAdvanced, setShowVideoAdvanced] = useState(false);
  const [displayInfo, setDisplayInfo] = useState<{ width: number; height: number; refreshRate: number; scaleFactor: number; isPrimary: boolean }[]>([]);

  // Load codec capabilities + GPU info + display info on mount.
  // Deferred via requestAnimationFrame so React paints the UI first.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      Promise.all([
        detectCodecCapabilities(),
        window.electron?.getGPUInfo?.() ?? Promise.resolve(null),
        window.electron?.getHardwareAcceleration?.() ?? Promise.resolve(null),
        window.electron?.getDisplayInfo?.() ?? Promise.resolve(null),
      ]).then(([caps, gpu, hwAccel, displays]) => {
        useVideoSettingsStore.setState({
          codecCapabilities: caps,
          gpuInfo: gpu ?? useVideoSettingsStore.getState().gpuInfo,
          ...(hwAccel != null ? { hardwareAcceleration: hwAccel } : {}),
        });
        if (hwAccel != null) setInitialHwAccel(hwAccel);
        if (displays) setDisplayInfo(displays);
      });
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  const restartNeeded = initialHwAccel !== null && hardwareAcceleration !== initialHwAccel;

  // Display-derived values for screen share options
  const bestDisplay = useMemo(() => {
    if (displayInfo.length === 0) return { width: 1920, height: 1080, refreshRate: 60 };
    return displayInfo.reduce((best, d) => (d.width * d.height > best.width * best.height ? d : best));
  }, [displayInfo]);

  const maxRefreshRate = useMemo(() => {
    if (displayInfo.length === 0) return 60;
    return Math.max(...displayInfo.map((d) => d.refreshRate || 60));
  }, [displayInfo]);

  // Unique display resolutions for the "Your Displays" optgroup
  const uniqueDisplayResolutions = useMemo(() => {
    const seen = new Set<string>();
    return displayInfo
      .map((d) => ({ width: d.width, height: d.height, isPrimary: d.isPrimary }))
      .filter((d) => {
        const key = `${d.width}x${d.height}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => b.width * b.height - a.width * a.height);
  }, [displayInfo]);

  // Dynamic bitrate recommendation based on resolution, FPS, and codec
  const recommendedBitrate = useMemo(() => {
    const resMap: Record<string, { w: number; h: number }> = {
      '720p': { w: 1280, h: 720 },
      '1080p': { w: 1920, h: 1080 },
      '1440p': { w: 2560, h: 1440 },
      '4K': { w: 3840, h: 2160 },
      'source': { w: bestDisplay.width, h: bestDisplay.height },
    };
    const parsed = screenResolution.match(/^(\d+)x(\d+)$/);
    const res = parsed
      ? { w: Number(parsed[1]), h: Number(parsed[2]) }
      : (resMap[screenResolution] || resMap['1080p']);
    const effectiveFps = screenFrameRate === 0 ? maxRefreshRate : screenFrameRate;
    const isEfficient = preferredScreenCodec?.includes('AV1') || preferredScreenCodec?.includes('H265') || preferredScreenCodec?.includes('HEVC') || preferredScreenCodec?.includes('VP9');
    const bpp = isEfficient ? 0.04 : 0.07;
    const bps = res.w * res.h * effectiveFps * bpp;
    return Math.round(bps / 100_000) * 100_000;
  }, [screenResolution, screenFrameRate, preferredScreenCodec, bestDisplay, maxRefreshRate]);

  const clampedRecommended = Math.max(1_500_000, Math.min(30_000_000, recommendedBitrate));

  // Advanced audio settings
  const musicMode = useAudioSettingsStore((s) => s.musicMode);
  const frameSize = useAudioSettingsStore((s) => s.frameSize);
  const silenceDetection = useAudioSettingsStore((s) => s.silenceDetection);
  const fecMode = useAudioSettingsStore((s) => s.fecMode);
  const fecManualPercent = useAudioSettingsStore((s) => s.fecManualPercent);
  const opusNack = useAudioSettingsStore((s) => s.opusNack);
  const adaptivePtime = useAudioSettingsStore((s) => s.adaptivePtime);
  const audioPriority = useAudioSettingsStore((s) => s.audioPriority);

  // Derived tier capabilities
  const tierConfig = AUDIO_QUALITY_TIERS[qualityTier];
  const tierAllows10ms = qualityTier === 'hifi' || qualityTier === 'studio';
  const tierSupportsFec = tierConfig.opusFec;

  // Tier slider index
  const tierIndex = TIER_ORDER.indexOf(qualityTier);
  const handleTierSlider = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const idx = Number(e.target.value);
    if (idx >= 0 && idx < TIER_ORDER.length) setQualityTier(TIER_ORDER[idx]);
  }, [setQualityTier]);

  return (
    <>
      {/* ═══ Device Configuration ═══ */}
      <div className="settings-section" id="section-device-config">
        <h2 className="settings-section-title">Device Configuration</h2>

        <h3 className="settings-subsection-title">Input</h3>
        <div className="settings-device-row">
          <DeviceSelector kind="audioinput" />
        </div>
        <div className="settings-volume-row">
          <span className="settings-volume-label">Input Volume</span>
          <div className="settings-volume-track">
            <input
              type="range"
              className="settings-volume-slider"
              min={0}
              max={200}
              value={inputVolume}
              onChange={(e) => useAudioSettingsStore.getState().setInputVolume(Number(e.target.value))}
            />
          </div>
          <span className="settings-volume-value">{inputVolume}%</span>
        </div>

        <h3 className="settings-subsection-title">Output</h3>
        <div className="settings-device-row">
          <DeviceSelector kind="audiooutput" />
        </div>
        <div className="settings-volume-row">
          <span className="settings-volume-label">Output Volume</span>
          <div className="settings-volume-track">
            <input
              type="range"
              className="settings-volume-slider"
              min={0}
              max={200}
              value={outputVolume}
              onChange={(e) => useAudioSettingsStore.getState().setOutputVolume(Number(e.target.value))}
            />
          </div>
          <span className="settings-volume-value">{outputVolume}%</span>
        </div>

        <h3 className="settings-subsection-title">Camera</h3>
        <div className="settings-device-row">
          <DeviceSelector kind="videoinput" />
        </div>
      </div>

      {/* ═══ Audio Configuration ═══ */}
      <div className="settings-section" id="section-audio-config">
        <h2 className="settings-section-title">Audio Configuration</h2>

        {/* ── Quality ── */}
        <h3 className="settings-subsection-title">Quality</h3>
        <p className="settings-section-description">
          Higher quality uses more bandwidth. Premium tiers require a subscription.
        </p>

        <div className="settings-tier-slider-container">
          <div className="settings-tier-labels">
            {TIER_ORDER.map((tier, i) => {
              const config = AUDIO_QUALITY_TIERS[tier];
              return (
                <span
                  key={tier}
                  className={`settings-tier-label ${tierIndex === i ? 'active' : ''}`}
                  onClick={() => setQualityTier(tier)}
                >
                  {config.label}
                </span>
              );
            })}
          </div>
          <div className="settings-tier-track">
            <div className="settings-tier-ticks">
              {TIER_ORDER.map((_, i) => (
                <span
                  key={i}
                  className={`settings-tier-tick ${tierIndex === i ? 'active' : ''}`}
                />
              ))}
            </div>
            <input
              type="range"
              className="settings-tier-slider"
              min={0}
              max={TIER_ORDER.length - 1}
              step={1}
              value={tierIndex}
              onChange={handleTierSlider}
            />
          </div>
          <div className="settings-tier-description">
            {TIER_DESCRIPTIONS[qualityTier].split('\n').map((line, i) => (
              <span key={i}>{line}</span>
            ))}
            {AUDIO_QUALITY_TIERS[qualityTier].premium && (
              <span className="settings-quality-premium-badge">Premium</span>
            )}
          </div>
        </div>

        {/* ── Processing ── */}
        <h3 className="settings-subsection-title">Processing</h3>

        <div className={`settings-row ${musicMode ? 'settings-row-disabled' : ''}`}>
          <div className="settings-row-info">
            <span className="settings-row-label">Noise Cancellation</span>
            <span className="settings-row-hint">Reduces background noise from your microphone{musicMode ? ' (disabled by Music Mode)' : ''}</span>
          </div>
          <ToggleSwitch
            checked={!musicMode && noiseCancellation}
            onChange={(v) => { if (!musicMode) useAudioSettingsStore.getState().setNoiseCancellation(v); }}
            disabled={musicMode}
          />
        </div>

        <div className={`settings-row ${musicMode ? 'settings-row-disabled' : ''}`}>
          <div className="settings-row-info">
            <span className="settings-row-label">Echo Cancellation</span>
            <span className="settings-row-hint">Prevents speakers from feeding back into your mic{musicMode ? ' (disabled by Music Mode)' : ''}</span>
          </div>
          <ToggleSwitch
            checked={!musicMode && echoCancellation}
            onChange={(v) => { if (!musicMode) useAudioSettingsStore.getState().setEchoCancellation(v); }}
            disabled={musicMode}
          />
        </div>

        <div className={`settings-row ${musicMode ? 'settings-row-disabled' : ''}`}>
          <div className="settings-row-info">
            <span className="settings-row-label">Auto Gain Control</span>
            <span className="settings-row-hint">Automatically adjusts microphone volume{musicMode ? ' (disabled by Music Mode)' : ''}</span>
          </div>
          <ToggleSwitch
            checked={!musicMode && autoGainControl}
            onChange={(v) => { if (!musicMode) useAudioSettingsStore.getState().setAutoGainControl(v); }}
            disabled={musicMode}
          />
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Noise Gate</span>
            <span className="settings-row-hint">
              {noiseGateMode === 'manual'
                ? `Hard cutoff — mutes input below ${noiseGateLevel} dBFS.`
                : 'Off — no hard cutoff applied. Relies on noise cancellation and AGC if enabled.'}
            </span>
          </div>
          <ToggleSwitch
            checked={noiseGateMode === 'manual'}
            onChange={(v) => useAudioSettingsStore.getState().setNoiseGateMode(v ? 'manual' : 'auto')}
          />
        </div>

        {noiseGateMode === 'manual' && (
          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">Gate Threshold</span>
              <span className="settings-row-hint">{noiseGateLevel} dBFS — audio below this level is muted</span>
            </div>
            <input
              type="range"
              className="settings-slider"
              min={-80}
              max={-20}
              value={noiseGateLevel}
              onChange={(e) => useAudioSettingsStore.getState().setNoiseGateLevel(Number(e.target.value))}
            />
          </div>
        )}

        {/* ── Output Enhancement ── */}
        <h3 className="settings-subsection-title">Output Enhancement</h3>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Boost Quiet Users</span>
            <span className="settings-row-hint">
              {quietBoost
                ? 'Dynamically amplifies participants whose audio falls below the threshold. Normal-volume users are unaffected.'
                : 'Off — all participants play at their natural volume level.'}
            </span>
          </div>
          <ToggleSwitch
            checked={quietBoost}
            onChange={(v) => useAudioSettingsStore.getState().setQuietBoost(v)}
          />
        </div>

        {quietBoost && (
          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">Boost Threshold</span>
              <span className="settings-row-hint">
                {quietBoostThreshold} dBFS —{' '}
                {quietBoostThreshold >= -27
                  ? 'Boosts anyone below normal speaking volume (aggressive)'
                  : quietBoostThreshold >= -35
                    ? 'Boosts soft-spoken users up to normal level'
                    : quietBoostThreshold >= -44
                      ? 'Boosts whispers and very soft speakers'
                      : 'Only boosts barely-audible users (conservative)'}
              </span>
            </div>
            <input
              type="range"
              className="settings-slider"
              min={-50}
              max={-20}
              value={quietBoostThreshold}
              onChange={(e) => useAudioSettingsStore.getState().setQuietBoostThreshold(Number(e.target.value))}
            />
          </div>
        )}

        {/* ── Advanced Settings ── */}
        <button
          className="settings-advanced-toggle"
          onClick={() => setShowAdvanced(!showAdvanced)}
        >
          <span>Advanced Settings</span>
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            style={{ transform: showAdvanced ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}
          >
            <path d="M3 4.5L6 7.5L9 4.5" stroke="var(--text-secondary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {showAdvanced && (
          <div className="settings-advanced-panel">
            <div className="settings-advanced-warning">
              These settings affect audio encoding at a low level. Incorrect values may degrade voice quality.
            </div>

            <h4 className="settings-advanced-subheader">Opus Codec</h4>

            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Music Mode</span>
                <span className="settings-row-hint">
                  Disables noise suppression, echo cancellation, and AGC. Signals the encoder to use full 48 kHz bandwidth for music fidelity.
                </span>
              </div>
              <ToggleSwitch checked={musicMode} onChange={(v) => useAudioSettingsStore.getState().setMusicMode(v)} />
            </div>

            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Adaptive Frame Size</span>
                <span className="settings-row-hint">
                  Lets Concord dynamically scale ptime during congestion (e.g. 20ms → 60ms), trading latency for reliability. Overrides manual Frame Size when enabled.
                </span>
              </div>
              <ToggleSwitch checked={adaptivePtime} onChange={(v) => useAudioSettingsStore.getState().setAdaptivePtime(v)} />
            </div>

            {!adaptivePtime && (
              <div className="settings-row">
                <div className="settings-row-info">
                  <span className="settings-row-label">Frame Size (ptime)</span>
                  <span className="settings-row-hint">
                    Default uses the lowest latency the tier supports ({tierAllows10ms ? '10' : '20'}ms).
                    Explicit values are respected regardless of tier.
                  </span>
                </div>
                <select
                  className="settings-select"
                  value={frameSize}
                  onChange={(e) => useAudioSettingsStore.getState().setFrameSize(Number(e.target.value) as 0 | 10 | 20 | 40 | 60)}
                >
                  <option value={0}>Default ({tierAllows10ms ? '10' : '20'} ms)</option>
                  <option value={10}>10 ms (lowest latency)</option>
                  <option value={20}>20 ms</option>
                  <option value={40}>40 ms (efficient)</option>
                  <option value={60}>60 ms (most efficient)</option>
                </select>
              </div>
            )}

            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Silence Detection (DTX)</span>
                <span className="settings-row-hint">
                  Discontinuous transmission — sends fewer packets during silence to save bandwidth.
                </span>
              </div>
              <ToggleSwitch checked={silenceDetection} onChange={(v) => useAudioSettingsStore.getState().setSilenceDetection(v)} />
            </div>

            <h4 className="settings-advanced-subheader">Error Correction & Reliability</h4>

            <div className={`settings-row ${!tierSupportsFec ? 'settings-row-disabled' : ''}`}>
              <div className="settings-row-info">
                <span className="settings-row-label">Forward Error Correction</span>
                <span className="settings-row-hint">
                  {!tierSupportsFec
                    ? 'Disabled — current quality tier does not use FEC. High bitrate tiers rely on audio fidelity over redundancy.'
                    : fecMode === 'auto'
                      ? 'Automatically adjusts FEC overhead based on detected packet loss.'
                      : `Manual: ${fecManualPercent}% redundancy overhead.`}
                </span>
              </div>
              <select
                className="settings-select"
                value={fecMode}
                onChange={(e) => useAudioSettingsStore.getState().setFecMode(e.target.value as 'auto' | 'manual')}
                disabled={!tierSupportsFec}
              >
                <option value="auto">Auto</option>
                <option value="manual">Manual</option>
              </select>
            </div>

            {fecMode === 'manual' && tierSupportsFec && (
              <div className="settings-row">
                <div className="settings-row-info">
                  <span className="settings-row-label">FEC Redundancy</span>
                  <span className="settings-row-hint">{fecManualPercent}%</span>
                </div>
                <input
                  type="range"
                  className="settings-slider"
                  min={0}
                  max={100}
                  value={fecManualPercent}
                  onChange={(e) => useAudioSettingsStore.getState().setFecManualPercent(Number(e.target.value))}
                />
              </div>
            )}

            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">NACK (Retransmission)</span>
                <span className="settings-row-hint">
                  Request retransmission of lost audio packets. Adds latency but improves reliability on lossy networks.
                </span>
              </div>
              <ToggleSwitch checked={opusNack} onChange={(v) => useAudioSettingsStore.getState().setOpusNack(v)} />
            </div>

            <h4 className="settings-advanced-subheader">Transport</h4>

            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Quality of Service for Audio</span>
                <span className="settings-row-hint">
                  Flags traffic using DSCP marking so your network can prioritize it. May not work on all networks.
                </span>
              </div>
              <select
                className="settings-select"
                value={audioPriority}
                onChange={(e) => useAudioSettingsStore.getState().setAudioPriority(e.target.value as AudioPriority)}
              >
                <option value="off">Off (No Tagging)</option>
                <option value="low">Low (DF)</option>
                <option value="medium">Default (AF41)</option>
                <option value="high">High (EF)</option>
              </select>
            </div>
          </div>
        )}
      </div>

      {/* ═══ Video & Screen Share ═══ */}
      <div className="settings-section" id="section-video-screen">
        <h2 className="settings-section-title">Video & Screen Share</h2>

        {/* ── Camera ── */}
        <h3 className="settings-subsection-title">Camera</h3>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Camera Preset</span>
            <span className="settings-row-hint">System Default lets the camera/driver decide. Other presets request a specific resolution.</span>
          </div>
          <select
            className="settings-select"
            value={cameraPreset}
            onChange={(e) => useVideoSettingsStore.getState().setCameraPreset(e.target.value)}
          >
            {Object.entries(VIDEO_QUALITY_PRESETS).map(([key, preset]) => (
              <option key={key} value={key}>{preset.label}</option>
            ))}
          </select>
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Congestion Priority</span>
            <span className="settings-row-hint">
              {degradationPreference === 'balanced'
                ? 'Concord decides whether to reduce resolution or framerate during congestion.'
                : degradationPreference === 'maintain-framerate'
                  ? 'Keeps framerate smooth by reducing resolution when bandwidth is limited.'
                  : 'Keeps resolution crisp by reducing framerate when bandwidth is limited.'}
            </span>
          </div>
          <select
            className="settings-select"
            value={degradationPreference}
            onChange={(e) => useVideoSettingsStore.getState().setDegradationPreference(e.target.value as DegradationPreference)}
          >
            <option value="balanced">Balanced</option>
            <option value="maintain-framerate">Prefer Smooth Video</option>
            <option value="maintain-resolution">Prefer Sharp Details</option>
          </select>
        </div>

        {/* ── Screen Share ── */}
        <h3 className="settings-subsection-title">Screen Share</h3>
        <p className="settings-section-description">
          Default settings for screen sharing. These can be changed per-share in the picker.
        </p>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Resolution</span>
          </div>
          <select
            className="settings-select"
            value={screenResolution}
            onChange={(e) => useVideoSettingsStore.getState().setScreenResolution(e.target.value)}
          >
            <optgroup label="Common Resolutions">
              <option value="source">Native</option>
              {bestDisplay.height >= 2160 && <option value="4K">4K (3840×2160)</option>}
              {bestDisplay.height >= 1440 && <option value="1440p">1440p (2560×1440)</option>}
              <option value="1080p">1080p (1920×1080)</option>
              <option value="720p">720p (1280×720)</option>
            </optgroup>
            {uniqueDisplayResolutions.length > 0 && (
              <optgroup label="Your Displays">
                {uniqueDisplayResolutions.map((d) => (
                  <option key={`${d.width}x${d.height}`} value={`${d.width}x${d.height}`}>
                    {d.width}×{d.height}{d.isPrimary ? ' (Primary)' : ''}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Frame Rate</span>
          </div>
          <select
            className="settings-select"
            value={screenFrameRate}
            onChange={(e) => useVideoSettingsStore.getState().setScreenFrameRate(Number(e.target.value))}
          >
            <optgroup label="Common">
              <option value={0}>Native ({maxRefreshRate} Hz)</option>
              <option value={60}>60 FPS</option>
              <option value={30}>30 FPS</option>
            </optgroup>
            <optgroup label="Additional">
              {maxRefreshRate >= 120 && <option value={120}>120 FPS</option>}
              {maxRefreshRate >= 100 && <option value={100}>100 FPS</option>}
              {maxRefreshRate >= 90 && <option value={90}>90 FPS</option>}
              {maxRefreshRate >= 75 && <option value={75}>75 FPS</option>}
              <option value={24}>24 FPS (Cinematic)</option>
              <option value={15}>15 FPS</option>
              <option value={5}>5 FPS (Slideshow)</option>
            </optgroup>
          </select>
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Content Type</span>
            <span className="settings-row-hint">
              {screenContentType === 'auto'
                ? 'Auto \u2014 Concord detects whether your screen has fast motion or static content and optimizes accordingly.'
                : screenContentType === 'motion'
                  ? 'Motion \u2014 Prioritizes smooth frame rate for video playback, games, and animations. Uses more bandwidth.'
                  : 'Detail \u2014 Prioritizes sharp text and edges for code editors, documents, and design tools. Lower frame rate, crisper image.'}
            </span>
          </div>
          <select
            className="settings-select"
            value={screenContentType}
            onChange={(e) => useVideoSettingsStore.getState().setScreenContentType(e.target.value as ScreenContentType)}
          >
            <option value="auto">Auto</option>
            <option value="motion">Motion (Video & Animation)</option>
            <option value="detail">Detail (Text & Code)</option>
          </select>
        </div>

        {/* ── Advanced Settings ── */}
        <button
          className="settings-advanced-toggle"
          onClick={() => setShowVideoAdvanced(!showVideoAdvanced)}
        >
          <span>Advanced Settings</span>
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            style={{ transform: showVideoAdvanced ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}
          >
            <path d="M3 4.5L6 7.5L9 4.5" stroke="var(--text-secondary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {showVideoAdvanced && (
          <div className="settings-advanced-panel">
            <div className="settings-advanced-warning">
              These settings affect video encoding at a low level. Incorrect values may degrade video quality.
            </div>

            <h4 className="settings-advanced-subheader">Codec & Hardware</h4>

            {gpuInfo && (
              <p className="settings-section-description" style={{ marginTop: 0, marginBottom: 6 }}>
                <span className="settings-gpu-badge">
                  <GpuVendorIcon vendor={gpuInfo.vendor} />
                  {' '}{gpuInfo.vendor}{gpuInfo.device ? ` · ${gpuInfo.device}` : ''}
                </span>
              </p>
            )}

            {codecCapabilities.length > 0 && (() => {
              const codecPriority: Record<string, number> = { AV1: 0, H265: 1, HEVC: 1, VP9: 2, H264: 3, VP8: 4 };
              const codecDisplayName: Record<string, string> = { H264: 'AVC (H.264)', H265: 'HEVC (H.265)', HEVC: 'HEVC (H.265)' };
              // Codecs the mediasoup router supports (H265 not yet supported)
              const routerSupported = new Set(['video/vp8', 'video/vp9', 'video/h264', 'video/av1']);
              const sortByPriority = (a: CodecCapability, b: CodecCapability) =>
                (codecPriority[a.mimeType.replace('video/', '')] ?? 99) - (codecPriority[b.mimeType.replace('video/', '')] ?? 99);
              const displayName = (c: CodecCapability) => {
                const raw = c.mimeType.replace('video/', '');
                return codecDisplayName[raw] ?? raw;
              };
              const isSupported = (c: CodecCapability) => routerSupported.has(c.mimeType.toLowerCase());

              // HW column: codecs with GPU acceleration
              // SW column: ALL codecs (every codec has a software encoder fallback)
              const hwCodecs = codecCapabilities.filter((c) => c.powerEfficient).sort(sortByPriority);
              const swCodecs = [...codecCapabilities].sort(sortByPriority);

              // Which column is active: prefer HW if enabled AND has router-supported codecs
              const hwHasSupported = hwCodecs.some((c) => isSupported(c));
              const hwActive = hardwareAcceleration && hwHasSupported;

              // Determine preferred codec: first supported codec in priority order within the active column
              const activeCodecs = hwActive ? hwCodecs : swCodecs;
              const preferredMime = activeCodecs.find((c) => isSupported(c))?.mimeType ?? null;

              const renderCodecItem = (c: CodecCapability, columnKey: string, isActiveColumn: boolean) => {
                const supported = isSupported(c);
                const isPreferred = isActiveColumn && supported && c.mimeType === preferredMime;
                const tooltip = !supported ? 'Not supported' : isPreferred ? 'Preferred' : 'Available';
                return (
                  <div
                    key={`${columnKey}-${c.mimeType}`}
                    className={`settings-codec-item${isPreferred ? ' preferred' : ''}${!supported ? ' unsupported' : ''}`}
                    data-tooltip={tooltip}
                  >
                    <span className={`settings-codec-name${!supported ? ' strikethrough' : ''}`}>{displayName(c)}</span>
                  </div>
                );
              };

              return (
                <>
                  <div className="settings-codec-grid">
                    <div className={`settings-codec-column${hwActive ? ' active' : ''}`}>
                      <span
                        className={`settings-codec-column-header${hwActive ? ' active' : ''}`}
                        {...(hwActive ? { 'data-tooltip': 'Preferred' } : {})}
                      >Hardware</span>
                      <div className="settings-codec-column-items">
                        {hwCodecs.map((c) => renderCodecItem(c, 'hw', hwActive))}
                        {hwCodecs.length === 0 && (
                          <span className="settings-codec-empty">None detected</span>
                        )}
                      </div>
                    </div>
                    <div className={`settings-codec-column${!hwActive ? ' active' : ''}`}>
                      <span
                        className={`settings-codec-column-header${!hwActive ? ' active' : ''}`}
                        {...(!hwActive ? { 'data-tooltip': 'Preferred' } : {})}
                      >Software</span>
                      <div className="settings-codec-column-items">
                        {swCodecs.map((c) => renderCodecItem(c, 'sw', !hwActive))}
                        {swCodecs.length === 0 && (
                          <span className="settings-codec-empty">None detected</span>
                        )}
                      </div>
                    </div>
                  </div>
                  {hardwareAcceleration && !hwHasSupported && (
                    <div className="settings-hw-fallback-notice">
                      Hardware acceleration is enabled, but none of your GPU's codecs are currently supported. Concord has automatically failed over to software encoding.
                    </div>
                  )}
                </>
              );
            })()}

            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Camera Codec</span>
                <span className="settings-row-hint">Auto uses the best available codec</span>
              </div>
              <select
                className="settings-select"
                value={preferredVideoCodec ?? ''}
                onChange={(e) => useVideoSettingsStore.getState().setPreferredVideoCodec(e.target.value || null)}
              >
                <option value="">Auto</option>
                {codecCapabilities.map((c) => (
                  <option key={c.mimeType} value={c.mimeType}>
                    {c.mimeType.replace('video/', '')}{c.powerEfficient ? ' (HW)' : ''}
                  </option>
                ))}
              </select>
            </div>

            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Screen Share Codec</span>
                <span className="settings-row-hint">Auto uses the best available codec</span>
              </div>
              <select
                className="settings-select"
                value={preferredScreenCodec ?? ''}
                onChange={(e) => useVideoSettingsStore.getState().setPreferredScreenCodec(e.target.value || null)}
              >
                <option value="">Auto</option>
                {codecCapabilities.map((c) => (
                  <option key={c.mimeType} value={c.mimeType}>
                    {c.mimeType.replace('video/', '')}{c.powerEfficient ? ' (HW)' : ''}
                  </option>
                ))}
              </select>
            </div>

            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Hardware Acceleration</span>
                <span className="settings-row-hint">Uses your GPU for video encoding & decoding. If a codec isn't supported by your GPU, Concord will automatically fall back to software encoding on your CPU. Requires restart to apply.</span>
              </div>
              <ToggleSwitch
                checked={hardwareAcceleration}
                onChange={async (enabled) => {
                  await window.electron?.setHardwareAcceleration?.(enabled);
                  useVideoSettingsStore.getState().setHardwareAcceleration(enabled);
                }}
              />
            </div>

            {restartNeeded && (
              <div className="settings-restart-prompt">
                <span>Hardware acceleration change requires a restart.</span>
                <button
                  className="settings-restart-btn"
                  onClick={() => window.electron?.relaunchApp?.()}
                >
                  Restart Now
                </button>
              </div>
            )}

            <h4 className="settings-advanced-subheader">Bandwidth</h4>

            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Automatic Bitrate</span>
                <span className="settings-row-hint">
                  {screenShareBitrate === 0
                    ? `Concord adjusts based on your resolution, frame rate, and codec. Estimated: ~${(clampedRecommended / 1_000_000).toFixed(1)} Mbps for current settings.`
                    : `Manual: ${(screenShareBitrate / 1_000_000).toFixed(1)} Mbps. Recommended: ~${(clampedRecommended / 1_000_000).toFixed(1)} Mbps for current settings.`}
                </span>
              </div>
              <ToggleSwitch
                checked={screenShareBitrate === 0}
                onChange={(v) => useVideoSettingsStore.getState().setScreenShareBitrate(v ? 0 : clampedRecommended)}
              />
            </div>
            {screenShareBitrate > 0 && (
              <div className="settings-volume-row">
                <span className="settings-volume-label">Cap</span>
                <div className="settings-volume-track">
                  <input
                    type="range"
                    className="settings-volume-slider"
                    min={1.5}
                    max={30}
                    step={0.5}
                    value={screenShareBitrate / 1_000_000}
                    onChange={(e) => useVideoSettingsStore.getState().setScreenShareBitrate(Math.round(Number(e.target.value) * 1_000_000))}
                  />
                </div>
                <span className="settings-volume-value">{(screenShareBitrate / 1_000_000).toFixed(1)} Mbps</span>
              </div>
            )}

            <h4 className="settings-advanced-subheader">Transport</h4>

            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Quality of Service for Camera</span>
                <span className="settings-row-hint">
                  Flags traffic using DSCP marking so your network can prioritize it. May not work on all networks.
                </span>
              </div>
              <select
                className="settings-select"
                value={cameraPriority}
                onChange={(e) => useVideoSettingsStore.getState().setCameraPriority(e.target.value as VideoPriority)}
              >
                <option value="off">Off (No Tagging)</option>
                <option value="low">Low (DF)</option>
                <option value="medium">Default (AF43)</option>
                <option value="high">High (EF)</option>
              </select>
            </div>

            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Quality of Service for Screen Share</span>
                <span className="settings-row-hint">
                  Flags traffic using DSCP marking so your network can prioritize it. May not work on all networks.
                </span>
              </div>
              <select
                className="settings-select"
                value={screenSharePriority}
                onChange={(e) => useVideoSettingsStore.getState().setScreenSharePriority(e.target.value as VideoPriority)}
              >
                <option value="off">Off (No Tagging)</option>
                <option value="low">Low (DF)</option>
                <option value="medium">Default (AF42)</option>
                <option value="high">High (EF)</option>
              </select>
            </div>

            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Video Quality Layers</span>
                <span className="settings-row-hint">
                  Sends your video at multiple quality levels simultaneously. Viewers with slower connections automatically receive a lower quality version, while those with fast connections get full quality. More layers adapt better but use more CPU.
                </span>
              </div>
              <select
                className="settings-select"
                value={scalabilityMode}
                onChange={(e) => useVideoSettingsStore.getState().setScalabilityMode(e.target.value as 'auto' | 'L1T3' | 'L2T3' | 'L3T3')}
              >
                <option value="auto">Auto (3 Layers)</option>
                <option value="L1T3">Single Quality (No Adaptation)</option>
                <option value="L2T3">2 Layers</option>
                <option value="L3T3">3 Layers (Best Adaptation)</option>
              </select>
            </div>
          </div>
        )}
      </div>

      <TTSSection />
    </>
  );
};

// ─── Text-to-Speech Section ─────────────────────────────────────────────────

const TTSSection: React.FC = () => {
  const ttsEnabled = useTTSSettingsStore((s) => s.ttsEnabled);
  const ttsVoice = useTTSSettingsStore((s) => s.ttsVoice);
  const ttsRate = useTTSSettingsStore((s) => s.ttsRate);
  const ttsVolume = useTTSSettingsStore((s) => s.ttsVolume);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);

  useEffect(() => {
    const loadVoices = () => {
      const available = window.speechSynthesis?.getVoices() ?? [];
      setVoices(available);
    };
    loadVoices();
    window.speechSynthesis?.addEventListener('voiceschanged', loadVoices);
    return () => window.speechSynthesis?.removeEventListener('voiceschanged', loadVoices);
  }, []);

  const handlePreview = () => {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance('This is a preview of text-to-speech in Concord.');
    utterance.rate = ttsRate;
    utterance.volume = ttsVolume;
    if (ttsVoice) {
      const match = voices.find((v) => v.voiceURI === ttsVoice);
      if (match) utterance.voice = match;
    }
    window.speechSynthesis.speak(utterance);
  };

  return (
    <div className="settings-section" id="section-tts">
      <h2 className="settings-section-title">Text-to-Speech</h2>
      <p className="settings-section-description">
        Read voice text chat messages aloud while you're in a voice channel.
      </p>

      <div className="settings-row">
        <div className="settings-row-info">
          <span className="settings-row-label">Enable TTS Playback</span>
          <span className="settings-row-hint">Incoming voice text chat messages will be spoken aloud</span>
        </div>
        <ToggleSwitch
          checked={ttsEnabled}
          onChange={(v) => useTTSSettingsStore.getState().setTtsEnabled(v)}
        />
      </div>

      <div className="settings-row">
        <div className="settings-row-info">
          <span className="settings-row-label">Voice</span>
          <span className="settings-row-hint">Select the TTS voice to use</span>
        </div>
        <select
          className="settings-select"
          value={ttsVoice ?? ''}
          onChange={(e) => useTTSSettingsStore.getState().setTtsVoice(e.target.value || null)}
        >
          <option value="">System Default</option>
          {voices.map((v) => (
            <option key={v.voiceURI} value={v.voiceURI}>
              {v.name} ({v.lang})
            </option>
          ))}
        </select>
      </div>

      <div className="settings-row">
        <div className="settings-row-info">
          <span className="settings-row-label">Speed</span>
          <span className="settings-row-hint">{ttsRate.toFixed(1)}x</span>
        </div>
        <input
          type="range"
          className="settings-slider"
          min={0.5}
          max={2.0}
          step={0.1}
          value={ttsRate}
          onChange={(e) => useTTSSettingsStore.getState().setTtsRate(Number(e.target.value))}
        />
      </div>

      <div className="settings-row">
        <div className="settings-row-info">
          <span className="settings-row-label">Volume</span>
          <span className="settings-row-hint">{Math.round(ttsVolume * 100)}%</span>
        </div>
        <input
          type="range"
          className="settings-slider"
          min={0}
          max={1}
          step={0.05}
          value={ttsVolume}
          onChange={(e) => useTTSSettingsStore.getState().setTtsVolume(Number(e.target.value))}
        />
      </div>

      <div className="settings-row">
        <button className="settings-btn-secondary" onClick={handlePreview}>
          Preview
        </button>
      </div>
    </div>
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

const NAV_SUBSECTIONS: Record<string, { id: string; label: string }[]> = {
  appearance: [
    { id: 'color-scheme', label: 'Color Scheme' },
    { id: 'theme', label: 'Theme' },
    { id: 'display', label: 'Display' },
  ],
  privacy: [
    { id: 'active-sessions', label: 'Active Sessions' },
    { id: 'past-sessions', label: 'Past Sessions' },
  ],
  voice: [
    { id: 'device-config', label: 'Device Configuration' },
    { id: 'audio-config', label: 'Audio Configuration' },
    { id: 'video-screen', label: 'Video & Screen Share' },
    { id: 'tts', label: 'Text-to-Speech' },
  ],
};

// ─── Settings Page ──────────────────────────────────────────────────────────

const SettingsPage: React.FC = () => {
  const navigate = useNavigate();
  const [activeSection, setActiveSection] = useState<SettingsSection>('appearance');
  const [isPending, startTransition] = useTransition();
  const [activeSubsection, setActiveSubsection] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // IntersectionObserver: track which section is in view and highlight tree nav
  useEffect(() => {
    const root = contentRef.current?.closest('.settings-page-content') as HTMLElement | null;
    if (!root) return;

    // Small delay to let sections render after tab switch
    const timer = setTimeout(() => {
      const observer = new IntersectionObserver(
        (entries) => {
          let bestEntry: IntersectionObserverEntry | null = null;
          for (const entry of entries) {
            if (entry.isIntersecting && (!bestEntry || entry.intersectionRatio > bestEntry.intersectionRatio)) {
              bestEntry = entry;
            }
          }
          if (bestEntry) {
            setActiveSubsection(bestEntry.target.id.replace('section-', ''));
          }
        },
        { root, threshold: [0, 0.25, 0.5, 0.75, 1], rootMargin: '-20% 0px -60% 0px' }
      );

      const sections = root.querySelectorAll('[id^="section-"]');
      sections.forEach((el) => observer.observe(el));

      // Store observer ref for cleanup
      (root as any).__settingsObserver = observer;
    }, 50);

    return () => {
      clearTimeout(timer);
      const obs = (root as any)?.__settingsObserver as IntersectionObserver | undefined;
      obs?.disconnect();
    };
  }, [activeSection]);

  const scrollToSection = useCallback((sectionId: string) => {
    const el = document.getElementById(`section-${sectionId}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

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
            {/* Left navigation with tree subsections */}
            <nav className="settings-nav">
              {navItems.map((item) => {
                const isActive = activeSection === item.id;
                const subs = isActive ? NAV_SUBSECTIONS[item.id] : undefined;

                return (
                  <div key={item.id} className="settings-nav-group">
                    <button
                      className={`settings-nav-item ${isActive ? 'active' : ''}`}
                      onClick={() => item.enabled && startTransition(() => setActiveSection(item.id))}
                      disabled={!item.enabled}
                    >
                      <span className="settings-nav-item-icon">{item.icon}</span>
                      {item.label}
                      {!item.enabled && <span className="settings-nav-badge">Soon</span>}
                    </button>

                    {subs && subs.length > 0 && (
                      <div className="settings-nav-tree">
                        {subs.map((sub, i) => (
                          <div
                            key={sub.id}
                            className={`settings-nav-tree-item-wrapper${i === subs.length - 1 ? ' settings-nav-tree-item-wrapper--last' : ''}`}
                          >
                            <button
                              className={`settings-nav-tree-item${activeSubsection === sub.id ? ' active' : ''}`}
                              onClick={() => scrollToSection(sub.id)}
                            >
                              {sub.label}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </nav>

            {/* Right content */}
            <div
              ref={contentRef}
              className={`settings-content${isPending ? ' settings-content-loading' : ''}`}
            >
              {renderSection()}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SettingsPage;
