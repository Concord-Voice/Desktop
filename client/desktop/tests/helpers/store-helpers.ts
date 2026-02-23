import { useAuthStore } from '../../src/renderer/stores/authStore';
import { useUserStore } from '../../src/renderer/stores/userStore';
import { useServerStore } from '../../src/renderer/stores/serverStore';
import { useChannelStore } from '../../src/renderer/stores/channelStore';
import { useChatStore } from '../../src/renderer/stores/chatStore';
import { useMemberStore } from '../../src/renderer/stores/memberStore';
import { useUnreadStore } from '../../src/renderer/stores/unreadStore';
import { useInviteStore } from '../../src/renderer/stores/inviteStore';

/**
 * Resets all Zustand stores to their initial state.
 * Call this in beforeEach() or afterEach() to prevent test leakage.
 */
export function resetAllStores(): void {
  // Stores with explicit clear/reset methods
  useAuthStore.getState().clearTokens();
  useUserStore.getState().clearUser();
  useServerStore.getState().clearServers();
  useChannelStore.getState().clearChannels();
  useChatStore.getState().reset();
  useMemberStore.getState().clearMembers();
  useUnreadStore.getState().clearAll();
  useInviteStore.getState().clearInvites();

  // Clear persisted state from localStorage
  localStorage.clear();
}
