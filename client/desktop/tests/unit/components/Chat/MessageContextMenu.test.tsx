import { render, screen, fireEvent } from '../../../test-utils';
import { mockMessage } from '../../../mocks/fixtures';
import MessageContextMenu from '@/renderer/components/Chat/MessageContextMenu';

describe('MessageContextMenu', () => {
  const mockOnClose = vi.fn();
  const mockOnEdit = vi.fn();
  const mockOnDelete = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const renderMenu = (canModify = true) => {
    return render(
      <MessageContextMenu
        message={mockMessage}
        position={{ x: 100, y: 100 }}
        isOwnMessage={canModify}
        canModify={canModify}
        onClose={mockOnClose}
        onEdit={mockOnEdit}
        onDelete={mockOnDelete}
      />
    );
  };

  it('renders Copy Text option', () => {
    renderMenu();
    expect(screen.getByText('Copy Text')).toBeInTheDocument();
  });

  it('renders Reply option (disabled)', () => {
    renderMenu();
    const replyBtn = screen.getByText('Reply');
    expect(replyBtn).toBeInTheDocument();
    expect(replyBtn.closest('button')).toBeDisabled();
  });

  it('renders Pin Message option (disabled)', () => {
    renderMenu();
    const pinBtn = screen.getByText('Pin Message');
    expect(pinBtn).toBeInTheDocument();
    expect(pinBtn.closest('button')).toBeDisabled();
  });

  it('shows Edit/Delete for message author', () => {
    renderMenu(true);
    expect(screen.getByText('Edit Message')).toBeInTheDocument();
    expect(screen.getByText('Delete Message')).toBeInTheDocument();
  });

  it('hides Edit/Delete for non-author', () => {
    renderMenu(false);
    expect(screen.queryByText('Edit Message')).not.toBeInTheDocument();
    expect(screen.queryByText('Delete Message')).not.toBeInTheDocument();
  });

  it('calls onEdit when Edit clicked', () => {
    renderMenu(true);
    fireEvent.click(screen.getByText('Edit Message'));
    expect(mockOnEdit).toHaveBeenCalled();
    expect(mockOnClose).toHaveBeenCalled();
  });

  it('calls onDelete when Delete clicked', () => {
    renderMenu(true);
    fireEvent.click(screen.getByText('Delete Message'));
    expect(mockOnDelete).toHaveBeenCalled();
    expect(mockOnClose).toHaveBeenCalled();
  });
});
