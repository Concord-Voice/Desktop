import { useLayoutStore } from '@/renderer/stores/layoutStore';
import { resetAllStores } from '../../helpers/store-helpers';

describe('layoutStore', () => {
  beforeEach(() => {
    resetAllStores();
    // Reset layout store to defaults
    useLayoutStore.setState({
      channelPanelPinned: true,
      channelPanelWidth: 240,
      memberPanelMode: 'expanded',
      memberPanelWidth: 240,
      serverBarHeight: 48,
      folderBarHeight: 32,
      serverFolders: [],
      serverOrder: [],
      channelPanelHoverVisible: false,
    });
  });

  describe('channel panel', () => {
    it('toggles channel pin', () => {
      const initial = useLayoutStore.getState().channelPanelPinned;
      useLayoutStore.getState().toggleChannelPin();
      expect(useLayoutStore.getState().channelPanelPinned).toBe(!initial);
    });

    it('clamps channel panel width to valid range', () => {
      useLayoutStore.getState().setChannelPanelWidth(100);
      expect(useLayoutStore.getState().channelPanelWidth).toBe(180);
      useLayoutStore.getState().setChannelPanelWidth(500);
      expect(useLayoutStore.getState().channelPanelWidth).toBe(400);
    });

    it('accepts valid width', () => {
      useLayoutStore.getState().setChannelPanelWidth(300);
      expect(useLayoutStore.getState().channelPanelWidth).toBe(300);
    });
  });

  describe('member panel', () => {
    it('sets member panel mode', () => {
      useLayoutStore.getState().setMemberPanelMode('collapsed');
      expect(useLayoutStore.getState().memberPanelMode).toBe('collapsed');
    });

    it('cycles member panel mode', () => {
      useLayoutStore.getState().setMemberPanelMode('expanded');
      useLayoutStore.getState().cycleMemberPanelMode();
      expect(useLayoutStore.getState().memberPanelMode).toBe('collapsed');
      useLayoutStore.getState().cycleMemberPanelMode();
      expect(useLayoutStore.getState().memberPanelMode).toBe('hidden');
      useLayoutStore.getState().cycleMemberPanelMode();
      expect(useLayoutStore.getState().memberPanelMode).toBe('expanded');
    });

    it('clamps member panel width', () => {
      useLayoutStore.getState().setMemberPanelWidth(100);
      expect(useLayoutStore.getState().memberPanelWidth).toBe(160);
      useLayoutStore.getState().setMemberPanelWidth(500);
      expect(useLayoutStore.getState().memberPanelWidth).toBe(340);
    });
  });

  describe('server bar', () => {
    it('clamps server bar height', () => {
      useLayoutStore.getState().setServerBarHeight(20);
      expect(useLayoutStore.getState().serverBarHeight).toBe(36);
      useLayoutStore.getState().setServerBarHeight(100);
      expect(useLayoutStore.getState().serverBarHeight).toBe(64);
    });

    it('clamps folder bar height', () => {
      useLayoutStore.getState().setFolderBarHeight(10);
      expect(useLayoutStore.getState().folderBarHeight).toBe(24);
      useLayoutStore.getState().setFolderBarHeight(100);
      expect(useLayoutStore.getState().folderBarHeight).toBe(48);
    });
  });

  describe('server folders', () => {
    it('creates a folder', () => {
      useLayoutStore.getState().createFolder('Gaming');
      const folders = useLayoutStore.getState().serverFolders;
      expect(folders).toHaveLength(1);
      expect(folders[0].name).toBe('Gaming');
    });

    it('renames a folder', () => {
      useLayoutStore.getState().createFolder('Gaming');
      const folderId = useLayoutStore.getState().serverFolders[0].id;
      useLayoutStore.getState().renameFolder(folderId, 'Work');
      expect(useLayoutStore.getState().serverFolders[0].name).toBe('Work');
    });

    it('deletes a folder', () => {
      useLayoutStore.getState().createFolder('Gaming');
      const folderId = useLayoutStore.getState().serverFolders[0].id;
      useLayoutStore.getState().deleteFolder(folderId);
      expect(useLayoutStore.getState().serverFolders).toHaveLength(0);
    });

    it('moves server to folder', () => {
      useLayoutStore.getState().createFolder('Gaming');
      const folderId = useLayoutStore.getState().serverFolders[0].id;
      useLayoutStore.setState({ serverOrder: ['server-1', 'server-2'] });
      useLayoutStore.getState().moveServerToFolder('server-1', folderId);
      expect(useLayoutStore.getState().serverFolders[0].serverIds).toContain('server-1');
    });

    it('removes server from folder', () => {
      useLayoutStore.getState().createFolder('Gaming', ['server-1']);
      useLayoutStore.getState().removeServerFromFolder('server-1');
      expect(useLayoutStore.getState().serverFolders[0].serverIds).not.toContain('server-1');
      expect(useLayoutStore.getState().serverOrder).toContain('server-1');
    });
  });

  describe('reorderServers', () => {
    it('reorders server list', () => {
      useLayoutStore.getState().reorderServers(['server-2', 'server-1']);
      expect(useLayoutStore.getState().serverOrder).toEqual(['server-2', 'server-1']);
    });
  });
});
