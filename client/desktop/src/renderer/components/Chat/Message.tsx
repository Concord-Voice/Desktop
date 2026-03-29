import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Lock } from 'lucide-react';
import { MessageWithStatus } from '../../types/chat';
import { useMemberStore, type ServerMember } from '../../stores/memberStore';
import { usePermissionStore } from '../../stores/permissionStore';
import { useFriendStore } from '../../stores/friendStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { resolveUserAccentColors } from '../../utils/schemeColors';
import MemberProfileCard, { type ProfileCardMember } from '../Members/MemberProfileCard';
import UserProfileModal from '../Members/UserProfileModal';
import DeleteMessageModal from './DeleteMessageModal';
import MessageContextMenu from './MessageContextMenu';
import './Message.css';

/**
 * Detect emoji-only messages and return the count.
 * Returns 0 if the message contains any non-emoji text.
 * Uses Unicode emoji properties to match all standard emoji sequences.
 */
function getEmojiOnlyCount(text: string): number {
  if (!text || text.length === 0) return 0;
  const stripped = text.replace(EMOJI_REGEX, '').replace(/[\s\u{FE0F}\u{200D}]/gu, '');
  if (stripped.length > 0) return 0;
  const matches = text.match(EMOJI_REGEX);
  return matches ? matches.length : 0;
}

/**
 * Returns a CSS class for emoji-only messages based on emoji count.
 * 1 emoji = largest (48px), linearly scales down to base (24px) at 5+.
 */
function getEmojiSizeClass(count: number): string {
  if (count <= 0) return '';
  if (count === 1) return 'emoji-jumbo-1';
  if (count === 2) return 'emoji-jumbo-2';
  if (count === 3) return 'emoji-jumbo-3';
  if (count === 4) return 'emoji-jumbo-4';
  if (count === 5) return 'emoji-jumbo-5';
  return '';
}

/**
 * Matches complete emoji sequences including:
 * - Regional indicator pairs (country flags: 🇺🇸)
 * - Tag sequences (subdivision flags: 🏴󠁧󠁢󠁥󠁮󠁧󠁿)
 * - ZWJ sequences with text-default emoji (🏴‍☠️, ❤️‍🔥, 👁️‍🗨️)
 * - Skin tone modifiers (👋🏽)
 * - Keycap sequences (1️⃣)
 *
 * Key fix: after ZWJ, match \p{Emoji}\uFE0F (text-default + variation selector)
 * in addition to \p{Emoji_Presentation}. Characters like ☠ (U+2620) are \p{Emoji}
 * but NOT \p{Emoji_Presentation} — without this, ZWJ sequences containing them
 * (e.g. 🏴‍☠️) get split into their component emoji.
 */
const EMOJI_REGEX =
  /(?:\p{Regional_Indicator}{2}|\p{Emoji_Presentation}[\u{E0020}-\u{E007E}]+\u{E007F}|(?:\p{Emoji_Presentation}|\p{Emoji}\uFE0F)(?:\u{200D}(?:\p{Emoji_Presentation}|\p{Emoji}\uFE0F)|\p{Emoji_Modifier}|\uFE0F?\u{20E3})*)/gu;

/**
 * Renders message text with emoji characters wrapped in <span class="emoji">
 * so they can be styled at a larger font size than surrounding text.
 */
// Regex for mention patterns — supports both:
// - Token format: <@userId>, <@&roleId> (inserted by autocomplete, handles spaces in names)
// - Plain format: @username, @all, @here (typed manually or legacy)
const MENTION_REGEX = /<@&?[\w-]+>|@[\w.-]+/g;

// Token pattern matchers for resolving UUIDs to display names
const USER_TOKEN_RE = /^<@([\w-]+)>$/;
const ROLE_TOKEN_RE = /^<@&([\w-]+)>$/;

/** Precomputed lookup maps for O(1) mention token resolution. */
interface MentionLookup {
  users: Map<string, string>; // userId → display name
  roles: Map<string, string>; // roleId → role name
}

/** Resolve a mention token to a display string using precomputed lookup maps. */
function resolveMentionDisplay(token: string, lookup: MentionLookup): string {
  // User token: <@userId> → @displayName
  const userMatch = USER_TOKEN_RE.exec(token);
  if (userMatch) {
    const display = lookup.users.get(userMatch[1]);
    return display ? `@${display}` : token;
  }
  // Role token: <@&roleId> → @roleName
  const roleMatch = ROLE_TOKEN_RE.exec(token);
  if (roleMatch) {
    const name = lookup.roles.get(roleMatch[1]);
    return name ? `@${name}` : token;
  }
  // Plain format (@username, @all, @here) — return as-is
  return token;
}

function renderContent(text: string, lookup: MentionLookup): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;

  // Combine emoji and mention patterns into a single pass
  // Process mentions first, then emoji within non-mention segments
  const mentionMatches: Array<{ index: number; length: number; text: string }> = [];
  MENTION_REGEX.lastIndex = 0;
  let mentionMatch: RegExpExecArray | null;
  while ((mentionMatch = MENTION_REGEX.exec(text)) !== null) {
    mentionMatches.push({
      index: mentionMatch.index,
      length: mentionMatch[0].length,
      text: mentionMatch[0],
    });
  }

  if (mentionMatches.length === 0) {
    // No mentions — render with emoji only (existing behavior)
    return renderEmoji(text);
  }

  for (const m of mentionMatches) {
    // Render text before this mention (with emoji)
    if (m.index > lastIndex) {
      parts.push(...renderEmoji(text.slice(lastIndex, m.index)));
    }
    // Resolve token to display name and render as highlighted span
    const display = resolveMentionDisplay(m.text, lookup);
    parts.push(
      <span key={`mention-${m.index}`} className="mention-highlight">
        {display}
      </span>
    );
    lastIndex = m.index + m.length;
  }

  // Render remaining text after last mention
  if (lastIndex < text.length) {
    parts.push(...renderEmoji(text.slice(lastIndex)));
  }

  return parts;
}

/** Render emoji spans within a text segment (no mention handling). */
function renderEmoji(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  EMOJI_REGEX.lastIndex = 0;
  while ((match = EMOJI_REGEX.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    parts.push(
      <span key={match.index} className="emoji">
        {match[0]}
      </span>
    );
    lastIndex = EMOJI_REGEX.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts;
}

export interface MessageProps {
  message: MessageWithStatus;
  currentUserId: string;
  onEdit?: (messageId: string, newContent: string) => void;
  onDelete?: (messageId: string) => void;
  showAvatar?: boolean;
  shiftHeld?: boolean;
}

// Messages with pending/sent status still have temporary client-generated IDs.
// Only allow edit/delete once the message has a server-assigned UUID.
const isServerMessage = (msg: MessageWithStatus) => !msg.status || msg.status === 'delivered';

const Message: React.FC<MessageProps> = ({
  message,
  currentUserId,
  onEdit,
  onDelete,
  showAvatar = true,
  shiftHeld = false,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(message.content);
  const [showOptions, setShowOptions] = useState(false);

  // Sync editContent when message content changes externally (not while editing)
  useEffect(() => {
    if (!isEditing) {
      setEditContent(message.content);
    }
  }, [message.content, isEditing]);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [selectedMember, setSelectedMember] = useState<{
    member: ProfileCardMember;
    serverMember: ServerMember | null;
    position: { x: number; y: number };
  } | null>(null);
  const [fullProfileMember, setFullProfileMember] = useState<ServerMember | null>(null);
  const optionsRef = useRef<HTMLDivElement>(null);
  const isOwnMessage = message.user_id === currentUserId;
  const canModify = isOwnMessage && isServerMessage(message);

  const members = useMemberStore((state) => state.members);
  const allServerRoles = usePermissionStore((state) => state.serverRoles);
  const userStatuses = useMemberStore((state) => state.userStatuses);

  // Precompute O(1) lookup maps for mention token resolution (memoized to avoid
  // rebuilding on every render in long message lists)
  const mentionLookup = useMemo(() => {
    const users = new Map<string, string>();
    for (const m of members) {
      users.set(m.user_id, m.display_name || m.username);
    }
    const roles = new Map<string, string>();
    for (const serverRoles of Object.values(allServerRoles)) {
      for (const r of serverRoles) {
        roles.set(r.id, r.name);
      }
    }
    return { users, roles };
  }, [members, allServerRoles]);
  const lastSeenByUser = useMemberStore((state) => state.lastSeenByUser);
  const senderMember = members.find((m) => m.user_id === message.user_id);
  const senderColors = resolveUserAccentColors(senderMember?.color_scheme);

  // Highest display_separately role for the sender (emoji + color only from those roles)
  const topDisplayRole = senderMember?.roles?.length
    ? ([...senderMember.roles]
        .filter((r) => r.display_separately)
        .sort((a, b) => b.position - a.position)[0] ?? null)
    : null;
  const senderRoleEmoji = topDisplayRole?.role_emoji ?? null;
  const senderRoleColor = topDisplayRole?.role_color ?? null;

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const handleAvatarClick = useCallback(
    (e: React.MouseEvent) => {
      // Toggle: if card is already open for this user, close it
      if (selectedMember?.member.user_id === message.user_id) {
        setSelectedMember(null);
        return;
      }

      const position = { x: e.clientX, y: e.clientY };

      // Try server member store first (has full data: role, joined_at, bio, etc.)
      const serverMember = members.find((m) => m.user_id === message.user_id);
      if (serverMember) {
        setSelectedMember({ member: serverMember, serverMember, position });
        return;
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
    ]
  );

  useEffect(() => {
    if (!showOptions) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (optionsRef.current && !optionsRef.current.contains(event.target as Node)) {
        setShowOptions(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showOptions]);

  const handleEditSubmit = () => {
    if (editContent.trim() && editContent !== message.content && onEdit) {
      onEdit(message.id, editContent.trim());
      setIsEditing(false);
    }
  };

  const handleEditCancel = () => {
    setEditContent(message.content);
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleEditSubmit();
    } else if (e.key === 'Escape') {
      handleEditCancel();
    }
  };

  const getInitials = (username: string) => {
    return username.charAt(0).toUpperCase();
  };

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();

    if (isToday) {
      return date.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
    } else {
      return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
    }
  };

  const formatShortTime = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  };

  return (
    <div
      className={`message ${isOwnMessage ? 'own-message' : ''} ${showAvatar ? '' : 'message-grouped'}`}
      onContextMenu={handleContextMenu}
    >
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
      <div className="message-content-wrapper">
        {showAvatar && (
          <div className="message-header">
            {senderRoleEmoji && <span className="message-role-emoji">{senderRoleEmoji}</span>}
            <span
              className="message-username"
              style={senderRoleColor ? { color: senderRoleColor } : undefined}
            >
              {message.display_name || message.username}
            </span>
            <span className="message-timestamp">{formatTimestamp(message.created_at)}</span>
            {message.edited_at && <span className="message-edited">(edited)</span>}
          </div>
        )}

        {isEditing ? (
          <div className="message-edit-box">
            <textarea
              className="message-edit-input"
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              onKeyDown={handleKeyDown}
              autoFocus
              rows={3}
            />
            <div className="message-edit-actions">
              <button className="btn-edit-cancel" onClick={handleEditCancel}>
                Cancel
              </button>
              <button
                className="btn-edit-save"
                onClick={handleEditSubmit}
                disabled={!editContent.trim() || editContent === message.content}
              >
                Save
              </button>
            </div>
          </div>
        ) : (
          (() => {
            const emojiCount =
              !message.pendingKeys && !message.decryptFailed
                ? getEmojiOnlyCount(message.content)
                : 0;
            const emojiClass = getEmojiSizeClass(emojiCount);
            return (
              <div className={'message-text' + (emojiClass ? ' ' + emojiClass : '')}>
                {message.is_encrypted && (
                  <span className="encrypted-indicator" title="End-to-end encrypted">
                    <Lock size={12} />
                  </span>
                )}
                {(() => {
                  if (message.pendingKeys) {
                    return (
                      <span className="decrypt-failed pending-keys">
                        <Lock size={14} />
                        Waiting for encryption keys...
                      </span>
                    );
                  }
                  if (message.decryptFailed) {
                    return (
                      <span className="decrypt-failed">
                        <Lock size={14} />
                        Unable to decrypt this message
                      </span>
                    );
                  }
                  return renderContent(message.content, mentionLookup);
                })()}
                {!showAvatar && message.edited_at && (
                  <span className="message-edited-inline">(edited)</span>
                )}
              </div>
            );
          })()
        )}

        {canModify && !isEditing && (
          <div className="message-options" ref={optionsRef}>
            {shiftHeld && onDelete && (
              <button
                className="message-quick-delete"
                onClick={() => onDelete(message.id)}
                aria-label="Delete message"
                title="Delete message"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M2.5 4.5h11M6 4.5V3.5h4v1M4 4.5v8.5a1 1 0 001 1h6a1 1 0 001-1V4.5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            )}
            <button
              className="message-options-trigger"
              onClick={() => setShowOptions(!showOptions)}
              aria-label="Message options"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="3" r="1.5" fill="currentColor" />
                <circle cx="8" cy="8" r="1.5" fill="currentColor" />
                <circle cx="8" cy="13" r="1.5" fill="currentColor" />
              </svg>
            </button>

            {showOptions && (
              <div className="message-options-menu">
                {onEdit && (
                  <button
                    className="message-option"
                    onClick={() => {
                      setIsEditing(true);
                      setShowOptions(false);
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <path
                        d="M10.5 1.5l2 2L4 12H2v-2L10.5 1.5z"
                        stroke="currentColor"
                        strokeWidth="1.5"
                      />
                    </svg>
                    Edit
                  </button>
                )}
                {onDelete && (
                  <button
                    className="message-option message-option-danger"
                    onClick={(e) => {
                      setShowOptions(false);
                      if (e.shiftKey) {
                        onDelete(message.id);
                      } else {
                        setShowDeleteModal(true);
                      }
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <path
                        d="M2 4h10M5 4V3h4v1M3 4v8a1 1 0 001 1h6a1 1 0 001-1V4"
                        stroke="currentColor"
                        strokeWidth="1.5"
                      />
                    </svg>
                    Delete
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {onDelete && (
        <DeleteMessageModal
          isOpen={showDeleteModal}
          onClose={() => setShowDeleteModal(false)}
          onConfirm={() => {
            onDelete(message.id);
            setShowDeleteModal(false);
          }}
        />
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

      {contextMenu && (
        <MessageContextMenu
          message={message}
          position={contextMenu}
          isOwnMessage={isOwnMessage}
          canModify={canModify}
          onClose={() => setContextMenu(null)}
          onEdit={() => setIsEditing(true)}
          onDelete={() => {
            if (onDelete) {
              setShowDeleteModal(true);
            }
          }}
        />
      )}
    </div>
  );
};

export default React.memo(Message);
