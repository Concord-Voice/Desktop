import React, { useState, useEffect, useCallback, useMemo, useRef, useTransition } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import { useUserStore } from '../../stores/userStore';
import type { AppearanceSettings, CustomColors } from '../../stores/settingsStore';
import { useVoiceStore, AUDIO_QUALITY_TIERS, type AudioQualityTier } from '../../stores/voiceStore';
import { useAudioSettingsStore, type AudioPriority } from '../../stores/audioSettingsStore';
import {
  useVideoSettingsStore,
  VIDEO_QUALITY_PRESETS,
  type ScreenContentType,
  type DegradationPreference,
  type VideoPriority,
} from '../../stores/videoSettingsStore';
import {
  codecKey,
  codecKeyMime,
  getCodecInfo,
  type CodecCapability,
} from '../../services/mediaCapabilities';
import { isValidHex } from '../../utils/colorUtils';
import { apiFetch } from '../../services/apiClient';
import LoadingSpinner from '../Auth/LoadingSpinner';
import Modal from '../ui/Modal';
import DeviceSelector from '../Voice/DeviceSelector';
import { useMicTest } from '../../hooks/useMicTest';
import {
  useDraftAudioSetting,
  useDraftVideoSetting,
  useDraftTtsSetting,
  useDraftAppearance,
  setDraftAudioSetting,
  setDraftVideoSetting,
  setDraftTtsSetting,
  setDraftAppearanceSetting,
  batchSetAudioDrafts,
  useDraftSettingsLifecycle,
  useDraftActions,
  useStashAndSwapAudioMode,
} from '../../hooks/useDraftSettings';
import { usePrivacyStore } from '../../stores/privacyStore';
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
  const appearance = useDraftAppearance();

  const colorSchemes: {
    value: AppearanceSettings['colorScheme'];
    label: string;
    gradient: string;
  }[] = [
    {
      value: 'concord',
      label: 'Concord Voice',
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
              onClick={() => setDraftAppearanceSetting('colorScheme', cs.value)}
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
                setDraftAppearanceSetting('customColors', appearance.customColors);
                setDraftAppearanceSetting('colorScheme', 'custom');
              } else {
                const defaults: CustomColors = {
                  background: '#0d0821',
                  accentPrimary: '#fa709a',
                  accentSecondary: '#ffe13f',
                };
                setDraftAppearanceSetting('customColors', defaults);
                setDraftAppearanceSetting('colorScheme', 'custom');
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
            {[
              { key: 'background' as const, label: 'Background' },
              { key: 'accentPrimary' as const, label: 'Primary Accent' },
              { key: 'accentSecondary' as const, label: 'Secondary Accent' },
            ].map(({ key, label }) => (
              <div key={key} className="custom-theme-picker-row">
                <label className="custom-theme-picker-label">{label}</label>
                <div className="custom-theme-picker-input-group">
                  <input
                    type="color"
                    value={appearance.customColors![key]}
                    onChange={(e) =>
                      setDraftAppearanceSetting('customColors', {
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
                        setDraftAppearanceSetting('customColors', {
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
          Choose how Concord Voice looks to you. Select a theme or match your system settings.
        </p>
        <div className="theme-selector">
          {themes.map((t) => (
            <button
              key={t.value}
              className={`theme-option ${appearance.theme === t.value ? 'selected' : ''}`}
              onClick={() => setDraftAppearanceSetting('theme', t.value)}
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
                onClick={() => setDraftAppearanceSetting('fontSize', fs.value)}
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
              {appearance.compactMode
                ? 'Enabled. Padding and spacing are reduced throughout the interface, fitting more content on screen.'
                : 'Disabled. Standard padding and spacing for a comfortable, spacious layout.'}
            </span>
          </div>
          <ToggleSwitch
            checked={appearance.compactMode}
            onChange={(v) => setDraftAppearanceSetting('compactMode', v)}
          />
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Reduce Animations</span>
            <span className="settings-row-hint">
              {appearance.reduceAnimations
                ? 'Enabled. Motion and transitions are minimized throughout the interface for a snappier experience.'
                : 'Disabled. Standard animations and transitions are used for a fluid interface.'}
            </span>
          </div>
          <ToggleSwitch
            checked={appearance.reduceAnimations}
            onChange={(v) => setDraftAppearanceSetting('reduceAnimations', v)}
          />
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

// ─── GPU Vendor Icon ────────────────────────────────────────────────────────

const GpuVendorIcon: React.FC<{ vendor: string }> = ({ vendor }) => {
  const v = vendor.toLowerCase();
  // Apple
  if (v.includes('apple'))
    return (
      <svg
        width="13"
        height="16"
        viewBox="0 0 256 315"
        fill="none"
        style={{ display: 'block', flexShrink: 0 }}
      >
        <path
          d="M213.8 167.1c-.4-39.2 32-58.1 33.5-59.1-18.2-26.7-46.6-30.3-56.7-30.7-24.2-2.4-47.2 14.2-59.5 14.2-12.3 0-31.3-13.9-51.4-13.5-26.5.4-50.9 15.4-64.5 39.1-27.5 47.7-7 118.4 19.8 157.1 13.1 18.9 28.7 40.2 49.2 39.4 19.7-.8 27.2-12.8 51-12.8 23.9 0 30.6 12.8 51.5 12.4 21.2-.4 34.7-19.3 47.7-38.3 15.1-22 21.3-43.2 21.7-44.3-.5-.2-41.6-16-42.1-63.5zM175 64.2C185.8 51.1 193.1 33.4 191 15.8c-15.2.6-33.7 10.2-44.6 23-9.8 11.3-18.4 29.5-16.1 46.9 17 1.3 34.3-8.6 44.7-21.5z"
          fill="currentColor"
        />
      </svg>
    );
  // NVIDIA
  if (v.includes('nvidia'))
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        style={{ verticalAlign: 'middle' }}
      >
        <rect x="1" y="3" width="14" height="10" rx="2" fill="#76B900" />
        <text
          x="8"
          y="10.5"
          textAnchor="middle"
          fill="white"
          fontSize="7"
          fontWeight="bold"
          fontFamily="sans-serif"
        >
          N
        </text>
      </svg>
    );
  // Intel
  if (v.includes('intel'))
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        style={{ verticalAlign: 'middle' }}
      >
        <circle cx="8" cy="8" r="7" fill="#0071C5" />
        <text
          x="8"
          y="11"
          textAnchor="middle"
          fill="white"
          fontSize="8"
          fontWeight="bold"
          fontFamily="sans-serif"
        >
          i
        </text>
      </svg>
    );
  // AMD
  if (v.includes('amd'))
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        style={{ verticalAlign: 'middle' }}
      >
        <rect x="1" y="3" width="14" height="10" rx="2" fill="#ED1C24" />
        <text
          x="8"
          y="10.5"
          textAnchor="middle"
          fill="white"
          fontSize="6"
          fontWeight="bold"
          fontFamily="sans-serif"
        >
          AMD
        </text>
      </svg>
    );
  // Qualcomm
  if (v.includes('qualcomm'))
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        style={{ verticalAlign: 'middle' }}
      >
        <circle cx="8" cy="8" r="7" fill="#3253DC" />
        <text
          x="8"
          y="11"
          textAnchor="middle"
          fill="white"
          fontSize="8"
          fontWeight="bold"
          fontFamily="sans-serif"
        >
          Q
        </text>
      </svg>
    );
  // ARM
  if (v.includes('arm'))
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        style={{ verticalAlign: 'middle' }}
      >
        <rect x="1" y="3" width="14" height="10" rx="2" fill="#0091BD" />
        <text
          x="8"
          y="10.5"
          textAnchor="middle"
          fill="white"
          fontSize="6"
          fontWeight="bold"
          fontFamily="sans-serif"
        >
          ARM
        </text>
      </svg>
    );
  return null;
};

// ─── Voice & Audio Section ──────────────────────────────────────────────────

const TIER_ORDER: AudioQualityTier[] = [
  'minimum',
  'low',
  'moderate',
  'standard',
  'high',
  'hifi',
  'studio',
];

const TIER_DESCRIPTIONS_BASIC: Record<AudioQualityTier, string> = {
  minimum:
    '16 kbps · Mono | FEC On | DTX | AFS (60ms Preferred)\nOptimized for pure survival over quality. Uses silence detection and aggressive error correction to keep you connected when the digital world is ending. Use if:\n\u2022 Bandwidth is an absolute luxury.\n\u2022 Your system is basically a Commodore 64.\n\u2022 Your internet just filed for divorce and took the router.',
  low: "32 kbps · Mono | FEC On | DTX | AFS (40ms Preferred)\nPrioritizes keeping you in the conversation without chewing through your data cap. You won't sound like a podcast host, but we will understand you. Use if:\n\u2022 You are on a strict data diet.\n\u2022 Your microphone was found at the bottom of a cereal box.\n\u2022 Your Wi-Fi is acting suspiciously spotty.",
  moderate:
    "64 kbps · Mono | FEC On | DTX | AFS (20ms Preferred)\nThe ol' reliable. The industry standard sweet spot that perfectly balances crisp voice audio with reasonable bandwidth demands. Use if:\n\u2022 You just want it to work without overthinking it.\n\u2022 You are using standard consumer-grade headsets.\n\u2022 Your internet connection actually pays rent.",
  standard:
    '96 kbps · Mono | FEC On | DTX | AFS (20ms Preferred)\nThe Concord default. Optimized for maximum clarity in voice chats, making you sound exactly like your actual self (for better or worse). Use if:\n\u2022 You want the intended, nearly-transparent Concord Voice experience.\n\u2022 You refuse to mess with settings menus.',
  high: '192 kbps · Mono | FEC On | AFS (10ms Preferred)\nCranking the dial to "virtually transparent." Delivers exceptional clarity and frequency response without crossing into absolute overkill territory. Use if:\n\u2022 You are an enthusiast who appreciates the finer frequencies.\n\u2022 You invested in a seriously good microphone.\n\u2022 Your internet speeds are something you brag about at parties.',
  hifi: '256 kbps · Stereo | FEC Off | AFS (10ms Preferred)\nMaximum fidelity for power users. This is unfiltered, transparent audio that squeezes the full factor of quality with quantity out of the Opus codec. Use if:\n\u2022 You demand maximum bang-for-the-buck quality.\n\u2022 You have enthusiast-grade, borderline-unreasonable audio gear.\n\u2022 Your internet is hardwired and unflinching.',
  studio:
    "510 kbps · Stereo | FEC Off | AFS (10ms Preferred)\nThe absolute ceiling. Massive, glorious, overkill bandwidth for acoustically transparent 48kHz/16-bit audio. It's dangerous to go alone, so take these 510,000 bits per second... Every second. Use if:\n\u2022 You are running studio-level audio production over the web.\n\u2022 You own audiophile equipment that costs more than a used car.\n\u2022 You have a rock-solid, direct-to-the-vein fiber optic connection.",
};

const VoiceAudioSection: React.FC = () => {
  const qualityTier = useVoiceStore((s) => s.qualityTier);
  const setQualityTier = useVoiceStore((s) => s.setQualityTier);
  const activeCameraCodec = useVoiceStore((s) => s.activeCameraCodec);
  const activeScreenCodec = useVoiceStore((s) => s.activeScreenCodec);
  const isInVoiceCall = useVoiceStore(
    (s) =>
      s.connectionState === 'connected' ||
      s.connectionState === 'connecting' ||
      s.connectionState === 'reconnecting'
  );
  const { isTesting, dbfsLevel, error: micTestError, startTest, stopTest } = useMicTest();

  // Audio mode (excluded from drafts — immediate)
  const advancedMode = useAudioSettingsStore((s) => s.advancedMode);

  // Audio processing settings (drafted)
  const stereoOverride = useDraftAudioSetting('stereoOverride');
  const noiseCancellation = useDraftAudioSetting('noiseCancellation');
  const echoCancellation = useDraftAudioSetting('echoCancellation');
  const autoGainControl = useDraftAudioSetting('autoGainControl');
  const noiseGateMode = useDraftAudioSetting('noiseGateMode');
  const noiseGateLevel = useDraftAudioSetting('noiseGateLevel');
  const inputVolume = useDraftAudioSetting('inputVolume');
  const outputVolume = useDraftAudioSetting('outputVolume');
  const quietBoost = useDraftAudioSetting('quietBoost');
  const quietBoostThreshold = useDraftAudioSetting('quietBoostThreshold');

  // Video settings (drafted)
  const cameraPreset = useDraftVideoSetting('cameraPreset');
  const screenResolution = useDraftVideoSetting('screenResolution');
  const screenFrameRate = useDraftVideoSetting('screenFrameRate');
  const screenContentType = useDraftVideoSetting('screenContentType');
  const preferredVideoCodec = useDraftVideoSetting('preferredVideoCodec');
  const screenSharePriority = useDraftVideoSetting('screenSharePriority');
  const screenShareBitrate = useDraftVideoSetting('screenShareBitrate');
  const cameraPriority = useDraftVideoSetting('cameraPriority');
  const degradationPreference = useDraftVideoSetting('degradationPreference');
  const scalabilityMode = useDraftVideoSetting('scalabilityMode');
  const hardwareAcceleration = useDraftVideoSetting('hardwareAcceleration');
  const hdrEncoding = useDraftVideoSetting('hdrEncoding');

  // Video settings (excluded from drafts — system-detected / UI-only)
  const codecCapabilities = useVideoSettingsStore((s) => s.codecCapabilities);
  const gpuInfo = useVideoSettingsStore((s) => s.gpuInfo);
  const videoAdvancedMode = useVideoSettingsStore((s) => s.videoAdvancedMode);
  const systemHdr = useVideoSettingsStore((s) => s.systemHdr);

  const [displayInfo, setDisplayInfo] = useState<
    {
      width: number;
      height: number;
      refreshRate: number;
      scaleFactor: number;
      isPrimary: boolean;
    }[]
  >([]);

  useEffect(() => {
    window.electron?.getDisplayInfo?.().then((displays) => {
      if (displays) setDisplayInfo(displays);
    });
  }, []);

  // Mode stashing
  const stashAndSwapAudioMode = useStashAndSwapAudioMode();

  // Display-derived values for screen share options
  const bestDisplay = useMemo(() => {
    if (displayInfo.length === 0) return { width: 1920, height: 1080, refreshRate: 60 };
    return displayInfo.reduce((best, d) =>
      d.width * d.height > best.width * best.height ? d : best
    );
  }, [displayInfo]);

  const maxRefreshRate = useMemo(() => {
    if (displayInfo.length === 0) return 60;
    return Math.round(Math.max(...displayInfo.map((d) => d.refreshRate || 60)));
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
      source: { w: bestDisplay.width, h: bestDisplay.height },
    };
    const parsed = screenResolution.match(/^(\d+)x(\d+)$/);
    const res = parsed
      ? { w: Number(parsed[1]), h: Number(parsed[2]) }
      : resMap[screenResolution] || resMap['1080p'];
    const effectiveFps = screenFrameRate === 0 ? maxRefreshRate : screenFrameRate;
    // Determine effective codec for efficiency: active (in-use) > preferred > auto-pick
    // Auto cascade picks AV1 → HEVC → VP9 first, so if any efficient codec is available, auto uses it
    const effectiveCodec = activeScreenCodec ?? preferredVideoCodec;
    const isEfficient = effectiveCodec
      ? effectiveCodec.includes('AV1') ||
        effectiveCodec.includes('H265') ||
        effectiveCodec.includes('HEVC') ||
        effectiveCodec.includes('VP9')
      : codecCapabilities.some(
          (c) =>
            c.mimeType.includes('AV1') ||
            c.mimeType.includes('H265') ||
            c.mimeType.includes('HEVC') ||
            c.mimeType.includes('VP9')
        );
    const bpp = isEfficient ? 0.04 : 0.07;
    const bps = res.w * res.h * effectiveFps * bpp;
    return Math.round(bps / 100_000) * 100_000;
  }, [
    screenResolution,
    screenFrameRate,
    preferredVideoCodec,
    activeScreenCodec,
    codecCapabilities,
    bestDisplay,
    maxRefreshRate,
  ]);

  const clampedRecommended = Math.max(1_500_000, Math.min(30_000_000, recommendedBitrate));

  // Advanced audio settings (drafted)
  const musicMode = useDraftAudioSetting('musicMode');
  const frameSize = useDraftAudioSetting('frameSize');
  const silenceDetection = useDraftAudioSetting('silenceDetection');
  const inlineFec = useDraftAudioSetting('inlineFec');
  const fecHeadroom = useDraftAudioSetting('fecHeadroom');
  const opusNack = useDraftAudioSetting('opusNack');
  const adaptivePtime = useDraftAudioSetting('adaptivePtime');
  const audioPriority = useDraftAudioSetting('audioPriority');

  // Derived tier capabilities
  const tierConfig = AUDIO_QUALITY_TIERS[qualityTier];
  // Tier slider index
  const tierIndex = TIER_ORDER.indexOf(qualityTier);
  const handleTierSlider = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const idx = Number(e.target.value);
      if (idx >= 0 && idx < TIER_ORDER.length) {
        const tier = TIER_ORDER[idx];
        setQualityTier(tier); // voiceStore — immediate, not drafted
        if (!useAudioSettingsStore.getState().advancedMode) {
          // Basic mode: batch-draft tier defaults
          const tc = AUDIO_QUALITY_TIERS[tier];
          batchSetAudioDrafts({
            silenceDetection: tc.opusDtx,
            inlineFec: tc.opusFec,
            fecHeadroom: tc.opusFec,
            frameSize: 0 as 0 | 10 | 20 | 40 | 60,
            stereoOverride: null,
          });
        }
      }
    },
    [setQualityTier]
  );

  const handleAdvancedToggle = useCallback(
    (enabled: boolean) => {
      useAudioSettingsStore.getState().setAdvancedMode(enabled); // immediate — UI toggle
      stashAndSwapAudioMode(enabled, qualityTier);
    },
    [qualityTier, stashAndSwapAudioMode]
  );

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
          <div className="settings-row-info">
            <span className="settings-volume-label">Input Volume</span>
            <span className="settings-row-hint">
              Scales your microphone level from muted (left) to 2x boost (right). Values above 100%
              may introduce clipping.
            </span>
          </div>
          <div className="settings-slider-wrapper">
            <span className="settings-slider-value">{inputVolume}%</span>
            <input
              type="range"
              className="settings-volume-slider"
              min={0}
              max={200}
              value={inputVolume}
              onChange={(e) => setDraftAudioSetting('inputVolume', Number(e.target.value))}
            />
          </div>
        </div>

        <div className="settings-mic-test-row">
          <button
            className={`settings-mic-test-btn${isTesting ? ' testing' : ''}`}
            onClick={isTesting ? stopTest : startTest}
            disabled={isInVoiceCall}
            title={isInVoiceCall ? 'Unavailable during a voice call' : undefined}
          >
            {isTesting ? 'Stop Testing' : 'Test'}
          </button>
          {micTestError && <span className="settings-mic-test-error">{micTestError}</span>}
        </div>

        {isTesting && (
          <div className="settings-mic-meter-container">
            <div className="settings-mic-meter-track">
              <div
                className="settings-mic-meter-fill"
                style={{ width: `${Math.max(0, ((dbfsLevel + 80) / 80) * 100)}%` }}
              />
            </div>
            <div className="settings-mic-meter-ticks">
              <span>-80</span>
              <span>-60</span>
              <span>-40</span>
              <span>-20</span>
              <span>0 dBFS</span>
            </div>
          </div>
        )}

        <h3 className="settings-subsection-title">Output</h3>
        <div className="settings-device-row">
          <DeviceSelector kind="audiooutput" />
        </div>
        <div className="settings-volume-row">
          <div className="settings-row-info">
            <span className="settings-volume-label">Output Volume</span>
            <span className="settings-row-hint">
              Scales all incoming audio from muted (left) to 2x boost (right). Values above 100% may
              introduce clipping.
            </span>
          </div>
          <div className="settings-slider-wrapper">
            <span className="settings-slider-value">{outputVolume}%</span>
            <input
              type="range"
              className="settings-volume-slider"
              min={0}
              max={200}
              value={outputVolume}
              onChange={(e) => setDraftAudioSetting('outputVolume', Number(e.target.value))}
            />
          </div>
        </div>

        <h3 className="settings-subsection-title">Camera</h3>
        <div className="settings-device-row">
          <DeviceSelector kind="videoinput" />
        </div>
      </div>

      {/* ═══ Audio Configuration ═══ */}
      <div className="settings-section" id="section-audio-config">
        <h2 className="settings-section-title">Audio Configuration</h2>

        {/* ── Mode Toggle ── */}
        <div className="settings-mode-toggle">
          <span
            className={`settings-mode-pill ${!advancedMode ? 'active' : ''}`}
            onClick={() => handleAdvancedToggle(false)}
          >
            Basic Settings
          </span>
          <span
            className={`settings-mode-pill ${advancedMode ? 'active' : ''}`}
            onClick={() => handleAdvancedToggle(true)}
          >
            Advanced Settings
          </span>
        </div>

        {advancedMode && (
          <p className="settings-mode-notice">
            These settings override the quality tier presets. Switching back to Basic will save your
            advanced configuration but apply your last Basic settings instead.
          </p>
        )}

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
                  onClick={() => {
                    setQualityTier(tier);
                    if (!useAudioSettingsStore.getState().advancedMode) {
                      const tc = AUDIO_QUALITY_TIERS[tier];
                      batchSetAudioDrafts({
                        silenceDetection: tc.opusDtx,
                        inlineFec: tc.opusFec,
                        fecHeadroom: tc.opusFec,
                        frameSize: 0 as 0 | 10 | 20 | 40 | 60,
                        stereoOverride: null,
                      });
                    }
                  }}
                >
                  {config.label}
                </span>
              );
            })}
          </div>
          <div className="settings-tier-track">
            <div className="settings-tier-ticks">
              {TIER_ORDER.map((_, i) => (
                <span key={i} className={`settings-tier-tick ${tierIndex === i ? 'active' : ''}`} />
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
          <div className="settings-tier-kbps-container">
            <span
              className="settings-tier-kbps-label"
              style={{
                left: `calc(${100 / 14 + (tierIndex / (TIER_ORDER.length - 1)) * (100 - 200 / 14)}%)`,
              }}
            >
              {Math.round(AUDIO_QUALITY_TIERS[qualityTier].maxBitrate / 1000)} kbps
            </span>
          </div>
          {!advancedMode && (
            <div className="settings-tier-description">
              {TIER_DESCRIPTIONS_BASIC[qualityTier].split('\n').map((line, i) => (
                <span key={i}>{line}</span>
              ))}
              {AUDIO_QUALITY_TIERS[qualityTier].premium && (
                <span className="settings-quality-premium-badge">Premium</span>
              )}
            </div>
          )}
        </div>

        {/* ── Processing ── */}
        <h3 className="settings-subsection-title">Processing</h3>

        <div className={`settings-row ${musicMode ? 'settings-row-disabled' : ''}`}>
          <div className="settings-row-info">
            <span className="settings-row-label">Noise Cancellation</span>
            <span className="settings-row-hint">
              {musicMode
                ? 'Locked by Music Mode. Noise cancellation is forced off to preserve full-bandwidth audio fidelity.'
                : noiseCancellation
                  ? "Enabled. Background noise from your microphone is actively filtered out by the system's noise suppression. May slightly reduce audio fidelity in noisy environments."
                  : 'Disabled. No noise filtering is applied \u2014 all ambient sound passes through unprocessed.'}
            </span>
          </div>
          <ToggleSwitch
            checked={!musicMode && noiseCancellation}
            onChange={(v) => {
              if (!musicMode) setDraftAudioSetting('noiseCancellation', v);
            }}
            disabled={musicMode}
          />
        </div>

        <div className={`settings-row ${musicMode ? 'settings-row-disabled' : ''}`}>
          <div className="settings-row-info">
            <span className="settings-row-label">Echo Cancellation</span>
            <span className="settings-row-hint">
              {musicMode
                ? 'Locked by Music Mode. Echo cancellation is forced off to preserve unprocessed audio fidelity.'
                : echoCancellation
                  ? 'Enabled. Acoustic echo cancellation prevents your speakers from feeding back into your microphone, allowing speaker use without headphones.'
                  : 'Disabled. No echo cancellation is applied. Use headphones to prevent feedback loops.'}
            </span>
          </div>
          <ToggleSwitch
            checked={!musicMode && echoCancellation}
            onChange={(v) => {
              if (!musicMode) setDraftAudioSetting('echoCancellation', v);
            }}
            disabled={musicMode}
          />
        </div>

        <div className={`settings-row ${musicMode ? 'settings-row-disabled' : ''}`}>
          <div className="settings-row-info">
            <span className="settings-row-label">Auto Gain Control</span>
            <span className="settings-row-hint">
              {musicMode
                ? 'Locked by Music Mode. Automatic gain control is forced off to prevent dynamic compression of your audio signal.'
                : autoGainControl
                  ? 'Enabled. Automatically normalizes your microphone volume \u2014 making quiet speech louder and loud speech softer.'
                  : 'Disabled. Your microphone level is not automatically adjusted. Manual volume control via the input slider is recommended.'}
            </span>
          </div>
          <ToggleSwitch
            checked={!musicMode && autoGainControl}
            onChange={(v) => {
              if (!musicMode) setDraftAudioSetting('autoGainControl', v);
            }}
            disabled={musicMode}
          />
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Input Noise Gate</span>
            <span className="settings-row-hint">
              {noiseGateMode === 'manual'
                ? `Enabled. Input below ${noiseGateLevel} dBFS is muted with a hard cutoff. Sounds above this threshold pass through unaffected.`
                : 'Disabled. No hard cutoff is applied to your input. Relies on noise cancellation and auto gain control if those are enabled.'}
            </span>
          </div>
          <ToggleSwitch
            checked={noiseGateMode === 'manual'}
            onChange={(v) => setDraftAudioSetting('noiseGateMode', v ? 'manual' : 'auto')}
          />
        </div>

        {noiseGateMode === 'manual' && (
          <div className="settings-row settings-row-child">
            <div className="settings-row-info">
              <span className="settings-row-label">Gate Threshold</span>
              <span className="settings-row-hint">
                {noiseGateLevel >= -25
                  ? `${noiseGateLevel} dBFS \u2014 Gates everything except loud, close-mic speech. Only passes through someone talking directly into a microphone.`
                  : noiseGateLevel >= -35
                    ? `${noiseGateLevel} dBFS \u2014 Gates background noise and quiet sounds. Passes through normal conversational speaking volume.`
                    : noiseGateLevel >= -50
                      ? `${noiseGateLevel} dBFS \u2014 Gates ambient room noise. Passes through most intentional speech, including softer voices.`
                      : noiseGateLevel >= -65
                        ? `${noiseGateLevel} dBFS \u2014 Gates only faint background hum. Most sounds above a quiet whisper will pass through.`
                        : `${noiseGateLevel} dBFS \u2014 Gates only near-total silence. Virtually everything audible passes through unaffected.`}
              </span>
            </div>
            <div className="settings-slider-wrapper">
              <span className="settings-slider-value">{noiseGateLevel} dBFS</span>
              <input
                type="range"
                className="settings-slider"
                min={-80}
                max={-20}
                value={noiseGateLevel}
                onChange={(e) => setDraftAudioSetting('noiseGateLevel', Number(e.target.value))}
              />
            </div>
          </div>
        )}

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Boost Quiet Users</span>
            <span className="settings-row-hint">
              {quietBoost
                ? 'Enabled. Participants whose audio falls below the threshold are dynamically amplified to a comfortable level. Normal-volume users are unaffected.'
                : 'Disabled. All participants play at their natural volume level with no receiver-side amplification.'}
            </span>
          </div>
          <ToggleSwitch
            checked={quietBoost}
            onChange={(v) => setDraftAudioSetting('quietBoost', v)}
          />
        </div>

        {quietBoost && (
          <div className="settings-row settings-row-child">
            <div className="settings-row-info">
              <span className="settings-row-label">Boost Threshold</span>
              <span className="settings-row-hint">
                {quietBoostThreshold >= -24
                  ? `${quietBoostThreshold} dBFS \u2014 Boosts anyone not talking directly at their mic. Like someone speaking to you from across the room.`
                  : quietBoostThreshold >= -30
                    ? `${quietBoostThreshold} dBFS \u2014 Boosts participants who sound turned away from their mic. Like someone talking but facing the other direction.`
                    : quietBoostThreshold >= -38
                      ? `${quietBoostThreshold} dBFS \u2014 Boosts noticeably quiet participants. Like someone whispering nearby or speaking softly from a distance.`
                      : quietBoostThreshold >= -45
                        ? `${quietBoostThreshold} dBFS \u2014 Boosts only very quiet participants. Like someone whispering close to their mic.`
                        : `${quietBoostThreshold} dBFS \u2014 Boosts only barely-audible participants. Like catching a faint whisper from across a quiet room.`}
              </span>
            </div>
            <div className="settings-slider-wrapper">
              <span className="settings-slider-value">{quietBoostThreshold} dBFS</span>
              <input
                type="range"
                className="settings-slider"
                min={-50}
                max={-20}
                value={quietBoostThreshold}
                onChange={(e) =>
                  setDraftAudioSetting('quietBoostThreshold', Number(e.target.value))
                }
              />
            </div>
          </div>
        )}

        {/* ── Advanced-only: Opus Codec ── */}
        {advancedMode && (
          <>
            <h3 className="settings-subsection-title">Opus Codec</h3>

            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Music Mode</span>
                <span className="settings-row-hint">
                  {musicMode
                    ? 'Enabled. Noise suppression, echo cancellation, and auto gain control are bypassed. The Opus codec uses full 48 kHz bandwidth optimized for music fidelity.'
                    : 'Disabled. Standard voice processing is active with voice-optimized encoding.'}
                </span>
              </div>
              <ToggleSwitch
                checked={musicMode}
                onChange={(v) => setDraftAudioSetting('musicMode', v)}
              />
            </div>

            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Adaptive Frame Size (AFS)</span>
                <span className="settings-row-hint">
                  {adaptivePtime
                    ? 'Enabled. Concord Voice dynamically adjusts packet duration during congestion, trading latency for reliability. Manual Frame Size is overridden.'
                    : 'Disabled. Packet duration is fixed at the configured Frame Size value below.'}
                </span>
              </div>
              <ToggleSwitch
                checked={adaptivePtime}
                onChange={(v) => setDraftAudioSetting('adaptivePtime', v)}
              />
            </div>

            <div className={`settings-row ${adaptivePtime ? 'settings-row-disabled' : ''}`}>
              <div className="settings-row-info">
                <span className="settings-row-label">Frame Size (ptime)</span>
                <span className="settings-row-hint">
                  {adaptivePtime
                    ? 'Locked by Adaptive Frame Size. Manual frame size is overridden while adaptive sizing is active.'
                    : frameSize === 0
                      ? `Packet duration sent to other participants. Currently using the tier's preferred size (${tierConfig.preferredFrameSize}ms).`
                      : frameSize === 10
                        ? 'Packet duration sent to other participants. Currently 10ms \u2014 lowest latency, highest overhead.'
                        : frameSize === 20
                          ? 'Packet duration sent to other participants. Currently 20ms \u2014 standard balance of latency and efficiency.'
                          : frameSize === 40
                            ? 'Packet duration sent to other participants. Currently 40ms \u2014 reduced overhead, moderately increased latency.'
                            : 'Packet duration sent to other participants. Currently 60ms \u2014 maximum efficiency, highest latency.'}
                </span>
              </div>
              <select
                className="settings-select"
                value={adaptivePtime ? 0 : frameSize}
                onChange={(e) =>
                  setDraftAudioSetting('frameSize', Number(e.target.value) as 0 | 10 | 20 | 40 | 60)
                }
                disabled={adaptivePtime}
              >
                <option value={0}>Default ({tierConfig.preferredFrameSize} ms)</option>
                <option value={10}>10 ms (lowest latency)</option>
                <option value={20}>20 ms</option>
                <option value={40}>40 ms (efficient)</option>
                <option value={60}>60 ms (most efficient)</option>
              </select>
            </div>

            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Silence Detection (DTX)</span>
                <span className="settings-row-hint">
                  {silenceDetection
                    ? 'Enabled. The Opus codec uses discontinuous transmission to send fewer packets during silence, reducing bandwidth usage.'
                    : 'Disabled. Packets are sent continuously regardless of input activity. Uses more bandwidth but avoids transition artifacts.'}
                </span>
              </div>
              <ToggleSwitch
                checked={silenceDetection}
                onChange={(v) => setDraftAudioSetting('silenceDetection', v)}
              />
            </div>

            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Mic Channel Mode</span>
                <span className="settings-row-hint">
                  {(stereoOverride ?? tierConfig.opusStereo)
                    ? 'Currently Stereo — Opus encodes two channels using mid-side (M/S) joint stereo, splitting audio into a summed Mid channel and a difference Side channel. When channels are similar, the Side channel compresses to near-nothing, so stereo does not double bandwidth. Recommended for multi-microphone setups, Hi-Fi, or studio-grade configurations.'
                    : 'Currently Mono — a single audio channel is encoded and delivered. Recommended for most users, especially with standard single-microphone headsets and desk mics.'}
                </span>
              </div>
              <select
                className="settings-select"
                value={(stereoOverride ?? tierConfig.opusStereo) ? 'stereo' : 'mono'}
                onChange={(e) => {
                  const v = e.target.value === 'stereo';
                  setDraftAudioSetting('stereoOverride', v);
                }}
              >
                <option value="stereo">Stereo</option>
                <option value="mono">Mono</option>
              </select>
            </div>

            {/* ── Error Correction & Reliability ── */}
            <h3 className="settings-subsection-title">Error Correction & Reliability</h3>

            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">In-Line Forward Error Correction (FEC)</span>
                <span className="settings-row-hint">
                  {inlineFec
                    ? 'Enabled. Every packet includes a low-quality copy of the previous frame as a safety net. The receiver uses it to fill gaps when a packet goes missing. VBR keeps the overhead minimal on easy frames.'
                    : 'Disabled. Packets carry only primary audio with no redundancy. Maximizes quality per-packet, but the receiver has nothing to fall back on during packet loss.'}
                </span>
              </div>
              <ToggleSwitch
                checked={inlineFec}
                onChange={(v) => setDraftAudioSetting('inlineFec', v)}
              />
            </div>

            {inlineFec && (
              <div className="settings-row">
                <div className="settings-row-info">
                  <span className="settings-row-label">Grant FEC Headroom</span>
                  <span className="settings-row-hint">
                    {fecHeadroom
                      ? 'Enabled. When packet loss is detected, the bitrate ceiling is raised so the always-present FEC payload does not eat into primary audio quality.'
                      : "Disabled. The bitrate ceiling stays fixed at the tier's base rate. Since FEC is always encoded, it competes with primary audio for the same budget on complex frames."}
                  </span>
                </div>
                <ToggleSwitch
                  checked={fecHeadroom}
                  onChange={(v) => setDraftAudioSetting('fecHeadroom', v)}
                />
              </div>
            )}

            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">NACK (Retransmission)</span>
                <span className="settings-row-hint">
                  {opusNack
                    ? 'Enabled. Concord requests retransmission of lost audio packets from the server. Improves reliability on lossy networks at the cost of added latency.'
                    : 'Disabled. Lost packets are not retransmitted. Relies on FEC or interpolation to handle gaps.'}
                </span>
              </div>
              <ToggleSwitch
                checked={opusNack}
                onChange={(v) => setDraftAudioSetting('opusNack', v)}
              />
            </div>

            {/* ── Transport ── */}
            <h3 className="settings-subsection-title">Transport</h3>

            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Quality of Service for Audio</span>
                <span className="settings-row-hint">
                  {
                    'Marks audio traffic with DSCP tags so your network can prioritize it. Not all networks honor DSCP tags; some may ignore or strip them, so this setting may have no effect depending on you or your ISP\u2019s network configurations. '
                  }
                  {audioPriority === 'off'
                    ? 'Currently off \u2014 no tagging applied.'
                    : audioPriority === 'low'
                      ? 'Currently Low (DF) \u2014 minimal differentiation. (RFC 2474)'
                      : audioPriority === 'medium'
                        ? 'Currently Default (AF41) \u2014 recommended for most networks. (RFC 2597)'
                        : 'Currently High (EF) \u2014 highest priority. (RFC 5127)'}
                </span>
              </div>
              <select
                className="settings-select"
                value={audioPriority}
                onChange={(e) =>
                  setDraftAudioSetting('audioPriority', e.target.value as AudioPriority)
                }
              >
                <option value="off">Off (No Tagging)</option>
                <option value="low">Low (DF)</option>
                <option value="medium">Default (AF41)</option>
                <option value="high">High (EF)</option>
              </select>
            </div>
          </>
        )}
      </div>

      {/* ═══ Video Configuration ═══ */}
      <div className="settings-section" id="section-video-screen">
        <h2 className="settings-section-title">Video Configuration</h2>

        <div className="settings-mode-toggle">
          <span
            className={`settings-mode-pill ${!videoAdvancedMode ? 'active' : ''}`}
            onClick={() => useVideoSettingsStore.getState().setVideoAdvancedMode(false)}
          >
            Basic Settings
          </span>
          <span
            className={`settings-mode-pill ${videoAdvancedMode ? 'active' : ''}`}
            onClick={() => useVideoSettingsStore.getState().setVideoAdvancedMode(true)}
          >
            Advanced Settings
          </span>
        </div>

        {/* ── Camera ── */}
        <h3 className="settings-subsection-title">Camera</h3>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Camera Preset</span>
            <span className="settings-row-hint">
              {cameraPreset === 'system'
                ? "Constrains the camera's capture resolution and frame rate. Currently System Default \u2014 the camera and driver decide automatically."
                : `Constrains the camera's capture resolution and frame rate. Currently requesting ${VIDEO_QUALITY_PRESETS[cameraPreset]?.label ?? cameraPreset}.`}
            </span>
          </div>
          <select
            className="settings-select"
            value={cameraPreset}
            onChange={(e) => setDraftVideoSetting('cameraPreset', e.target.value)}
          >
            {Object.entries(VIDEO_QUALITY_PRESETS).map(([key, preset]) => (
              <option key={key} value={key}>
                {preset.label}
              </option>
            ))}
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
            <span className="settings-row-hint">
              {screenResolution === 'source'
                ? "Default capture resolution for screen sharing. Currently Native \u2014 captures at your display's full resolution."
                : `Default capture resolution for screen sharing. Currently ${screenResolution}.`}
            </span>
          </div>
          <select
            className="settings-select"
            value={screenResolution}
            onChange={(e) => setDraftVideoSetting('screenResolution', e.target.value)}
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
                    {d.width}×{d.height}
                    {d.isPrimary ? ' (Primary)' : ''}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Frame Rate</span>
            <span className="settings-row-hint">
              {screenFrameRate === 0
                ? `Default capture frame rate for screen sharing. Currently Native (${maxRefreshRate} Hz).`
                : `Default capture frame rate for screen sharing. Currently ${screenFrameRate} FPS.`}
            </span>
          </div>
          <select
            className="settings-select"
            value={screenFrameRate}
            onChange={(e) => setDraftVideoSetting('screenFrameRate', Number(e.target.value))}
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
                ? 'Optimizes encoding for the type of content being shared. Currently Auto \u2014 Concord Voice detects motion vs. static content and adjusts accordingly.'
                : screenContentType === 'motion'
                  ? 'Optimizes encoding for the type of content being shared. Currently Motion \u2014 prioritizes smooth frame rate for video and animations.'
                  : 'Optimizes encoding for the type of content being shared. Currently Detail \u2014 prioritizes sharp text and edges for code and documents.'}
            </span>
          </div>
          <select
            className="settings-select"
            value={screenContentType}
            onChange={(e) =>
              setDraftVideoSetting('screenContentType', e.target.value as ScreenContentType)
            }
          >
            <option value="auto">Auto</option>
            <option value="motion">Motion (Video & Animation)</option>
            <option value="detail">Detail (Text & Code)</option>
          </select>
        </div>

        {/* ── Advanced Video Settings ── */}
        {videoAdvancedMode && (
          <>
            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Congestion Priority</span>
                <span className="settings-row-hint">
                  {degradationPreference === 'balanced'
                    ? 'How Concord adapts your camera during network congestion. Currently Balanced \u2014 Concord decides whether to reduce resolution or framerate.'
                    : degradationPreference === 'maintain-framerate'
                      ? 'How Concord adapts your camera during network congestion. Currently Prefer Smooth Video \u2014 keeps framerate by reducing resolution.'
                      : 'How Concord adapts your camera during network congestion. Currently Prefer Sharp Details \u2014 keeps resolution by reducing framerate.'}
                </span>
              </div>
              <select
                className="settings-select"
                value={degradationPreference}
                onChange={(e) =>
                  setDraftVideoSetting(
                    'degradationPreference',
                    e.target.value as DegradationPreference
                  )
                }
              >
                <option value="balanced">Balanced</option>
                <option value="maintain-framerate">Prefer Smooth Video</option>
                <option value="maintain-resolution">Prefer Sharp Details</option>
              </select>
            </div>

            <h3 className="settings-subsection-title">Codec & Hardware</h3>

            {gpuInfo && (
              <p className="settings-section-description" style={{ marginTop: 0, marginBottom: 6 }}>
                <span className="settings-gpu-badge">
                  <GpuVendorIcon vendor={gpuInfo.vendor} /> {gpuInfo.vendor}
                  {gpuInfo.device ? ` · ${gpuInfo.device}` : ''}
                </span>
              </p>
            )}

            {codecCapabilities.length > 0 &&
              (() => {
                const codecPriority: Record<string, number> = {
                  AV1: 0,
                  H265: 1,
                  HEVC: 1,
                  VP9: 2,
                  H264: 3,
                  VP8: 4,
                };
                const codecDisplayName: Record<string, string> = {
                  H264: 'AVC (H.264)',
                  H265: 'HEVC (H.265)',
                  HEVC: 'HEVC (H.265)',
                };
                // Codecs the mediasoup router supports (H265 not yet supported)
                const routerSupported = new Set([
                  'video/vp8',
                  'video/vp9',
                  'video/h264',
                  'video/av1',
                ]);
                const sortByPriority = (a: CodecCapability, b: CodecCapability) =>
                  (codecPriority[a.mimeType.replace('video/', '')] ?? 99) -
                  (codecPriority[b.mimeType.replace('video/', '')] ?? 99);
                const displayName = (c: CodecCapability) => {
                  const raw = c.mimeType.replace('video/', '');
                  const base = codecDisplayName[raw] ?? raw;
                  const profile = c.profileLabel ? ` (${c.profileLabel})` : '';
                  return `${base}${profile}`;
                };
                const isSupported = (c: CodecCapability) =>
                  routerSupported.has(c.mimeType.toLowerCase());

                // HW column: codecs with GPU acceleration
                // SW column: ALL codecs (every codec has a software encoder fallback)
                const hwCodecs = codecCapabilities
                  .filter((c) => c.powerEfficient)
                  .sort(sortByPriority);
                const swCodecs = [...codecCapabilities].sort(sortByPriority);

                // Which column is active
                const hwHasSupported = hwCodecs.some((c) => isSupported(c));
                const preferredMime = preferredVideoCodec
                  ? codecKeyMime(preferredVideoCodec)
                  : null;
                const hwActive = preferredMime
                  ? // User picked a specific codec → active column is whichever contains its mimeType
                    hardwareAcceleration &&
                    hwCodecs.some(
                      (c) =>
                        c.mimeType.toLowerCase() === preferredMime.toLowerCase() && isSupported(c)
                    )
                  : hardwareAcceleration && hwHasSupported;

                // Determine preferred codec key for green highlight
                const activeColumnCodecs = hwActive ? hwCodecs : swCodecs;
                const preferredKey =
                  preferredVideoCodec &&
                  routerSupported.has(codecKeyMime(preferredVideoCodec).toLowerCase())
                    ? preferredVideoCodec
                    : (() => {
                        const first = activeColumnCodecs.find((c) => isSupported(c));
                        return first ? codecKey(first) : null;
                      })();

                // Active codecs currently in use (from voice producers — now profile-aware keys)
                const inUseKeys = new Set<string>(
                  [activeCameraCodec, activeScreenCodec]
                    .filter(Boolean)
                    .map((k) => (k as string).toLowerCase())
                );

                const renderCodecItem = (
                  c: CodecCapability,
                  columnKey: string,
                  isActiveColumn: boolean
                ) => {
                  const supported = isSupported(c);
                  const cKey = codecKey(c);
                  const isPreferred = isActiveColumn && supported && cKey === preferredKey;
                  const isInUse =
                    supported &&
                    (inUseKeys.has(cKey.toLowerCase()) || inUseKeys.has(c.mimeType.toLowerCase()));
                  const tooltip = !supported
                    ? 'Not supported'
                    : isPreferred && isInUse
                      ? 'Preferred · In Use'
                      : isInUse
                        ? 'In Use'
                        : isPreferred
                          ? 'Preferred'
                          : 'Available';
                  return (
                    <div
                      key={`${columnKey}-${cKey}`}
                      className={`settings-codec-item${isPreferred ? ' preferred' : ''}${isInUse ? ' in-use' : ''}${!supported ? ' unsupported' : ''}`}
                      data-tooltip={tooltip}
                    >
                      <span className={`settings-codec-name${!supported ? ' strikethrough' : ''}`}>
                        {displayName(c)}
                      </span>
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
                        >
                          Hardware
                        </span>
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
                        >
                          Software
                        </span>
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
                        Hardware acceleration is enabled, but none of your GPU's codecs are
                        currently supported. Concord Voice has automatically failed over to software
                        encoding.
                      </div>
                    )}
                  </>
                );
              })()}

            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Enable HDR Encoding</span>
                <span className="settings-row-hint">
                  {!systemHdr
                    ? 'No HDR display detected. Connect an HDR-capable display to enable.'
                    : hdrEncoding
                      ? 'Enabled. VP9 HDR (10-bit) will be prioritized when available.'
                      : 'Disabled. HDR codec profiles are available but not preferred.'}
                </span>
              </div>
              <ToggleSwitch
                checked={hdrEncoding}
                onChange={(v) => setDraftVideoSetting('hdrEncoding', v)}
                disabled={!systemHdr}
              />
            </div>

            {(() => {
              const routerSupported = new Set([
                'video/vp8',
                'video/vp9',
                'video/h264',
                'video/av1',
              ]);
              const codecPriority: Record<string, number> = {
                AV1: 0,
                H265: 1,
                HEVC: 1,
                VP9: 2,
                H264: 3,
                VP8: 4,
              };
              const sortByPriority = (a: CodecCapability, b: CodecCapability) =>
                (codecPriority[a.mimeType.replace('video/', '')] ?? 99) -
                (codecPriority[b.mimeType.replace('video/', '')] ?? 99);
              const supported = codecCapabilities.filter((c) =>
                routerSupported.has(c.mimeType.toLowerCase())
              );
              const sdrCodecs = supported.filter((c) => !c.isHdr).sort(sortByPriority);
              const hdrCodecs = supported.filter((c) => c.isHdr).sort(sortByPriority);

              // Resolve effective codec key for info badge
              const firstSupported = sdrCodecs[0] || supported[0];
              const effectiveKey =
                preferredVideoCodec || (firstSupported ? codecKey(firstSupported) : null);
              const info = effectiveKey ? getCodecInfo(effectiveKey) : null;

              return (
                <>
                  <div className="settings-row">
                    <div className="settings-row-info">
                      <span className="settings-row-label">Video Codec</span>
                      <span className="settings-row-hint">
                        {preferredVideoCodec
                          ? `Preferred codec for camera and screen share encoding. Currently ${getCodecInfo(preferredVideoCodec).name}. Concord falls back automatically if a peer cannot decode it.`
                          : 'Preferred codec for camera and screen share encoding. Currently Auto \u2014 Concord selects the best available based on hardware and peer support.'}
                      </span>
                    </div>
                    <select
                      className="settings-select"
                      value={preferredVideoCodec ?? ''}
                      onChange={(e) =>
                        setDraftVideoSetting('preferredVideoCodec', e.target.value || null)
                      }
                    >
                      <option value="">Auto</option>
                      {sdrCodecs.map((c) => {
                        const key = codecKey(c);
                        const name = c.mimeType.replace('video/', '');
                        const profile = c.profileLabel ? ` (${c.profileLabel})` : '';
                        return (
                          <option key={key} value={key}>
                            {name}
                            {profile}
                          </option>
                        );
                      })}
                      {hdrCodecs.length > 0 && (
                        <optgroup label={hdrEncoding ? 'HDR' : 'Requires HDR'}>
                          {hdrCodecs.map((c) => {
                            const key = codecKey(c);
                            const name = c.mimeType.replace('video/', '');
                            const profile = c.profileLabel ? ` (${c.profileLabel})` : '';
                            return (
                              <option key={key} value={key} disabled={!hdrEncoding}>
                                {name}
                                {profile}
                              </option>
                            );
                          })}
                        </optgroup>
                      )}
                    </select>
                  </div>

                  {info && (
                    <span className="settings-codec-info-badge">
                      {info.name} — {info.quality} quality · {info.efficiency} efficiency (
                      {info.compressionRatio}){info.hdr ? ' · HDR' : ''}
                      {info.notes ? ` · ${info.notes}` : ''}
                    </span>
                  )}

                  {preferredVideoCodec && (
                    <div className="settings-codec-preference-notice">
                      Your client will prefer this codec, but will fall back to the next best option
                      if another participant can't decode it. Active codecs are shown above with a{' '}
                      <span
                        className="settings-codec-item in-use"
                        style={{
                          display: 'inline-flex',
                          padding: '1px 6px',
                          margin: '0 3px',
                          fontSize: 'inherit',
                          verticalAlign: 'baseline',
                        }}
                      >
                        highlight
                      </span>
                      .
                    </div>
                  )}
                </>
              );
            })()}

            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Hardware Acceleration</span>
                <span className="settings-row-hint">
                  {hardwareAcceleration
                    ? 'Enabled. Your GPU handles video encoding and decoding. Concord Voice falls back to software encoding for unsupported codecs.'
                    : 'Disabled. All video encoding and decoding runs on your CPU. Avoids GPU-specific limitations but increases CPU usage. Requires restart.'}
                </span>
              </div>
              <ToggleSwitch
                checked={hardwareAcceleration}
                onChange={(enabled) => setDraftVideoSetting('hardwareAcceleration', enabled)}
              />
            </div>

            <h3 className="settings-subsection-title">Bandwidth</h3>

            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Automatic Bitrate</span>
                <span className="settings-row-hint">
                  {screenShareBitrate === 0
                    ? 'Enabled. Concord Voice adjusts bitrate based on your resolution, frame rate, and codec.'
                    : `Disabled. Using a fixed ${(screenShareBitrate / 1_000_000).toFixed(1)} Mbps cap. Recommended ~${(clampedRecommended / 1_000_000).toFixed(1)} Mbps for current settings.`}
                </span>
                {screenShareBitrate === 0 && (
                  <span className="settings-estimated-bitrate">
                    Estimated Bitrate: ~{(clampedRecommended / 1_000_000).toFixed(1)} Mbps
                  </span>
                )}
              </div>
              <ToggleSwitch
                checked={screenShareBitrate === 0}
                onChange={(v) =>
                  setDraftVideoSetting('screenShareBitrate', v ? 0 : clampedRecommended)
                }
              />
            </div>
            {screenShareBitrate !== 0 && (
              <div className="settings-volume-row">
                <div className="settings-row-info">
                  <span className="settings-volume-label">Cap</span>
                  <span className="settings-row-hint">
                    Sets the maximum bitrate cap for screen sharing. Left (1.5 Mbps) for simple
                    content. Right (30 Mbps) for high-motion content.
                  </span>
                </div>
                <div className="settings-slider-wrapper">
                  <span className="settings-slider-value">
                    {(screenShareBitrate / 1_000_000).toFixed(1)} Mbps
                  </span>
                  <input
                    type="range"
                    className="settings-volume-slider"
                    min={1.5}
                    max={30}
                    step={0.5}
                    value={screenShareBitrate / 1_000_000}
                    onChange={(e) =>
                      setDraftVideoSetting(
                        'screenShareBitrate',
                        Math.round(Number(e.target.value) * 1_000_000)
                      )
                    }
                  />
                </div>
              </div>
            )}

            <h3 className="settings-subsection-title">Transport</h3>

            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Quality of Service for Camera</span>
                <span className="settings-row-hint">
                  {
                    'Marks camera traffic with DSCP tags so your network can prioritize it. Not all networks honor DSCP tags; some may ignore or strip them, so this setting may have no effect depending on you or your ISP\u2019s network configurations. '
                  }
                  {cameraPriority === 'off'
                    ? 'Currently off \u2014 no tagging applied.'
                    : cameraPriority === 'low'
                      ? 'Currently Low (DF) \u2014 minimal differentiation. (RFC 2474)'
                      : cameraPriority === 'medium'
                        ? 'Currently Default (AF43) \u2014 recommended for most networks. (RFC 2597)'
                        : 'Currently High (EF) \u2014 highest priority. (RFC 5127)'}
                </span>
              </div>
              <select
                className="settings-select"
                value={cameraPriority}
                onChange={(e) =>
                  setDraftVideoSetting('cameraPriority', e.target.value as VideoPriority)
                }
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
                  {
                    'Marks screen share traffic with DSCP tags so your network can prioritize it. Not all networks honor DSCP tags; some may ignore or strip them, so this setting may have no effect depending on you or your ISP\u2019s network configurations. '
                  }
                  {screenSharePriority === 'off'
                    ? 'Currently off \u2014 no tagging applied.'
                    : screenSharePriority === 'low'
                      ? 'Currently Low (DF) \u2014 minimal differentiation. (RFC 2474)'
                      : screenSharePriority === 'medium'
                        ? 'Currently Default (AF42) \u2014 recommended for most networks. (RFC 2597)'
                        : 'Currently High (EF) \u2014 highest priority. (RFC 5127)'}
                </span>
              </div>
              <select
                className="settings-select"
                value={screenSharePriority}
                onChange={(e) =>
                  setDraftVideoSetting('screenSharePriority', e.target.value as VideoPriority)
                }
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
                  {scalabilityMode === 'auto' || scalabilityMode === 'L3T3'
                    ? 'Sends video at multiple quality levels so viewers on slower connections get a lower-quality stream. Currently 3 Layers \u2014 best adaptability, highest CPU usage.'
                    : scalabilityMode === 'L2T3'
                      ? 'Sends video at multiple quality levels so viewers on slower connections get a lower-quality stream. Currently 2 Layers \u2014 moderate adaptability.'
                      : 'Sends video at multiple quality levels so viewers on slower connections get a lower-quality stream. Currently Single Quality \u2014 no adaptation, lowest CPU usage.'}
                </span>
              </div>
              <select
                className="settings-select"
                value={scalabilityMode === 'auto' ? 'L3T3' : scalabilityMode}
                onChange={(e) =>
                  setDraftVideoSetting(
                    'scalabilityMode',
                    e.target.value as 'L1T3' | 'L2T3' | 'L3T3'
                  )
                }
              >
                <option value="L3T3">3 Layers (Default)</option>
                <option value="L2T3">2 Layers</option>
                <option value="L1T3">Single Quality</option>
              </select>
            </div>
          </>
        )}
      </div>
    </>
  );
};

// ─── Text-to-Speech Section ─────────────────────────────────────────────────

const TTSSection: React.FC = () => {
  const ttsEnabled = useDraftTtsSetting('ttsEnabled');
  const ttsVoice = useDraftTtsSetting('ttsVoice');
  const ttsRate = useDraftTtsSetting('ttsRate');
  const ttsVolume = useDraftTtsSetting('ttsVolume');
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
    const utterance = new SpeechSynthesisUtterance(
      'This is a preview of text-to-speech in Concord Voice.'
    );
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
          <span className="settings-row-hint">
            {ttsEnabled
              ? 'Enabled. Incoming voice text chat messages are read aloud while you are in a voice channel.'
              : 'Disabled. Voice text chat messages are displayed as text only.'}
          </span>
        </div>
        <ToggleSwitch checked={ttsEnabled} onChange={(v) => setDraftTtsSetting('ttsEnabled', v)} />
      </div>

      <div className="settings-row">
        <div className="settings-row-info">
          <span className="settings-row-label">Voice</span>
          <span className="settings-row-hint">
            {`Select which text-to-speech voice reads messages aloud. Currently using ${ttsVoice ? (voices.find((v) => v.voiceURI === ttsVoice)?.name ?? ttsVoice) : 'System Default'}.`}
          </span>
        </div>
        <select
          className="settings-select"
          value={ttsVoice ?? ''}
          onChange={(e) => setDraftTtsSetting('ttsVoice', e.target.value || null)}
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
          <span className="settings-row-hint">
            Playback speed for text-to-speech. Left (0.5x) for slow speech. Right (2.0x) for
            rapid-fire reading.
          </span>
        </div>
        <div className="settings-slider-wrapper">
          <span className="settings-slider-value">{ttsRate.toFixed(1)}x</span>
          <input
            type="range"
            className="settings-slider"
            min={0.5}
            max={2.0}
            step={0.1}
            value={ttsRate}
            onChange={(e) => setDraftTtsSetting('ttsRate', Number(e.target.value))}
          />
        </div>
      </div>

      <div className="settings-row">
        <div className="settings-row-info">
          <span className="settings-row-label">Volume</span>
          <span className="settings-row-hint">
            Volume level for text-to-speech playback. Left is muted. Right is full volume.
          </span>
        </div>
        <div className="settings-slider-wrapper">
          <span className="settings-slider-value">{Math.round(ttsVolume * 100)}%</span>
          <input
            type="range"
            className="settings-slider"
            min={0}
            max={1}
            step={0.05}
            value={ttsVolume}
            onChange={(e) => setDraftTtsSetting('ttsVolume', Number(e.target.value))}
          />
        </div>
      </div>

      <div className="settings-row">
        <button className="settings-btn-secondary" onClick={handlePreview}>
          Preview
        </button>
      </div>
    </div>
  );
};

// ─── Accessibility Section ──────────────────────────────────────────────────

const AccessibilitySection: React.FC = () => <TTSSection />;

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
    enabled: true,
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
    { id: 'video-screen', label: 'Video Configuration' },
  ],
  accessibility: [{ id: 'tts', label: 'Text-to-Speech' }],
};

// ─── Settings Page ──────────────────────────────────────────────────────────

const SettingsPage: React.FC = () => {
  const navigate = useNavigate();
  const [activeSection, setActiveSection] = useState<SettingsSection>('appearance');
  const [isPending, startTransition] = useTransition();
  const [activeSubsection, setActiveSubsection] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // Draft settings lifecycle
  useDraftSettingsLifecycle();
  const { apply, revert, hasPendingChanges, hwAccelChanged } = useDraftActions();

  // Blob animation state
  const [blobBouncing, setBlobBouncing] = useState(false);
  const [blobFading, setBlobFading] = useState(false);

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
            if (
              entry.isIntersecting &&
              (!bestEntry || entry.intersectionRatio > bestEntry.intersectionRatio)
            ) {
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
      case 'accessibility':
        return <AccessibilitySection />;
      default:
        return null;
    }
  };

  return (
    <div className="view-container settings-fullpage">
      <div className="settings-page-content">
        <div className="settings-page-inner">
          {/* Back button — blocked when changes are pending */}
          <button
            className={`settings-back-btn${hasPendingChanges ? ' settings-back-btn--blocked' : ''}`}
            onClick={() => {
              if (!hasPendingChanges) navigate('/app');
            }}
            onMouseEnter={() => {
              if (hasPendingChanges) {
                setBlobBouncing(true);
              }
            }}
            onMouseLeave={() => {
              if (hasPendingChanges) {
                setBlobBouncing(false);
                setBlobFading(true);
                setTimeout(() => setBlobFading(false), 3000);
              }
            }}
          >
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
                      onClick={() =>
                        item.enabled && startTransition(() => setActiveSection(item.id))
                      }
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

              {/* Pending changes blob */}
              {hasPendingChanges && (
                <div
                  className={`settings-pending-blob${
                    blobBouncing ? ' settings-pending-blob--bouncing' : ''
                  }${blobFading ? ' settings-pending-blob--fading' : ''}`}
                >
                  <p className="settings-pending-blob-text">
                    {hwAccelChanged
                      ? 'Settings have changed! Applying will restart the app.'
                      : 'Settings have changed! Would you like to apply?'}
                  </p>
                  <div className="settings-pending-blob-actions">
                    <button className="settings-pending-blob-apply" onClick={apply}>
                      {hwAccelChanged ? 'Apply & Restart' : 'Apply'}
                    </button>
                    <button className="settings-pending-blob-revert" onClick={revert}>
                      Revert
                    </button>
                  </div>
                </div>
              )}
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
