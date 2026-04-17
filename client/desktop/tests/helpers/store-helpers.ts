import { useAuthStore } from '../../src/renderer/stores/authStore';
import { useUserStore } from '../../src/renderer/stores/userStore';
import { useServerStore } from '../../src/renderer/stores/serverStore';
import { useChannelStore } from '../../src/renderer/stores/channelStore';
import { useChatStore } from '../../src/renderer/stores/chatStore';
import { useMemberStore } from '../../src/renderer/stores/memberStore';
import { useUnreadStore } from '../../src/renderer/stores/unreadStore';
import { useInviteStore } from '../../src/renderer/stores/inviteStore';
import { useDMStore } from '../../src/renderer/stores/dmStore';
import { useFriendStore } from '../../src/renderer/stores/friendStore';
import { useConnectionStore } from '../../src/renderer/stores/connectionStore';
import { usePrivacyStore } from '../../src/renderer/stores/privacyStore';
import { useMFAChallengeStore } from '../../src/renderer/stores/mfaChallengeStore';
import { useSavedGifsStore } from '../../src/renderer/stores/savedGifsStore';
import { useChannelScrollStore } from '../../src/renderer/stores/channelScrollStore';
import { useTelemetryConsentStore } from '../../src/renderer/stores/telemetryConsentStore';
import { useVoiceStore } from '../../src/renderer/stores/voiceStore';

/**
 * Resets all Zustand stores to their initial state.
 * Call this in beforeEach() or afterEach() to prevent test leakage.
 */
export function resetAllStores(): void {
  // Stores with explicit clear/reset methods
  useAuthStore.getState().clearAccessToken();
  useAuthStore.getState().setRememberMe(true); // Reset to default
  useUserStore.getState().clearUser();
  useServerStore.getState().clearServers();
  useChannelStore.getState().clearChannels();
  useChatStore.getState().reset();
  useMemberStore.getState().clearMembers();
  useUnreadStore.getState().clearAll();
  useInviteStore.getState().clearInvites();
  useDMStore.getState().clearDMs();
  useFriendStore.getState().clearFriends();
  useConnectionStore.getState().reset();
  usePrivacyStore.getState().clearPrivacy();
  useMFAChallengeStore.getState().clearChallenge();
  useSavedGifsStore.setState({ gifs: [] });
  useChannelScrollStore.setState({ positions: {} });
  useVoiceStore.getState().reset();
  useVoiceStore.setState({ channelVoiceMembers: {}, serverVoiceCounts: {} });
  useTelemetryConsentStore.setState({
    telemetryOptIn: false,
    firstPromptCompleted: false,
    policyAcknowledgedVersion: 0,
    isLoaded: false,
  });

  // Clear persisted state from localStorage
  localStorage.clear();
}
