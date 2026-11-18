// regression for #247: the join path must never write a roster that shows the
// local user as unmoderated when the join data says they are server-moderated.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('mediasoup-client', () => ({
  Device: class MockDevice {
    load = vi.fn().mockResolvedValue(undefined);
    rtpCapabilities = {};
    loaded = true;
  },
  types: {},
}));

import { voiceService } from '@/renderer/services/voice/voiceService';
import { resetAllStores } from '../../helpers/store-helpers';
import { useVoiceStore } from '@/renderer/stores/voice/voiceStore';
import { useUserStore } from '@/renderer/stores/auth/userStore';

const LOCAL = 'local-user';
const PEER = 'peer-user';

describe('join path seeds the local server moderation in one write (#247)', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any -- private members under test. */
  let svc: any;
  let unsubscribe: () => void;

  beforeEach(() => {
    resetAllStores();
    useUserStore.setState({ user: { id: LOCAL } as any });
    svc = voiceService as any;
    svc.socket = { emit: vi.fn(), on: vi.fn() };
    for (const name of [
      'requireJoinOwnership',
      'createSendTransport',
      'createRecvTransports',
      'setupE2EEForChannel',
      'setupLiveSubscriptions',
      'consumeExistingProducers',
    ]) {
      vi.spyOn(svc, name).mockResolvedValue(undefined);
    }
    vi.spyOn(svc, 'requireJoinOwnership').mockReturnValue(undefined);
    vi.spyOn(svc, 'setupLiveSubscriptions').mockReturnValue(undefined);
    vi.spyOn(svc, 'joinPermitsSpeak').mockReturnValue(false);
    vi.spyOn(svc, 'joinMediaRoom').mockResolvedValue({
      rtpCapabilities: {},
      participants: [
        { userId: LOCAL, username: 'l' },
        { userId: PEER, username: 'p' },
      ],
      existingProducers: [],
    });
  });

  afterEach(() => {
    unsubscribe?.();
    vi.restoreAllMocks();
  });

  it.each([
    ['server-muted', { server_muted: true, server_deafened: false }],
    ['server-deafened', { server_muted: true, server_deafened: true }],
  ])('every store write shows the local user as %s', async (_name, flags) => {
    const seen: Array<{ serverMuted?: boolean; serverDeafened?: boolean }> = [];
    unsubscribe = useVoiceStore.subscribe((state) => {
      const local = state.participants[LOCAL];
      if (local)
        seen.push({ serverMuted: local.serverMuted, serverDeafened: local.serverDeafened });
    });
    const store = useVoiceStore.getState();
    await svc.establishMediaSession(store, 'ch-1', { ...flags }, undefined, 0);
    expect(seen.length, 'the join must write the local participant').toBeGreaterThan(0);
    const expected = { serverMuted: flags.server_muted, serverDeafened: flags.server_deafened };
    for (const entry of seen) {
      expect(entry, 'no store write may show the local user unmoderated').toEqual(expected);
    }
  });
});
