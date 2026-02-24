import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Smile, ImagePlay, Paperclip, Lock, Unlock } from 'lucide-react';
import MessageInputContextMenu from './MessageInputContextMenu';
import EmojiPicker from '../EmojiPicker/EmojiPicker';
import UserPanel from '../User/UserPanel';
import { useLayoutStore } from '../../stores/layoutStore';
import './MessageInput.css';

export interface MessageInputProps {
  onSendMessage: (content: string) => void;
  onTyping?: (isTyping: boolean) => void;
  placeholder?: string;
  maxLength?: number;
  disabled?: boolean;
  channelName?: string;
  isChannelEncrypted?: boolean;
}

const MessageInput: React.FC<MessageInputProps> = ({
  onSendMessage,
  onTyping,
  placeholder = 'Type a message...',
  maxLength = 4000,
  disabled = false,
  channelName,
  isChannelEncrypted = false,
}) => {
  const channelPanelPinned = useLayoutStore((s) => s.channelPanelPinned);
  const [content, setContent] = useState('');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [emojiPickerPos, setEmojiPickerPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const emojiBtnRef = useRef<HTMLButtonElement>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isTypingRef = useRef(false);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const handlePasteFromMenu = useCallback(
    (text: string) => {
      const textarea = textareaRef.current;
      if (!textarea) {
        // Fallback: just append
        setContent((prev) => {
          const combined = prev + text;
          return combined.length <= maxLength ? combined : combined.slice(0, maxLength);
        });
        return;
      }

      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const before = content.slice(0, start);
      const after = content.slice(end);
      const combined = before + text + after;
      const newContent = combined.length <= maxLength ? combined : combined.slice(0, maxLength);

      setContent(newContent);

      // Restore cursor position after the pasted text
      requestAnimationFrame(() => {
        const newCursor = Math.min(start + text.length, newContent.length);
        textarea.selectionStart = newCursor;
        textarea.selectionEnd = newCursor;
        textarea.focus();
      });
    },
    [content, maxLength]
  );

  const handleEmojiSelect = useCallback(
    (emoji: string) => {
      const textarea = textareaRef.current;
      if (!textarea) {
        setContent((prev) => {
          const combined = prev + emoji;
          return combined.length <= maxLength ? combined : combined.slice(0, maxLength);
        });
        setShowEmojiPicker(false);
        return;
      }

      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const before = content.slice(0, start);
      const after = content.slice(end);
      const combined = before + emoji + after;
      const newContent = combined.length <= maxLength ? combined : combined.slice(0, maxLength);

      setContent(newContent);
      setShowEmojiPicker(false);

      requestAnimationFrame(() => {
        const newCursor = Math.min(start + emoji.length, newContent.length);
        textarea.selectionStart = newCursor;
        textarea.selectionEnd = newCursor;
        textarea.focus();
      });
    },
    [content, maxLength]
  );

  const getPickerPosition = useCallback(() => {
    if (!emojiBtnRef.current) return { x: 0, y: 0 };
    const rect = emojiBtnRef.current.getBoundingClientRect();
    const pickerWidth = 352;
    const pickerHeight = 420;

    // Position above the button, right-aligned to the button
    let x = rect.right - pickerWidth;
    let y = rect.top - pickerHeight - 8;

    // Viewport clamping
    x = Math.max(8, Math.min(x, window.innerWidth - pickerWidth - 8));
    y = Math.max(8, y);

    return { x, y };
  }, []);

  const toggleEmojiPicker = useCallback(() => {
    if (showEmojiPicker) {
      setShowEmojiPicker(false);
    } else {
      setEmojiPickerPos(getPickerPosition());
      setShowEmojiPicker(true);
    }
  }, [showEmojiPicker, getPickerPosition]);

  const adjustTextareaHeight = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    // When empty, collapse to a single row
    if (!content) {
      textarea.style.height = 'auto';
      return;
    }

    // Cap at 25% of the closest .chat-view ancestor (or 200px fallback)
    const chatView = textarea.closest('.chat-view');
    const maxH = chatView ? chatView.clientHeight * 0.25 : 200;

    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, maxH) + 'px';
  };

  useEffect(() => {
    adjustTextareaHeight();
  }, [content]);

  // Re-adjust on window resize so the textarea doesn't retain a stale height
  useEffect(() => {
    const onResize = () => adjustTextareaHeight();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [content]);

  // Cleanup typing state on unmount
  useEffect(() => {
    return () => {
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
      if (onTyping && isTypingRef.current) {
        onTyping(false);
      }
    };
  }, [onTyping]);

  const handleSend = () => {
    const trimmedContent = content.trim();
    if (trimmedContent && trimmedContent.length <= maxLength) {
      // Stop typing indicator before sending
      if (onTyping && isTypingRef.current) {
        isTypingRef.current = false;
        onTyping(false);
      }
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
      }

      onSendMessage(trimmedContent);
      setContent('');
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (e.target.value.length <= maxLength) {
      setContent(e.target.value);
    }

    // Typing indicator logic
    if (onTyping) {
      if (!isTypingRef.current && e.target.value.length > 0) {
        isTypingRef.current = true;
        onTyping(true);
      }

      // Clear previous timeout
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }

      // If input is cleared, stop typing immediately
      if (e.target.value.length === 0) {
        if (isTypingRef.current) {
          isTypingRef.current = false;
          onTyping(false);
        }
      } else {
        // Set timeout to stop typing after 3 seconds of no input
        typingTimeoutRef.current = setTimeout(() => {
          if (isTypingRef.current) {
            isTypingRef.current = false;
            onTyping(false);
          }
        }, 3000);
      }
    }
  };

  const charactersRemaining = maxLength - content.length;
  const showCounter = content.length > maxLength * 0.8; // Show when 80% full

  return (
    <div className="message-input-container">
      {/* Always-visible E2EE status indicator */}
      <div className={`e2ee-status-bar ${isChannelEncrypted ? 'encrypted' : 'unencrypted'}`}>
        {isChannelEncrypted ? (
          <>
            <Lock size={14} />
            <span>Messages are Encrypted End-to-End</span>
          </>
        ) : (
          <>
            <Unlock size={14} />
            <span>Channel is NOT using End-to-End Encryption</span>
          </>
        )}
      </div>

      <div className="message-input-wrapper">
        <div className="message-input-box" onContextMenu={handleContextMenu}>
          {!channelPanelPinned && (
            <div className="message-input-user-panel">
              <UserPanel compact />
            </div>
          )}
          <textarea
            ref={textareaRef}
            className="message-input-textarea"
            placeholder={channelName ? `Message #${channelName}` : placeholder}
            value={content}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            rows={1}
            aria-label="Message input"
          />

          <div className="message-input-actions">
            {showCounter && (
              <span className={`char-counter ${charactersRemaining < 100 ? 'warning' : ''}`}>
                {charactersRemaining}
              </span>
            )}

            <button
              className="send-button"
              onClick={handleSend}
              disabled={disabled || !content.trim()}
              aria-label="Send message"
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path d="M2 10l16-8-8 16-2-6-6-2z" fill="currentColor" />
              </svg>
            </button>
          </div>
        </div>

        <div className="message-input-hints">
          <span className="hint">
            Press <kbd>Enter</kbd> to send, <kbd>Shift+Enter</kbd> for new line
          </span>
          <div className="message-input-extras">
            <button
              ref={emojiBtnRef}
              className={`media-btn ${showEmojiPicker ? 'active' : ''}`}
              title="Emoji"
              onClick={toggleEmojiPicker}
            >
              <Smile size={18} />
            </button>
            <button className="media-btn" title="GIF" disabled>
              <ImagePlay size={18} />
            </button>
            <button className="media-btn" title="Attach file" disabled>
              <Paperclip size={18} />
            </button>
          </div>
        </div>
      </div>

      {showEmojiPicker && (
        <EmojiPicker
          mode="popover"
          position={emojiPickerPos}
          onSelect={handleEmojiSelect}
          onClose={() => setShowEmojiPicker(false)}
        />
      )}

      {contextMenu && (
        <MessageInputContextMenu
          position={contextMenu}
          onClose={() => setContextMenu(null)}
          onPaste={handlePasteFromMenu}
          onOpenEmojiPicker={toggleEmojiPicker}
        />
      )}
    </div>
  );
};

export default MessageInput;
