import { render, screen, fireEvent } from '../../../test-utils';
import { useServerStore } from '@/renderer/stores/serverStore';
import { useLayoutStore } from '@/renderer/stores/layoutStore';
import { useUnreadStore } from '@/renderer/stores/unreadStore';
import { mockServer, mockServer2 } from '../../../mocks/fixtures';
import FolderBar from '@/renderer/components/Layout/FolderBar';

describe('FolderBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useServerStore.setState({
      servers: [],
      activeServerId: null,
    });
    useLayoutStore.setState({
      serverFolders: [],
      folderBarHeight: 36,
    });
    useUnreadStore.setState({
      serverUnreadSet: new Set(),
    });
  });

  it('renders without crashing', () => {
    const { container } = render(<FolderBar />);
    expect(container).toBeTruthy();
  });

  it('renders folder items when folders exist', () => {
    useLayoutStore.setState({
      serverFolders: [
        { id: 'folder-1', name: 'My Folder', serverIds: [], collapsed: false },
      ],
    });
    render(<FolderBar />);
    expect(screen.getByText('My Folder')).toBeInTheDocument();
  });

  it('renders create folder button', () => {
    render(<FolderBar />);
    const addBtn = screen.getByText('New Folder');
    expect(addBtn).toBeInTheDocument();
  });

  it('toggles folder open/close on click', () => {
    useLayoutStore.setState({
      serverFolders: [
        { id: 'folder-1', name: 'My Folder', serverIds: ['server-1'], collapsed: false },
      ],
    });
    useServerStore.setState({ servers: [mockServer] });
    render(<FolderBar />);
    // Click folder to toggle
    const folderBtn = screen.getByText('My Folder');
    fireEvent.click(folderBtn);
    // Clicking again toggles
    fireEvent.click(folderBtn);
  });

  it('shows folder context menu on right click', () => {
    useLayoutStore.setState({
      serverFolders: [
        { id: 'folder-1', name: 'My Folder', serverIds: [], collapsed: false },
      ],
    });
    render(<FolderBar />);
    fireEvent.contextMenu(screen.getByText('My Folder'));
    expect(screen.getByText('Rename Folder')).toBeInTheDocument();
    expect(screen.getByText('Delete Folder')).toBeInTheDocument();
  });

  it('renders multiple folders', () => {
    useLayoutStore.setState({
      serverFolders: [
        { id: 'folder-1', name: 'Games', serverIds: [], collapsed: false },
        { id: 'folder-2', name: 'Work', serverIds: [], collapsed: false },
      ],
    });
    render(<FolderBar />);
    expect(screen.getByText('Games')).toBeInTheDocument();
    expect(screen.getByText('Work')).toBeInTheDocument();
  });

  it('shows server names inside expanded folder', () => {
    useLayoutStore.setState({
      serverFolders: [
        { id: 'folder-1', name: 'My Folder', serverIds: ['server-1', 'server-2'], collapsed: false },
      ],
    });
    useServerStore.setState({ servers: [mockServer, mockServer2] });
    render(<FolderBar />);
    // Click folder chip to open the dropdown
    fireEvent.click(screen.getByText('My Folder'));
    expect(screen.getByText('Test Server')).toBeInTheDocument();
    expect(screen.getByText('Second Server')).toBeInTheDocument();
  });

  it('hides server names when folder is not clicked open', () => {
    useLayoutStore.setState({
      serverFolders: [
        { id: 'folder-1', name: 'My Folder', serverIds: ['server-1'], collapsed: false },
      ],
    });
    useServerStore.setState({ servers: [mockServer] });
    render(<FolderBar />);
    expect(screen.getByText('My Folder')).toBeInTheDocument();
    // Server names should not be visible until folder is clicked open
    expect(screen.queryByText('Test Server')).not.toBeInTheDocument();
  });

  it('creates a new folder when New Folder is clicked', () => {
    render(<FolderBar />);
    fireEvent.click(screen.getByText('New Folder'));
    // After clicking, a new folder with a rename input should appear
    const state = useLayoutStore.getState();
    expect(state.serverFolders.length).toBe(1);
  });

  it('shows unread indicator on folder with unread servers', () => {
    useLayoutStore.setState({
      serverFolders: [
        { id: 'folder-1', name: 'My Folder', serverIds: ['server-1'], collapsed: true },
      ],
    });
    useServerStore.setState({ servers: [mockServer] });
    useUnreadStore.setState({ serverUnreadSet: new Set(['server-1']) });
    const { container } = render(<FolderBar />);
    const unreadBadge = container.querySelector('.folder-chip-badge');
    expect(unreadBadge).toBeInTheDocument();
  });

  it('renders folder bar container', () => {
    const { container } = render(<FolderBar />);
    expect(container.querySelector('.folder-bar')).toBeInTheDocument();
  });
});
