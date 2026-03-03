/**
 * Lazy-load wrapper for voice services (#74 — frontend performance).
 *
 * mediasoup-client (~200KB) and socket.io-client (~50KB) are heavy dependencies
 * that are only needed when a user actually joins a voice channel. This module
 * ensures they are code-split into a separate chunk and loaded on demand.
 *
 * Usage:
 *   const { voiceService } = await getVoiceService();
 *   await voiceService.joinChannel(channelId);
 */

let voiceServiceModule: typeof import('./voiceService') | null = null;

/** Lazily load and cache the voice service module */
export async function getVoiceService() {
  if (!voiceServiceModule) {
    voiceServiceModule = await import('./voiceService');
  }
  return voiceServiceModule;
}
