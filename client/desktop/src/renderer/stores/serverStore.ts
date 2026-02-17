import { create } from 'zustand';
import { ServerWithRole } from '../types/server';

interface ServerState {
  servers: ServerWithRole[];
  activeServerId: string | null;
  isLoading: boolean;
  error: string | null;

  fetchServers: (accessToken: string) => Promise<void>;
  addServer: (server: ServerWithRole) => void;
  updateServer: (serverId: string, updates: Partial<ServerWithRole>) => void;
  removeServer: (serverId: string) => void;
  setActiveServer: (serverId: string | null) => void;
  clearServers: () => void;
}

export const useServerStore = create<ServerState>()((set, get) => ({
  servers: [],
  activeServerId: null,
  isLoading: false,
  error: null,

  fetchServers: async (accessToken: string) => {
    set({ isLoading: true, error: null });

    try {
      const response = await fetch('http://localhost:8080/api/v1/servers', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

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
}));
