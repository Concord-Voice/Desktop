import React from 'react';
import './PasswordStrength.css';

export interface PasswordStrengthProps {
  password: string;
}

interface StrengthResult {
  score: number; // 0-4
  label: string;
  color: string;
  feedback: string[];
}

/**
 * Calculate password strength score (0-4)
 * Based on length, character variety, and common patterns
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

  // Length scoring
  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (password.length >= 16) score++;

  if (password.length < 8) {
    feedback.push('Use at least 8 characters');
  }

  // Character variety
  const hasLowercase = /[a-z]/.test(password);
  const hasUppercase = /[A-Z]/.test(password);
  const hasNumbers = /\d/.test(password);
  const hasSpecial = /[^a-zA-Z0-9]/.test(password);

  const varietyCount = [hasLowercase, hasUppercase, hasNumbers, hasSpecial].filter(Boolean).length;

  if (varietyCount >= 3) score++;
  if (varietyCount === 4) score++;

  if (!hasLowercase || !hasUppercase) {
    feedback.push('Mix uppercase and lowercase');
  }
  if (!hasNumbers) {
    feedback.push('Add some numbers');
  }
  if (!hasSpecial) {
    feedback.push('Add special characters (!@#$%...)');
  }

  // Common patterns to penalize
  const commonPatterns = [
    /^123/,
    /password/i,
    /qwerty/i,
    /abc123/i,
    /111111/,
    /(.)\1{2,}/, // Repeated characters
  ];

  for (const pattern of commonPatterns) {
    if (pattern.test(password)) {
      score = Math.max(0, score - 1);
      feedback.push('Avoid common patterns');
      break;
    }
  }

  // Cap score at 4
  score = Math.min(4, score);

  // Determine label and color based on score
  const levels = [
    { label: 'Very Weak', color: 'var(--danger)' },
    { label: 'Weak', color: '#f39c12' },
    { label: 'Fair', color: 'var(--accent-secondary)' },
    { label: 'Good', color: '#43b581' },
    { label: 'Strong', color: 'var(--success)' },
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
        {[0, 1, 2, 3, 4].map((index) => (
          <div
            key={index}
            className={`strength-bar-segment ${index < strength.score ? 'active' : ''}`}
            style={{
              backgroundColor: index < strength.score ? strength.color : 'var(--bg-tertiary)',
            }}
          />
        ))}
      </div>

      <div className="strength-info">
        <span className="strength-label" style={{ color: strength.color }}>
          {strength.label}
        </span>
        {strength.feedback.length > 0 && (
          <div className="strength-feedback">
            {strength.feedback.map((tip, index) => (
              <span key={index} className="feedback-item">
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
