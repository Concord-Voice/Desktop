import { useInviteStore } from '@/renderer/stores/inviteStore';
import { resetAllStores } from '../../helpers/store-helpers';

describe('inviteStore', () => {
  beforeEach(() => {
    resetAllStores();
  });

  it('starts with empty state', () => {
    const state = useInviteStore.getState();
    expect(state.invites).toEqual({});
    expect(state.isLoading).toBe(false);
    expect(state.error).toBeNull();
  });

  describe('clearInvites', () => {
    it('clears all invite data', () => {
      // Directly set some state for testing
      useInviteStore.setState({
        invites: {
          'server-1': [
            {
              id: 'invite-1',
              server_id: 'server-1',
              code: 'ABC12345',
              created_by: 'user-1',
              creator_username: 'testuser',
              max_uses: null,
              use_count: 0,
              expires_at: null,
              is_revoked: false,
              created_at: '2025-01-01T00:00:00Z',
            },
          ],
        },
      });
      useInviteStore.getState().clearInvites();
      expect(useInviteStore.getState().invites).toEqual({});
    });
  });
});
