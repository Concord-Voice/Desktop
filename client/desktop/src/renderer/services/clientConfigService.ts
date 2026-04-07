/**
 * Client Config Polling Service — fetches server-pushed configuration
 * (feature flags, min version, TURN/media-plane URLs) on a periodic interval.
 *
 * The endpoint GET /api/v1/client/config is public (pre-auth), and we poll
 * from the App root so minVersion enforcement works regardless of auth state.
 */

import { apiFetch } from './apiClient';
import { useClientConfigStore } from '../stores/clientConfigStore';

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const STARTUP_DELAY_MS = 2_000; // 2s after mount — let auth + profile settle first

interface ServerConfigResponse {
  minVersion: string;
  featureFlags: { voice: boolean; video: boolean; e2ee: boolean; klipyApiKey?: string };
  mediaPlaneUrl: string;
  turn: { host?: string; realm?: string };
  spaUrl?: string;
  spaIpcContract?: number;
}

class ClientConfigService {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;

  /** Fetch config from server and apply to store. */
  async fetch(): Promise<void> {
    try {
      const res = await apiFetch('/api/v1/client/config');
      if (!res.ok) {
        console.warn('[ClientConfig] Fetch failed:', res.status);
        return;
      }

      const data: ServerConfigResponse = await res.json();
      useClientConfigStore.getState().setConfig({
        minVersion: data.minVersion,
        featureFlags: data.featureFlags,
        mediaPlaneUrl: data.mediaPlaneUrl,
        turn: { host: data.turn?.host ?? '', realm: data.turn?.realm ?? '' },
        spaUrl: data.spaUrl || '',
        spaIpcContract: data.spaIpcContract || 0,
      });

      console.debug('[ClientConfig] Updated config, minVersion:', data.minVersion || '(none)');
    } catch (err) {
      console.warn('[ClientConfig] Fetch error:', err);
    }
  }

  /** Start polling. Safe to call multiple times — stops previous timers first. */
  start(): void {
    this.stop();

    // Initial fetch after short delay
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      this.fetch();
    }, STARTUP_DELAY_MS);

    // Periodic polling
    this.pollTimer = setInterval(() => {
      this.fetch();
    }, POLL_INTERVAL_MS);
  }

  /** Stop polling and clear all timers. */
  stop(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}

// Singleton
export const clientConfigService = new ClientConfigService();
