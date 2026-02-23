import { render, screen } from '../../../test-utils';
import MessageInput from '@/renderer/components/Chat/MessageInput';
import { vi } from 'vitest';
import userEvent from '@testing-library/user-event';

describe('MessageInput', () => {
  const onSendMessage = vi.fn();
  const onTyping = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders textarea', () => {
    render(<MessageInput onSendMessage={onSendMessage} />);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('shows channel name in placeholder', () => {
    render(<MessageInput onSendMessage={onSendMessage} channelName="general" />);
    expect(screen.getByPlaceholderText(/general/i)).toBeInTheDocument();
  });

  it('shows encrypted indicator for encrypted channels', () => {
    render(<MessageInput onSendMessage={onSendMessage} isChannelEncrypted={true} />);
    expect(screen.getByText(/encrypted/i)).toBeInTheDocument();
  });

  it('shows unencrypted indicator', () => {
    render(<MessageInput onSendMessage={onSendMessage} isChannelEncrypted={false} />);
    expect(screen.getByText(/NOT using End-to-End Encryption/i)).toBeInTheDocument();
  });

  it('calls onSendMessage on Enter key', async () => {
    const user = userEvent.setup();
    render(<MessageInput onSendMessage={onSendMessage} />);
    const textarea = screen.getByRole('textbox');
    await user.type(textarea, 'Hello world');
    await user.keyboard('{Enter}');
    expect(onSendMessage).toHaveBeenCalledWith('Hello world');
  });

  it('does not send empty message', async () => {
    const user = userEvent.setup();
    render(<MessageInput onSendMessage={onSendMessage} />);
    const textarea = screen.getByRole('textbox');
    await user.click(textarea);
    await user.keyboard('{Enter}');
    expect(onSendMessage).not.toHaveBeenCalled();
  });

  it('clears textarea after sending', async () => {
    const user = userEvent.setup();
    render(<MessageInput onSendMessage={onSendMessage} />);
    const textarea = screen.getByRole('textbox');
    await user.type(textarea, 'Hello');
    await user.keyboard('{Enter}');
    expect(textarea).toHaveValue('');
  });

  it('does not send on Shift+Enter', async () => {
    const user = userEvent.setup();
    render(<MessageInput onSendMessage={onSendMessage} />);
    const textarea = screen.getByRole('textbox');
    await user.type(textarea, 'Hello');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(onSendMessage).not.toHaveBeenCalled();
  });

  it('disables input when disabled prop is true', () => {
    render(<MessageInput onSendMessage={onSendMessage} disabled={true} />);
    expect(screen.getByRole('textbox')).toBeDisabled();
  });
});
