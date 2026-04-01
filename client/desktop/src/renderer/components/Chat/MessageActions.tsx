import React, { useState, useRef, useEffect } from 'react';

export interface MessageActionsProps {
  messageId: string;
  canModify: boolean;
  isEditing: boolean;
  shiftHeld: boolean;
  onEdit?: () => void;
  onDelete?: (messageId: string) => void;
  onRequestDelete?: () => void;
  onReply?: () => void;
}

const MessageActions: React.FC<MessageActionsProps> = ({
  messageId,
  canModify,
  isEditing,
  shiftHeld,
  onEdit,
  onDelete,
  onRequestDelete,
  onReply,
}) => {
  const [showOptions, setShowOptions] = useState(false);
  const optionsRef = useRef<HTMLDivElement>(null);

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

  if (isEditing) return null;
  if (!canModify && !onReply) return null;

  const hasMenuItems = !!(onEdit || onDelete);

  return (
    <div className="message-options" ref={optionsRef}>
      {onReply && (
        <button className="message-quick-reply" onClick={onReply} aria-label="Reply" title="Reply">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M6 3L2 7l4 4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M2 7h8a4 4 0 014 4v1"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
      {shiftHeld && onDelete && (
        <button
          className="message-quick-delete"
          onClick={() => onDelete(messageId)}
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
      {hasMenuItems && (
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
      )}

      {hasMenuItems && showOptions && (
        <div className="message-options-menu">
          {onEdit && (
            <button
              className="message-option"
              onClick={() => {
                onEdit();
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
                  onDelete(messageId);
                } else if (onRequestDelete) {
                  onRequestDelete();
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
  );
};

export default React.memo(MessageActions);
