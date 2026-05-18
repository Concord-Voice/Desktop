import { render, screen, fireEvent, waitFor } from '../../../test-utils';
import DMConversationContextMenu from '@/renderer/components/DirectMessages/DMConversationContextMenu';
import type { DMConversation } from '@/renderer/stores/dmStore';

vi.mock('@/renderer/services/apiClient', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/renderer/services/apiClient';

const mockApiFetch = apiFetch as ReturnType<typeof vi.fn>;

const CURRENT_USER_ID = 'user-1';

function makeConversation(overrides: Partial<DMConversation> = {}): DMConversation {
  return {
    id: 'conv-1',
    isGroup: false,
    isPersonal: false,
    name: null,
    participants: [
      { userId: 'user-1', username: 'alice' },
      { userId: 'user-2', username: 'bob' },
    ],
    lastMessage: null,
    unreadCount: 0,
    createdAt: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('DMConversationContextMenu', () => {
  const mockOnClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const renderMenu = (conversation: DMConversation, currentUserId = CURRENT_USER_ID) => {
    return render(
      <DMConversationContextMenu
        conversation={conversation}
        currentUserId={currentUserId}
        position={{ x: 100, y: 100 }}
        onClose={mockOnClose}
      />
    );
  };

  it('shows Rotate Encryption Key for encrypted 1:1 DM', () => {
    renderMenu(makeConversation());
    expect(screen.getByText('Rotate Encryption Key')).toBeInTheDocument();
  });

  it('shows Rotate Encryption Key for group DM when user is creator', () => {
    renderMenu(
      makeConversation({
        isGroup: true,
        createdBy: CURRENT_USER_ID,
        name: 'Test Group',
      })
    );
    expect(screen.getByText('Rotate Encryption Key')).toBeInTheDocument();
  });

  it('hides Rotate Encryption Key for group DM when user is not creator', () => {
    renderMenu(
      makeConversation({
        isGroup: true,
        createdBy: 'user-other',
        name: 'Test Group',
      })
    );
    expect(screen.queryByText('Rotate Encryption Key')).not.toBeInTheDocument();
    expect(screen.getByText('No actions available')).toBeInTheDocument();
  });

  it('calls correct API endpoint and shows success', async () => {
    mockApiFetch.mockResolvedValue({ ok: true, status: 200 });
    const conv = makeConversation({ id: 'conv-42' });
    renderMenu(conv);

    fireEvent.click(screen.getByText('Rotate Encryption Key'));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/dm/conversations/conv-42/rotate-key', {
        method: 'POST',
      });
    });

    await waitFor(() => {
      expect(screen.getByText('Key Rotated!')).toBeInTheDocument();
    });
  });

  it('shows rate limit message on 429', async () => {
    mockApiFetch.mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ retry_after: 7200 }),
    });
    renderMenu(makeConversation());

    fireEvent.click(screen.getByText('Rotate Encryption Key'));

    await waitFor(() => {
      expect(screen.getByText('Try again in 2h')).toBeInTheDocument();
    });
  });

  it('shows error message on non-429 failure', async () => {
    mockApiFetch.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: 'Forbidden' }),
    });
    renderMenu(makeConversation());

    fireEvent.click(screen.getByText('Rotate Encryption Key'));

    await waitFor(() => {
      expect(screen.getByText('Forbidden')).toBeInTheDocument();
    });
  });

  it('shows fallback error message on network failure', async () => {
    mockApiFetch.mockRejectedValue(new Error('Network error'));
    renderMenu(makeConversation());

    fireEvent.click(screen.getByText('Rotate Encryption Key'));

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
  });
});
