import React, { useState } from 'react';
import PasswordStrength from './PasswordStrength';
import { generateRegistrationKeys, exportPublicKey } from '../../utils/crypto';
import './Register.css';

export interface RegisterProps {
  onBack: () => void;
  onSuccess: (tokens: { accessToken: string; refreshToken: string }) => void;
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
    e2eeEnabled: true,
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
    } else if (formData.password.length < 8) {
      newErrors.password = 'Password must be at least 8 characters';
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
      console.log('Generating E2EE keys...');
      const keys = await generateRegistrationKeys(formData.password);
      const publicKeyBase64 = await exportPublicKey(keys.publicKey);

      console.log('Keys generated, registering with server...');

      // Register with backend
      const response = await fetch('http://localhost:8080/api/v1/auth/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
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
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Registration failed');
      }

      console.log('Registration successful!');

      // Store the private key in memory (we'll add proper key storage later)
      // For now, we'll just pass the tokens up
      onSuccess({
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
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

  const handleChange = (field: keyof FormData) => (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setFormData((prev) => ({ ...prev, [field]: value }));
    // Clear error for this field when user starts typing
    if (errors[field]) {
      setErrors((prev) => ({ ...prev, [field]: undefined }));
    }
  };

  return (
    <div className="register-container">
      <div className="register-content">
        <div className="register-header">
          <img src="/branding/logos/main-logo-transparent-vector.svg" className="register-logo" alt="Concord" />
          <h2 className="register-title">Create Your Account</h2>
          <p className="register-subtitle">Join the Concord network with end-to-end encryption</p>
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
            <span className="form-hint">This will be your identity: username@concord.chat</span>
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
              className={`form-input ${errors.confirmPassword ? 'error' : ''}`}
              placeholder="Confirm your password"
              value={formData.confirmPassword}
              onChange={handleChange('confirmPassword')}
              disabled={isSubmitting}
            />
            {errors.confirmPassword && <span className="form-error">{errors.confirmPassword}</span>}
          </div>

          {/* E2EE Preference */}
          <div className="form-group">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={formData.e2eeEnabled}
                onChange={handleChange('e2eeEnabled')}
                disabled={isSubmitting}
              />
              <div className="checkbox-content">
                <span className="checkbox-title">Enable End-to-End Encryption (Recommended)</span>
                <span className="checkbox-description">
                  Your messages will be encrypted on your device. Not even Concord can read them.
                </span>
              </div>
            </label>
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
          <button
            type="submit"
            className="register-submit-btn"
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Creating Account...' : 'Create Account'}
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
