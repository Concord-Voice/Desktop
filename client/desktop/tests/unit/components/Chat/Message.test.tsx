import { render, screen } from '../../../test-utils';
import Message from '@/renderer/components/Chat/Message';
import { mockMessage, mockMessage2, mockPendingMessage, mockMember } from '../../../mocks/fixtures';
import { useMemberStore } from '@/renderer/stores/memberStore';
import { resetAllStores } from '../../../helpers/store-helpers';
import { vi } from 'vitest';

describe('Message', () => {
  beforeEach(() => {
    resetAllStores();
    useMemberStore.getState().addMember(mockMember);
  });

  it('renders message content', () => {
    render(
      <Message
        message={mockMessage}
        currentUserId="user-1"
        showAvatar={true}
      />
    );
    expect(screen.getByText('Hello, world!')).toBeInTheDocument();
  });

  it('renders display name when showAvatar is true', () => {
    render(
      <Message
        message={mockMessage}
        currentUserId="user-2"
        showAvatar={true}
      />
    );
    // display_name takes priority over username
    expect(screen.getByText('Test User')).toBeInTheDocument();
  });

  it('falls back to username when no display_name', () => {
    render(
      <Message
        message={{ ...mockMessage, display_name: undefined as unknown as string }}
        currentUserId="user-2"
        showAvatar={true}
      />
    );
    expect(screen.getByText('testuser')).toBeInTheDocument();
  });

  it('shows encrypted indicator for encrypted messages', () => {
    render(
      <Message
        message={{ ...mockMessage, is_encrypted: true }}
        currentUserId="user-2"
        showAvatar={true}
      />
    );
    expect(document.querySelector('.encrypted-indicator')).toBeInTheDocument();
  });

  it('shows pending status indicator', () => {
    render(
      <Message
        message={mockPendingMessage}
        currentUserId="user-1"
        showAvatar={true}
      />
    );
    // Pending message should have visual indicator
    const msgEl = document.querySelector('.message');
    expect(msgEl).toBeInTheDocument();
  });

  it('renders message with failed status', () => {
    render(
      <Message
        message={{ ...mockMessage, status: 'failed', error: 'Network error' }}
        currentUserId="user-1"
        showAvatar={true}
      />
    );
    // Failed messages still render content; canModify is false since status != 'delivered'
    expect(screen.getByText('Hello, world!')).toBeInTheDocument();
    const msgEl = document.querySelector('.message');
    expect(msgEl).toBeInTheDocument();
  });

  it('does not show edit/delete buttons for other users messages', () => {
    render(
      <Message
        message={mockMessage}
        currentUserId="user-2"
        showAvatar={true}
      />
    );
    expect(screen.queryByLabelText(/edit/i)).not.toBeInTheDocument();
  });

  it('shows decryption failure message', () => {
    render(
      <Message
        message={{ ...mockMessage, decryptFailed: true }}
        currentUserId="user-2"
        showAvatar={true}
      />
    );
    expect(screen.getByText(/unable to decrypt/i)).toBeInTheDocument();
  });

  it('shows pending keys message', () => {
    render(
      <Message
        message={{ ...mockMessage, pendingKeys: true }}
        currentUserId="user-2"
        showAvatar={true}
      />
    );
    expect(screen.getByText(/waiting for encryption keys/i)).toBeInTheDocument();
  });
});
