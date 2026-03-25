import { render, screen, fireEvent } from '../../../test-utils';
import { useFriendStore } from '@/renderer/stores/friendStore';
import { usePrivacyStore } from '@/renderer/stores/privacyStore';
import { vi } from 'vitest';

// Mock apiFetch
vi.mock('@/renderer/services/apiClient', () => ({
  apiFetch: vi.fn().mockResolvedValue({ ok: false }),
  API_BASE: 'http://localhost:8080',
}));

// Mock CustomSelect
vi.mock('@/renderer/components/ui/CustomSelect', () => ({
  default: ({
    id,
    value,
    options,
    onChange,
  }: {
    id?: string;
    value: string;
    options: { value: string; label: string }[];
    onChange: (v: string) => void;
  }) => (
    <select
      data-testid={id || 'custom-select'}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  ),
}));

// Mock clipboard
Object.assign(navigator, {
  clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
});

import AddFriendModal from '@/renderer/components/DirectMessages/AddFriendModal';

describe('AddFriendModal', () => {
  const mockOnClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useFriendStore.setState({
      friendCodes: [],
      previewFriendCode: vi
        .fn()
        .mockResolvedValue({ valid: true, username: 'alice', displayName: 'Alice' }),
      claimFriendCode: vi
        .fn()
        .mockResolvedValue({ status: 'pending', user: { username: 'alice' } }),
      generateFriendCode: vi.fn().mockResolvedValue({ code: 'ABCD1234' }),
      revokeFriendCode: vi.fn().mockResolvedValue(undefined),
      fetchFriendCodes: vi.fn().mockResolvedValue(undefined),
      searchUsers: vi.fn().mockResolvedValue([]),
      sendRequest: vi.fn().mockResolvedValue(undefined),
    });
    usePrivacyStore.setState({
      settings: {
        autoAcceptFriendCodes: false,
        searchable: true,
        searchableByEmail: false,
        searchableByPhone: false,
      },
    });
  });

  it('renders nothing when closed', () => {
    const { container } = render(<AddFriendModal isOpen={false} onClose={mockOnClose} />);
    expect(container.querySelector('.modal-overlay')).not.toBeInTheDocument();
  });

  it('renders modal title when open', () => {
    render(<AddFriendModal isOpen={true} onClose={mockOnClose} />);
    const modalTitle = document.querySelector('.modal-title');
    expect(modalTitle?.textContent).toBe('Add Friend');
  });

  it('renders all sections', () => {
    render(<AddFriendModal isOpen={true} onClose={mockOnClose} />);
    expect(screen.getByText('Add by Friend Code')).toBeInTheDocument();
    expect(screen.getByText('Share Your Friend Code')).toBeInTheDocument();
  });

  it('renders friend code input field', () => {
    render(<AddFriendModal isOpen={true} onClose={mockOnClose} />);
    expect(screen.getByPlaceholderText('Enter 8-character code...')).toBeInTheDocument();
  });

  it('accepts friend code input', () => {
    render(<AddFriendModal isOpen={true} onClose={mockOnClose} />);
    const input = screen.getByPlaceholderText('Enter 8-character code...') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'ABCD1234' } });
    expect(input.value).toBe('ABCD1234');
  });

  it('has maxLength of 8 on friend code input', () => {
    render(<AddFriendModal isOpen={true} onClose={mockOnClose} />);
    const input = screen.getByPlaceholderText('Enter 8-character code...');
    expect(input.getAttribute('maxLength')).toBe('8');
  });

  it('previews friend code when 8 characters entered', async () => {
    const mockPreview = vi.fn().mockResolvedValue({
      valid: true,
      username: 'alice',
      displayName: 'Alice',
    });
    useFriendStore.setState({ previewFriendCode: mockPreview });
    render(<AddFriendModal isOpen={true} onClose={mockOnClose} />);
    const input = screen.getByPlaceholderText('Enter 8-character code...');
    fireEvent.change(input, { target: { value: 'ABCD1234' } });
    await vi.waitFor(() => {
      expect(mockPreview).toHaveBeenCalledWith('ABCD1234');
    });
  });

  it('shows preview with Send Friend Request button for valid code', async () => {
    const mockPreview = vi.fn().mockResolvedValue({
      valid: true,
      username: 'alice',
      displayName: 'Alice',
    });
    useFriendStore.setState({ previewFriendCode: mockPreview });
    render(<AddFriendModal isOpen={true} onClose={mockOnClose} />);
    const input = screen.getByPlaceholderText('Enter 8-character code...');
    fireEvent.change(input, { target: { value: 'ABCD1234' } });
    await vi.waitFor(() => {
      expect(screen.getByText('Send Friend Request')).toBeInTheDocument();
      expect(screen.getByText('Alice')).toBeInTheDocument();
    });
  });

  it('shows error for expired code', async () => {
    const mockPreview = vi.fn().mockResolvedValue({ valid: false });
    useFriendStore.setState({ previewFriendCode: mockPreview });
    render(<AddFriendModal isOpen={true} onClose={mockOnClose} />);
    const input = screen.getByPlaceholderText('Enter 8-character code...');
    fireEvent.change(input, { target: { value: 'EXPIRED8' } });
    await vi.waitFor(() => {
      expect(screen.getByText('This code is expired or has been used')).toBeInTheDocument();
    });
  });

  it('claims friend code and shows success', async () => {
    const mockPreview = vi.fn().mockResolvedValue({
      valid: true,
      username: 'alice',
      displayName: 'Alice',
    });
    const mockClaim = vi.fn().mockResolvedValue({
      status: 'accepted',
      user: { username: 'alice' },
    });
    useFriendStore.setState({
      previewFriendCode: mockPreview,
      claimFriendCode: mockClaim,
    });
    render(<AddFriendModal isOpen={true} onClose={mockOnClose} />);
    const input = screen.getByPlaceholderText('Enter 8-character code...');
    fireEvent.change(input, { target: { value: 'ABCD1234' } });
    await vi.waitFor(() => {
      expect(screen.getByText('Send Friend Request')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Send Friend Request'));
    await vi.waitFor(() => {
      expect(screen.getByText('You are now friends with alice!')).toBeInTheDocument();
    });
  });

  it('renders search input', () => {
    render(<AddFriendModal isOpen={true} onClose={mockOnClose} />);
    expect(
      screen.getByPlaceholderText('Search by username (3+ characters)...')
    ).toBeInTheDocument();
  });

  it('does not search for queries less than 3 characters', () => {
    const mockSearch = vi.fn();
    useFriendStore.setState({ searchUsers: mockSearch });
    render(<AddFriendModal isOpen={true} onClose={mockOnClose} />);
    const input = screen.getByPlaceholderText('Search by username (3+ characters)...');
    fireEvent.change(input, { target: { value: 'ab' } });
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('shows search results after typing 3+ characters', async () => {
    const mockSearch = vi
      .fn()
      .mockResolvedValue([{ id: 'u1', username: 'charlie', displayName: 'Charlie' }]);
    useFriendStore.setState({ searchUsers: mockSearch });
    render(<AddFriendModal isOpen={true} onClose={mockOnClose} />);
    const input = screen.getByPlaceholderText('Search by username (3+ characters)...');
    fireEvent.change(input, { target: { value: 'cha' } });
    await vi.waitFor(() => {
      expect(screen.getByText('Charlie')).toBeInTheDocument();
    });
  });

  it('renders Generate Code button', () => {
    render(<AddFriendModal isOpen={true} onClose={mockOnClose} />);
    expect(screen.getByText('Generate Code')).toBeInTheDocument();
  });

  it('generates a friend code on Generate button click', async () => {
    const mockGenerate = vi.fn().mockResolvedValue({ code: 'NEWCODE1' });
    useFriendStore.setState({ generateFriendCode: mockGenerate });
    render(<AddFriendModal isOpen={true} onClose={mockOnClose} />);
    fireEvent.click(screen.getByText('Generate Code'));
    await vi.waitFor(() => {
      expect(mockGenerate).toHaveBeenCalled();
      expect(screen.getByText('NEWCODE1')).toBeInTheDocument();
    });
  });

  it('copies generated code to clipboard', async () => {
    const mockGenerate = vi.fn().mockResolvedValue({ code: 'COPYCODE' });
    useFriendStore.setState({ generateFriendCode: mockGenerate });
    render(<AddFriendModal isOpen={true} onClose={mockOnClose} />);
    fireEvent.click(screen.getByText('Generate Code'));
    await vi.waitFor(() => {
      expect(screen.getByText('COPYCODE')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Copy'));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('COPYCODE');
  });

  it('renders expiry dropdown', () => {
    render(<AddFriendModal isOpen={true} onClose={mockOnClose} />);
    expect(screen.getByText('Expires after')).toBeInTheDocument();
  });

  it('renders max uses dropdown', () => {
    render(<AddFriendModal isOpen={true} onClose={mockOnClose} />);
    expect(screen.getByText('Max uses')).toBeInTheDocument();
  });

  it('renders auto-accept toggle', () => {
    render(<AddFriendModal isOpen={true} onClose={mockOnClose} />);
    expect(screen.getByText('Auto-accept')).toBeInTheDocument();
  });

  it('renders active friend codes list', () => {
    useFriendStore.setState({
      friendCodes: [
        {
          id: 'fc-1',
          code: 'ACTIVE01',
          maxUses: 3,
          useCount: 1,
          expiresAt: null,
          autoAccept: false,
          createdAt: '2025-01-01T00:00:00Z',
        },
      ],
      fetchFriendCodes: vi.fn().mockResolvedValue(undefined),
    });
    render(<AddFriendModal isOpen={true} onClose={mockOnClose} />);
    expect(screen.getByText('Active Codes')).toBeInTheDocument();
    expect(screen.getByText('ACTIVE01')).toBeInTheDocument();
    expect(screen.getByText('1/3 uses')).toBeInTheDocument();
  });

  it('revokes a friend code on revoke button click', async () => {
    const mockRevoke = vi.fn().mockResolvedValue(undefined);
    useFriendStore.setState({
      friendCodes: [
        {
          id: 'fc-3',
          code: 'REVOKE01',
          maxUses: 1,
          useCount: 0,
          expiresAt: null,
          autoAccept: false,
          createdAt: '2025-01-01T00:00:00Z',
        },
      ],
      fetchFriendCodes: vi.fn().mockResolvedValue(undefined),
      revokeFriendCode: mockRevoke,
    });
    render(<AddFriendModal isOpen={true} onClose={mockOnClose} />);
    const revokeBtn = document.querySelector('.add-friend-revoke-btn');
    expect(revokeBtn).toBeInTheDocument();
    fireEvent.click(revokeBtn!);
    await vi.waitFor(() => {
      expect(mockRevoke).toHaveBeenCalledWith('fc-3');
    });
  });

  it('does not show Active Codes section when no codes exist', () => {
    useFriendStore.setState({
      friendCodes: [],
      fetchFriendCodes: vi.fn().mockResolvedValue(undefined),
    });
    render(<AddFriendModal isOpen={true} onClose={mockOnClose} />);
    expect(screen.queryByText('Active Codes')).not.toBeInTheDocument();
  });

  it('fetches friend codes when modal opens', () => {
    const mockFetch = vi.fn().mockResolvedValue(undefined);
    useFriendStore.setState({ fetchFriendCodes: mockFetch });
    render(<AddFriendModal isOpen={true} onClose={mockOnClose} />);
    expect(mockFetch).toHaveBeenCalled();
  });
});
