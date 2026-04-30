import { createStore } from '../utils/createStore';

/**
 * Purpose discriminates which interceptor / flow is awaiting the MFA result:
 * - 'suspicious_refresh': mid-session — apiClient interceptor caught a 401
 *   with mfa_required and is gating a refresh attempt.
 * - 'sso_login': SSO sign-in surfaced an mfa_required response from the
 *   provider callback; useSSOFlow awaits the verified result before flipping
 *   the SSO store to idle and rehydrating E2EE.
 *
 * MFAChallengeModal itself does NOT branch on purpose — both paths render the
 * same UI and POST to /api/v1/auth/mfa/verify. The discriminator exists so
 * future wiring (e.g., distinct cancel-flow telemetry) can act on it.
 */
type MFAChallengePurpose = 'suspicious_refresh' | 'sso_login';

interface MFAChallengeState {
  /** The MFA challenge token from the server */
  challengeToken: string | null;
  /** Available MFA methods for this user */
  methods: string[];
  /** Methods restricted to recovery only (excluded from login/verification prompts) */
  recoveryOnlyMethods: string[];
  /** Purpose of the challenge (login handled separately — this is for mid-session or SSO) */
  purpose: MFAChallengePurpose | null;
  /** Promise resolver — the interceptor awaits this */
  resolve: ((verified: boolean) => void) | null;

  /** Present the MFA challenge modal and return a promise that resolves when verified */
  showChallenge: (
    token: string,
    methods: string[],
    purpose: MFAChallengePurpose,
    recoveryOnlyMethods?: string[]
  ) => Promise<boolean>;
  /** Called by the modal after successful MFA verification */
  completeChallenge: (verified: boolean) => void;
  /** Clear the challenge state */
  clearChallenge: () => void;
}

export const useMFAChallengeStore = createStore<MFAChallengeState>()((set, get) => ({
  challengeToken: null,
  methods: [],
  recoveryOnlyMethods: [],
  purpose: null,
  resolve: null,

  showChallenge: (token, methods, purpose, recoveryOnlyMethods) => {
    return new Promise<boolean>((resolve) => {
      set({
        challengeToken: token,
        methods,
        recoveryOnlyMethods: recoveryOnlyMethods || [],
        purpose,
        resolve,
      });
    });
  },

  completeChallenge: (verified) => {
    const { resolve } = get();
    if (resolve) resolve(verified);
    set({
      challengeToken: null,
      methods: [],
      recoveryOnlyMethods: [],
      purpose: null,
      resolve: null,
    });
  },

  clearChallenge: () => {
    const { resolve } = get();
    if (resolve) resolve(false);
    set({
      challengeToken: null,
      methods: [],
      recoveryOnlyMethods: [],
      purpose: null,
      resolve: null,
    });
  },
}));
