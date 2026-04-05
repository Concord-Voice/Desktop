import React, { useState, useCallback } from 'react';
import { MessageWithStatus, type ChatContextType } from '../../types/chat';
import { useMemberStore, type ServerMember } from '../../stores/memberStore';
import { useFriendStore } from '../../stores/friendStore';
import { useSettingsStore } from '../../stores/settingsStore';
import MemberProfileCard, { type ProfileCardMember } from '../Members/MemberProfileCard';
import UserProfileModal from '../Members/UserProfileModal';

const EMPTY_MEMBERS: never[] = [];

export interface MessageAvatarProps {
  message: MessageWithStatus;
  currentUserId: string;
  showAvatar: boolean;
  senderColors?: { gradient: string } | null;
  chatContext?: ChatContextType;
}

function getInitials(username: string) {
  return username.charAt(0).toUpperCase();
}

function formatShortTime(timestamp: string) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

const MessageAvatar: React.FC<MessageAvatarProps> = ({
  message,
  currentUserId,
  showAvatar,
  senderColors,
  chatContext = 'channel',
}) => {
  const [selectedMember, setSelectedMember] = useState<{
    member: ProfileCardMember;
    serverMember: ServerMember | null;
    position: { x: number; y: number };
  } | null>(null);
  const [fullProfileMember, setFullProfileMember] = useState<ServerMember | null>(null);

  const isDM = chatContext === 'dm';
  const members = useMemberStore((state) => (isDM ? EMPTY_MEMBERS : state.members));
  const userStatuses = useMemberStore((state) => state.userStatuses);
  const lastSeenByUser = useMemberStore((state) => state.lastSeenByUser);

  const handleAvatarClick = useCallback(
    (e: React.MouseEvent) => {
      // Toggle: if card is already open for this user, close it
      if (selectedMember?.member.user_id === message.user_id) {
        setSelectedMember(null);
        return;
      }

      const position = { x: e.clientX, y: e.clientY };

      // In server contexts, try server member store first (has full data: role, joined_at, bio, etc.)
      if (chatContext !== 'dm') {
        const serverMember = members.find((m) => m.user_id === message.user_id);
        if (serverMember) {
          setSelectedMember({ member: serverMember, serverMember, position });
          return;
        }
      }

      // Fall back to friend store (has colorScheme, avatarUrl, displayName)
      const friend = useFriendStore.getState().friends.find((f) => f.userId === message.user_id);
      if (friend) {
        setSelectedMember({
          member: {
            user_id: friend.userId,
            username: friend.username,
            display_name: friend.displayName,
            avatar_url: friend.avatarUrl,
            color_scheme: friend.colorScheme,
          },
          serverMember: null,
          position,
        });
        return;
      }

      // Last resort: construct from message data.
      // If it's the current user's own avatar, pull color_scheme from settings.
      let colorScheme: string | undefined;
      if (message.user_id === currentUserId) {
        const { colorScheme: scheme, customColors } = useSettingsStore.getState().appearance;
        const themeMode =
          useSettingsStore.getState().appearance.theme === 'light' ? 'light' : 'dark';
        if (scheme === 'custom' && customColors) {
          colorScheme = JSON.stringify({
            scheme: 'custom',
            themeMode,
            accentPrimary: customColors.accentPrimary,
            accentSecondary: customColors.accentSecondary,
          });
        } else {
          colorScheme = JSON.stringify({ scheme, themeMode });
        }
      }

      setSelectedMember({
        member: {
          user_id: message.user_id,
          username: message.username,
          display_name: message.display_name,
          avatar_url: message.avatar_url,
          color_scheme: colorScheme,
        },
        serverMember: null,
        position,
      });
    },
    [
      members,
      message.user_id,
      message.username,
      message.display_name,
      message.avatar_url,
      currentUserId,
      selectedMember,
      chatContext,
    ]
  );

  return (
    <>
      {showAvatar ? (
        <button
          type="button"
          className="message-avatar"
          onClick={handleAvatarClick}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              const rect = e.currentTarget.getBoundingClientRect();
              handleAvatarClick({
                clientX: rect.left + rect.width / 2,
                clientY: rect.top + rect.height / 2,
                currentTarget: e.currentTarget,
              } as unknown as React.MouseEvent);
            }
          }}
          aria-label="View user profile"
        >
          {message.avatar_url ? (
            <img className="avatar-image" src={message.avatar_url} alt={message.username} />
          ) : (
            <div
              className="avatar-circle"
              style={senderColors ? { background: senderColors.gradient } : undefined}
            >
              {getInitials(message.display_name || message.username)}
            </div>
          )}
        </button>
      ) : (
        <div className="message-gutter">
          <span className="message-gutter-timestamp">{formatShortTime(message.created_at)}</span>
        </div>
      )}

      {selectedMember && (
        <MemberProfileCard
          member={selectedMember.member}
          status={userStatuses.get(selectedMember.member.user_id) || 'offline'}
          lastSeen={lastSeenByUser.get(selectedMember.member.user_id)}
          position={selectedMember.position}
          onClose={() => setSelectedMember(null)}
          onViewFullProfile={
            selectedMember.serverMember
              ? () => {
                  setFullProfileMember(selectedMember.serverMember);
                  setSelectedMember(null);
                }
              : undefined
          }
        />
      )}

      {fullProfileMember && (
        <UserProfileModal
          isOpen={!!fullProfileMember}
          onClose={() => setFullProfileMember(null)}
          member={fullProfileMember}
          presenceStatus={userStatuses.get(fullProfileMember.user_id) || 'offline'}
          lastSeen={lastSeenByUser.get(fullProfileMember.user_id)}
        />
      )}
    </>
  );
};

export default React.memo(MessageAvatar);
