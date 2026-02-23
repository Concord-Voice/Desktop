import { render, screen, fireEvent } from '../../../test-utils';
import { useLayoutStore } from '@/renderer/stores/layoutStore';
import AppLayout from '@/renderer/components/Layout/AppLayout';

describe('AppLayout', () => {
  const defaultProps = {
    serverBar: <div data-testid="server-bar">Server Bar</div>,
    folderBar: <div data-testid="folder-bar">Folder Bar</div>,
    channelPanel: <div data-testid="channel-panel">Channel Panel</div>,
    chatArea: <div data-testid="chat-area">Chat Area</div>,
    memberSpace: <div data-testid="member-space">Member Space</div>,
  };

  beforeEach(() => {
    useLayoutStore.setState({
      channelPanelPinned: true,
      memberPanelMode: 'side',
      serverBarHeight: 56,
      folderBarHeight: 200,
    });
  });

  it('renders all layout sections', () => {
    render(<AppLayout {...defaultProps} />);
    expect(screen.getByTestId('server-bar')).toBeInTheDocument();
    expect(screen.getByTestId('folder-bar')).toBeInTheDocument();
    expect(screen.getByTestId('channel-panel')).toBeInTheDocument();
    expect(screen.getByTestId('chat-area')).toBeInTheDocument();
    expect(screen.getByTestId('member-space')).toBeInTheDocument();
  });

  it('renders app-layout container', () => {
    const { container } = render(<AppLayout {...defaultProps} />);
    expect(container.querySelector('.app-layout')).toBeInTheDocument();
  });

  it('renders server bar section', () => {
    const { container } = render(<AppLayout {...defaultProps} />);
    expect(container.querySelector('.layout-server-bar')).toBeInTheDocument();
  });

  it('renders folder bar section', () => {
    const { container } = render(<AppLayout {...defaultProps} />);
    expect(container.querySelector('.layout-folder-bar')).toBeInTheDocument();
  });

  it('renders resize handles', () => {
    const { container } = render(<AppLayout {...defaultProps} />);
    const resizeHandles = container.querySelectorAll('.layout-resize-handle-h');
    expect(resizeHandles.length).toBeGreaterThanOrEqual(1);
  });

  it('renders chat area section', () => {
    const { container } = render(<AppLayout {...defaultProps} />);
    expect(container.querySelector('.layout-chat-area')).toBeInTheDocument();
  });

  it('renders member space section', () => {
    const { container } = render(<AppLayout {...defaultProps} />);
    expect(container.querySelector('.layout-member-space')).toBeInTheDocument();
  });

  it('sets data-channel-pinned attribute based on store', () => {
    useLayoutStore.setState({ channelPanelPinned: true });
    const { container } = render(<AppLayout {...defaultProps} />);
    const layout = container.querySelector('.app-layout');
    expect(layout?.getAttribute('data-channel-pinned')).toBe('true');
  });

  it('sets data-channel-pinned to true when forceChannelPin is set', () => {
    useLayoutStore.setState({ channelPanelPinned: false });
    const { container } = render(<AppLayout {...defaultProps} forceChannelPin />);
    const layout = container.querySelector('.app-layout');
    expect(layout?.getAttribute('data-channel-pinned')).toBe('true');
  });

  it('sets data-channel-pinned to false when not pinned', () => {
    useLayoutStore.setState({ channelPanelPinned: false });
    const { container } = render(<AppLayout {...defaultProps} />);
    const layout = container.querySelector('.app-layout');
    expect(layout?.getAttribute('data-channel-pinned')).toBe('false');
  });

  it('sets data-member-mode attribute', () => {
    useLayoutStore.setState({ memberPanelMode: 'expanded' });
    const { container } = render(<AppLayout {...defaultProps} />);
    const layout = container.querySelector('.app-layout');
    expect(layout?.getAttribute('data-member-mode')).toBe('expanded');
  });

  it('applies serverBarHeight from store', () => {
    useLayoutStore.setState({ serverBarHeight: 80 });
    const { container } = render(<AppLayout {...defaultProps} />);
    const serverBar = container.querySelector('.layout-server-bar') as HTMLElement;
    expect(serverBar.style.height).toBe('80px');
  });

  it('applies folderBarHeight from store', () => {
    useLayoutStore.setState({ folderBarHeight: 150 });
    const { container } = render(<AppLayout {...defaultProps} />);
    const folderBar = container.querySelector('.layout-folder-bar') as HTMLElement;
    expect(folderBar.style.height).toBe('150px');
  });

  it('renders two resize handles', () => {
    const { container } = render(<AppLayout {...defaultProps} />);
    const resizeHandles = container.querySelectorAll('.layout-resize-handle-h');
    expect(resizeHandles.length).toBe(2);
  });
});
