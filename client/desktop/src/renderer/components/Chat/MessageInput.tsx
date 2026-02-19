import React, { useState, useRef, useEffect } from 'react';
import './MessageInput.css';

export interface MessageInputProps {
  onSendMessage: (content: string, isEncrypted: boolean) => void;
  onTyping?: (isTyping: boolean) => void;
  placeholder?: string;
  maxLength?: number;
  disabled?: boolean;
  channelName?: string;
  encryptionEnabled?: boolean;
}

const MessageInput: React.FC<MessageInputProps> = ({
  onSendMessage,
  onTyping,
  placeholder = 'Type a message...',
  maxLength = 4000,
  disabled = false,
  channelName,
  encryptionEnabled = false,
}) => {
  const [content, setContent] = useState('');
  const [isEncrypted, setIsEncrypted] = useState(encryptionEnabled);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isTypingRef = useRef(false);

  useEffect(() => {
    adjustTextareaHeight();
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

  const adjustTextareaHeight = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
    }
  };

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

      onSendMessage(trimmedContent, isEncrypted);
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
      <div className="message-input-wrapper">
        <div className="message-input-box">
          <textarea
            ref={textareaRef}
            className="message-input-textarea"
            placeholder={
              channelName
                ? `Message #${channelName}`
                : placeholder
            }
            value={content}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            rows={1}
            aria-label="Message input"
          />

          <div className="message-input-actions">
            {encryptionEnabled && (
              <button
                className={`encryption-toggle ${isEncrypted ? 'active' : ''}`}
                onClick={() => setIsEncrypted(!isEncrypted)}
                title={isEncrypted ? 'End-to-end encryption enabled' : 'Click to enable encryption'}
                aria-label="Toggle encryption"
              >
                {isEncrypted ? '🔒' : '🔓'}
              </button>
            )}

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
                <path
                  d="M2 10l16-8-8 16-2-6-6-2z"
                  fill="currentColor"
                />
              </svg>
            </button>
          </div>
        </div>

        <div className="message-input-hints">
          <span className="hint">
            Press <kbd>Enter</kbd> to send, <kbd>Shift+Enter</kbd> for new line
          </span>
          {isEncrypted && (
            <span className="encryption-hint">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path
                  d="M6 1L3 3v3c0 2 1.5 3.5 3 4 1.5-.5 3-2 3-4V3L6 1z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  fill="none"
                />
              </svg>
              Messages are end-to-end encrypted
            </span>
          )}
        </div>
      </div>
    </div>
  );
};

export default MessageInput;
