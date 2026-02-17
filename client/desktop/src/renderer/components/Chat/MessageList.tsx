import React, { useEffect, useRef, useState } from 'react';
import { MessageWithUser } from '../../types/chat';
import Message from './Message';
import './MessageList.css';

export interface MessageListProps {
  messages: MessageWithUser[];
  currentUserId: string;
  channelName?: string;
  isLoading?: boolean;
  hasMore?: boolean;
  onLoadMore?: () => void;
  onEditMessage?: (messageId: string, newContent: string) => void;
  onDeleteMessage?: (messageId: string) => void;
}

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
  const [autoScroll, setAutoScroll] = useState(true);
  const prevMessagesLength = useRef(messages.length);

  useEffect(() => {
    if (autoScroll && listRef.current) {
      scrollToBottom();
    }
  }, [messages, autoScroll]);

  useEffect(() => {
    // Auto-scroll when new messages arrive
    if (messages.length > prevMessagesLength.current) {
      const isAtBottom = checkIfAtBottom();
      if (isAtBottom) {
        scrollToBottom();
      }
    }
    prevMessagesLength.current = messages.length;
  }, [messages]);

  const scrollToBottom = () => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  };

  const checkIfAtBottom = () => {
    if (!listRef.current) return false;
    const { scrollTop, scrollHeight, clientHeight } = listRef.current;
    return scrollHeight - scrollTop - clientHeight < 100;
  };

  const handleScroll = () => {
    if (!listRef.current) return;

    const isAtBottom = checkIfAtBottom();
    setAutoScroll(isAtBottom);

    // Load more messages when scrolled to top
    if (hasMore && onLoadMore && listRef.current.scrollTop === 0 && !isLoading) {
      onLoadMore();
    }
  };

  const shouldShowAvatar = (index: number): boolean => {
    if (index === 0) return true;
    const currentMessage = messages[index];
    const previousMessage = messages[index - 1];

    // Show avatar if different user or time gap > 5 minutes
    if (currentMessage.user_id !== previousMessage.user_id) return true;

    const currentTime = new Date(currentMessage.created_at).getTime();
    const previousTime = new Date(previousMessage.created_at).getTime();
    const fiveMinutes = 5 * 60 * 1000;

    return currentTime - previousTime > fiveMinutes;
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
            />
          </React.Fragment>
        ))}
      </div>

      {!autoScroll && (
        <button
          className="scroll-to-bottom"
          onClick={scrollToBottom}
          aria-label="Scroll to bottom"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path
              d="M10 14l-6-6h12l-6 6z"
              fill="currentColor"
            />
          </svg>
          New messages
        </button>
      )}
    </div>
  );
};

export default MessageList;
