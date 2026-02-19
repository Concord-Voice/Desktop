import { create } from 'zustand';
import { persist, devtools } from 'zustand/middleware';
import { ServerWithRole } from '../types/server';
import { apiFetch } from '../services/apiClient';

interface ServerState {
  servers: ServerWithRole[];
  activeServerId: string | null;
  isLoading: boolean;
  error: string | null;

  fetchServers: () => Promise<void>;
  addServer: (server: ServerWithRole) => void;
  updateServer: (serverId: string, updates: Partial<ServerWithRole>) => void;
  removeServer: (serverId: string) => void;
  setActiveServer: (serverId: string | null) => void;
  clearServers: () => void;
}

export const useServerStore = create<ServerState>()(
  devtools(
    persist(
      (set, get) => ({
        servers: [],
        activeServerId: null,
        isLoading: false,
        error: null,

  fetchServers: async () => {
    set({ isLoading: true, error: null });

    try {
      const response = await apiFetch('/api/v1/servers');

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to load servers');
      }

      const data = await response.json();
      set({ servers: data.servers || [], isLoading: false });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to load servers',
        isLoading: false,
      });
    }
  },

  addServer: (server: ServerWithRole) => {
    set((state) => ({ servers: [server, ...state.servers] }));
  },

  updateServer: (serverId: string, updates: Partial<ServerWithRole>) => {
    set((state) => ({
      servers: state.servers.map((s) =>
        s.id === serverId ? { ...s, ...updates } : s
      ),
    }));
  },

  removeServer: (serverId: string) => {
    const { activeServerId } = get();
    set((state) => ({
      servers: state.servers.filter((s) => s.id !== serverId),
      activeServerId: activeServerId === serverId ? null : activeServerId,
    }));
  },

  setActiveServer: (serverId: string | null) => {
    set({ activeServerId: serverId });
  },

  clearServers: () => {
    set({ servers: [], activeServerId: null, isLoading: false, error: null });
  },
      }),
      {
        name: 'concord-servers',
        partialize: (state) => ({ activeServerId: state.activeServerId }),
      }
    ),
    { name: 'ServerStore' }
  )
);
