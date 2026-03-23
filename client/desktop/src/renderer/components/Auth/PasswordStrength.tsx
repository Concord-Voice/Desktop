import React from 'react';
import './PasswordStrength.css';

export interface PasswordStrengthProps {
  password: string;
}

interface StrengthResult {
  score: number; // 0-5
  label: string;
  color: string;
  feedback: string[];
}

/**
 * Calculate password strength score (0-4)
 * Based on NIST guidelines and industry best practices
 */
function calculateStrength(password: string): StrengthResult {
  if (!password) {
    return {
      score: 0,
      label: 'No password',
      color: 'var(--text-muted)',
      feedback: ['Enter a password'],
    };
  }

  let score = 0;
  const feedback: string[] = [];
  let hasPenalty = false;

  // Length scoring (most important factor per NIST)
  // Minimum is 12 chars (matches backend ValidatePasswordStrength)
  if (password.length >= 12) score++;
  if (password.length >= 16) score++;
  if (password.length >= 20) score++;
  if (password.length >= 24) score++; // Bonus for very long passwords

  if (password.length < 12) {
    feedback.push('Use at least 12 characters');
  } else if (password.length < 16) {
    feedback.push('Try 16+ characters for better security');
  }

  // Character variety
  const hasLowercase = /[a-z]/.test(password);
  const hasUppercase = /[A-Z]/.test(password);
  const hasNumbers = /\d/.test(password);
  const hasSpecial = /[^a-zA-Z0-9]/.test(password);

  const varietyCount = [hasLowercase, hasUppercase, hasNumbers, hasSpecial].filter(Boolean).length;

  // More lenient variety scoring
  if (varietyCount >= 2) score++; // Basic variety
  if (varietyCount >= 4) score++; // Full variety bonus

  if (varietyCount < 3) {
    if (!hasLowercase || !hasUppercase) {
      feedback.push('Mix uppercase and lowercase');
    } else if (!hasNumbers) {
      feedback.push('Add some numbers');
    } else if (!hasSpecial) {
      feedback.push('Add special characters (!@#$%...)');
    }
  }

  // Common patterns penalty (only penalize, don't add score)
  const commonPatterns = [
    { pattern: /^(123|abc|qwe)/i, message: 'Avoid sequential starts' },
    { pattern: /password|letmein|welcome/i, message: 'Avoid common words' },
    { pattern: /(.)\1{2,}/, message: 'Avoid repeated characters' },
    { pattern: /^[a-z]+$/i, message: 'Add numbers or symbols' },
    { pattern: /^[0-9]+$/, message: 'Add letters' },
  ];

  for (const { pattern, message } of commonPatterns) {
    if (pattern.test(password)) {
      score = Math.max(0, score - 2); // Stronger penalty
      if (!hasPenalty) {
        feedback.push(message);
        hasPenalty = true;
      }
      break;
    }
  }

  // Bonus point for truly exceptional passwords (no penalties + max criteria)
  if (score >= 6 && !hasPenalty && password.length >= 24 && varietyCount === 4) {
    score = 5; // Legendary tier
  }

  // Ensure score is 0-5
  score = Math.max(0, Math.min(5, score));

  // Determine label and color based on score
  const levels = [
    { label: 'Very Weak', color: 'var(--danger)' },
    { label: 'Weak', color: '#f39c12' },
    { label: 'Fair', color: 'var(--accent-secondary)' },
    { label: 'Good', color: '#43b581' },
    { label: 'Strong', color: 'var(--success)' },
    { label: 'Legendary 🔥', color: '#b762ff' }, // Purple for legendary tier
  ];

  return {
    score,
    label: levels[score].label,
    color: levels[score].color,
    feedback: feedback.slice(0, 2), // Show max 2 feedback items
  };
}

const PasswordStrength: React.FC<PasswordStrengthProps> = ({ password }) => {
  const strength = calculateStrength(password);

  if (!password) {
    return null;
  }

  return (
    <div className="password-strength">
      <div className="strength-bar-container">
        {['seg-1', 'seg-2', 'seg-3', 'seg-4', 'seg-5'].map((id, index) => (
          <div
            key={id}
            className={`strength-bar-segment ${index < strength.score ? 'active' : ''}`}
            style={{
              backgroundColor: index < strength.score ? strength.color : 'var(--bg-tertiary)',
            }}
          />
        ))}
      </div>

      <div className="strength-info">
        <span
          className={`strength-label ${strength.score === 5 ? 'legendary' : ''}`}
          style={{ color: strength.score === 5 ? undefined : strength.color }}
        >
          {strength.label}
        </span>
        {strength.feedback.length > 0 && (
          <div className="strength-feedback">
            {strength.feedback.map((tip) => (
              <span key={tip} className="feedback-item">
                {tip}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default PasswordStrength;
