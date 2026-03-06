import { create } from 'zustand';

interface MFAChallengeState {
  /** The MFA challenge token from the server */
  challengeToken: string | null;
  /** Available MFA methods for this user */
  methods: string[];
  /** Methods restricted to recovery only (excluded from login/verification prompts) */
  recoveryOnlyMethods: string[];
  /** Purpose of the challenge (login handled separately — this is for mid-session) */
  purpose: 'suspicious_refresh' | null;
  /** Promise resolver — the interceptor awaits this */
  resolve: ((verified: boolean) => void) | null;

  /** Present the MFA challenge modal and return a promise that resolves when verified */
  showChallenge: (
    token: string,
    methods: string[],
    purpose: 'suspicious_refresh',
    recoveryOnlyMethods?: string[]
  ) => Promise<boolean>;
  /** Called by the modal after successful MFA verification */
  completeChallenge: (verified: boolean) => void;
  /** Clear the challenge state */
  clearChallenge: () => void;
}

export const useMFAChallengeStore = create<MFAChallengeState>((set, get) => ({
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
