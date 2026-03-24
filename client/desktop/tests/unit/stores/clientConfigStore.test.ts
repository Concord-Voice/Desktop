import { useClientConfigStore } from '@/renderer/stores/clientConfigStore';
import { resetAllStores } from '../../helpers/store-helpers';

beforeEach(() => {
  resetAllStores();
  useClientConfigStore.setState({
    minVersion: '',
    featureFlags: { voice: true, video: true, e2ee: true },
    mediaPlaneUrl: '',
    turn: { host: '', realm: '' },
    spaUrl: '',
    spaIpcContract: 0,
    lastFetchedAt: null,
  });
});

describe('clientConfigStore', () => {
  it('has correct default values', () => {
    const state = useClientConfigStore.getState();
    expect(state.minVersion).toBe('');
    expect(state.featureFlags).toEqual({ voice: true, video: true, e2ee: true });
    expect(state.mediaPlaneUrl).toBe('');
    expect(state.turn).toEqual({ host: '', realm: '' });
    expect(state.spaUrl).toBe('');
    expect(state.spaIpcContract).toBe(0);
    expect(state.lastFetchedAt).toBeNull();
  });

  it('setConfig updates all fields', () => {
    const before = Date.now();
    useClientConfigStore.getState().setConfig({
      minVersion: '0.2.0',
      featureFlags: { voice: true, video: false, e2ee: true },
      mediaPlaneUrl: 'https://media.concordvoice.chat',
      turn: { host: 'turn.concordvoice.chat', realm: 'concord' },
      spaUrl: 'https://app.concordvoice.chat',
      spaIpcContract: 3,
    });

    const state = useClientConfigStore.getState();
    expect(state.minVersion).toBe('0.2.0');
    expect(state.featureFlags.video).toBe(false);
    expect(state.mediaPlaneUrl).toBe('https://media.concordvoice.chat');
    expect(state.turn.host).toBe('turn.concordvoice.chat');
    expect(state.spaUrl).toBe('https://app.concordvoice.chat');
    expect(state.spaIpcContract).toBe(3);
    expect(state.lastFetchedAt).toBeGreaterThanOrEqual(before);
  });

  it('setConfig sets lastFetchedAt timestamp', () => {
    expect(useClientConfigStore.getState().lastFetchedAt).toBeNull();

    useClientConfigStore.getState().setConfig({
      minVersion: '0.1.0',
      featureFlags: { voice: true, video: true, e2ee: true },
      mediaPlaneUrl: '',
      turn: { host: '', realm: '' },
      spaUrl: '',
      spaIpcContract: 0,
    });

    expect(useClientConfigStore.getState().lastFetchedAt).not.toBeNull();
  });
});
