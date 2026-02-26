import { create } from 'zustand';

interface AuthState {
  accessToken: string | null;
  rememberMe: boolean;
  setAccessToken: (accessToken: string) => void;
  setRememberMe: (rememberMe: boolean) => void;
  clearAccessToken: () => void;
}

export const useAuthStore = create<AuthState>()((set) => ({
  accessToken: null,
  rememberMe: true,
  setAccessToken: (accessToken) => set({ accessToken }),
  setRememberMe: (rememberMe) => set({ rememberMe }),
  clearAccessToken: () => set({ accessToken: null }),
}));
