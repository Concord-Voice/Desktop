/** Persisted channel identifiers shared by update preferences and consumers. */
export const UPDATE_CHANNELS = ['stable', 'prerelease', 'pilot'] as const;
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];
export type RemoteSpaChannel = Exclude<UpdateChannel, 'pilot'>;

export function isUpdateChannel(value: unknown): value is UpdateChannel {
  return value === 'stable' || value === 'prerelease' || value === 'pilot';
}

/** Pilot always uses its bundled renderer. */
export function remoteSpaChannel(channel: UpdateChannel): RemoteSpaChannel | null {
  return channel === 'pilot' ? null : channel;
}
