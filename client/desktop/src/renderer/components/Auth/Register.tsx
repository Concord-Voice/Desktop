import React, { useState } from 'react';
import PasswordStrength from './PasswordStrength';
import InfoTooltip from './InfoTooltip';
import LoadingSpinner from './LoadingSpinner';
import { generateRegistrationKeys, exportPublicKey } from '../../utils/crypto';
import { e2eeService } from '../../services/e2eeService';
import { preferencesSyncService } from '../../services/preferencesSync';
import { useAuthStore } from '../../stores/authStore';
import { API_BASE, ensureMachineId } from '../../services/apiClient';
import { UserProfile } from '../../stores/userStore';
import './Register.css';

export interface RegisterProps {
  onBack: () => void;
  onSuccess: (data: { accessToken: string; user?: UserProfile }) => void;
  onSwitchToLogin: () => void;
}

interface FormData {
  email: string;
  username: string;
  password: string;
  confirmPassword: string;
  ageConfirmed: boolean;
  e2eeEnabled: boolean;
}

interface FormErrors {
  email?: string;
  username?: string;
  password?: string;
  confirmPassword?: string;
  ageConfirmed?: string;
  general?: string;
}

const Register: React.FC<RegisterProps> = ({ onBack, onSuccess, onSwitchToLogin }) => {
  const [formData, setFormData] = useState<FormData>({
    email: '',
    username: '',
    password: '',
    confirmPassword: '',
    ageConfirmed: false,
    e2eeEnabled: true, // Always true - E2EE is mandatory
  });

  const [errors, setErrors] = useState<FormErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [passwordsMatch, setPasswordsMatch] = useState(false);

  const validateForm = (): boolean => {
    const newErrors: FormErrors = {};

    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!formData.email) {
      newErrors.email = 'Email is required';
    } else if (!emailRegex.test(formData.email)) {
      newErrors.email = 'Invalid email format';
    }

    // Username validation
    const usernameRegex = /^[a-zA-Z0-9_-]{3,32}$/;
    if (!formData.username) {
      newErrors.username = 'Username is required';
    } else if (!usernameRegex.test(formData.username)) {
      newErrors.username = 'Username must be 3-32 characters (letters, numbers, _ -)';
    }

    // Password validation
    if (!formData.password) {
      newErrors.password = 'Password is required';
    } else if (formData.password.length < 12) {
      newErrors.password = 'Password must be at least 12 characters';
    }

    // Confirm password validation
    if (!formData.confirmPassword) {
      newErrors.confirmPassword = 'Please confirm your password';
    } else if (formData.password !== formData.confirmPassword) {
      newErrors.confirmPassword = 'Passwords do not match';
    }

    // Age confirmation
    if (!formData.ageConfirmed) {
      newErrors.ageConfirmed = 'You must confirm you are at least 16 years old';
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

    setIsSubmitting(true);

    try {
      // Generate E2EE keys
      console.debug('Generating E2EE keys...');
      const keys = await generateRegistrationKeys(formData.password);
      const publicKeyBase64 = await exportPublicKey(keys.publicKey);

      console.debug('Keys generated, registering with server...');

      const machineId = await ensureMachineId();

      // Register with backend
      const response = await fetch(`${API_BASE}/api/v1/auth/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(machineId ? { 'X-Machine-Id': machineId } : {}),
        },
        credentials: 'include', // Include cookies for refresh token
        body: JSON.stringify({
          email: formData.email,
          username: formData.username,
          password: formData.password,
          age_confirmation: formData.ageConfirmed,
          e2ee_preference: formData.e2eeEnabled,
          public_key: publicKeyBase64,
          wrapped_private_key: keys.wrappedPrivateKey,
          key_derivation_salt: keys.keyDerivationSalt,
          key_derivation_alg: keys.keyDerivationAlg,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Registration failed');
      }

      console.debug('Registration successful, initializing E2EE service...');

      // Initialize E2EE service so encryption works immediately after registration
      await e2eeService.initialize(
        formData.password,
        keys.wrappedPrivateKey,
        keys.keyDerivationSalt,
        keys.keyDerivationAlg
      );
      preferencesSyncService.startWatching();

      // Store refresh token securely in main process, set access token in renderer
      if (window.electron?.storeRefreshToken) {
        await window.electron.storeRefreshToken({
          refreshToken: data.refresh_token,
          rememberMe: true, // Registration always remembers
          apiBase: API_BASE,
        });
      }
      useAuthStore.getState().setAccessToken(data.access_token);
      if (data.session_id) useAuthStore.getState().setSessionId(data.session_id);

      // Persist E2EE session keys in safeStorage for session restore
      const sessionKeys = e2eeService.getSessionKeys();
      if (sessionKeys && window.electron?.storeE2EEKeys) {
        await window.electron.storeE2EEKeys(sessionKeys);
      }

      onSuccess({
        accessToken: data.access_token,
        user: data.user,
      });
    } catch (error) {
      console.error('Registration error:', error);
      setErrors({
        general: error instanceof Error ? error.message : 'Registration failed. Please try again.',
      });
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

  const handleConfirmPasswordBlur = () => {
    // Only validate if confirmPassword has been filled
    if (formData.confirmPassword.length > 0) {
      if (formData.password !== formData.confirmPassword) {
        setErrors((prev) => ({ ...prev, confirmPassword: 'Passwords do not match' }));
        setPasswordsMatch(false);
      } else {
        setErrors((prev) => ({ ...prev, confirmPassword: undefined }));
        setPasswordsMatch(true);
      }
    }
  };

  const handlePasswordBlur = () => {
    // If confirmPassword has been filled, revalidate match
    if (formData.confirmPassword.length > 0) {
      if (formData.password !== formData.confirmPassword) {
        setErrors((prev) => ({ ...prev, confirmPassword: 'Passwords do not match' }));
        setPasswordsMatch(false);
      } else {
        setErrors((prev) => ({ ...prev, confirmPassword: undefined }));
        setPasswordsMatch(true);
      }
    }
  };

  return (
    <div className="register-container">
      <div className="register-content">
        <div className="register-header">
          <img
            src="./branding/logos/main-logo-transparent-vector.svg"
            className="register-logo"
            alt="Concord Voice"
          />
          <h2 className="register-title">Create Your Account</h2>
          <p className="register-subtitle">
            Join the Concord Voice network with end-to-end encryption
          </p>
        </div>

        <form className="register-form" onSubmit={handleSubmit}>
          {/* Email */}
          <div className="form-group">
            <label className="form-label">Email</label>
            <input
              type="email"
              className={`form-input ${errors.email ? 'error' : ''}`}
              placeholder="you@example.com"
              value={formData.email}
              onChange={handleChange('email')}
              disabled={isSubmitting}
            />
            {errors.email && <span className="form-error">{errors.email}</span>}
          </div>

          {/* Username */}
          <div className="form-group">
            <label className="form-label">Username</label>
            <input
              type="text"
              className={`form-input ${errors.username ? 'error' : ''}`}
              placeholder="your_username"
              value={formData.username}
              onChange={handleChange('username')}
              disabled={isSubmitting}
            />
            {errors.username && <span className="form-error">{errors.username}</span>}
            <span className="form-hint">
              This will be your identity: {formData.username || 'username'}@concordvoice.chat
            </span>
          </div>

          {/* Password */}
          <div className="form-group">
            <label className="form-label">Password</label>
            <input
              type="password"
              className={`form-input ${errors.password ? 'error' : ''}`}
              placeholder="Create a strong password"
              value={formData.password}
              onChange={handleChange('password')}
              onBlur={handlePasswordBlur}
              disabled={isSubmitting}
            />
            {errors.password && <span className="form-error">{errors.password}</span>}
            <PasswordStrength password={formData.password} />
          </div>

          {/* Confirm Password */}
          <div className="form-group">
            <label className="form-label">Confirm Password</label>
            <input
              type="password"
              className={`form-input ${errors.confirmPassword ? 'error' : ''} ${passwordsMatch ? 'success' : ''}`}
              placeholder="Confirm your password"
              value={formData.confirmPassword}
              onChange={handleChange('confirmPassword')}
              onBlur={handleConfirmPasswordBlur}
              disabled={isSubmitting}
            />
            {errors.confirmPassword && <span className="form-error">{errors.confirmPassword}</span>}
            {passwordsMatch && formData.confirmPassword.length > 0 && (
              <span className="form-success">✓ Passwords match</span>
            )}
          </div>

          {/* E2EE Info Banner */}
          <div className="form-group">
            <div className="info-banner">
              <div className="info-banner-icon">🔒</div>
              <div className="info-banner-content">
                <div className="info-banner-title">
                  End-to-End Encryption Enabled
                  <InfoTooltip
                    content={
                      <div>
                        <strong>What is E2EE?</strong>
                        <p>
                          End-to-End Encryption means your messages are encrypted on your device
                          before being sent. Only you and the recipient can read them.
                        </p>
                        <strong>How it works:</strong>
                        <ul>
                          <li>
                            <strong>User-to-User & Groups:</strong> Always fully encrypted - maximum
                            protection guaranteed
                          </li>
                          <li>
                            <strong>E2EE Servers:</strong> Always fully encrypted - complete privacy
                            protection
                          </li>
                          <li>
                            <strong>Non-E2EE Servers:</strong> Messages downgrade to plaintext with
                            big warning banner
                          </li>
                          <li>
                            <strong>Your Keys:</strong> Protected by your password - keep it safe!
                          </li>
                        </ul>
                        <strong>Privacy First:</strong> Not even Concord Voice can read your
                        encrypted messages. We can't reset your password if you forget it.
                      </div>
                    }
                  />
                </div>
                <p className="info-banner-description">
                  Your account uses DEFCON-grade encryption by default. Your messages are encrypted
                  on your device before sending — not even Concord Voice can read them.
                </p>
              </div>
            </div>
          </div>

          {/* Age Confirmation */}
          <div className="form-group">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={formData.ageConfirmed}
                onChange={handleChange('ageConfirmed')}
                disabled={isSubmitting}
              />
              <div className="checkbox-content">
                <span className="checkbox-title">I confirm I am at least 16 years old</span>
              </div>
            </label>
            {errors.ageConfirmed && <span className="form-error">{errors.ageConfirmed}</span>}
          </div>

          {/* General Error */}
          {errors.general && (
            <div className="form-error-banner">
              <span>{errors.general}</span>
            </div>
          )}

          {/* Submit Button */}
          <button type="submit" className="register-submit-btn" disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                Creating Account...
                <LoadingSpinner size="small" inline />
              </>
            ) : (
              'Create Account'
            )}
          </button>

          {/* Back Button */}
          <button
            type="button"
            className="register-back-btn"
            onClick={onBack}
            disabled={isSubmitting}
          >
            ← Back to Connection Options
          </button>
        </form>

        <div className="register-footer">
          <p className="footer-text">
            Already have an account?{' '}
            <button
              className="switch-to-login-btn"
              onClick={onSwitchToLogin}
              disabled={isSubmitting}
            >
              Sign in
            </button>
          </p>
          <p className="footer-text footer-terms">
            By creating an account, you agree to our Terms of Service and Privacy Policy
          </p>
        </div>
      </div>
    </div>
  );
};

export default Register;
