import React, { useState, useMemo } from 'react';
import { unwrapLoginKeys, generateRegistrationKeys } from '../../utils/crypto';
import { e2eeService } from '../../services/e2eeService';
import { preferencesSyncService } from '../../services/preferencesSync';
import { useSettingsStore } from '../../stores/settingsStore';
import { useLayoutStore } from '../../stores/layoutStore';
import { savedGifsSyncService } from '../../services/savedGifsSync';
import { useAuthStore } from '../../stores/authStore';
import { API_BASE, apiFetch, ensureMachineId } from '../../services/apiClient';
import { UserProfile } from '../../stores/userStore';
import TOTPInput from './TOTPInput';
import BackupCodeInput from './BackupCodeInput';
import WebAuthnPrompt from './WebAuthnPrompt';
import MFAMethodPicker, {
  getDefaultMethod,
  getAvailableCategories,
  MFAMethodCategory,
} from './MFAMethodPicker';
import LoadingSpinner from './LoadingSpinner';
import './Login.css';
import './TOTPInput.css';

// Convert base64url-encoded WebAuthn options from the server into ArrayBuffer format
// that navigator.credentials.get() expects.
function base64urlToBuffer(base64url: string): ArrayBuffer {
  const base64 = base64url.replaceAll('-', '+').replaceAll('_', '/');
  const pad = base64.length % 4 === 0 ? '' : '='.repeat(4 - (base64.length % 4));
  const binary = atob(base64 + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseWebAuthnOptions(serverOptions: any): PublicKeyCredentialRequestOptions {
  const pk = serverOptions.publicKey || serverOptions;
  const opts: PublicKeyCredentialRequestOptions = {
    challenge: base64urlToBuffer(pk.challenge),
    timeout: pk.timeout,
    rpId: pk.rpId,
  };
  if (pk.allowCredentials) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    opts.allowCredentials = pk.allowCredentials.map((cred: any) => ({
      type: cred.type,
      id: base64urlToBuffer(cred.id),
      transports: cred.transports,
    }));
  }
  if (pk.userVerification) {
    opts.userVerification = pk.userVerification;
  }
  return opts;
}

/** Check that Electron safeStorage is available, returning an error message or null */
async function checkSafeStorage(): Promise<string | null> {
  if (!globalThis.electron?.checkPermission) return null;
  try {
    const status = await globalThis.electron.checkPermission('secureStorage');
    if (status !== 'granted') {
      return 'Secure storage is unavailable. Concord requires keychain / credential manager access to safely store authentication tokens and encryption keys. Please enable it and restart the app.';
    }
    return null;
  } catch {
    return 'Secure storage could not be verified. Please try again, and if the problem persists, restart the app.';
  }
}

export interface LoginProps {
  onBack: () => void;
  onSuccess: (data: { accessToken: string; user?: UserProfile; rememberMe: boolean }) => void;
  onSwitchToRegister: () => void;
  onForgotPassword: () => void;
}

interface FormData {
  email: string;
  password: string;
  rememberMe: boolean;
}

interface FormErrors {
  email?: string;
  password?: string;
  general?: string;
}

const Login: React.FC<LoginProps> = ({
  onBack,
  onSuccess,
  onSwitchToRegister,
  onForgotPassword,
}) => {
  const [formData, setFormData] = useState<FormData>({
    email: '',
    password: '',
    rememberMe: false,
  });

  const [errors, setErrors] = useState<FormErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  // MFA state
  const [mfaRequired, setMfaRequired] = useState(false);
  const [mfaChallengeToken, setMfaChallengeToken] = useState('');
  const [mfaMethods, setMfaMethods] = useState<string[]>([]);
  const [mfaMode, setMfaMode] = useState<MFAMethodCategory | 'method-select'>('totp');
  const [mfaRecoveryOnly, setMfaRecoveryOnly] = useState<string[]>([]);
  const [mfaError, setMfaError] = useState('');
  const [webauthnOptions, setWebauthnOptions] = useState<PublicKeyCredentialRequestOptions | null>(
    null
  );

  const validateForm = (): boolean => {
    const newErrors: FormErrors = {};

    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
    if (!formData.email) {
      newErrors.email = 'Email is required';
    } else if (!emailRegex.test(formData.email)) {
      newErrors.email = 'Invalid email format';
    }

    // Password validation
    if (!formData.password) {
      newErrors.password = 'Password is required';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});

    if (!validateForm()) {
      return;
    }

    // Fail-closed safeStorage enforcement (#197)
    const storageError = await checkSafeStorage();
    if (storageError) {
      setErrors({ general: storageError });
      return;
    }

    setIsSubmitting(true);

    try {
      console.debug('Logging in...');

      const machineId = await ensureMachineId();

      // Login with backend
      const response = await fetch(`${API_BASE}/api/v1/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(machineId ? { 'X-Machine-Id': machineId } : {}),
        },
        credentials: 'include', // Include cookies for refresh token
        body: JSON.stringify({
          email: formData.email,
          password: formData.password,
          remember_me: formData.rememberMe,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Login failed');
      }

      // Check if MFA is required
      if (data.mfa_required) {
        const serverMethods = data.methods || [];
        const recoveryOnly = data.recovery_only_methods || [];
        setMfaChallengeToken(data.mfa_challenge_token);
        setMfaMethods(serverMethods);
        setMfaRecoveryOnly(recoveryOnly);
        setMfaMode(getDefaultMethod(serverMethods, recoveryOnly));
        if (data.webauthn_options) setWebauthnOptions(parseWebAuthnOptions(data.webauthn_options));
        setMfaRequired(true);
        setIsSubmitting(false);
        return;
      }

      await completeLoginFromResponse(data);
    } catch (error) {
      console.error('Login error:', error);
      setErrors({
        general: error instanceof Error ? error.message : 'Login failed. Please try again.',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  // Complete login after receiving tokens (shared between direct login and MFA verify)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const completeLoginFromResponse = async (data: any) => {
    console.debug('Login successful, unwrapping private key...');

    // Set access token early so e2eeService can make authenticated API calls (e.g., key migration)
    useAuthStore.getState().setAccessToken(data.access_token);
    if (data.session_id) useAuthStore.getState().setSessionId(data.session_id);

    const kdAlg = data.e2ee_keys.key_derivation_alg || 'pbkdf2';
    try {
      await unwrapLoginKeys(
        formData.password,
        data.e2ee_keys.wrapped_private_key,
        data.e2ee_keys.key_derivation_salt,
        kdAlg
      );
      // e2eeService.initialize handles PBKDF2→Argon2id migration automatically
      await e2eeService.initialize(
        formData.password,
        data.e2ee_keys.wrapped_private_key,
        data.e2ee_keys.key_derivation_salt,
        kdAlg
      );
      console.debug('Private key unwrapped and E2EE service initialized!');
    } catch (unwrapError) {
      console.warn('Key unwrap failed, regenerating E2EE keys...', unwrapError);
      const newKeys = await generateRegistrationKeys(formData.password);

      if (globalThis.electron?.storeRefreshToken) {
        await globalThis.electron.storeRefreshToken({
          refreshToken: data.refresh_token,
          rememberMe: formData.rememberMe,
          apiBase: API_BASE,
        });
      }
      useAuthStore.getState().setAccessToken(data.access_token);
      if (data.session_id) useAuthStore.getState().setSessionId(data.session_id);

      const replaceRes = await apiFetch('/api/v1/users/me/keys', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wrapped_private_key: newKeys.wrappedPrivateKey,
          key_derivation_salt: newKeys.keyDerivationSalt,
          key_derivation_alg: newKeys.keyDerivationAlg,
        }),
      });
      if (!replaceRes.ok) throw new Error('Failed to recover encryption keys. Please try again.');

      await e2eeService.initialize(
        formData.password,
        newKeys.wrappedPrivateKey,
        newKeys.keyDerivationSalt,
        newKeys.keyDerivationAlg
      );
      console.debug('E2EE keys regenerated and service initialized!');
    }

    if (globalThis.electron?.storeRefreshToken) {
      await globalThis.electron.storeRefreshToken({
        refreshToken: data.refresh_token,
        rememberMe: data.remember_me ?? formData.rememberMe,
        apiBase: API_BASE,
      });
    }
    useAuthStore.getState().setAccessToken(data.access_token);
    if (data.session_id) useAuthStore.getState().setSessionId(data.session_id);

    const sessionKeys = e2eeService.getSessionKeys();
    if (sessionKeys && globalThis.electron?.storeE2EEKeys) {
      await globalThis.electron.storeE2EEKeys(sessionKeys);
    }

    preferencesSyncService.init({
      getAppearance: () => useSettingsStore.getState().appearance,
      setAppearance: (patch) =>
        useSettingsStore.setState((s) => ({ appearance: { ...s.appearance, ...patch } })),
      getLayout: () => {
        const s = useLayoutStore.getState();
        return {
          channelPanelPinned: s.channelPanelPinned,
          channelPanelWidth: s.channelPanelWidth,
          memberPanelMode: s.memberPanelMode,
          memberPanelWidth: s.memberPanelWidth,
          serverBarHeight: s.serverBarHeight,
          folderBarHeight: s.folderBarHeight,
          serverFolders: s.serverFolders,
          serverOrder: s.serverOrder,
        };
      },
      setLayout: (patch) => useLayoutStore.setState(patch),
    });
    preferencesSyncService.startWatching();
    await preferencesSyncService.fetchAndApply();
    savedGifsSyncService.startWatching();
    await savedGifsSyncService.fetchAndApply();

    onSuccess({
      accessToken: data.access_token,
      user: data.user,
      rememberMe: data.remember_me ?? formData.rememberMe,
    });
  };

  const handleMFAVerify = async (code: string, method: string) => {
    setIsSubmitting(true);
    setMfaError('');
    try {
      const machineId = await ensureMachineId();
      const res = await fetch(`${API_BASE}/api/v1/auth/mfa/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(machineId ? { 'X-Machine-Id': machineId } : {}),
        },
        credentials: 'include',
        body: JSON.stringify({
          mfa_challenge_token: mfaChallengeToken,
          method,
          code,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Verification failed');

      // MFA verify returns full login response (tokens + user + keys)
      await completeLoginFromResponse(data);
    } catch (err) {
      setMfaError(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleChange = (field: keyof FormData) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setFormData((prev) => ({ ...prev, [field]: value }));
    // Clear error for this field when user starts typing
    if (field in errors && errors[field as keyof FormErrors]) {
      setErrors((prev) => ({ ...prev, [field]: undefined }));
    }
  };

  const available = useMemo(
    () => getAvailableCategories(mfaMethods, mfaRecoveryOnly),
    [mfaMethods, mfaRecoveryOnly]
  );
  const hasMultipleMethods = available.length > 1;
  const defaultMethod = useMemo(
    () => getDefaultMethod(mfaMethods, mfaRecoveryOnly),
    [mfaMethods, mfaRecoveryOnly]
  );

  const handleWebAuthnSuccess = async (credential: Credential) => {
    const pkc = credential as PublicKeyCredential;
    const response = pkc.response as AuthenticatorAssertionResponse;

    // Encode ArrayBuffers as base64url (no padding) for the go-webauthn library
    const toBase64url = (buf: ArrayBuffer): string => {
      const bytes = new Uint8Array(buf);
      let binary = '';
      for (const byte of bytes) binary += String.fromCodePoint(byte);
      return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll(/=+$/g, '');
    };

    const assertion = {
      id: pkc.id,
      rawId: toBase64url(pkc.rawId),
      type: pkc.type,
      response: {
        authenticatorData: toBase64url(response.authenticatorData),
        clientDataJSON: toBase64url(response.clientDataJSON),
        signature: toBase64url(response.signature),
        userHandle: response.userHandle ? toBase64url(response.userHandle) : null,
      },
    };

    setIsSubmitting(true);
    setMfaError('');
    try {
      const machineId = await ensureMachineId();
      const res = await fetch(`${API_BASE}/api/v1/auth/mfa/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(machineId ? { 'X-Machine-Id': machineId } : {}),
        },
        credentials: 'include',
        body: JSON.stringify({
          mfa_challenge_token: mfaChallengeToken,
          method: 'webauthn',
          assertion,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Verification failed');
      await completeLoginFromResponse(data);
    } catch (err) {
      setMfaError(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  let mfaSubtitle: string;
  if (mfaMode === 'totp') mfaSubtitle = 'Enter the 6-digit code from your authenticator app';
  else if (mfaMode === 'backup') mfaSubtitle = 'Enter one of your backup codes';
  else if (mfaMode === 'webauthn') mfaSubtitle = 'Use your security key or biometrics';
  else if (mfaMode === 'email-sms') mfaSubtitle = 'Enter the verification code sent to you';
  else mfaSubtitle = 'Select a verification method';

  // MFA Step UI
  if (mfaRequired) {
    return (
      <div className="login-container">
        <div className="login-content">
          <div className="login-header">
            <img
              src="./branding/Concord-Voice/logos/main-logo-transparent-vector.svg"
              className="login-logo"
              alt="Concord Voice"
            />
            <h2 className="login-title">Two-Factor Authentication</h2>
            <p className="login-subtitle">{mfaSubtitle}</p>
          </div>

          <div className="login-form">
            {mfaMode === 'method-select' && (
              <MFAMethodPicker
                methods={mfaMethods}
                excludeMethods={mfaRecoveryOnly}
                currentMethod={defaultMethod}
                onSelect={(method) => {
                  setMfaMode(method);
                  setMfaError('');
                }}
                onCancel={() => {
                  setMfaMode(defaultMethod);
                  setMfaError('');
                }}
              />
            )}

            {mfaMode === 'totp' && (
              <TOTPInput
                onSubmit={(code) => handleMFAVerify(code, 'totp')}
                disabled={isSubmitting}
                error={mfaError}
              />
            )}

            {mfaMode === 'backup' && (
              <BackupCodeInput
                onSubmit={(code) => handleMFAVerify(code, 'backup_code')}
                disabled={isSubmitting}
                error={mfaError}
              />
            )}

            {mfaMode === 'webauthn' && (
              <>
                {webauthnOptions ? (
                  <WebAuthnPrompt
                    requestOptions={webauthnOptions}
                    onSuccess={handleWebAuthnSuccess}
                    onError={(msg) => setMfaError(msg)}
                    onCancel={() => {
                      setMfaMode('method-select');
                      setMfaError('');
                    }}
                  />
                ) : (
                  <div style={{ textAlign: 'center' }}>
                    <p style={{ color: 'var(--text-secondary, #bbb)', fontSize: 14 }}>
                      WebAuthn verification will be triggered by the server challenge.
                    </p>
                    {mfaError && <p className="totp-error">{mfaError}</p>}
                  </div>
                )}
              </>
            )}

            {mfaMode === 'email-sms' && (
              <TOTPInput
                onSubmit={(code) =>
                  handleMFAVerify(code, mfaMethods.includes('email') ? 'email' : 'sms')
                }
                disabled={isSubmitting}
                error={mfaError}
              />
            )}

            {/* "Choose another form" link */}
            {mfaMode !== 'method-select' && hasMultipleMethods && (
              <button
                type="button"
                className="mfa-choose-another"
                onClick={() => {
                  setMfaMode('method-select');
                  setMfaError('');
                }}
                disabled={isSubmitting}
              >
                Choose another form of verification
              </button>
            )}

            {isSubmitting && (
              <div style={{ display: 'flex', justifyContent: 'center', marginTop: 12 }}>
                <LoadingSpinner size="small" inline />
              </div>
            )}

            <button
              type="button"
              className="login-back-btn"
              onClick={() => {
                setMfaRequired(false);
                setMfaError('');
              }}
              disabled={isSubmitting}
            >
              ← Back to login
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="login-container">
      <div className="login-content">
        <div className="login-header">
          <img
            src="./branding/Concord-Voice/logos/main-logo-transparent-vector.svg"
            className="login-logo"
            alt="Concord Voice"
          />
          <h2 className="login-title">Welcome Back</h2>
          <p className="login-subtitle">Sign in to your Concord Voice account</p>
        </div>

        <form className="login-form" onSubmit={handleSubmit}>
          {/* Email */}
          <div className="form-group">
            <label htmlFor="login-email" className="form-label">
              Email
            </label>
            <input
              id="login-email"
              type="email"
              className={`form-input ${errors.email ? 'error' : ''}`}
              placeholder="you@example.com"
              value={formData.email}
              onChange={handleChange('email')}
              disabled={isSubmitting}
              autoFocus
            />
            {errors.email && <span className="form-error">{errors.email}</span>}
          </div>

          {/* Password */}
          <div className="form-group">
            <label htmlFor="login-password" className="form-label">
              Password
            </label>
            <input
              id="login-password"
              type="password"
              className={`form-input ${errors.password ? 'error' : ''}`}
              placeholder="Enter your password"
              value={formData.password}
              onChange={handleChange('password')}
              disabled={isSubmitting}
            />
            {errors.password && <span className="form-error">{errors.password}</span>}
          </div>

          {/* Remember Me & Forgot Password */}
          <div className="login-options">
            <label className="remember-me-label">
              <input
                type="checkbox"
                checked={formData.rememberMe}
                onChange={handleChange('rememberMe')}
                disabled={isSubmitting}
              />
              <span>Remember me</span>
            </label>
            <button
              type="button"
              className="forgot-password-link"
              onClick={onForgotPassword}
              disabled={isSubmitting}
            >
              Forgot password?
            </button>
          </div>

          {/* General Error */}
          {errors.general && (
            <div className="form-error-banner">
              <span>{errors.general}</span>
            </div>
          )}

          {/* Submit Button */}
          <button type="submit" className="login-submit-btn" disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                Signing In...
                <LoadingSpinner size="small" inline />
              </>
            ) : (
              'Sign In'
            )}
          </button>

          {/* Back Button */}
          <button type="button" className="login-back-btn" onClick={onBack} disabled={isSubmitting}>
            ← Back to Connection Options
          </button>
        </form>

        <div className="login-footer">
          <p className="footer-text">
            Don&apos;t have an account?{' '}
            <button
              className="switch-to-register-btn"
              onClick={onSwitchToRegister}
              disabled={isSubmitting}
            >
              Create one
            </button>
          </p>
        </div>
      </div>
    </div>
  );
};

export default Login;
