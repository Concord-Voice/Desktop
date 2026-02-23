import { render, screen, fireEvent, act } from '../../../test-utils';
import ContextMenu from '@/renderer/components/UI/ContextMenu';

describe('ContextMenu', () => {
  const mockOnClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders children at given position', () => {
    render(
      <ContextMenu position={{ x: 100, y: 200 }} onClose={mockOnClose}>
        <ContextMenu.Item label="Test Item" onClick={() => {}} />
      </ContextMenu>,
    );
    expect(screen.getByText('Test Item')).toBeInTheDocument();
  });

  it('renders Header component', () => {
    render(
      <ContextMenu position={{ x: 0, y: 0 }} onClose={mockOnClose}>
        <ContextMenu.Header>My Header</ContextMenu.Header>
      </ContextMenu>,
    );
    expect(screen.getByText('My Header')).toBeInTheDocument();
  });

  it('renders Separator', () => {
    const { container } = render(
      <ContextMenu position={{ x: 0, y: 0 }} onClose={mockOnClose}>
        <ContextMenu.Separator />
      </ContextMenu>,
    );
    expect(container.querySelector('.ctx-menu-separator')).toBeInTheDocument();
  });

  it('renders Item with icon', () => {
    render(
      <ContextMenu position={{ x: 0, y: 0 }} onClose={mockOnClose}>
        <ContextMenu.Item icon={<span data-testid="icon">I</span>} label="With Icon" onClick={() => {}} />
      </ContextMenu>,
    );
    expect(screen.getByTestId('icon')).toBeInTheDocument();
    expect(screen.getByText('With Icon')).toBeInTheDocument();
  });

  it('calls onClick when item is clicked', () => {
    const onClick = vi.fn();
    render(
      <ContextMenu position={{ x: 0, y: 0 }} onClose={mockOnClose}>
        <ContextMenu.Item label="Click Me" onClick={onClick} />
      </ContextMenu>,
    );
    fireEvent.click(screen.getByText('Click Me'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not call onClick when item is disabled', () => {
    const onClick = vi.fn();
    render(
      <ContextMenu position={{ x: 0, y: 0 }} onClose={mockOnClose}>
        <ContextMenu.Item label="Disabled" onClick={onClick} disabled />
      </ContextMenu>,
    );
    fireEvent.click(screen.getByText('Disabled'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('applies danger class to danger items', () => {
    render(
      <ContextMenu position={{ x: 0, y: 0 }} onClose={mockOnClose}>
        <ContextMenu.Item label="Danger" onClick={() => {}} danger />
      </ContextMenu>,
    );
    expect(screen.getByText('Danger').closest('button')).toHaveClass('ctx-menu-item-danger');
  });

  it('closes on Escape key', () => {
    render(
      <ContextMenu position={{ x: 0, y: 0 }} onClose={mockOnClose}>
        <ContextMenu.Item label="Item" onClick={() => {}} />
      </ContextMenu>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    act(() => { vi.advanceTimersByTime(200); });
    expect(mockOnClose).toHaveBeenCalled();
  });

  it('closes on click outside', () => {
    render(
      <ContextMenu position={{ x: 0, y: 0 }} onClose={mockOnClose}>
        <ContextMenu.Item label="Item" onClick={() => {}} />
      </ContextMenu>,
    );
    fireEvent.mouseDown(document.body);
    act(() => { vi.advanceTimersByTime(200); });
    expect(mockOnClose).toHaveBeenCalled();
  });

  it('renders SubMenu', () => {
    render(
      <ContextMenu position={{ x: 0, y: 0 }} onClose={mockOnClose}>
        <ContextMenu.Item label="Parent" onClick={() => {}} hasSubMenu />
        <ContextMenu.SubMenu>
          <ContextMenu.Item label="Sub Item" onClick={() => {}} />
        </ContextMenu.SubMenu>
      </ContextMenu>,
    );
    expect(screen.getByText('Sub Item')).toBeInTheDocument();
  });
});
