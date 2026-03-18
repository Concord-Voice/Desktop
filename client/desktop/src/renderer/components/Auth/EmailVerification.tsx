import React, { useState, useEffect, useCallback } from 'react';
import TOTPInput from './TOTPInput';
import LoadingSpinner from './LoadingSpinner';
import { useAuthStore } from '../../stores/authStore';
import { API_BASE } from '../../services/apiClient';
import './EmailVerification.css';
import './TOTPInput.css';

interface EmailVerificationProps {
  email: string;
  onVerified: (newAccessToken: string) => void;
  onBack: () => void;
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return email;
  if (local.length <= 2) return `${local[0]}***@${domain}`;
  return `${local[0]}${'*'.repeat(Math.min(local.length - 2, 6))}${local[local.length - 1]}@${domain}`;
}

const RESEND_COOLDOWN = 60; // seconds

const EmailVerification: React.FC<EmailVerificationProps> = ({ email, onVerified, onBack }) => {
  const accessToken = useAuthStore((state) => state.accessToken);
  const [error, setError] = useState<string>('');
  const [isVerifying, setIsVerifying] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [attemptsRemaining, setAttemptsRemaining] = useState<number | null>(null);
  const [showChangeEmail, setShowChangeEmail] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [changeEmailError, setChangeEmailError] = useState('');
  const [currentEmail, setCurrentEmail] = useState(email);

  // Countdown timer for resend button
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setInterval(() => {
      setResendCooldown((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [resendCooldown]);

  const handleSubmitCode = useCallback(
    async (code: string) => {
      if (isVerifying || !accessToken) return;
      setIsVerifying(true);
      setError('');

      try {
        const response = await fetch(`${API_BASE}/api/v1/auth/verify-email/confirm`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ code }),
        });

        const data = await response.json();

        if (!response.ok) {
          if (data.attempts_remaining !== undefined) {
            setAttemptsRemaining(data.attempts_remaining);
          }
          throw new Error(data.error || 'Verification failed');
        }

        // Success — update token and notify parent
        if (data.access_token) {
          useAuthStore.getState().setAccessToken(data.access_token);
          useAuthStore.getState().setEmailVerified(true);
          onVerified(data.access_token);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Verification failed');
      } finally {
        setIsVerifying(false);
      }
    },
    [accessToken, isVerifying, onVerified]
  );

  const handleResend = async () => {
    if (resendCooldown > 0 || isResending || !accessToken) return;
    setIsResending(true);
    setError('');

    try {
      const response = await fetch(`${API_BASE}/api/v1/auth/verify-email/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to resend code');
      }

      setResendCooldown(RESEND_COOLDOWN);
      setAttemptsRemaining(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resend');
    } finally {
      setIsResending(false);
    }
  };

  const handleChangeEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newEmail.trim() || !accessToken) return;
    setChangeEmailError('');

    try {
      const response = await fetch(`${API_BASE}/api/v1/auth/verify-email/change-email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ new_email: newEmail.trim() }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to change email');
      }

      setCurrentEmail(newEmail.trim());
      useAuthStore.getState().setPendingVerificationEmail(newEmail.trim());
      setShowChangeEmail(false);
      setNewEmail('');
      setResendCooldown(RESEND_COOLDOWN);
      setAttemptsRemaining(null);
      setError('');
    } catch (err) {
      setChangeEmailError(err instanceof Error ? err.message : 'Failed to change email');
    }
  };

  return (
    <div className="email-verification">
      <div className="email-verification-header">
        <h2>Verify your email</h2>
        <p className="email-verification-subtitle">
          Enter the 6-digit code sent to <strong>{maskEmail(currentEmail)}</strong>
        </p>
      </div>

      <div className="email-verification-input">
        <TOTPInput onSubmit={handleSubmitCode} disabled={isVerifying} error={error} autoFocus />
        {isVerifying && (
          <div className="email-verification-loading">
            <LoadingSpinner />
          </div>
        )}
      </div>

      {attemptsRemaining !== null && attemptsRemaining > 0 && (
        <p className="email-verification-attempts">
          {attemptsRemaining} attempt{attemptsRemaining !== 1 ? 's' : ''} remaining
        </p>
      )}

      <div className="email-verification-actions">
        <button
          type="button"
          className="email-verification-resend"
          onClick={handleResend}
          disabled={resendCooldown > 0 || isResending}
        >
          {isResending
            ? 'Sending...'
            : resendCooldown > 0
              ? `Send new code (${resendCooldown}s)`
              : 'Send new code'}
        </button>

        <button
          type="button"
          className="email-verification-change"
          onClick={() => setShowChangeEmail(!showChangeEmail)}
        >
          {showChangeEmail ? 'Cancel' : 'Change email'}
        </button>
      </div>

      {showChangeEmail && (
        <form className="email-verification-change-form" onSubmit={handleChangeEmail}>
          <input
            type="email"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            placeholder="New email address"
            autoFocus
            required
          />
          <button type="submit" disabled={!newEmail.trim()}>
            Update & send code
          </button>
          {changeEmailError && <p className="email-verification-error">{changeEmailError}</p>}
        </form>
      )}

      <button type="button" className="email-verification-back" onClick={onBack}>
        ← Back to registration
      </button>
    </div>
  );
};

export default EmailVerification;
