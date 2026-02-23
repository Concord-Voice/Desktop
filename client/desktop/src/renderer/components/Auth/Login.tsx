import React, { useState } from 'react';
import { unwrapLoginKeys, generateRegistrationKeys } from '../../utils/crypto';
import { e2eeService } from '../../services/e2eeService';
import { preferencesSyncService } from '../../services/preferencesSync';
import { useAuthStore } from '../../stores/authStore';
import { API_BASE, apiFetch } from '../../services/apiClient';
import { UserProfile } from '../../stores/userStore';
import LoadingSpinner from './LoadingSpinner';
import './Login.css';

export interface LoginProps {
  onBack: () => void;
  onSuccess: (data: {
    accessToken: string;
    refreshToken: string;
    user?: UserProfile;
    rememberMe: boolean;
  }) => void;
  onSwitchToRegister: () => void;
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

const Login: React.FC<LoginProps> = ({ onBack, onSuccess, onSwitchToRegister }) => {
  const [formData, setFormData] = useState<FormData>({
    email: '',
    password: '',
    rememberMe: false,
  });

  const [errors, setErrors] = useState<FormErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  const validateForm = (): boolean => {
    const newErrors: FormErrors = {};

    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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

    setIsSubmitting(true);

    try {
      console.debug('Logging in...');

      // Login with backend
      const response = await fetch(`${API_BASE}/api/v1/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
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

      console.debug('Login successful, unwrapping private key...');

      // Unwrap the private key using the password and initialize E2EE service
      try {
        await unwrapLoginKeys(
          formData.password,
          data.e2ee_keys.wrapped_private_key,
          data.e2ee_keys.key_derivation_salt
        );
        // Initialize the E2EE service for JIT encrypt/decrypt during the session
        await e2eeService.initialize(
          formData.password,
          data.e2ee_keys.wrapped_private_key,
          data.e2ee_keys.key_derivation_salt
        );
        console.debug('Private key unwrapped and E2EE service initialized!');
      } catch (unwrapError) {
        // Key unwrapping failed — keys are corrupted (e.g. password was changed
        // without re-wrapping). Regenerate keys with the current password.
        console.warn('Key unwrap failed, regenerating E2EE keys...', unwrapError);

        const newKeys = await generateRegistrationKeys(formData.password);

        // Set tokens first so apiFetch can use them for auth
        useAuthStore.getState().setTokens(data.access_token, data.refresh_token);

        const replaceRes = await apiFetch('/api/v1/users/me/keys', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            wrapped_private_key: newKeys.wrappedPrivateKey,
            key_derivation_salt: newKeys.keyDerivationSalt,
          }),
        });

        if (!replaceRes.ok) {
          throw new Error('Failed to recover encryption keys. Please try again.');
        }

        // Initialize E2EE service with the regenerated keys
        await e2eeService.initialize(
          formData.password,
          newKeys.wrappedPrivateKey,
          newKeys.keyDerivationSalt
        );
        console.debug('E2EE keys regenerated and service initialized!');
      }

      // Set token early so apiFetch can authenticate the preferences request.
      // onSuccess will call setTokens again (idempotent) and navigate to /app.
      useAuthStore.getState().setTokens(data.access_token, data.refresh_token);

      // Start watching for local preference changes and fetch remote preferences
      preferencesSyncService.startWatching();
      await preferencesSyncService.fetchAndApply();

      // Pass tokens and user data up
      onSuccess({
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        user: data.user,
        rememberMe: data.remember_me ?? formData.rememberMe,
      });
    } catch (error) {
      console.error('Login error:', error);
      setErrors({
        general: error instanceof Error ? error.message : 'Login failed. Please try again.',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleChange = (field: keyof FormData) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setFormData((prev) => ({ ...prev, [field]: value }));
    // Clear error for this field when user starts typing
    if (errors[field]) {
      setErrors((prev) => ({ ...prev, [field]: undefined }));
    }
  };

  return (
    <div className="login-container">
      <div className="login-content">
        <div className="login-header">
          <img
            src="./branding/logos/main-logo-transparent-vector.svg"
            className="login-logo"
            alt="Concord"
          />
          <h2 className="login-title">Welcome Back</h2>
          <p className="login-subtitle">Sign in to your Concord account</p>
        </div>

        <form className="login-form" onSubmit={handleSubmit}>
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
              autoFocus
            />
            {errors.email && <span className="form-error">{errors.email}</span>}
          </div>

          {/* Password */}
          <div className="form-group">
            <label className="form-label">Password</label>
            <input
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
            <a href="#" className="forgot-password-link" onClick={(e) => e.preventDefault()}>
              Forgot password?
            </a>
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
            Don't have an account?{' '}
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
