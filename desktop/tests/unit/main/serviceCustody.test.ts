// @vitest-environment node
// #86 PR 206 review row 11: a custody's proactive refresh is tagged with its own service.
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ custodyFor: vi.fn() }));
vi.mock('../../../src/main/tokenManager', () => ({ custodyFor: h.custodyFor }));

import { makeServiceCustody } from '../../../src/main/serviceCustody';

type RefreshCb = (accessToken: string, sessionId: string, previousSessionId: string) => void;

describe('makeServiceCustody', () => {
  it("hands each proactive refresh to the callback with that custody's own serviceId", () => {
    const callbacks = new Map<string, RefreshCb>();
    h.custodyFor.mockImplementation((serviceId: string) => ({
      setProactiveRefreshCallback: vi.fn((cb: RefreshCb) => callbacks.set(serviceId, cb)),
    }));
    const onRefresh = vi.fn();

    const a = makeServiceCustody('svc-a' as never, 'https://a.example', onRefresh);
    makeServiceCustody('svc-b' as never, 'https://b.example', onRefresh);

    expect(h.custodyFor.mock.calls).toEqual([
      ['svc-a', 'https://a.example'],
      ['svc-b', 'https://b.example'],
    ]);
    expect(a).toBe(h.custodyFor.mock.results[0].value);
    callbacks.get('svc-b')?.('tok-b', 'sess-b', 'prev-b');
    callbacks.get('svc-a')?.('tok-a', 'sess-a', 'prev-a');
    expect(onRefresh.mock.calls).toEqual([
      ['svc-b', 'tok-b', 'sess-b', 'prev-b'],
      ['svc-a', 'tok-a', 'sess-a', 'prev-a'],
    ]);
  });
});
