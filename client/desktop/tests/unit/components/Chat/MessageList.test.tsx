import { render, screen } from '../../../test-utils';
import MessageList from '@/renderer/components/Chat/MessageList';
import { mockMessage, mockMessage2 } from '../../../mocks/fixtures';

describe('MessageList', () => {
  it('renders messages', () => {
    render(
      <MessageList
        messages={[mockMessage, mockMessage2]}
        currentUserId="user-1"
      />
    );
    expect(screen.getByText('Hello, world!')).toBeInTheDocument();
    expect(screen.getByText('Hi there!')).toBeInTheDocument();
  });

  it('shows empty state when no messages', () => {
    render(
      <MessageList
        messages={[]}
        currentUserId="user-1"
        channelName="general"
      />
    );
    expect(screen.getByText(/welcome to #general/i)).toBeInTheDocument();
  });

  it('shows loading state', () => {
    render(
      <MessageList
        messages={[]}
        currentUserId="user-1"
        isLoading={true}
      />
    );
    expect(screen.getByText(/loading messages/i)).toBeInTheDocument();
  });

  it('shows date divider', () => {
    render(
      <MessageList
        messages={[mockMessage]}
        currentUserId="user-1"
      />
    );
    // Messages from 2025-01-01 should show a date divider
    const dateDividers = document.querySelectorAll('.date-divider');
    expect(dateDividers.length).toBeGreaterThan(0);
  });

  it('renders scroll to bottom button area', () => {
    render(
      <MessageList
        messages={[mockMessage]}
        currentUserId="user-1"
      />
    );
    // Container should exist
    expect(document.querySelector('.message-list-container')).toBeInTheDocument();
  });
});
