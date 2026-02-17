import { create } from 'zustand';
import { useAuthStore } from './authStore';
import { useServerStore } from './serverStore';

export interface UserProfile {
  id: string;
  username: string;
  email?: string;
  e2ee_preference: boolean;
  created_at?: string;
}

interface UserState {
  user: UserProfile | null;
  isLoading: boolean;
  error: string | null;

  fetchUser: (accessToken: string) => Promise<void>;
  setUser: (user: UserProfile) => void;
  clearUser: () => void;
  logout: () => Promise<void>;
}

export const useUserStore = create<UserState>()((set) => ({
  user: null,
  isLoading: false,
  error: null,

  fetchUser: async (accessToken: string) => {
    set({ isLoading: true, error: null });

    try {
      const response = await fetch('http://localhost:8080/api/v1/users/me', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (response.status === 401) {
        // Token expired — clear auth and let ProtectedRoute redirect
        useAuthStore.getState().clearTokens();
        set({ user: null, isLoading: false, error: null });
        return;
      }

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to fetch user');
      }

      const data = await response.json();
      set({ user: data.user, isLoading: false });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to fetch user',
        isLoading: false,
      });
    }
  },

  setUser: (user: UserProfile) => {
    set({ user, isLoading: false, error: null });
  },

  clearUser: () => {
    set({ user: null, isLoading: false, error: null });
  },

  logout: async () => {
    try {
      await fetch('http://localhost:8080/api/v1/auth/logout', {
        method: 'POST',
        credentials: 'include',
      });
    } catch (error) {
      console.error('Logout API error:', error);
      // Continue with local cleanup even if server call fails
    }

    // Clear all stores
    set({ user: null, isLoading: false, error: null });
    useAuthStore.getState().clearTokens();
    useServerStore.getState().clearServers();
  },
}));
