import React, { useEffect, useRef, useState, useCallback } from 'react';
import { MessageWithStatus } from '../../types/chat';
import Message from './Message';
import './MessageList.css';

export interface MessageListProps {
  messages: MessageWithStatus[];
  currentUserId: string;
  channelName?: string;
  isLoading?: boolean;
  hasMore?: boolean;
  onLoadMore?: () => void;
  onEditMessage?: (messageId: string, newContent: string) => void;
  onDeleteMessage?: (messageId: string) => void;
}

const NEAR_BOTTOM_THRESHOLD = 150;
const SHOW_BUTTON_THRESHOLD = 300;

const MessageList: React.FC<MessageListProps> = ({
  messages,
  currentUserId,
  channelName,
  isLoading = false,
  hasMore = false,
  onLoadMore,
  onEditMessage,
  onDeleteMessage,
}) => {
  const listRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [shiftHeld, setShiftHeld] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Shift') setShiftHeld(true); };
    const onKeyUp = (e: KeyboardEvent) => { if (e.key === 'Shift') setShiftHeld(false); };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  // Auto-scroll when messages change (new message arrives) if user is near bottom
  useEffect(() => {
    if (isNearBottomRef.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages]);

  const scrollToBottom = useCallback((smooth = true) => {
    if (listRef.current) {
      listRef.current.scrollTo({
        top: listRef.current.scrollHeight,
        behavior: smooth ? 'smooth' : 'auto',
      });
    }
  }, []);

  const handleScroll = useCallback(() => {
    if (!listRef.current) return;

    const { scrollTop, scrollHeight, clientHeight } = listRef.current;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

    isNearBottomRef.current = distanceFromBottom < NEAR_BOTTOM_THRESHOLD;

    const shouldShow = distanceFromBottom > SHOW_BUTTON_THRESHOLD;
    if (shouldShow !== showScrollButton) {
      setShowScrollButton(shouldShow);
    }

    // Load more messages when scrolled near top
    if (hasMore && onLoadMore && scrollTop < 50 && !isLoading) {
      onLoadMore();
    }
  }, [hasMore, onLoadMore, isLoading, showScrollButton]);

  const shouldShowAvatar = (index: number): boolean => {
    if (index === 0) return true;
    const currentMessage = messages[index];
    const previousMessage = messages[index - 1];

    // Show avatar if different user or time gap > 5 minutes
    if (currentMessage.user_id !== previousMessage.user_id) return true;

    const currentTime = new Date(currentMessage.created_at).getTime();
    const previousTime = new Date(previousMessage.created_at).getTime();
    const twoMinutes = 2 * 60 * 1000;

    return currentTime - previousTime > twoMinutes;
  };

  const formatDateDivider = (date: Date): string => {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (date.toDateString() === today.toDateString()) {
      return 'Today';
    } else if (date.toDateString() === yesterday.toDateString()) {
      return 'Yesterday';
    } else {
      return date.toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });
    }
  };

  const shouldShowDateDivider = (index: number): string | null => {
    if (index === 0) return formatDateDivider(new Date(messages[0].created_at));

    const currentDate = new Date(messages[index].created_at).toDateString();
    const previousDate = new Date(messages[index - 1].created_at).toDateString();

    if (currentDate !== previousDate) {
      return formatDateDivider(new Date(messages[index].created_at));
    }

    return null;
  };

  if (isLoading && messages.length === 0) {
    return (
      <div className="message-list-empty">
        <div className="loading-spinner">
          <div className="spinner"></div>
        </div>
        <p>Loading messages...</p>
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="message-list-empty">
        <div className="empty-icon">💬</div>
        <h3>Welcome to #{channelName || 'this channel'}!</h3>
        <p>This is the beginning of your conversation.</p>
        <p className="empty-hint">Send a message to get started.</p>
      </div>
    );
  }

  return (
    <div className="message-list-container">
      <div
        className="message-list"
        ref={listRef}
        onScroll={handleScroll}
      >
        {isLoading && hasMore && (
          <div className="loading-more">
            <div className="loading-spinner small">
              <div className="spinner"></div>
            </div>
            <span>Loading more messages...</span>
          </div>
        )}

        {messages.map((message, index) => (
          <React.Fragment key={message.id}>
            {shouldShowDateDivider(index) && (
              <div className="date-divider">
                <span className="date-divider-line"></span>
                <span className="date-divider-text">
                  {shouldShowDateDivider(index)}
                </span>
                <span className="date-divider-line"></span>
              </div>
            )}
            <Message
              message={message}
              currentUserId={currentUserId}
              onEdit={onEditMessage}
              onDelete={onDeleteMessage}
              showAvatar={shouldShowAvatar(index)}
              shiftHeld={shiftHeld}
            />
          </React.Fragment>
        ))}
        <div ref={bottomRef} />
      </div>

      {showScrollButton && (
        <button
          className="scroll-to-bottom"
          onClick={() => scrollToBottom(true)}
          aria-label="Return to latest"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path
              d="M10 14l-6-6h12l-6 6z"
              fill="currentColor"
            />
          </svg>
          Return to Latest
        </button>
      )}
    </div>
  );
};

export default MessageList;
