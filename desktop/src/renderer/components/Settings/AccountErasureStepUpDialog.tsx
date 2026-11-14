import React, { useRef, useState } from 'react';
import Modal from '../ui/Modal';
import StepUpCredentials, { stepUpActivation } from '../Auth/StepUpCredentials';
import {
  useStepUpFactor,
  type StepUpSubmit,
  type StepUpSubmitOutcome,
} from '../../hooks/auth/useStepUpFactor';
import { apiRequestContextIsCurrent } from '../../services/system/requestContext';
import { eraseAccount, PrivacyApiError, type AccountErasureResult } from '../../api/privacy';

interface AccountErasureStepUpDialogProps {
  confirmedOwnedServerIds: string[];
  emailConfirmation: { requestId: string; token: string } | null;
  onResult: (result: AccountErasureResult) => void;
  onStaleOwnedServers: () => void;
  onClose: () => void;
}

/** The password and MFA factor are component-local and unmounted on close. */
const AccountErasureStepUpDialog: React.FC<AccountErasureStepUpDialogProps> = ({
  confirmedOwnedServerIds,
  emailConfirmation,
  onResult,
  onStaleOwnedServers,
  onClose,
}) => {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const factor = useStepUpFactor({
    enabled: true,
    purpose: 'privacy.account_erase',
    passwordLeg: 'always',
    readFailure: 'passwordOnly',
    allowBackup: true,
  });

  const submit: StepUpSubmit = async (mfa, context): Promise<StepUpSubmitOutcome> => {
    setError(null);
    try {
      const result = await eraseAccount(
        {
          password,
          ...(mfa ? { mfa_code: mfa } : {}),
          confirmed_owned_server_ids: confirmedOwnedServerIds,
          ...(emailConfirmation
            ? {
                email_confirmation: {
                  request_id: emailConfirmation.requestId,
                  token: emailConfirmation.token,
                },
              }
            : {}),
        },
        context
      );
      if (apiRequestContextIsCurrent(context)) onResult(result);
      return { kind: 'success' };
    } catch (err) {
      if (err instanceof PrivacyApiError) {
        if (err.status === 403) return { kind: 'answered' };
        if (err.code === 'owned_server_confirmation_stale') onStaleOwnedServers();
        setError(
          err.status === 429
            ? 'Too many attempts. Wait before trying again.'
            : err.status === 503
              ? 'Verification is temporarily unavailable. Try again.'
              : err.code === 'owned_server_confirmation_stale'
                ? 'Your owned-server list changed. Review every acknowledgement again.'
                : 'We could not confirm this request. Review and try again.'
        );
        return { kind: 'answered' };
      }
      setError("Couldn't reach the server. Check your connection and try again.");
      return { kind: 'transport' };
    }
  };

  const { ariaDisabled, activate } = stepUpActivation(factor, password, submit);
  return (
    <Modal isOpen onClose={onClose} title="Erase your account" width="small" dismissable>
      <p className="settings-section-description">
        This permanently erases your account. Confirm it is you before continuing.
      </p>
      {error && <p role="alert">{error}</p>}
      <StepUpCredentials
        factor={factor}
        password={password}
        onPasswordChange={setPassword}
        primaryRef={primaryRef}
        focusOnReady
      />
      <div className="purge-modal__actions">
        <button type="button" className="purge-modal__cancel" onClick={onClose}>
          Cancel
        </button>
        <button
          ref={primaryRef}
          type="button"
          className="purge-modal__confirm"
          aria-disabled={ariaDisabled || undefined}
          onClick={activate}
        >
          Erase account
        </button>
      </div>
    </Modal>
  );
};

export default AccountErasureStepUpDialog;
