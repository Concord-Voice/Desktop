/**
 * Reset Service — Centralized state cleanup for auth lifecycle events
 *
 * Three tiers:
 * - softRestart: Page reload preserving auth tokens. Used by Recovery B when
 *   the client has issues but the session is valid.
 * - gracefulReset: Clears content stores, preserves device settings (theme, audio, etc.)
 *   Used when the user is being "remembered" but needs a fresh content slate.
 * - nuclearReset: Wipes everything. Used when the login screen appears — no ghost profiles.
 *
 * Core principle: if the login screen appears, go nuclear.
 */

import { useAuthStore } from '../stores/authStore';
import { stopProactiveRefresh } from './apiClient';
import { useServerStore } from '../stores/serverStore';
import { useChannelStore } from '../stores/channelStore';
import { useDMStore } from '../stores/dmStore';
import { useFriendStore } from '../stores/friendStore';
import { usePrivacyStore } from '../stores/privacyStore';
import { useMemberStore } from '../stores/memberStore';
import { useUnreadStore } from '../stores/unreadStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useChatStore } from '../stores/chatStore';
import { useLayoutStore } from '../stores/layoutStore';
import { useUserStore } from '../stores/userStore';
import { useDraftMessageStore } from '../stores/draftMessageStore';

/**
 * Clears content stores while preserving device settings.
 * Appropriate when rememberMe=true and the session can be restored,
 * but user-specific content must be wiped to prevent ghost artifacts.
 */
export function gracefulReset(): void {
  // Stop proactive token refresh timer (#240)
  stopProactiveRefresh();

  // Clear content stores (in-memory state)
  useServerStore.getState().clearServers();
  useChannelStore.getState().clearChannels();
  useDMStore.getState().clearDMs();
  useFriendStore.getState().clearFriends();
  usePrivacyStore.getState().clearPrivacy();
  useMemberStore.getState().clearMembers();
  useUnreadStore.getState().clearAll();
  useVoiceStore.getState().reset();
  useChatStore.getState().reset();
  useUserStore.getState().clearUser();

  // Clear user-specific layout content (serverFolders, serverOrder)
  // but preserve UI preferences (panel widths/modes)
  useLayoutStore.getState().clearUserContent();

  // Clear draft messages (user content, not device settings)
  useDraftMessageStore.getState().clearAllDrafts();

  // Remove persisted content store data from localStorage
  // (settings stores are NOT touched — theme, audio, video, TTS persist)
  localStorage.removeItem('concord:dm-store');
  localStorage.removeItem('concord-servers');
  localStorage.removeItem('concord-channels');
  localStorage.removeItem('concord:draft-messages');
}

/**
 * Soft restart — reloads the page while preserving auth tokens.
 * Used by Recovery B when the client has issues but the session is valid.
 * Auth tokens persist in zustand/persist localStorage, and disk tokens
 * remain untouched for Remember Me users.
 */
export function softRestart(): void {
  gracefulReset();
  globalThis.location.reload();
}

/**
 * Wipes all state — in-memory stores, localStorage, and main process tokens.
 * Used when the login screen appears (any reason), ensuring zero ghost state.
 */
export function nuclearReset(): void {
  // Start with everything gracefulReset does
  gracefulReset();

  // Additionally clear auth store
  useAuthStore.getState().clearAccessToken();

  // Remove ALL persisted localStorage keys (settings + layout)
  localStorage.removeItem('concord-layout');
  localStorage.removeItem('concord-settings');
  localStorage.removeItem('concord:audio-advanced');
  localStorage.removeItem('concord:video-settings');
  localStorage.removeItem('concord:tts-settings');

  // Clear main process tokens (disk files + in-memory)
  globalThis.electron?.clearTokens?.();
}
