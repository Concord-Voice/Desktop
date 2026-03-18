import { create } from 'zustand';

interface AuthState {
  accessToken: string | null;
  sessionId: string | null;
  rememberMe: boolean;
  emailVerified: boolean;
  pendingVerificationEmail: string | null;
  setAccessToken: (accessToken: string) => void;
  setSessionId: (sessionId: string | null) => void;
  setRememberMe: (rememberMe: boolean) => void;
  setEmailVerified: (verified: boolean) => void;
  setPendingVerificationEmail: (email: string | null) => void;
  clearAccessToken: () => void;
}

export const useAuthStore = create<AuthState>()((set) => ({
  accessToken: null,
  sessionId: null,
  rememberMe: true,
  emailVerified: true, // Default true for backward compat (existing sessions)
  pendingVerificationEmail: null,
  setAccessToken: (accessToken) => set({ accessToken }),
  setSessionId: (sessionId) => set({ sessionId }),
  setRememberMe: (rememberMe) => set({ rememberMe }),
  setEmailVerified: (emailVerified) => set({ emailVerified }),
  setPendingVerificationEmail: (pendingVerificationEmail) => set({ pendingVerificationEmail }),
  clearAccessToken: () =>
    set({
      accessToken: null,
      sessionId: null,
      emailVerified: true,
      pendingVerificationEmail: null,
    }),
}));
