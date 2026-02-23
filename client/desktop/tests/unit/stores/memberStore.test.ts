import { useMemberStore } from '@/renderer/stores/memberStore';
import { resetAllStores } from '../../helpers/store-helpers';
import { mockMember, mockMember2 } from '../../mocks/fixtures';

describe('memberStore', () => {
  beforeEach(() => {
    resetAllStores();
  });

  describe('addMember', () => {
    it('adds a member', () => {
      useMemberStore.getState().addMember(mockMember);
      expect(useMemberStore.getState().members).toHaveLength(1);
      expect(useMemberStore.getState().members[0].user_id).toBe('user-1');
    });

    it('prevents duplicate members', () => {
      useMemberStore.getState().addMember(mockMember);
      useMemberStore.getState().addMember(mockMember);
      expect(useMemberStore.getState().members).toHaveLength(1);
    });
  });

  describe('removeMember', () => {
    it('removes a member by userId', () => {
      useMemberStore.getState().addMember(mockMember);
      useMemberStore.getState().addMember(mockMember2);
      useMemberStore.getState().removeMember('user-1');
      expect(useMemberStore.getState().members).toHaveLength(1);
      expect(useMemberStore.getState().members[0].user_id).toBe('user-2');
    });
  });

  describe('setOnlineUsers', () => {
    it('sets online user IDs', () => {
      useMemberStore.getState().setOnlineUsers(['user-1', 'user-2']);
      expect(useMemberStore.getState().onlineUserIds.has('user-1')).toBe(true);
      expect(useMemberStore.getState().onlineUserIds.has('user-2')).toBe(true);
    });

    it('preserves DND status when updating online users', () => {
      useMemberStore.getState().setUserStatus('user-1', 'dnd');
      useMemberStore.getState().setOnlineUsers(['user-1', 'user-2']);
      expect(useMemberStore.getState().userStatuses.get('user-1')).toBe('dnd');
    });
  });

  describe('setUserStatus', () => {
    it('sets specific status', () => {
      useMemberStore.getState().setUserStatus('user-1', 'dnd');
      expect(useMemberStore.getState().userStatuses.get('user-1')).toBe('dnd');
    });

    it('adds to onlineUserIds for non-offline status', () => {
      useMemberStore.getState().setUserStatus('user-1', 'online');
      expect(useMemberStore.getState().onlineUserIds.has('user-1')).toBe(true);
    });

    it('removes from onlineUserIds for offline status', () => {
      useMemberStore.getState().setUserStatus('user-1', 'online');
      useMemberStore.getState().setUserStatus('user-1', 'offline');
      expect(useMemberStore.getState().onlineUserIds.has('user-1')).toBe(false);
    });
  });

  describe('setPresenceSnapshot', () => {
    it('bulk sets presence', () => {
      useMemberStore.getState().setPresenceSnapshot([
        { user_id: 'user-1', status: 'online' },
        { user_id: 'user-2', status: 'dnd' },
      ]);
      expect(useMemberStore.getState().onlineUserIds.has('user-1')).toBe(true);
      expect(useMemberStore.getState().userStatuses.get('user-2')).toBe('dnd');
    });
  });

  describe('clearMembers', () => {
    it('clears members list', () => {
      useMemberStore.getState().addMember(mockMember);
      useMemberStore.getState().clearMembers();
      expect(useMemberStore.getState().members).toHaveLength(0);
    });
  });
});
