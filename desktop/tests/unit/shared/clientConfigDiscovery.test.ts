import { describe, expect, it } from 'vitest';
import { clientConfigPath, SPA_DISCOVERY_CHANNEL } from '@/shared/clientConfigDiscovery';
import { isUpdateChannel, remoteSpaChannel, UPDATE_CHANNELS } from '@/shared/updateChannel';

describe('channel discovery policy', () => {
  it('holds production discovery on Stable', () => {
    expect(SPA_DISCOVERY_CHANNEL).toBe('stable');
    expect(clientConfigPath(SPA_DISCOVERY_CHANNEL)).toBe('/api/v1/client/config?channel=stable');
  });

  it.each(['stable', 'prerelease'] as const)(
    'requests the exact %s stream and retains IPC',
    (channel) => {
      expect(clientConfigPath(channel)).toBe(`/api/v1/client/config?channel=${channel}`);
      expect(clientConfigPath(channel, 7)).toBe(`/api/v1/client/config?channel=${channel}&ipc=7`);
      expect(remoteSpaChannel(channel)).toBe(channel);
    }
  );

  it('keeps Pilot generic config separate from remote SPA discovery', () => {
    expect(remoteSpaChannel('pilot')).toBeNull();
    expect(clientConfigPath('pilot', 7)).toBe('/api/v1/client/config');
  });

  it('recognizes only the closed persisted channel identifiers', () => {
    for (const channel of UPDATE_CHANNELS) expect(isUpdateChannel(channel)).toBe(true);
    for (const other of [undefined, null, '', 'Stable', ' prerelease', 'unknown', 1]) {
      expect(isUpdateChannel(other)).toBe(false);
    }
  });
});
