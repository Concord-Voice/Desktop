import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { useAuthStore } from './authStore';
import { apiFetch } from '../services/apiClient';
import { getWebSocketService } from '../services/websocketService';
import { e2eeService } from '../services/e2eeService';
import { preferencesSyncService } from '../services/preferencesSync';
import {
  deriveKeyFromPassword,
  unwrapPrivateKey,
  wrapPrivateKey,
  generateSalt,
  base64ToArrayBuffer,
  arrayBufferToBase64,
} from '../utils/crypto';

export interface UserProfile {
  id: string;
  username: string;
  email?: string;
  display_name?: string;
  bio?: string;
  avatar_url?: string;
  header_image_url?: string;
  links?: string[];
  e2ee_preference: boolean;
  created_at?: string;
}

export interface UpdateProfileData {
  username?: string;
  display_name?: string | null;
  bio?: string | null;
  avatar_url?: string | null;
  header_image_url?: string | null;
  color_scheme?: string | null;
  links?: string[];
}

interface UserState {
  user: UserProfile | null;
  isLoading: boolean;
  error: string | null;

  fetchUser: () => Promise<void>;
  setUser: (user: UserProfile) => void;
  clearUser: () => void;
  logout: () => Promise<void>;
  updateProfile: (updates: UpdateProfileData) => Promise<void>;
  changePassword: (
    currentPassword: string,
    newPassword: string
  ) => Promise<{ success: boolean; error?: string }>;
}

export const useUserStore = create<UserState>()(
  devtools(
    (set) => ({
      user: null,
      isLoading: false,
      error: null,

      fetchUser: async () => {
        set({ isLoading: true, error: null });

        try {
          const response = await apiFetch('/api/v1/users/me');

          if (response.status === 401) {
            // Token expired and refresh failed — clear auth
            useAuthStore.getState().clearAccessToken();
            window.electron?.clearTokens?.();
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
        // Stop syncing preferences before tearing down
        preferencesSyncService.stopWatching();
        e2eeService.clearKeys();

        // Disconnect WebSocket FIRST so the server receives the close frame
        // and broadcasts offline presence while the connection is still healthy.
        getWebSocketService().disconnect();

        try {
          // Main process handles logout API call (it holds the refresh token)
          if (window.electron?.logout) {
            await window.electron.logout({
              accessToken: useAuthStore.getState().accessToken ?? undefined,
            });
          }
        } catch (error) {
          console.error('Logout API error:', error);
        }

        // Nuclear reset: login screen will appear, so wipe everything
        const { nuclearReset } = await import('../services/resetService');
        nuclearReset();
      },

      updateProfile: async (updates: UpdateProfileData) => {
        const response = await apiFetch('/api/v1/users/me', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updates),
        });

        if (response.status === 401) {
          useAuthStore.getState().clearAccessToken();
          window.electron?.clearTokens?.();
          set({ user: null, isLoading: false, error: null });
          throw new Error('Session expired');
        }

        const text = await response.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          throw new Error(
            'Server returned an unexpected response. Make sure the backend is running the latest version.'
          );
        }

        if (!response.ok) {
          throw new Error(data.error || 'Failed to update profile');
        }

        set({ user: data.user });

        // Notify other clients via WebSocket so their cached user info updates
        getWebSocketService().sendProfileUpdate();
      },

      changePassword: async (currentPassword: string, newPassword: string) => {
        try {
          // Step 1: Fetch current E2EE keys from the server
          const keysRes = await apiFetch('/api/v1/users/me/keys');

          if (!keysRes.ok) {
            const keysData = await keysRes.json();
            return { success: false, error: keysData.error || 'Failed to fetch encryption keys' };
          }

          const keysData = await keysRes.json();
          const { wrapped_private_key, key_derivation_salt } = keysData.e2ee_keys;

          // Step 2: Unwrap private key with current password
          const currentSalt = new Uint8Array(base64ToArrayBuffer(key_derivation_salt));
          const currentWrappingKey = await deriveKeyFromPassword(currentPassword, currentSalt);
          const wrappedKeyBuffer = base64ToArrayBuffer(wrapped_private_key);
          const privateKey = await unwrapPrivateKey(wrappedKeyBuffer, currentWrappingKey);

          // Step 3: Re-wrap private key with new password
          const newSalt = generateSalt();
          const newWrappingKey = await deriveKeyFromPassword(newPassword, newSalt);
          const newWrappedKey = await wrapPrivateKey(privateKey, newWrappingKey);

          // Step 4: Send password change with re-wrapped keys
          const response = await apiFetch('/api/v1/users/me/password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              current_password: currentPassword,
              new_password: newPassword,
              wrapped_private_key: arrayBufferToBase64(newWrappedKey),
              key_derivation_salt: arrayBufferToBase64(newSalt.buffer as ArrayBuffer),
            }),
          });

          if (response.status === 401) {
            const data = await response.json();
            if (data.error === 'Current password is incorrect') {
              return { success: false, error: data.error };
            }
            useAuthStore.getState().clearAccessToken();
            window.electron?.clearTokens?.();
            set({ user: null, isLoading: false, error: null });
            return { success: false, error: 'Session expired' };
          }

          const data = await response.json();

          if (!response.ok) {
            return { success: false, error: data.error || 'Failed to change password' };
          }

          // Re-initialize E2EE service with new password so preferences key is updated
          await e2eeService.initialize(
            newPassword,
            arrayBufferToBase64(newWrappedKey),
            arrayBufferToBase64(newSalt.buffer as ArrayBuffer)
          );

          // Re-encrypt and push preferences with the new key
          await preferencesSyncService.pushPreferences();

          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to change password',
          };
        }
      },
    }),
    { name: 'UserStore' }
  )
);
