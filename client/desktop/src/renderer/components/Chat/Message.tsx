import React, { useState, useRef, useEffect } from 'react';
import { MessageWithUser } from '../../types/chat';
import './Message.css';

export interface MessageProps {
  message: MessageWithUser;
  currentUserId: string;
  onEdit?: (messageId: string, newContent: string) => void;
  onDelete?: (messageId: string) => void;
  showAvatar?: boolean;
}

const Message: React.FC<MessageProps> = ({
  message,
  currentUserId,
  onEdit,
  onDelete,
  showAvatar = true,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(message.content);
  const [showOptions, setShowOptions] = useState(false);
  const optionsRef = useRef<HTMLDivElement>(null);
  const isOwnMessage = message.user_id === currentUserId;

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (optionsRef.current && !optionsRef.current.contains(event.target as Node)) {
        setShowOptions(false);
      }
    };

    if (showOptions) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
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
        hour12: true
      });
    } else {
      return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      });
    }
  };

  return (
    <div className={`message ${isOwnMessage ? 'own-message' : ''}`}>
      {showAvatar && (
        <div className="message-avatar">
          <div className="avatar-circle">
            {getInitials(message.username)}
          </div>
        </div>
      )}
      <div className="message-content-wrapper">
        <div className="message-header">
          <span className="message-username">{message.username}</span>
          <span className="message-timestamp">
            {formatTimestamp(message.created_at)}
          </span>
          {message.edited_at && (
            <span className="message-edited">(edited)</span>
          )}
        </div>

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
              <button
                className="btn-edit-cancel"
                onClick={handleEditCancel}
              >
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
          <div className="message-text">
            {message.is_encrypted && (
              <span className="encrypted-indicator" title="End-to-end encrypted">
                🔒
              </span>
            )}
            {message.content}
          </div>
        )}

        {isOwnMessage && !isEditing && (
          <div className="message-options" ref={optionsRef}>
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
                      <path d="M10.5 1.5l2 2L4 12H2v-2L10.5 1.5z" stroke="currentColor" strokeWidth="1.5" />
                    </svg>
                    Edit
                  </button>
                )}
                {onDelete && (
                  <button
                    className="message-option message-option-danger"
                    onClick={() => {
                      if (window.confirm('Delete this message?')) {
                        onDelete(message.id);
                      }
                      setShowOptions(false);
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <path d="M2 4h10M5 4V3h4v1M3 4v8a1 1 0 001 1h6a1 1 0 001-1V4" stroke="currentColor" strokeWidth="1.5" />
                    </svg>
                    Delete
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default Message;
