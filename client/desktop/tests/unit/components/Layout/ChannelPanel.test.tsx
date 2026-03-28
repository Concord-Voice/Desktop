import { render, screen, fireEvent } from '../../../test-utils';
import { useLayoutStore } from '@/renderer/stores/layoutStore';
import ChannelPanel from '@/renderer/components/Layout/ChannelPanel';

// Mock UserPanel to prevent complex rendering
vi.mock('@/renderer/components/User/UserPanel', () => ({
  default: () => <div data-testid="user-panel">User Panel</div>,
}));

// Mock useResizablePanel
vi.mock('@/renderer/hooks/useResizablePanel', () => ({
  useResizablePanel: () => ({
    width: 240,
    onMouseDown: vi.fn(),
  }),
}));

describe('ChannelPanel', () => {
  beforeEach(() => {
    useLayoutStore.setState({
      channelPanelPinned: true,
      channelPanelHoverVisible: false,
    });
  });

  it('renders header and children in pinned mode', () => {
    render(
      <ChannelPanel header={<div>Test Header</div>}>
        <div>Test Content</div>
      </ChannelPanel>
    );
    expect(screen.getByText('Test Header')).toBeInTheDocument();
    expect(screen.getByText('Test Content')).toBeInTheDocument();
  });

  it('renders UserPanel in pinned mode', () => {
    render(
      <ChannelPanel header={<div>Header</div>}>
        <div>Content</div>
      </ChannelPanel>
    );
    expect(screen.getByTestId('user-panel')).toBeInTheDocument();
  });

  it('renders channels-sidebar class in pinned mode', () => {
    const { container } = render(
      <ChannelPanel header={<div>Header</div>}>
        <div>Content</div>
      </ChannelPanel>
    );
    expect(container.querySelector('.channels-sidebar')).toBeInTheDocument();
  });

  it('shows unpin button when pinned', () => {
    render(
      <ChannelPanel header={<div>Header</div>}>
        <div>Content</div>
      </ChannelPanel>
    );
    expect(screen.getByLabelText('Unpin channel panel')).toBeInTheDocument();
  });

  it('hides unpin button when forcePin is true', () => {
    render(
      <ChannelPanel header={<div>Header</div>} forcePin>
        <div>Content</div>
      </ChannelPanel>
    );
    expect(screen.queryByLabelText('Unpin channel panel')).not.toBeInTheDocument();
  });

  it('renders overlay in unpinned mode when hover visible', () => {
    useLayoutStore.setState({
      channelPanelPinned: false,
      channelPanelHoverVisible: true,
    });
    const { container } = render(
      <ChannelPanel header={<div>Header</div>}>
        <div>Content</div>
      </ChannelPanel>
    );
    expect(container.querySelector('.channel-panel-overlay')).toBeInTheDocument();
  });

  it('shows pin button in unpinned mode', () => {
    useLayoutStore.setState({
      channelPanelPinned: false,
      channelPanelHoverVisible: true,
    });
    render(
      <ChannelPanel header={<div>Header</div>}>
        <div>Content</div>
      </ChannelPanel>
    );
    expect(screen.getByLabelText('Pin channel panel')).toBeInTheDocument();
  });

  it('toggles channel pin when unpin button clicked', () => {
    useLayoutStore.setState({ channelPanelPinned: true });
    render(
      <ChannelPanel header={<div>Header</div>}>
        <div>Content</div>
      </ChannelPanel>
    );
    fireEvent.click(screen.getByLabelText('Unpin channel panel'));
    expect(useLayoutStore.getState().channelPanelPinned).toBe(false);
  });

  it('toggles channel pin when pin button clicked in unpinned mode', () => {
    useLayoutStore.setState({ channelPanelPinned: false, channelPanelHoverVisible: true });
    render(
      <ChannelPanel header={<div>Header</div>}>
        <div>Content</div>
      </ChannelPanel>
    );
    fireEvent.click(screen.getByLabelText('Pin channel panel'));
    expect(useLayoutStore.getState().channelPanelPinned).toBe(true);
  });

  it('renders overlay with slide-in class when visible', () => {
    useLayoutStore.setState({ channelPanelPinned: false, channelPanelHoverVisible: true });
    const { container } = render(
      <ChannelPanel header={<div>Header</div>}>
        <div>Content</div>
      </ChannelPanel>
    );
    const overlay = container.querySelector('.channel-panel-overlay');
    expect(overlay?.classList.contains('slide-in')).toBe(true);
  });

  it('renders overlay with slide-out class when not visible', () => {
    useLayoutStore.setState({ channelPanelPinned: false, channelPanelHoverVisible: false });
    const { container } = render(
      <ChannelPanel header={<div>Header</div>}>
        <div>Content</div>
      </ChannelPanel>
    );
    const overlay = container.querySelector('.channel-panel-overlay');
    expect(overlay?.classList.contains('slide-out')).toBe(true);
  });

  it('renders resize handle in pinned mode', () => {
    useLayoutStore.setState({ channelPanelPinned: true });
    const { container } = render(
      <ChannelPanel header={<div>Header</div>}>
        <div>Content</div>
      </ChannelPanel>
    );
    expect(container.querySelector('.layout-resize-handle')).toBeInTheDocument();
  });

  it('renders channels-sidebar-header in pinned mode', () => {
    useLayoutStore.setState({ channelPanelPinned: true });
    const { container } = render(
      <ChannelPanel header={<div>Header</div>}>
        <div>Content</div>
      </ChannelPanel>
    );
    expect(container.querySelector('.channels-sidebar-header')).toBeInTheDocument();
  });
});
