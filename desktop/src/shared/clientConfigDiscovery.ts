import { remoteSpaChannel, type UpdateChannel } from './updateChannel';

/** Held until signed channel metadata and channel-aware cache selection are wired. */
export const SPA_DISCOVERY_CHANNEL: UpdateChannel = 'stable';

/** Pilot uses this endpoint only for generic config, never remote SPA discovery. */
export function clientConfigPath(channel: UpdateChannel, ipcContract?: number): string {
  const remoteChannel = remoteSpaChannel(channel);
  if (remoteChannel === null) return '/api/v1/client/config';

  const query = new URLSearchParams({ channel: remoteChannel });
  if (ipcContract !== undefined) query.set('ipc', String(ipcContract));
  return `/api/v1/client/config?${query.toString()}`;
}
