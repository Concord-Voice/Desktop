import { render, screen, fireEvent } from '../../../test-utils';
import ConnectionSelector from '@/renderer/components/Auth/ConnectionSelector';

describe('ConnectionSelector', () => {
  const mockOnSelect = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders all connection options', () => {
    render(<ConnectionSelector onSelect={mockOnSelect} />);
    expect(screen.getByText('Sign In to Existing Account')).toBeInTheDocument();
    expect(screen.getByText('Create New Account')).toBeInTheDocument();
    expect(screen.getByText('Connect to Self-Hosted Server')).toBeInTheDocument();
  });

  it('disables continue button when no option selected', () => {
    render(<ConnectionSelector onSelect={mockOnSelect} />);
    expect(screen.getByText('Continue')).toBeDisabled();
  });

  it('enables continue button after selecting an option', () => {
    render(<ConnectionSelector onSelect={mockOnSelect} />);
    fireEvent.click(screen.getByText('Sign In to Existing Account'));
    expect(screen.getByText('Continue')).not.toBeDisabled();
  });

  it('calls onSelect with hosted-login when sign in is chosen', () => {
    render(<ConnectionSelector onSelect={mockOnSelect} />);
    fireEvent.click(screen.getByText('Sign In to Existing Account'));
    fireEvent.click(screen.getByText('Continue'));
    expect(mockOnSelect).toHaveBeenCalledWith('hosted-login');
  });

  it('calls onSelect with hosted when create account is chosen', () => {
    render(<ConnectionSelector onSelect={mockOnSelect} />);
    fireEvent.click(screen.getByText('Create New Account'));
    fireEvent.click(screen.getByText('Continue'));
    expect(mockOnSelect).toHaveBeenCalledWith('hosted');
  });

  it('calls onSelect with self-hosted when self-hosted is chosen', () => {
    render(<ConnectionSelector onSelect={mockOnSelect} />);
    fireEvent.click(screen.getByText('Connect to Self-Hosted Server'));
    fireEvent.click(screen.getByText('Continue'));
    expect(mockOnSelect).toHaveBeenCalledWith('self-hosted');
  });

  it('does not call onSelect when continue clicked without selection', () => {
    render(<ConnectionSelector onSelect={mockOnSelect} />);
    fireEvent.click(screen.getByText('Continue'));
    expect(mockOnSelect).not.toHaveBeenCalled();
  });
});
