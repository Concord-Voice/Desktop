import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

interface TelemetryConsentState {
  telemetryOptIn: boolean;
  firstPromptCompleted: boolean;
  policyAcknowledgedVersion: number;
  isLoaded: boolean;

  hydrate: () => Promise<void>;
  setConsent: (optIn: boolean, policyVersion: number) => Promise<void>;
  applyRemoteState: (state: {
    telemetryOptIn: boolean;
    firstPromptCompleted: boolean;
    policyAcknowledgedVersion: number;
  }) => void;
}

export const useTelemetryConsentStore = create<TelemetryConsentState>()(
  devtools(
    (set) => ({
      telemetryOptIn: false,
      firstPromptCompleted: false,
      policyAcknowledgedVersion: 0,
      isLoaded: false,

      hydrate: async () => {
        try {
          const state = await globalThis.electron.getConsentState();
          set({
            telemetryOptIn: state.telemetryOptIn,
            firstPromptCompleted: state.firstPromptCompleted,
            policyAcknowledgedVersion: state.policyAcknowledgedVersion,
            isLoaded: true,
          });
        } catch (err) {
          console.error('[TelemetryConsentStore] Failed to hydrate consent state:', err);
          set({ isLoaded: true });
        }
      },

      setConsent: async (optIn, policyVersion) => {
        const updates = {
          telemetryOptIn: optIn,
          firstPromptCompleted: true,
          policyAcknowledgedVersion: policyVersion,
        };
        try {
          await globalThis.electron.setConsentState(updates);
          set(updates);
        } catch (err) {
          console.error('[TelemetryConsentStore] Failed to persist consent via IPC:', err);
          // For opt-out: update local state so the UI reflects the user's intent
          // immediately. Main process eagerly disables Sentry on opt-out even if
          // the file write fails, so fail-closed privacy is maintained for the
          // current session. The file state will be re-synced on next launch.
          // For opt-in: leave local state unchanged — fail-closed (Sentry stays off).
          if (!optIn) {
            set(updates);
          }
        }
      },

      applyRemoteState: (state) => {
        set({
          telemetryOptIn: state.telemetryOptIn,
          firstPromptCompleted: state.firstPromptCompleted,
          policyAcknowledgedVersion: state.policyAcknowledgedVersion,
        });
      },
    }),
    { name: 'TelemetryConsentStore' }
  )
);
