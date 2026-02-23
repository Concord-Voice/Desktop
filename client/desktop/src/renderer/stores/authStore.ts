import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  rememberMe: boolean;
  setTokens: (accessToken: string, refreshToken: string | undefined) => void;
  setRememberMe: (rememberMe: boolean) => void;
  clearTokens: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      refreshToken: null,
      rememberMe: true,
      setTokens: (accessToken, refreshToken) =>
        set({ accessToken, refreshToken: refreshToken ?? null }),
      setRememberMe: (rememberMe) => set({ rememberMe }),
      clearTokens: () => set({ accessToken: null, refreshToken: null }),
    }),
    {
      name: 'concord-auth',
    }
  )
);
