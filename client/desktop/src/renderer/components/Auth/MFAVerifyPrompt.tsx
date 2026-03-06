import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import TOTPInput from './TOTPInput';
import BackupCodeInput from './BackupCodeInput';
import { apiFetch } from '../../services/apiClient';
import { getAvailableCategories, getDefaultMethod, type MFAMethodCategory } from './MFAMethodPicker';

interface MFAVerifyPromptProps {
  /** Raw method strings from the server (e.g. ['totp', 'webauthn', 'email', 'sms']) */
  methods: string[];
  /** Methods that are recovery-only and should be excluded */
  recoveryOnlyMethods?: string[];
  /** Called with the MFA code (TOTP, backup code, or WebAuthn inline-verify token) */
  onVerify: (code: string) => void;
  disabled?: boolean;
  error?: string;
  /** If true, backup codes are hidden (use during setup, not revoke/remove) */
  excludeBackupCodes?: boolean;
}

/**
 * Multi-method MFA verification prompt for protected operations (setup, revoke, etc.).
 * Supports TOTP, backup codes, and WebAuthn (via inline-verify token flow).
 */
const MFAVerifyPrompt: React.FC<MFAVerifyPromptProps> = ({
  methods,
  recoveryOnlyMethods = [],
  onVerify,
  disabled = false,
  error,
  excludeBackupCodes = false,
}) => {
  const excludedMethods = useMemo(() => [...recoveryOnlyMethods], [recoveryOnlyMethods]);

  const available = useMemo(() => {
    const cats = getAvailableCategories(methods, excludedMethods);
    return excludeBackupCodes ? cats.filter((c) => c !== 'backup') : cats;
  }, [methods, excludedMethods, excludeBackupCodes]);

  const defaultMethod = useMemo(() => {
    const def = getDefaultMethod(methods, excludedMethods);
    if (excludeBackupCodes && def === 'backup') {
      return available[0] || 'totp';
    }
    return def;
  }, [methods, excludedMethods, excludeBackupCodes, available]);

  const [mode, setMode] = useState<MFAMethodCategory>(defaultMethod);
  const [webauthnStatus, setWebauthnStatus] = useState<'idle' | 'waiting' | 'error'>('idle');
  const [webauthnError, setWebauthnError] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const showBackupSwitch = !excludeBackupCodes && available.includes('backup');

  // Abort any pending WebAuthn ceremony on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  // Build switch links for other available methods
  const otherMethodLinks = useCallback((currentMode: MFAMethodCategory) => {
    const links: React.ReactNode[] = [];
    if (currentMode !== 'webauthn' && available.includes('webauthn')) {
      links.push(
        <button key="webauthn" type="button" className="totp-backup-link" onClick={() => { setMode('webauthn'); setWebauthnStatus('idle'); setWebauthnError(''); }} disabled={disabled}>
          Use a security key instead
        </button>
      );
    }
    if (currentMode !== 'totp' && available.includes('totp')) {
      links.push(
        <button key="totp" type="button" className="totp-backup-link" onClick={() => { abortRef.current?.abort(); setMode('totp'); }} disabled={disabled}>
          Use authenticator app instead
        </button>
      );
    }
    if (showBackupSwitch && currentMode !== 'backup') {
      links.push(
        <button key="backup" type="button" className="totp-backup-link" onClick={() => { abortRef.current?.abort(); setMode('backup'); }} disabled={disabled}>
          Use a backup code instead
        </button>
      );
    }
    return links;
  }, [available, showBackupSwitch, disabled]);

  // WebAuthn inline-verify flow
  const handleWebAuthnVerify = useCallback(async () => {
    // Abort any previous pending ceremony
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setWebauthnStatus('waiting');
    setWebauthnError('');
    try {
      // Step 1: Get assertion options from server
      const beginRes = await apiFetch('/api/v1/mfa/webauthn/verify-inline/begin', { method: 'POST' });
      const beginData = await beginRes.json();
      if (!beginRes.ok) throw new Error(beginData.error || 'Failed to start verification');

      // Convert base64url fields for WebAuthn API
      const options = beginData.publicKey;
      options.challenge = base64urlToBuffer(options.challenge);
      if (options.allowCredentials) {
        for (const cred of options.allowCredentials) {
          cred.id = base64urlToBuffer(cred.id);
        }
      }

      // Step 2: Browser WebAuthn ceremony
      const credential = await navigator.credentials.get({
        publicKey: options,
        signal: controller.signal,
      }) as PublicKeyCredential;
      if (!credential) throw new Error('No credential returned');

      const assertion = credential.response as AuthenticatorAssertionResponse;

      // Step 3: Send assertion to server for verification
      const finishRes = await apiFetch('/api/v1/mfa/webauthn/verify-inline/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: credential.id,
          rawId: bufferToBase64url(credential.rawId),
          type: credential.type,
          response: {
            authenticatorData: bufferToBase64url(assertion.authenticatorData),
            clientDataJSON: bufferToBase64url(assertion.clientDataJSON),
            signature: bufferToBase64url(assertion.signature),
            userHandle: assertion.userHandle ? bufferToBase64url(assertion.userHandle) : undefined,
          },
        }),
      });
      const finishData = await finishRes.json();
      if (!finishRes.ok) throw new Error(finishData.error || 'Verification failed');

      // Pass the inline verification token as the MFA code
      onVerify(finishData.mfa_token);
    } catch (err) {
      // If aborted (unmount or new ceremony), silently reset
      if (err instanceof DOMException && err.name === 'AbortError') {
        setWebauthnStatus('idle');
        return;
      }
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        setWebauthnError('Cancelled or timed out. Try again.');
      } else {
        setWebauthnError(err instanceof Error ? err.message : 'Verification failed');
      }
      setWebauthnStatus('error');
    }
  }, [onVerify]);

  return (
    <div className="mfa-verify-prompt">
      <label className="mfa-verify-prompt-label">MFA Verification</label>

      {mode === 'totp' && (
        <>
          <TOTPInput
            onSubmit={onVerify}
            disabled={disabled}
            error={error}
            autoFocus
          />
          {otherMethodLinks('totp')}
        </>
      )}

      {mode === 'backup' && !excludeBackupCodes && (
        <>
          <BackupCodeInput
            onSubmit={onVerify}
            disabled={disabled}
            error={error}
          />
          {otherMethodLinks('backup')}
        </>
      )}

      {mode === 'webauthn' && (
        <div className="mfa-webauthn-inline">
          {webauthnStatus === 'idle' && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleWebAuthnVerify}
              disabled={disabled}
            >
              Verify with security key
            </button>
          )}
          {webauthnStatus === 'waiting' && (
            <div style={{ textAlign: 'center', padding: '8px 0' }}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ margin: '0 auto 8px', display: 'block', opacity: 0.7 }}>
                <path d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
              </svg>
              <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-secondary, #bbb)' }}>
                Touch your security key or use biometrics...
              </p>
            </div>
          )}
          {webauthnStatus === 'error' && (
            <>
              <p style={{ margin: '0 0 8px', fontSize: '13px', color: 'var(--error-color, #ed4245)' }}>
                {webauthnError}
              </p>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleWebAuthnVerify}
                disabled={disabled}
              >
                Try again
              </button>
            </>
          )}
          {otherMethodLinks('webauthn')}
        </div>
      )}

      {mode === 'email-sms' && (
        <>
          <TOTPInput
            onSubmit={onVerify}
            disabled={disabled}
            error={error}
            autoFocus
          />
          {otherMethodLinks('email-sms')}
        </>
      )}
    </div>
  );
};

// ── base64url helpers ──────────────────────────────────────────────────

function base64urlToBuffer(base64url: string): ArrayBuffer {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = base64.length % 4 === 0 ? '' : '='.repeat(4 - (base64.length % 4));
  const binary = atob(base64 + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function bufferToBase64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export default MFAVerifyPrompt;
