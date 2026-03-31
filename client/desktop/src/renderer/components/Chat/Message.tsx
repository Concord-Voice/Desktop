import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Lock } from 'lucide-react';
import { MessageWithStatus } from '../../types/chat';
import { useMemberStore } from '../../stores/memberStore';
import { usePermissionStore } from '../../stores/permissionStore';
import { resolveUserAccentColors } from '../../utils/schemeColors';
import MessageAvatar from './MessageAvatar';
import MessageActions from './MessageActions';
import ReactionBar from './ReactionBar';
import MessageContextMenu from './MessageContextMenu';
import LazyEmojiPicker from '../EmojiPicker/LazyEmojiPicker';
import { toggleReaction } from '../../services/reactionService';
import DeleteMessageModal from './DeleteMessageModal';
import {
  getEmojiOnlyCount,
  getEmojiSizeClass,
  renderContent,
  type MentionLookup,
} from './messageUtils';
import './Message.css';

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
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [reactionPicker, setReactionPicker] = useState<{ x: number; y: number } | null>(null);

  // Sync editContent when message content changes externally (not while editing)
  useEffect(() => {
    if (!isEditing) {
      setEditContent(message.content);
    }
  }, [message.content, isEditing]);

  const isOwnMessage = message.user_id === currentUserId;
  const canModify = isOwnMessage && isServerMessage(message);

  const members = useMemberStore((state) => state.members);
  const allServerRoles = usePermissionStore((state) => state.serverRoles);

  // Precompute O(1) lookup maps for mention token resolution (memoized to avoid
  // rebuilding on every render in long message lists)
  const mentionLookup: MentionLookup = useMemo(() => {
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
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

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

  return (
    <div
      className={`message ${isOwnMessage ? 'own-message' : ''} ${showAvatar ? '' : 'message-grouped'}`}
      onContextMenu={handleContextMenu}
    >
      <MessageAvatar
        message={message}
        currentUserId={currentUserId}
        showAvatar={showAvatar}
        senderColors={senderColors}
      />
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

        <MessageActions
          messageId={message.id}
          canModify={canModify}
          isEditing={isEditing}
          shiftHeld={shiftHeld}
          onEdit={onEdit ? () => setIsEditing(true) : undefined}
          onDelete={onDelete}
          onRequestDelete={() => setShowDeleteModal(true)}
        />

        {message.reactions && message.reactions.length > 0 && (
          <ReactionBar messageId={message.id} reactions={message.reactions} />
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
          onReaction={() => setReactionPicker(contextMenu)}
        />
      )}

      {reactionPicker && (
        <LazyEmojiPicker
          onSelect={(emoji: string) => {
            setReactionPicker(null);
            toggleReaction(message.id, emoji).catch(() => {});
          }}
          onClose={() => setReactionPicker(null)}
          mode="popover"
          position={reactionPicker}
        />
      )}
    </div>
  );
};

export default React.memo(Message);
