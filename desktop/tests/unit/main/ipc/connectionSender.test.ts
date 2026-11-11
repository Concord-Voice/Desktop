// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/concord-test-userdata' } }));

import {
  _resetConnectionRegistryForTesting,
  bindSender,
  disposeConnection,
  openConnection,
  registerService,
  setForeground,
  type ServiceRecord,
} from '../../../../src/main/connectionRegistry';
import {
  crossCheckApiBase,
  requireConnectionSender,
  requireForegroundPrimary,
  requireSaasPrimary,
} from '../../../../src/main/ipc/connectionSender';
import { isPermittedFrameUrlForKind } from '../../../../src/main/ipc/frameValidation';

const SAAS_ORIGIN = 'https://api.concordvoice.chat';
const A = new URL('https://a.example').origin;
const B = new URL('https://b.example:8443').origin;
const SPA = 'https://spa.concordvoice.chat';

function conn(origin: string, id: number) {
  const r = registerService(origin, {
    makeSession: () => ({}) as never,
    makeCustody: () => ({ tag: origin }) as never,
    isValidatedSelfHostedApiBase: () => true,
  });
  if (!r.ok) throw new Error(r.reason);
  const wc = fakeWc(id);
  const o = openConnection(r.service.serviceId, wc, null);
  if (!o.ok) throw new Error(o.reason);
  bindSender(wc, o.record.connectionId, 'primary');
  return { wc, record: o.record, service: r.service as ServiceRecord };
}
function pipOf(c: ReturnType<typeof conn>, id: number) {
  const wc = fakeWc(id);
  bindSender(wc, c.record.connectionId, 'pip');
  return wc;
}
/** A webContents whose `mainFrame` is frame-tree node `id`, as on a real one. */
const fakeWc = (id: number) => ({ id, mainFrame: { frameTreeNodeId: id } }) as never;
type FakeFrame = { url: string; parent: unknown; frameTreeNodeId?: number; detached?: boolean };
/** A frame on the sender's main frame-tree node unless the case names another one. */
const ev = (wc: unknown, frame: FakeFrame | null) => {
  const mainId = (wc as { mainFrame?: { frameTreeNodeId: number } }).mainFrame?.frameTreeNodeId;
  const senderFrame = frame && { frameTreeNodeId: mainId, ...frame };
  return { sender: wc, senderFrame } as unknown as IpcMainInvokeEvent;
};
const main = (url: string) => ({ url, parent: null });

beforeEach(() => _resetConnectionRegistryForTesting());

describe('requireConnectionSender', () => {
  it('admits an app://concord main frame in a self-hosted view with its own custody', () => {
    const a = conn(A, 1);
    const s = requireConnectionSender(ev(a.wc, main('app://concord/index.html')), undefined, null);
    expect(s).not.toBeNull();
    expect(s?.custody).toBe(a.service.custody);
    expect(s?.service).toBe(a.service);
    expect(s?.role).toBe('primary');
    expect(s?.ref).toEqual({ connectionId: a.record.connectionId, generation: 1 });
  });

  it('rejects an unregistered webContents', () => {
    conn(A, 1);
    expect(
      requireConnectionSender(ev(fakeWc(77), main('app://concord/')), undefined, null)
    ).toBeNull();
  });

  it('rejects a subframe sender', () => {
    const a = conn(A, 1);
    const frame = { url: 'app://concord/', parent: {} };
    expect(requireConnectionSender(ev(a.wc, frame), undefined, null)).toBeNull();
  });

  it('rejects a null senderFrame', () => {
    const a = conn(A, 1);
    expect(requireConnectionSender(ev(a.wc, null), undefined, null)).toBeNull();
  });

  it('rejects a parentless frame that is not the webContents main frame', () => {
    const a = conn(A, 1);
    const frame = { ...main('app://concord/'), frameTreeNodeId: 999 };
    expect(requireConnectionSender(ev(a.wc, frame), undefined, null)).toBeNull();
  });

  it('rejects a detached frame (the outgoing document of the main frame)', () => {
    const a = conn(A, 1);
    const frame = { ...main('app://concord/'), detached: true };
    expect(requireConnectionSender(ev(a.wc, frame), undefined, null)).toBeNull();
  });

  it('rejects the remote SPA origin inside a self-hosted view', () => {
    const a = conn(A, 1);
    expect(requireConnectionSender(ev(a.wc, main(`${SPA}/`)), undefined, SPA)).toBeNull();
  });

  it('rejects spa-cache://concord inside a self-hosted view', () => {
    const a = conn(A, 1);
    expect(
      requireConnectionSender(ev(a.wc, main('spa-cache://concord/')), undefined, null)
    ).toBeNull();
  });

  it('admits the remote SPA origin inside the saas view', () => {
    const s = conn(SAAS_ORIGIN, 1);
    expect(requireConnectionSender(ev(s.wc, main(`${SPA}/`)), undefined, SPA)).not.toBeNull();
  });

  it('rejects a pip when roles is restricted to primary', () => {
    const a = conn(A, 1);
    const pip = pipOf(a, 2);
    const e = ev(pip, main('app://concord/pip.html'));
    expect(requireConnectionSender(e, { roles: ['primary'] }, null)).toBeNull();
    expect(requireConnectionSender(e, { roles: ['pip'] }, null)?.role).toBe('pip');
  });
});

describe('a PiP is held to the remote-SPA origin main loaded it from', () => {
  const SPA_B = 'https://spa-b.concordvoice.chat';
  function saasPip(pinned: string | null) {
    const s = conn(SAAS_ORIGIN, 1);
    const wc = fakeWc(2);
    bindSender(wc, s.record.connectionId, 'pip', pinned);
    return { s, wc };
  }

  it('admits its own pinned origin after the remote SPA moved or went away', () => {
    const { wc } = saasPip(SPA);
    const e = ev(wc, main(`${SPA}/index.html#/pip/x`));
    expect(requireConnectionSender(e, undefined, null)?.role).toBe('pip');
    expect(requireConnectionSender(e, undefined, SPA_B)?.role).toBe('pip');
  });

  it('refuses a document of the CURRENT origin when that is not its pinned one', () => {
    const { wc } = saasPip(SPA);
    expect(requireConnectionSender(ev(wc, main(`${SPA_B}/`)), undefined, SPA_B)).toBeNull();
  });

  it('refuses the remote SPA in an unpinned PiP even while it is current', () => {
    const { wc } = saasPip(null);
    expect(requireConnectionSender(ev(wc, main(`${SPA}/`)), undefined, SPA)).toBeNull();
    expect(
      requireConnectionSender(ev(wc, main('app://concord/index.html')), undefined, SPA)?.role
    ).toBe('pip');
  });

  it('admits no remote SPA for a caller that supplies no origin, pinned or not', () => {
    const { wc } = saasPip(SPA);
    expect(requireConnectionSender(ev(wc, main(`${SPA}/`)))).toBeNull();
  });

  it('never moves a primary onto a PiP pin: the primary keeps the current origin', () => {
    const { s } = saasPip(SPA);
    expect(requireConnectionSender(ev(s.wc, main(`${SPA}/`)), undefined, null)).toBeNull();
  });

  it('a pin does not let a self-hosted PiP speak from a CVNet document', () => {
    const a = conn(A, 3);
    const wc = fakeWc(4);
    bindSender(wc, a.record.connectionId, 'pip', SPA);
    expect(requireConnectionSender(ev(wc, main(`${SPA}/`)), undefined, SPA)).toBeNull();
  });
});

describe('requireForegroundPrimary / requireSaasPrimary', () => {
  it('rejects a background primary and admits the foreground one', () => {
    const a = conn(A, 1);
    const b = conn(B, 2);
    setForeground(b.record.connectionId);
    expect(requireForegroundPrimary(ev(a.wc, main('app://concord/')), null)).toBeNull();
    expect(requireForegroundPrimary(ev(b.wc, main('app://concord/')), null)).not.toBeNull();
  });

  it('rejects a self-hosted primary and admits the saas primary', () => {
    const a = conn(A, 1);
    const s = conn(SAAS_ORIGIN, 2);
    expect(requireSaasPrimary(ev(a.wc, main('app://concord/')), null)).toBeNull();
    expect(requireSaasPrimary(ev(s.wc, main('app://concord/')), null)?.service.kind).toBe('saas');
  });

  it('rejects a saas pip through requireSaasPrimary', () => {
    const s = conn(SAAS_ORIGIN, 1);
    const pip = pipOf(s, 2);
    expect(requireSaasPrimary(ev(pip, main('app://concord/pip.html')), null)).toBeNull();
  });
});

describe('crossCheckApiBase', () => {
  it('is true for undefined, true for own origin, false for another connection origin', () => {
    const a = conn(A, 1);
    const b = conn(B, 2);
    const sa = requireConnectionSender(ev(a.wc, main('app://concord/')), undefined, null);
    const sb = requireConnectionSender(ev(b.wc, main('app://concord/')), undefined, null);
    if (!sa || !sb) throw new Error('senders must resolve');
    expect(crossCheckApiBase(sa, undefined)).toBe(true);
    expect(crossCheckApiBase(sa, 'https://b.example:8443/api/')).toBe(false);
    expect(crossCheckApiBase(sb, 'https://b.example:8443/api/')).toBe(true);
  });

  it('rejects a pip of A acting as B', () => {
    const a = conn(A, 1);
    conn(B, 2);
    const pip = pipOf(a, 3);
    const s = requireConnectionSender(ev(pip, main('app://concord/pip.html')), undefined, null);
    if (!s) throw new Error('pip sender must resolve');
    expect(crossCheckApiBase(s, B)).toBe(false);
  });

  it('rejects an unparseable or non-string supplied value', () => {
    const a = conn(A, 1);
    const s = requireConnectionSender(ev(a.wc, main('app://concord/')), undefined, null);
    if (!s) throw new Error('sender must resolve');
    expect(crossCheckApiBase(s, 'not a url')).toBe(false);
    expect(crossCheckApiBase(s, 42)).toBe(false);
  });
});

describe('isPermittedFrameUrlForKind', () => {
  it('saas defers to isPermittedFrameUrl (remote SPA origin allowed)', () => {
    expect(isPermittedFrameUrlForKind(`${SPA}/x`, 'saas', SPA)).toBe(true);
    expect(isPermittedFrameUrlForKind('spa-cache://concord/', 'saas', null)).toBe(true);
    expect(isPermittedFrameUrlForKind('https://evil.example/', 'saas', SPA)).toBe(false);
  });

  it('selfhost permits only app://concord and http://localhost:*', () => {
    expect(isPermittedFrameUrlForKind('app://concord/index.html', 'selfhost', null)).toBe(true);
    expect(isPermittedFrameUrlForKind('http://localhost:3001/', 'selfhost', null)).toBe(true);
    expect(isPermittedFrameUrlForKind(`${SPA}/`, 'selfhost', SPA)).toBe(false);
    expect(isPermittedFrameUrlForKind('spa-cache://concord/', 'selfhost', null)).toBe(false);
    expect(isPermittedFrameUrlForKind('file:///app/index.html', 'selfhost', null)).toBe(false);
    expect(isPermittedFrameUrlForKind('app://concord.evil.com/', 'selfhost', null)).toBe(false);
  });
});

describe('hardening (guards added beyond the plan matrix)', () => {
  it('rejects a primary binding that is not the record webContents', () => {
    const a = conn(A, 1);
    const stray = fakeWc(9);
    bindSender(stray, a.record.connectionId, 'primary');
    expect(requireConnectionSender(ev(stray, main('app://concord/')), undefined, null)).toBeNull();
  });

  it('admits nothing for an empty roles list', () => {
    const a = conn(A, 1);
    expect(
      requireConnectionSender(ev(a.wc, main('app://concord/')), { roles: [] }, null)
    ).toBeNull();
  });

  it('rejects a frame whose url read throws', () => {
    const a = conn(A, 1);
    const frame = {
      parent: null,
      frameTreeNodeId: 1,
      get url(): never {
        throw new Error('Render frame was disposed');
      },
    };
    const e = { sender: a.wc, senderFrame: frame } as unknown as IpcMainInvokeEvent;
    expect(requireConnectionSender(e, undefined, null)).toBeNull();
  });

  it('rejects the sender of a disposed connection', () => {
    const a = conn(A, 1);
    disposeConnection(a.record.connectionId);
    expect(requireConnectionSender(ev(a.wc, main('app://concord/')), undefined, null)).toBeNull();
  });

  it('rejects a sender whose record is marked disposed before it is removed', () => {
    const a = conn(A, 1);
    a.record.state = 'disposed';
    expect(requireConnectionSender(ev(a.wc, main('app://concord/')), undefined, null)).toBeNull();
  });

  it('defaults remoteSpaOrigin to null, so the remote SPA is not admitted unless supplied', () => {
    const s = conn(SAAS_ORIGIN, 1);
    expect(requireConnectionSender(ev(s.wc, main(`${SPA}/`)))).toBeNull();
  });

  it('isPermittedFrameUrlForKind fails closed on an unknown kind', () => {
    expect(isPermittedFrameUrlForKind('app://concord/', 'other' as never, null)).toBe(false);
  });

  it('crossCheckApiBase rejects null and opaque origins', () => {
    const a = conn(A, 1);
    const s = requireConnectionSender(ev(a.wc, main('app://concord/')), undefined, null);
    if (!s) throw new Error('sender must resolve');
    expect(crossCheckApiBase(s, null)).toBe(false);
    expect(crossCheckApiBase(s, 'app://concord/')).toBe(false);
  });
});
