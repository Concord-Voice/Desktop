import React from 'react';
import Modal from './ui/Modal';
import { useTelemetryConsentStore } from '../stores/telemetryConsentStore';
import { TELEMETRY_POLICY_VERSION } from '../../shared/sentry-policy-version';
import './TelemetryConsentDialog.css';

const TELEMETRY_CHANGELOG_URL = 'https://concordvoice.com/telemetry-policy';

type DialogMode = 'first-launch' | 'policy-update' | null;

function useDialogMode(): DialogMode {
  const isLoaded = useTelemetryConsentStore((s) => s.isLoaded);
  const firstPromptCompleted = useTelemetryConsentStore((s) => s.firstPromptCompleted);
  const pendingReConsent = useTelemetryConsentStore((s) => s.pendingReConsent);

  if (!isLoaded) return null;
  if (!firstPromptCompleted) return 'first-launch';
  if (pendingReConsent) return 'policy-update';
  return null;
}

const TelemetryConsentDialog: React.FC = () => {
  const mode = useDialogMode();
  const policyVersion = TELEMETRY_POLICY_VERSION;
  const setConsent = useTelemetryConsentStore((s) => s.setConsent);

  if (!mode) return null;

  const handleAccept = async () => {
    await setConsent(true, policyVersion);
  };

  const handleDecline = async () => {
    await setConsent(false, policyVersion);
  };

  const title = mode === 'first-launch' ? 'Help improve Concord Voice' : 'Telemetry policy updated';

  return (
    <Modal isOpen onClose={() => {}} title={title} width="small" dismissable={false}>
      <div className="telemetry-consent-body">
        {mode === 'first-launch' ? (
          <>
            <p>
              Would you like to send anonymous crash reports to help us fix bugs? No message
              content, personal information, or encryption keys are ever included.
            </p>
            <p className="telemetry-consent-hint">
              You can change this anytime in Settings &rarr; Privacy &amp; Security.
            </p>
          </>
        ) : (
          <>
            <p>
              We&apos;ve updated how crash reports are collected.{' '}
              <a href={TELEMETRY_CHANGELOG_URL} target="_blank" rel="noopener noreferrer">
                View changes &rarr;
              </a>
            </p>
            <p>Would you like to continue sending anonymous crash reports?</p>
          </>
        )}
        <div className="telemetry-consent-actions">
          <button className="btn btn-primary" onClick={handleAccept}>
            {mode === 'first-launch' ? 'Yes, send crash reports' : 'Yes, continue'}
          </button>
          <button className="btn btn-secondary" onClick={handleDecline}>
            {mode === 'first-launch' ? 'No thanks' : 'Opt out'}
          </button>
        </div>
      </div>
    </Modal>
  );
};

export default TelemetryConsentDialog;
