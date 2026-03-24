import { usePermissionStore } from '@/renderer/stores/permissionStore';
import { useAuthStore } from '@/renderer/stores/authStore';
import { resetAllStores } from '../../helpers/store-helpers';
import { server } from '../../mocks/server';
import { http, HttpResponse } from 'msw';

const API_BASE = 'http://localhost:8080';

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
afterAll(() => server.close());
afterEach(() => server.resetHandlers());

beforeEach(() => {
  resetAllStores();
  useAuthStore.getState().setAccessToken('mock-token');
  usePermissionStore.setState({
    serverRoles: {},
    serverPermissions: {},
    channelOverrides: {},
  });
});

describe('permissionStore', () => {
  describe('hasServerPermission', () => {
    it('returns false when no permissions loaded', () => {
      expect(usePermissionStore.getState().hasServerPermission('server-1', BigInt(1))).toBe(false);
    });

    it('returns true when permission is set', () => {
      usePermissionStore.setState({
        serverPermissions: { 'server-1': BigInt(0b111) },
      });
      expect(usePermissionStore.getState().hasServerPermission('server-1', BigInt(0b001))).toBe(
        true
      );
      expect(usePermissionStore.getState().hasServerPermission('server-1', BigInt(0b100))).toBe(
        true
      );
    });

    it('returns false when permission not in bitmask', () => {
      usePermissionStore.setState({
        serverPermissions: { 'server-1': BigInt(0b001) },
      });
      expect(usePermissionStore.getState().hasServerPermission('server-1', BigInt(0b100))).toBe(
        false
      );
    });
  });

  describe('fetchRoles', () => {
    it('loads roles from API', async () => {
      server.use(
        http.get(`${API_BASE}/api/v1/servers/:id/roles`, () => {
          return HttpResponse.json({
            roles: [
              { id: 'role-1', name: '@all', position: 0, permissions: '1023', is_default: true },
              { id: 'role-2', name: 'Admin', position: 10, permissions: '2047', is_default: false },
            ],
          });
        })
      );

      await usePermissionStore.getState().fetchRoles('server-1');
      const roles = usePermissionStore.getState().serverRoles['server-1'];
      expect(roles).toHaveLength(2);
      expect(roles[0].name).toBe('@all');
    });
  });

  describe('createRole', () => {
    it('creates a role via API', async () => {
      server.use(
        http.post(`${API_BASE}/api/v1/servers/:id/roles`, () => {
          return HttpResponse.json(
            {
              role: {
                id: 'role-new',
                name: 'Moderator',
                position: 5,
                permissions: '128',
              },
            },
            { status: 201 }
          );
        })
      );

      // Pre-populate roles so we can verify the new one is added
      usePermissionStore.setState({ serverRoles: { 'server-1': [] } });

      const result = await usePermissionStore
        .getState()
        .createRole('server-1', { name: 'Moderator', permissions: '128' });
      expect(result).not.toBeNull();
    });
  });

  describe('deleteRole', () => {
    it('deletes a role via API', async () => {
      server.use(
        http.delete(`${API_BASE}/api/v1/servers/:id/roles/:roleId`, () => {
          return HttpResponse.json({ message: 'Role deleted' });
        })
      );

      usePermissionStore.setState({
        serverRoles: {
          'server-1': [
            {
              id: 'role-del',
              name: 'ToDelete',
              position: 3,
              permissions: '0',
              server_id: 'server-1',
              is_default: false,
              is_managed: false,
              created_at: '',
              updated_at: '',
            },
          ],
        },
      });

      const result = await usePermissionStore.getState().deleteRole('server-1', 'role-del');
      expect(result).toBe(true);
    });
  });

  describe('fetchServerPermissions', () => {
    it('loads effective permissions', async () => {
      server.use(
        http.get(`${API_BASE}/api/v1/servers/:id/permissions`, () => {
          return HttpResponse.json({ permissions: '1023' });
        })
      );

      await usePermissionStore.getState().fetchServerPermissions('server-1');
      const perms = usePermissionStore.getState().serverPermissions['server-1'];
      expect(perms).toBeDefined();
    });
  });

  describe('channel overrides', () => {
    it('fetches channel overrides', async () => {
      server.use(
        http.get(`${API_BASE}/api/v1/channels/:id/overrides`, () => {
          return HttpResponse.json({
            overrides: [
              {
                id: 'ov-1',
                channel_id: 'ch-1',
                target_type: 'role',
                target_id: 'role-1',
                allow: '0',
                deny: '2048',
                created_at: '2025-01-01T00:00:00Z',
                updated_at: '2025-01-01T00:00:00Z',
              },
            ],
          });
        })
      );

      await usePermissionStore.getState().fetchChannelOverrides('ch-1');
      const overrides = usePermissionStore.getState().channelOverrides['ch-1'];
      expect(overrides).toHaveLength(1);
    });
  });
});
