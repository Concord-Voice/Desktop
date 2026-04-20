import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '../../../test-utils';
import MessageInput from '@/renderer/components/Chat/MessageInput';
import { resetAllStores } from '../../../helpers/store-helpers';
import userEvent from '@testing-library/user-event';

// Mock child components and stores that MessageInput depends on
vi.mock('@/renderer/components/Chat/MessageInputContextMenu', () => ({
  default: () => null,
}));
vi.mock('@/renderer/components/User/UserPanel', () => ({
  default: () => <div data-testid="user-panel" />,
}));
vi.mock('@/renderer/stores/layoutStore', () => ({
  useLayoutStore: () => false,
}));

const defaultProps = {
  channelId: 'c1',
  onSendMessage: vi.fn(),
  canAttachFiles: false,
};

describe('MessageInput markdown UX', () => {
  beforeEach(() => {
    resetAllStores();
  });

  it('shows the hint text with the ? help icon', () => {
    render(<MessageInput {...defaultProps} />);
    expect(screen.getByText(/Supports/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/markdown syntax help/i)).toBeInTheDocument();
  });

  it('opens the SyntaxHelpModal when ? clicked', async () => {
    render(<MessageInput {...defaultProps} />);
    await userEvent.click(screen.getByLabelText(/markdown syntax help/i));
    expect(screen.getByText(/Supported Markdown Syntax/i)).toBeInTheDocument();
  });

  it('does not show character counter below 75% capacity', async () => {
    render(<MessageInput {...defaultProps} />);
    const textarea = screen.getByRole('textbox');
    await userEvent.type(textarea, 'a'.repeat(100));
    expect(screen.queryByText(/\/24000/)).not.toBeInTheDocument();
  });

  it('shows character counter at >=18000 chars', () => {
    render(<MessageInput {...defaultProps} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'a'.repeat(18000) } });
    expect(screen.getByText(/18000\/24000/)).toBeInTheDocument();
  });

  it('shows warning class at >=22800 chars', () => {
    render(<MessageInput {...defaultProps} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'a'.repeat(22800) } });
    const counter = screen.getByText(/22800\/24000/);
    expect(counter.className).toContain('warn');
  });

  it('disables submit when over 24000 chars', () => {
    render(<MessageInput {...defaultProps} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'a'.repeat(24001) } });
    const submit = screen.getByRole('button', { name: /send/i });
    expect(submit).toBeDisabled();
  });
});
