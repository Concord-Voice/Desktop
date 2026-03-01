import { create } from 'zustand';

interface AuthState {
  accessToken: string | null;
  sessionId: string | null;
  rememberMe: boolean;
  setAccessToken: (accessToken: string) => void;
  setSessionId: (sessionId: string | null) => void;
  setRememberMe: (rememberMe: boolean) => void;
  clearAccessToken: () => void;
}

export const useAuthStore = create<AuthState>()((set) => ({
  accessToken: null,
  sessionId: null,
  rememberMe: true,
  setAccessToken: (accessToken) => set({ accessToken }),
  setSessionId: (sessionId) => set({ sessionId }),
  setRememberMe: (rememberMe) => set({ rememberMe }),
  clearAccessToken: () => set({ accessToken: null, sessionId: null }),
}));
