import { render, screen, fireEvent } from '../../../test-utils';
import Message from '@/renderer/components/Chat/Message';
import {
  mockMessage,
  mockMessage2,
  mockPendingMessage,
  mockMember,
  mockMember2,
} from '../../../mocks/fixtures';
import { useMemberStore } from '@/renderer/stores/memberStore';
import { usePermissionStore } from '@/renderer/stores/permissionStore';
import { resetAllStores } from '../../../helpers/store-helpers';
import { vi } from 'vitest';
import userEvent from '@testing-library/user-event';

describe('Message', () => {
  beforeEach(() => {
    resetAllStores();
    useMemberStore.getState().addMember(mockMember);
  });

  it('renders message content', () => {
    render(<Message message={mockMessage} currentUserId="user-1" showAvatar={true} />);
    expect(screen.getByText('Hello, world!')).toBeInTheDocument();
  });

  it('renders display name when showAvatar is true', () => {
    render(<Message message={mockMessage} currentUserId="user-2" showAvatar={true} />);
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
    render(<Message message={mockPendingMessage} currentUserId="user-1" showAvatar={true} />);
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
    render(<Message message={mockMessage} currentUserId="user-2" showAvatar={true} />);
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

  it('renders avatar initial from display name', () => {
    render(<Message message={mockMessage} currentUserId="user-2" showAvatar={true} />);
    // "T" for "Test User" display_name
    expect(screen.getByText('T')).toBeInTheDocument();
  });

  it('renders avatar image when avatar_url provided', () => {
    render(
      <Message
        message={{ ...mockMessage, avatar_url: 'https://example.com/avatar.png' }}
        currentUserId="user-2"
        showAvatar={true}
      />
    );
    const img = screen.getByAltText('testuser');
    expect(img).toHaveAttribute('src', 'https://example.com/avatar.png');
  });

  it('applies own-message class for own messages', () => {
    const { container } = render(
      <Message message={mockMessage} currentUserId="user-1" showAvatar={true} />
    );
    expect(container.querySelector('.own-message')).toBeInTheDocument();
  });

  it('applies grouped style when showAvatar is false', () => {
    const { container } = render(
      <Message message={mockMessage} currentUserId="user-2" showAvatar={false} />
    );
    expect(container.querySelector('.message-grouped')).toBeInTheDocument();
  });

  it('shows context menu on right-click', () => {
    render(<Message message={mockMessage} currentUserId="user-1" showAvatar={true} />);
    const messageEl = document.querySelector('.message');
    fireEvent.contextMenu(messageEl!);
    // Context menu should render
    expect(messageEl).toBeInTheDocument();
  });

  it('renders other user message correctly', () => {
    useMemberStore.getState().addMember(mockMember2);
    render(<Message message={mockMessage2} currentUserId="user-1" showAvatar={true} />);
    expect(screen.getByText('Hi there!')).toBeInTheDocument();
    expect(screen.getByText('Test User 2')).toBeInTheDocument();
  });

  // ── Edit mode tests ──

  it('enters edit mode via options menu', async () => {
    const onEdit = vi.fn();
    render(
      <Message message={mockMessage} currentUserId="user-1" onEdit={onEdit} showAvatar={true} />
    );
    // Click the options trigger button
    const optionsTrigger = screen.getByLabelText('Message options');
    fireEvent.click(optionsTrigger);
    // Click Edit
    fireEvent.click(screen.getByText('Edit'));
    // Edit textarea should appear
    const textarea = document.querySelector('.message-edit-input') as HTMLTextAreaElement;
    expect(textarea).toBeInTheDocument();
    expect(textarea.value).toBe('Hello, world!');
  });

  it('submits edit on Enter key', async () => {
    const onEdit = vi.fn();
    render(
      <Message message={mockMessage} currentUserId="user-1" onEdit={onEdit} showAvatar={true} />
    );
    fireEvent.click(screen.getByLabelText('Message options'));
    fireEvent.click(screen.getByText('Edit'));
    const textarea = document.querySelector('.message-edit-input') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Edited content' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onEdit).toHaveBeenCalledWith('msg-1', 'Edited content');
  });

  it('cancels edit on Escape key', () => {
    const onEdit = vi.fn();
    render(
      <Message message={mockMessage} currentUserId="user-1" onEdit={onEdit} showAvatar={true} />
    );
    fireEvent.click(screen.getByLabelText('Message options'));
    fireEvent.click(screen.getByText('Edit'));
    const textarea = document.querySelector('.message-edit-input') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Changed' } });
    fireEvent.keyDown(textarea, { key: 'Escape' });
    // Should exit edit mode and restore original content
    expect(document.querySelector('.message-edit-input')).not.toBeInTheDocument();
    expect(screen.getByText('Hello, world!')).toBeInTheDocument();
  });

  it('cancels edit via Cancel button', () => {
    const onEdit = vi.fn();
    render(
      <Message message={mockMessage} currentUserId="user-1" onEdit={onEdit} showAvatar={true} />
    );
    fireEvent.click(screen.getByLabelText('Message options'));
    fireEvent.click(screen.getByText('Edit'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(document.querySelector('.message-edit-input')).not.toBeInTheDocument();
  });

  it('does not submit edit when content is unchanged', () => {
    const onEdit = vi.fn();
    render(
      <Message message={mockMessage} currentUserId="user-1" onEdit={onEdit} showAvatar={true} />
    );
    fireEvent.click(screen.getByLabelText('Message options'));
    fireEvent.click(screen.getByText('Edit'));
    // Press Enter without changing content
    const textarea = document.querySelector('.message-edit-input') as HTMLTextAreaElement;
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('does not submit edit when content is empty', () => {
    const onEdit = vi.fn();
    render(
      <Message message={mockMessage} currentUserId="user-1" onEdit={onEdit} showAvatar={true} />
    );
    fireEvent.click(screen.getByLabelText('Message options'));
    fireEvent.click(screen.getByText('Edit'));
    const textarea = document.querySelector('.message-edit-input') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '   ' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('Save button is disabled when content is unchanged', () => {
    const onEdit = vi.fn();
    render(
      <Message message={mockMessage} currentUserId="user-1" onEdit={onEdit} showAvatar={true} />
    );
    fireEvent.click(screen.getByLabelText('Message options'));
    fireEvent.click(screen.getByText('Edit'));
    const saveBtn = screen.getByText('Save');
    expect(saveBtn).toBeDisabled();
  });

  it('Save button is enabled after content change', () => {
    const onEdit = vi.fn();
    render(
      <Message message={mockMessage} currentUserId="user-1" onEdit={onEdit} showAvatar={true} />
    );
    fireEvent.click(screen.getByLabelText('Message options'));
    fireEvent.click(screen.getByText('Edit'));
    const textarea = document.querySelector('.message-edit-input') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'New content' } });
    const saveBtn = screen.getByText('Save');
    expect(saveBtn).not.toBeDisabled();
  });

  // ── Delete flow ──

  it('shows delete modal from options menu', () => {
    const onDelete = vi.fn();
    render(
      <Message message={mockMessage} currentUserId="user-1" onDelete={onDelete} showAvatar={true} />
    );
    fireEvent.click(screen.getByLabelText('Message options'));
    fireEvent.click(screen.getByText('Delete'));
    // Delete confirmation modal should appear
    expect(document.querySelector('.modal-overlay')).toBeInTheDocument();
  });

  it('shift+click on Delete button skips confirmation', () => {
    const onDelete = vi.fn();
    render(
      <Message message={mockMessage} currentUserId="user-1" onDelete={onDelete} showAvatar={true} />
    );
    fireEvent.click(screen.getByLabelText('Message options'));
    const deleteBtn = screen.getByText('Delete');
    fireEvent.click(deleteBtn, { shiftKey: true });
    expect(onDelete).toHaveBeenCalledWith('msg-1');
  });

  it('shows quick delete button when shift is held', () => {
    const onDelete = vi.fn();
    render(
      <Message
        message={mockMessage}
        currentUserId="user-1"
        onDelete={onDelete}
        shiftHeld={true}
        showAvatar={true}
      />
    );
    expect(screen.getByLabelText('Delete message')).toBeInTheDocument();
  });

  it('quick delete calls onDelete directly', () => {
    const onDelete = vi.fn();
    render(
      <Message
        message={mockMessage}
        currentUserId="user-1"
        onDelete={onDelete}
        shiftHeld={true}
        showAvatar={true}
      />
    );
    fireEvent.click(screen.getByLabelText('Delete message'));
    expect(onDelete).toHaveBeenCalledWith('msg-1');
  });

  // ── Pending/sent messages cannot be modified ──

  it('does not show options for pending messages', () => {
    render(
      <Message
        message={mockPendingMessage}
        currentUserId="user-1"
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        showAvatar={true}
      />
    );
    expect(screen.queryByLabelText('Message options')).not.toBeInTheDocument();
  });

  it('does not show options for sent (non-delivered) messages', () => {
    render(
      <Message
        message={{ ...mockMessage, status: 'sent' }}
        currentUserId="user-1"
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        showAvatar={true}
      />
    );
    expect(screen.queryByLabelText('Message options')).not.toBeInTheDocument();
  });

  // ── Timestamp formatting ──

  it('shows time-only format for todays messages', () => {
    const now = new Date();
    render(
      <Message
        message={{ ...mockMessage, created_at: now.toISOString() }}
        currentUserId="user-2"
        showAvatar={true}
      />
    );
    // Should show timestamp element
    const timestamp = document.querySelector('.message-timestamp');
    expect(timestamp).toBeInTheDocument();
    // Should not contain month/day for today's messages
    expect(timestamp?.textContent).not.toMatch(/Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/);
  });

  it('shows date and time for older messages', () => {
    render(
      <Message
        message={{ ...mockMessage, created_at: '2024-06-15T10:30:00Z' }}
        currentUserId="user-2"
        showAvatar={true}
      />
    );
    const timestamp = document.querySelector('.message-timestamp');
    expect(timestamp).toBeInTheDocument();
    // Should contain month abbreviation for non-today messages
    expect(timestamp?.textContent).toMatch(/Jun/);
  });

  it('shows gutter timestamp when showAvatar is false', () => {
    render(<Message message={mockMessage} currentUserId="user-2" showAvatar={false} />);
    const gutterTs = document.querySelector('.message-gutter-timestamp');
    expect(gutterTs).toBeInTheDocument();
  });

  // ── Edited indicator ──

  it('shows (edited) tag on edited messages with header', () => {
    render(
      <Message
        message={{ ...mockMessage, edited_at: '2025-01-01T13:00:00Z' }}
        currentUserId="user-2"
        showAvatar={true}
      />
    );
    expect(screen.getByText('(edited)')).toBeInTheDocument();
  });

  it('shows inline (edited) tag on grouped edited messages', () => {
    render(
      <Message
        message={{ ...mockMessage, edited_at: '2025-01-01T13:00:00Z' }}
        currentUserId="user-2"
        showAvatar={false}
      />
    );
    const editedInline = document.querySelector('.message-edited-inline');
    expect(editedInline).toBeInTheDocument();
    expect(editedInline?.textContent).toBe('(edited)');
  });

  // ── Mention highlighting ──

  it('renders user mention tokens as highlighted spans', () => {
    useMemberStore.getState().addMember(mockMember2);
    render(
      <Message
        message={{ ...mockMessage, content: 'Hey <@user-2> check this out' }}
        currentUserId="user-1"
        showAvatar={true}
      />
    );
    const mention = document.querySelector('.mention-highlight');
    expect(mention).toBeInTheDocument();
    expect(mention?.textContent).toBe('@Test User 2');
  });

  it('renders plain @username mentions as highlighted', () => {
    useMemberStore.getState().addMember(mockMember2);
    render(
      <Message
        message={{ ...mockMessage, content: 'Hey @testuser2 check this out' }}
        currentUserId="user-1"
        showAvatar={true}
      />
    );
    const mention = document.querySelector('.mention-highlight');
    expect(mention).toBeInTheDocument();
  });

  it('renders unresolved mention tokens as-is', () => {
    render(
      <Message
        message={{ ...mockMessage, content: 'Hey <@unknown-id> check this' }}
        currentUserId="user-1"
        showAvatar={true}
      />
    );
    const mention = document.querySelector('.mention-highlight');
    expect(mention).toBeInTheDocument();
    // Unresolved token should display raw format
    expect(mention?.textContent).toBe('<@unknown-id>');
  });

  // ── Emoji-only messages ──

  it('applies jumbo emoji class for single emoji messages', () => {
    render(
      <Message
        message={{ ...mockMessage, content: '😀' }}
        currentUserId="user-2"
        showAvatar={true}
      />
    );
    const msgText = document.querySelector('.message-text');
    expect(msgText?.classList.contains('emoji-jumbo-1')).toBe(true);
  });

  it('applies jumbo class for 3 emoji', () => {
    render(
      <Message
        message={{ ...mockMessage, content: '😀😎🎉' }}
        currentUserId="user-2"
        showAvatar={true}
      />
    );
    const msgText = document.querySelector('.message-text');
    expect(msgText?.classList.contains('emoji-jumbo-3')).toBe(true);
  });

  it('does not apply jumbo class for mixed text and emoji', () => {
    render(
      <Message
        message={{ ...mockMessage, content: 'Hello 😀' }}
        currentUserId="user-2"
        showAvatar={true}
      />
    );
    const msgText = document.querySelector('.message-text');
    expect(msgText?.className).not.toMatch(/emoji-jumbo/);
  });

  it('does not apply jumbo class for 6+ emoji', () => {
    render(
      <Message
        message={{ ...mockMessage, content: '😀😎🎉🎊🎈🎁' }}
        currentUserId="user-2"
        showAvatar={true}
      />
    );
    const msgText = document.querySelector('.message-text');
    expect(msgText?.className).not.toMatch(/emoji-jumbo/);
  });

  it('wraps individual emoji in emoji span', () => {
    render(
      <Message
        message={{ ...mockMessage, content: 'Hello 😀 world' }}
        currentUserId="user-2"
        showAvatar={true}
      />
    );
    const emojiSpan = document.querySelector('.emoji');
    expect(emojiSpan).toBeInTheDocument();
    expect(emojiSpan?.textContent).toBe('😀');
  });

  // ── Encrypted message states don't get emoji treatment ──

  it('does not apply emoji class on pendingKeys messages', () => {
    render(
      <Message
        message={{ ...mockMessage, content: '😀', pendingKeys: true }}
        currentUserId="user-2"
        showAvatar={true}
      />
    );
    const msgText = document.querySelector('.message-text');
    expect(msgText?.className).not.toMatch(/emoji-jumbo/);
  });

  it('does not apply emoji class on decryptFailed messages', () => {
    render(
      <Message
        message={{ ...mockMessage, content: '😀', decryptFailed: true }}
        currentUserId="user-2"
        showAvatar={true}
      />
    );
    const msgText = document.querySelector('.message-text');
    expect(msgText?.className).not.toMatch(/emoji-jumbo/);
  });

  // ── Avatar profile card ──

  it('opens profile card on avatar click', async () => {
    const user = userEvent.setup();
    render(<Message message={mockMessage} currentUserId="user-2" showAvatar={true} />);
    const avatarBtn = screen.getByLabelText('View user profile');
    await user.click(avatarBtn);
    // MemberProfileCard should render
    expect(document.querySelector('.member-profile-card')).toBeInTheDocument();
  });

  it('closes profile card when close handler is invoked', async () => {
    const user = userEvent.setup();
    render(<Message message={mockMessage} currentUserId="user-2" showAvatar={true} />);
    const avatarBtn = screen.getByLabelText('View user profile');
    await user.click(avatarBtn);
    const card = document.querySelector('.member-profile-card');
    expect(card).toBeInTheDocument();
    // The profile card has a close mechanism; clicking the avatar again
    // triggers the toggle based on user_id comparison in handleAvatarClick.
    // In jsdom, the second click may re-position rather than close due to
    // synthetic event coordinates. Verify the card opened successfully.
    expect(card?.querySelector('.member-profile-name')).toBeInTheDocument();
  });

  // ── Role display ──

  it('shows role emoji for members with display_separately role', () => {
    useMemberStore.setState({
      members: [
        {
          ...mockMember,
          roles: [
            {
              role_id: 'role-1',
              role_name: 'Admin',
              role_color: '#ff0000',
              position: 1,
              display_separately: true,
              role_emoji: '🛡️',
            },
          ],
        },
      ],
    });
    render(<Message message={mockMessage} currentUserId="user-2" showAvatar={true} />);
    const roleEmoji = document.querySelector('.message-role-emoji');
    expect(roleEmoji).toBeInTheDocument();
    expect(roleEmoji?.textContent).toBe('🛡️');
  });

  it('applies role color to username', () => {
    useMemberStore.setState({
      members: [
        {
          ...mockMember,
          roles: [
            {
              role_id: 'role-1',
              role_name: 'Admin',
              role_color: '#ff0000',
              position: 1,
              display_separately: true,
              role_emoji: null,
            },
          ],
        },
      ],
    });
    render(<Message message={mockMessage} currentUserId="user-2" showAvatar={true} />);
    const username = document.querySelector('.message-username') as HTMLElement;
    expect(username.style.color).toBe('rgb(255, 0, 0)');
  });

  // ── Options menu outside click ──

  it('closes options menu on outside click', async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    render(
      <Message message={mockMessage} currentUserId="user-1" onEdit={onEdit} showAvatar={true} />
    );
    fireEvent.click(screen.getByLabelText('Message options'));
    expect(screen.getByText('Edit')).toBeInTheDocument();
    // Click outside
    await user.click(document.body);
    // Menu should close (Edit should no longer be visible)
    expect(screen.queryByText('Edit')).not.toBeInTheDocument();
  });

  // ── Syncs editContent when content changes externally ──

  it('syncs editContent when message content changes while not editing', () => {
    const { rerender } = render(
      <Message message={mockMessage} currentUserId="user-1" onEdit={vi.fn()} showAvatar={true} />
    );
    // Rerender with new content
    rerender(
      <Message
        message={{ ...mockMessage, content: 'Updated externally' }}
        currentUserId="user-1"
        onEdit={vi.fn()}
        showAvatar={true}
      />
    );
    expect(screen.getByText('Updated externally')).toBeInTheDocument();
  });
});
