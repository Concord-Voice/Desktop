import { render, screen } from '../../../test-utils';
import MessageList from '@/renderer/components/Chat/MessageList';
import { mockMessage, mockMessage2 } from '../../../mocks/fixtures';
import { vi } from 'vitest';

// Mock the Message component to simplify testing
vi.mock('@/renderer/components/Chat/Message', () => ({
  default: ({ message }: { message: any }) => <div data-testid="message">{message.content}</div>,
}));

describe('MessageList', () => {
  it('renders messages', () => {
    render(<MessageList messages={[mockMessage, mockMessage2]} currentUserId="user-1" />);
    expect(screen.getByText('Hello, world!')).toBeInTheDocument();
    expect(screen.getByText('Hi there!')).toBeInTheDocument();
  });

  it('shows empty state when no messages', () => {
    render(<MessageList messages={[]} currentUserId="user-1" channelName="general" />);
    expect(screen.getByText(/welcome to #general/i)).toBeInTheDocument();
  });

  it('shows loading state', () => {
    render(<MessageList messages={[]} currentUserId="user-1" isLoading={true} />);
    expect(screen.getByText(/loading messages/i)).toBeInTheDocument();
  });

  it('shows date divider for first message', () => {
    render(<MessageList messages={[mockMessage]} currentUserId="user-1" />);
    // Messages from 2025-01-01 should show a date divider
    const dateDividers = document.querySelectorAll('.date-divider');
    expect(dateDividers.length).toBeGreaterThan(0);
  });

  it('shows date dividers between messages on different days', () => {
    const messageDay1 = {
      ...mockMessage,
      id: 'msg-day1',
      created_at: '2025-01-01T12:00:00Z',
      updated_at: '2025-01-01T12:00:00Z',
    };
    const messageDay2 = {
      ...mockMessage2,
      id: 'msg-day2',
      created_at: '2025-01-03T14:00:00Z',
      updated_at: '2025-01-03T14:00:00Z',
    };

    render(<MessageList messages={[messageDay1, messageDay2]} currentUserId="user-1" />);

    // Should show two date dividers (one for each distinct day)
    const dateDividers = document.querySelectorAll('.date-divider');
    expect(dateDividers.length).toBe(2);
  });

  it('renders container class for scroll area', () => {
    render(<MessageList messages={[mockMessage]} currentUserId="user-1" />);
    expect(document.querySelector('.message-list-container')).toBeInTheDocument();
  });

  it('shows default channel name when channelName is not provided', () => {
    render(<MessageList messages={[]} currentUserId="user-1" />);
    expect(screen.getByText(/welcome to #this channel/i)).toBeInTheDocument();
  });

  it('shows loading more indicator when loading with existing messages', () => {
    render(
      <MessageList
        messages={[mockMessage]}
        currentUserId="user-1"
        isLoading={true}
        hasMore={true}
      />
    );
    expect(screen.getByText(/loading more messages/i)).toBeInTheDocument();
  });

  it('renders the correct number of message elements', () => {
    render(<MessageList messages={[mockMessage, mockMessage2]} currentUserId="user-1" />);
    const messageElements = screen.getAllByTestId('message');
    expect(messageElements).toHaveLength(2);
  });
});
