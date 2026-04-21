import CollapsibleSection from './CollapsibleSection';
import ToggleSwitch from './ToggleSwitch';
import TelemetryAllowlistDisclosure from '../TelemetryAllowlistDisclosure';
import { useTelemetryConsentStore } from '../../stores/telemetryConsentStore';
import { TELEMETRY_POLICY_VERSION } from '../../../shared/sentry-policy-version';

const CrashReportingSection = () => {
  const telemetryOptIn = useTelemetryConsentStore((s) => s.telemetryOptIn);
  const isConsentLoaded = useTelemetryConsentStore((s) => s.isLoaded);
  const policyVersion = TELEMETRY_POLICY_VERSION;

  return (
    <CollapsibleSection id="section-crash-reporting" title="Crash Reporting">
      <p className="settings-section-description">
        Help improve Concord by sending anonymous crash data when errors occur. No message content
        or personal information is included.
      </p>
      <div className="settings-row">
        <div className="settings-row-info">
          <span className="settings-row-label">Send anonymous crash reports</span>
          <span className="settings-row-hint">
            Crash reports help us identify and fix bugs faster
          </span>
        </div>
        <ToggleSwitch
          checked={telemetryOptIn}
          disabled={!isConsentLoaded}
          onChange={async (enabled: boolean) => {
            try {
              await useTelemetryConsentStore.getState().setConsent(enabled, policyVersion);
            } catch (err) {
              console.error(
                '[Settings] Failed to update telemetry consent:',
                err instanceof Error ? err.message : 'unknown'
              );
            }
          }}
        />
      </div>
      <TelemetryAllowlistDisclosure />
    </CollapsibleSection>
  );
};

export default CrashReportingSection;
