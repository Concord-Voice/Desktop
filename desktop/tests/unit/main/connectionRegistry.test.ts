// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceId } from '../../../src/shared/connectionIdentity';
import { isConnectionId } from '../../../src/shared/connectionIdentity';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/concord-test-userdata' } }));

const profile = vi.hoisted(() => ({
  idOverride: null as ((apiBase: string) => string | null) | null,
}));
vi.mock('../../../src/main/selfHostedProfile', async () => {
  const actual = await vi.importActual<typeof import('../../../src/main/selfHostedProfile')>(
    '../../../src/main/selfHostedProfile'
  );
  return {
    ...actual,
    serviceIdForApiBase: (apiBase: string) =>
      profile.idOverride?.(apiBase) ?? actual.serviceIdForApiBase(apiBase),
  };
});

import {
  MAX_LIVE_CONNECTIONS,
  _resetConnectionRegistryForTesting,
  advanceGeneration,
  bindSender,
  bindingFor,
  disposeConnection,
  foreground,
  getService,
  liveConnections,
  mintConnectionId,
  onGenerationAdvanced,
  openConnection,
  primaries,
  recordFor,
  refOf,
  registerService,
  serviceForOrigin,
  setForeground,
} from '../../../src/main/connectionRegistry';

const SAAS_ORIGIN = 'https://api.concordvoice.chat';
const A = new URL('https://a.example').origin;
const B = new URL('https://b.example:8443').origin;

function deps(validated = true) {
  return {
    makeSession: vi.fn(() => ({ fake: 'session' }) as never),
    makeCustody: vi.fn(() => ({}) as never),
    isValidatedSelfHostedApiBase: vi.fn(() => validated),
  };
}
const wcObj = (id = 1) => ({ id, fake: true }) as never;

function mustRegister(origin: string, d = deps()) {
  const r = registerService(origin, d);
  if (!r.ok) throw new Error(`register failed: ${r.reason}`);
  return r.service;
}
function mustOpen(serviceId: ServiceId, wc = wcObj()) {
  const r = openConnection(serviceId, wc, null);
  if (!r.ok) throw new Error(`open failed: ${r.reason}`);
  return r.record;
}

beforeEach(() => {
  _resetConnectionRegistryForTesting();
  profile.idOverride = null;
});

describe('registerService', () => {
  it('returns the same record for the same origin twice', () => {
    const d = deps();
    const first = mustRegister(A, d);
    const second = mustRegister(A, d);
    expect(second).toBe(first);
    expect(getService(first.serviceId)).toBe(first);
    expect(serviceForOrigin(A)).toBe(first);
  });

  it('registers saas with the saas service id', () => {
    const s = mustRegister(SAAS_ORIGIN);
    expect(s.serviceId).toBe('saas');
    expect(s.kind).toBe('saas');
  });

  it('refuses a service-id collision and leaves the origin map unchanged', () => {
    const first = mustRegister(A);
    profile.idOverride = () => first.serviceId;
    const r = registerService(B, deps());
    expect(r).toEqual({ ok: false, reason: 'service-id-collision' });
    expect(serviceForOrigin(B)).toBeUndefined();
    expect(serviceForOrigin(A)).toBe(first);
  });

  it('refuses a self-hosted origin that is not validated', () => {
    expect(registerService(A, deps(false))).toEqual({ ok: false, reason: 'not-approved' });
  });

  it('refuses an unparseable origin', () => {
    expect(registerService('not a url', deps())).toEqual({ ok: false, reason: 'invalid-origin' });
  });
});

describe('openConnection', () => {
  it('refuses an unknown service', () => {
    const r = openConnection('selfhost-0123456789abcdef' as ServiceId, wcObj(), null);
    expect(r).toEqual({ ok: false, reason: 'unknown-service' });
  });

  it('refuses a second connection for the same service', () => {
    const s = mustRegister(A);
    mustOpen(s.serviceId);
    expect(openConnection(s.serviceId, wcObj(2), null)).toEqual({
      ok: false,
      reason: 'already-open',
    });
  });

  it('refuses the MAX_LIVE_CONNECTIONS + 1th connection', () => {
    for (let i = 0; i < MAX_LIVE_CONNECTIONS; i++) {
      const s = mustRegister(`https://h${i}.example`);
      mustOpen(s.serviceId, wcObj(i));
    }
    const extra = mustRegister('https://extra.example');
    expect(openConnection(extra.serviceId, wcObj(99), null)).toEqual({
      ok: false,
      reason: 'limit',
    });
  });

  it('starts records at generation 1 in the loading state', () => {
    const s = mustRegister(A);
    const rec = mustOpen(s.serviceId);
    expect(rec.generation).toBe(1);
    expect(rec.state).toBe('loading');
    expect(refOf(rec)).toEqual({ connectionId: rec.connectionId, generation: 1 });
    expect(recordFor(rec.connectionId)).toBe(rec);
    expect(liveConnections()).toEqual([rec]);
  });
});

describe('mintConnectionId', () => {
  it('mints valid, distinct ids', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const id = mintConnectionId();
      expect(isConnectionId(id)).toBe(true);
      seen.add(id);
    }
    expect(seen.size).toBe(1000);
  });
});

describe('advanceGeneration', () => {
  it('is strictly increasing starting at 2 and notifies listeners', () => {
    const rec = mustOpen(mustRegister(A).serviceId);
    const seen: unknown[][] = [];
    onGenerationAdvanced((...args) => seen.push(args));
    expect(advanceGeneration(rec.connectionId, 'document')).toBe(2);
    expect(advanceGeneration(rec.connectionId, 'credential-start')).toBe(3);
    expect(advanceGeneration(rec.connectionId, 'credential-end')).toBe(4);
    expect(seen).toEqual([
      [rec.connectionId, 1, 2, 'document'],
      [rec.connectionId, 2, 3, 'credential-start'],
      [rec.connectionId, 3, 4, 'credential-end'],
    ]);
    expect(recordFor(rec.connectionId)?.generation).toBe(4);
  });

  it('stops delivery after unsubscribe', () => {
    const rec = mustOpen(mustRegister(A).serviceId);
    const l = vi.fn();
    const off = onGenerationAdvanced(l);
    advanceGeneration(rec.connectionId, 'document');
    off();
    advanceGeneration(rec.connectionId, 'document');
    expect(l).toHaveBeenCalledTimes(1);
  });
});

describe('sender bindings', () => {
  it('keys bindings by object identity, not by field equality', () => {
    const rec = mustOpen(mustRegister(A).serviceId);
    const one = { id: 7 } as never;
    const twin = { id: 7 } as never;
    bindSender(one, rec.connectionId, 'primary');
    expect(bindingFor(one)).toEqual({ connectionId: rec.connectionId, role: 'primary' });
    expect(bindingFor(twin)).toBeUndefined();
  });

  it('resolves a pip to the opener connection with role pip', () => {
    const rec = mustOpen(mustRegister(A).serviceId);
    const pip = wcObj(50);
    bindSender(pip, rec.connectionId, 'pip');
    expect(bindingFor(pip)).toEqual({ connectionId: rec.connectionId, role: 'pip' });
  });

  it('primaries() lists only primary webContents', () => {
    const rec = mustOpen(mustRegister(A).serviceId, wcObj(1));
    bindSender(rec.webContents, rec.connectionId, 'primary');
    bindSender(wcObj(2), rec.connectionId, 'pip');
    expect(primaries()).toEqual([rec.webContents]);
  });
});

describe('disposeConnection', () => {
  it("fires 'disposed', clears foreground, and removes the record", () => {
    const rec = mustOpen(mustRegister(A).serviceId);
    setForeground(rec.connectionId);
    expect(foreground()).toBe(rec);
    const l = vi.fn();
    onGenerationAdvanced(l);
    disposeConnection(rec.connectionId);
    expect(l).toHaveBeenCalledWith(rec.connectionId, 1, 2, 'disposed');
    expect(rec.state).toBe('disposed');
    expect(foreground()).toBeNull();
    expect(recordFor(rec.connectionId)).toBeUndefined();
    expect(liveConnections()).toEqual([]);
  });

  it('leaves foreground alone when another connection is disposed', () => {
    const a = mustOpen(mustRegister(A).serviceId, wcObj(1));
    const b = mustOpen(mustRegister(B).serviceId, wcObj(2));
    setForeground(a.connectionId);
    disposeConnection(b.connectionId);
    expect(foreground()).toBe(a);
  });
});

describe('hardening (guards added beyond the plan matrix)', () => {
  it('generation cannot be assigned or redefined from outside the registry', () => {
    const rec = mustOpen(mustRegister(A).serviceId);
    expect(() => {
      (rec as unknown as { generation: number }).generation = 99;
    }).toThrow(TypeError);
    expect(() => Object.defineProperty(rec, 'generation', { value: 99 })).toThrow(TypeError);
    expect(rec.generation).toBe(1);
  });

  it('refuses to rebind a webContents to another connection or role; same binding is idempotent', () => {
    const a = mustOpen(mustRegister(A).serviceId, wcObj(1));
    const b = mustOpen(mustRegister(B).serviceId, wcObj(2));
    bindSender(a.webContents, a.connectionId, 'primary');
    expect(() => bindSender(a.webContents, a.connectionId, 'primary')).not.toThrow();
    expect(() => bindSender(a.webContents, b.connectionId, 'primary')).toThrow();
    expect(() => bindSender(a.webContents, a.connectionId, 'pip')).toThrow();
    expect(bindingFor(a.webContents)).toEqual({ connectionId: a.connectionId, role: 'primary' });
  });

  it("refuses to bind another connection's not-yet-bound primary, or a primary as a pip", () => {
    const a = mustOpen(mustRegister(A).serviceId, wcObj(1));
    const b = mustOpen(mustRegister(B).serviceId, wcObj(2));
    expect(() => bindSender(a.webContents, b.connectionId, 'pip')).toThrow();
    expect(() => bindSender(a.webContents, b.connectionId, 'primary')).toThrow();
    expect(() => bindSender(a.webContents, a.connectionId, 'pip')).toThrow();
    expect(bindingFor(a.webContents)).toBeUndefined();
    expect(b.pips.has(a.webContents)).toBe(false);
    expect(() => bindSender(a.webContents, a.connectionId, 'primary')).not.toThrow();
  });

  it('refuses to rebind a pip to another connection or role', () => {
    const a = mustOpen(mustRegister(A).serviceId, wcObj(1));
    const b = mustOpen(mustRegister(B).serviceId, wcObj(2));
    const pip = wcObj(3);
    bindSender(pip, a.connectionId, 'pip');
    expect(() => bindSender(pip, b.connectionId, 'pip')).toThrow();
    expect(() => bindSender(pip, a.connectionId, 'primary')).toThrow();
    expect(bindingFor(pip)).toEqual({ connectionId: a.connectionId, role: 'pip' });
    expect(b.pips.has(pip)).toBe(false);
  });

  it("announces 'disposed' once when a listener re-enters disposeConnection", () => {
    const rec = mustOpen(mustRegister(A).serviceId);
    const reasons: string[] = [];
    onGenerationAdvanced((id, _from, _to, reason) => {
      reasons.push(reason);
      if (reason === 'disposed') disposeConnection(id);
    });
    disposeConnection(rec.connectionId);
    expect(reasons).toEqual(['disposed']);
    expect(recordFor(rec.connectionId)).toBeUndefined();
  });

  it('refuses to bind to an unknown connection', () => {
    expect(() => bindSender(wcObj(), 'A'.repeat(22) as never, 'primary')).toThrow();
  });

  it('refuses to open a connection on a webContents another connection owns', () => {
    const a = mustOpen(mustRegister(A).serviceId, wcObj(1));
    const other = mustRegister(B);
    expect(() => openConnection(other.serviceId, a.webContents, null)).toThrow();
    expect(liveConnections()).toEqual([a]);
  });

  it('refuses non-http(s) origins', () => {
    expect(registerService('app://concord', deps())).toEqual({
      ok: false,
      reason: 'invalid-origin',
    });
    expect(registerService('file:///etc/passwd', deps())).toEqual({
      ok: false,
      reason: 'invalid-origin',
    });
  });

  it('re-checks approval even for an origin that is already registered', () => {
    mustRegister(A);
    expect(registerService(A, deps(false))).toEqual({ ok: false, reason: 'not-approved' });
  });

  it('makes no session or custody on a refusal', () => {
    const unapproved = deps(false);
    registerService(A, unapproved);
    const first = mustRegister(A);
    profile.idOverride = () => first.serviceId;
    const colliding = deps();
    registerService(B, colliding);
    for (const d of [unapproved, colliding]) {
      expect(d.makeSession).not.toHaveBeenCalled();
      expect(d.makeCustody).not.toHaveBeenCalled();
    }
  });

  it('stores the canonical origin and serves lookups by canonical form', () => {
    const s = mustRegister('https://A.Example:443/api/v1/');
    expect(s.origin).toBe('https://a.example');
    expect(serviceForOrigin('https://a.example/other')).toBe(s);
  });

  it('delivers an advance made inside a listener after the outer one, in order, to every listener', () => {
    const rec = mustOpen(mustRegister(A).serviceId);
    const first: unknown[][] = [];
    const second: unknown[][] = [];
    onGenerationAdvanced((id, from, to, reason) => {
      first.push([from, to, reason]);
      if (reason === 'credential-end') disposeConnection(id);
    });
    onGenerationAdvanced((_id, from, to, reason) => second.push([from, to, reason]));
    expect(advanceGeneration(rec.connectionId, 'credential-end')).toBe(2);
    const expected = [
      [1, 2, 'credential-end'],
      [2, 3, 'disposed'],
    ];
    expect(first).toEqual(expected);
    expect(second).toEqual(expected);
    expect(recordFor(rec.connectionId)).toBeUndefined();
  });

  it('keeps delivering to the remaining listeners when one throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const rec = mustOpen(mustRegister(A).serviceId);
    onGenerationAdvanced(() => {
      throw new Error('listener failure');
    });
    const l = vi.fn();
    onGenerationAdvanced(l);
    expect(advanceGeneration(rec.connectionId, 'document')).toBe(2);
    expect(l).toHaveBeenCalledWith(rec.connectionId, 1, 2, 'document');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('throws when advancing a dead connection; dispose is idempotent', () => {
    const rec = mustOpen(mustRegister(A).serviceId);
    disposeConnection(rec.connectionId);
    expect(() => disposeConnection(rec.connectionId)).not.toThrow();
    expect(() => advanceGeneration(rec.connectionId, 'renderer-gone')).toThrow();
  });

  it('dispose drops the bindings of the primary and its pips', () => {
    const rec = mustOpen(mustRegister(A).serviceId, wcObj(1));
    const pip = wcObj(2);
    bindSender(rec.webContents, rec.connectionId, 'primary');
    bindSender(pip, rec.connectionId, 'pip');
    expect(rec.pips.has(pip)).toBe(true);
    disposeConnection(rec.connectionId);
    expect(bindingFor(rec.webContents)).toBeUndefined();
    expect(bindingFor(pip)).toBeUndefined();
    expect(rec.pips.has(pip)).toBe(true); // left for the caller to destroy (§3.9)
  });

  it('setForeground refuses an unknown connection and accepts null', () => {
    expect(() => setForeground('A'.repeat(22) as never)).toThrow();
    expect(() => setForeground(null)).not.toThrow();
    expect(foreground()).toBeNull();
  });

  it('primaries() omits a connection whose primary is not bound, or is bound off-record', () => {
    const rec = mustOpen(mustRegister(A).serviceId, wcObj(1));
    expect(primaries()).toEqual([]);
    bindSender(wcObj(9), rec.connectionId, 'primary'); // a primary that is not record.webContents
    expect(primaries()).toEqual([]);
  });
});
