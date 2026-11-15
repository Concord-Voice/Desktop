// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/concord-test-userdata' } }));

import {
  _resetConnectionRegistryForTesting,
  advanceGeneration,
  bindSender,
  disposeConnection,
  openConnection,
  refOf,
  registerService,
} from '../../../src/main/connectionRegistry';
import {
  bindOwner,
  isOwnerCurrent,
  onGenerationAdvanced,
  requireOwner,
  type OwnerBinding,
} from '../../../src/main/connectionCapability';

const A = new URL('https://a.example').origin;
const B = new URL('https://b.example:8443').origin;

function setup(origin: string, id: number) {
  const r = registerService(origin, {
    makeSession: () => ({}) as never,
    makeCustody: () => ({}) as never,
    isValidatedSelfHostedApiBase: () => true,
  });
  if (!r.ok) throw new Error(r.reason);
  const wc = fakeWc(id);
  const o = openConnection(r.service.serviceId, wc, null);
  if (!o.ok) throw new Error(o.reason);
  bindSender(wc, o.record.connectionId, 'primary');
  return { wc, record: o.record };
}

/** A webContents whose `mainFrame` is frame-tree node `id`, as on a real one. */
const fakeWc = (id: number) => ({ id, mainFrame: { frameTreeNodeId: id } }) as never;

type FakeFrame = { url?: string; parent: unknown; frameTreeNodeId?: number; detached?: boolean };
/** A frame on the sender's main frame-tree node unless the case names another one. */
function eventFor(wc: unknown, frame: FakeFrame | null) {
  const mainId = (wc as { mainFrame?: { frameTreeNodeId: number } }).mainFrame?.frameTreeNodeId;
  const senderFrame = frame && { frameTreeNodeId: mainId, ...frame };
  return { sender: wc, senderFrame } as unknown as IpcMainInvokeEvent;
}
const MAIN_FRAME = { url: 'app://concord/index.html', parent: null };

beforeEach(() => _resetConnectionRegistryForTesting());

describe('isOwnerCurrent', () => {
  it('is true right after bindOwner and false after a generation advance', () => {
    const { record } = setup(A, 1);
    const b = bindOwner('audiocap', refOf(record));
    expect(isOwnerCurrent(b)).toBe(true);
    advanceGeneration(record.connectionId, 'document');
    expect(isOwnerCurrent(b)).toBe(false);
  });

  it('is false for a hand-built object literal', () => {
    const { record } = setup(A, 1);
    const forged = { kind: 'audiocap', ref: refOf(record) } as unknown as OwnerBinding;
    expect(isOwnerCurrent(forged)).toBe(false);
  });

  it('is false once the connection no longer exists', () => {
    const b = bindOwner('tray', {
      connectionId: 'A'.repeat(22) as never,
      generation: 1 as never,
    });
    expect(isOwnerCurrent(b)).toBe(false);
  });
});

describe('requireOwner', () => {
  it('returns the record for the bound, current, main-frame sender', () => {
    const { wc, record } = setup(A, 1);
    const b = bindOwner('sso-loopback', refOf(record));
    expect(requireOwner(eventFor(wc, MAIN_FRAME), b)).toBe(record);
  });

  it('returns null when the sender is bound to another connection', () => {
    const { record } = setup(A, 1);
    const other = setup(B, 2);
    const b = bindOwner('audiocap', refOf(record));
    expect(requireOwner(eventFor(other.wc, MAIN_FRAME), b)).toBeNull();
  });

  it('returns null for a subframe sender', () => {
    const { wc, record } = setup(A, 1);
    const b = bindOwner('audiocap', refOf(record));
    expect(requireOwner(eventFor(wc, { url: MAIN_FRAME.url, parent: {} }), b)).toBeNull();
  });

  it('returns null when senderFrame is null', () => {
    const { wc, record } = setup(A, 1);
    const b = bindOwner('audiocap', refOf(record));
    expect(requireOwner(eventFor(wc, null), b)).toBeNull();
  });

  it('returns null for an unbound sender', () => {
    const { record } = setup(A, 1);
    const b = bindOwner('audiocap', refOf(record));
    expect(requireOwner(eventFor(fakeWc(99), MAIN_FRAME), b)).toBeNull();
  });

  it('returns null when the binding is stale', () => {
    const { wc, record } = setup(A, 1);
    const b = bindOwner('capture-lease', refOf(record));
    advanceGeneration(record.connectionId, 'credential-end');
    expect(requireOwner(eventFor(wc, MAIN_FRAME), b)).toBeNull();
  });
});

describe('revocation timing', () => {
  it('has already revoked old bindings when an onGenerationAdvanced listener runs', () => {
    const { record } = setup(A, 1);
    const b = bindOwner('tray', refOf(record));
    const observed: boolean[] = [];
    onGenerationAdvanced(() => observed.push(isOwnerCurrent(b)));
    advanceGeneration(record.connectionId, 'renderer-gone');
    expect(observed).toEqual([false]);
  });

  it('keeps a binding revoked after an aborted navigation (section 3.9 ceiling)', () => {
    const { record } = setup(A, 1);
    const b = bindOwner('audiocap', refOf(record));
    advanceGeneration(record.connectionId, 'document'); // did-start-navigation
    // navigation aborts: nothing may restore the old generation
    expect(isOwnerCurrent(b)).toBe(false);
    expect(refOf(record).generation).toBe(2);
    expect(isOwnerCurrent(bindOwner('audiocap', refOf(record)))).toBe(true);
  });
});

describe('hardening (guards added beyond the plan matrix)', () => {
  it('is false for an object built on the real prototype (instanceof would pass)', () => {
    const { record } = setup(A, 1);
    const real = bindOwner('audiocap', refOf(record));
    const forged = Object.create(Object.getPrototypeOf(real) as object) as Record<string, unknown>;
    forged.kind = 'audiocap';
    forged.ref = refOf(record);
    expect(isOwnerCurrent(forged as unknown as OwnerBinding)).toBe(false);
    expect(requireOwner(eventFor(record.webContents, MAIN_FRAME), forged as never)).toBeNull();
  });

  it('copies the ref at bind time: mutating the caller object cannot resurrect a stale binding', () => {
    const { record } = setup(A, 1);
    const ref = { ...refOf(record) } as { connectionId: never; generation: number };
    const b = bindOwner('audiocap', ref as never);
    advanceGeneration(record.connectionId, 'document');
    ref.generation = 2;
    expect(b.ref.generation).toBe(1);
    expect(isOwnerCurrent(b)).toBe(false);
  });

  it('rejects a malformed kind or ref', () => {
    const { record } = setup(A, 1);
    expect(() => bindOwner('root' as never, refOf(record))).toThrow(TypeError);
    expect(() =>
      bindOwner('audiocap', { connectionId: 'short' as never, generation: 1 as never })
    ).toThrow(TypeError);
    expect(() =>
      bindOwner('audiocap', { connectionId: record.connectionId, generation: 0 as never })
    ).toThrow(TypeError);
  });

  it('is revoked by dispose', () => {
    const { wc, record } = setup(A, 1);
    const b = bindOwner('tray', refOf(record));
    disposeConnection(record.connectionId);
    expect(isOwnerCurrent(b)).toBe(false);
    expect(requireOwner(eventFor(wc, MAIN_FRAME), b)).toBeNull();
  });

  it('returns null for a primary binding that is not the record webContents', () => {
    const { record } = setup(A, 1);
    const stray = fakeWc(5);
    bindSender(stray, record.connectionId, 'primary');
    const b = bindOwner('audiocap', refOf(record));
    expect(requireOwner(eventFor(stray, MAIN_FRAME), b)).toBeNull();
  });

  it('returns null when reading senderFrame throws (disposed frame)', () => {
    const { wc, record } = setup(A, 1);
    const b = bindOwner('audiocap', refOf(record));
    const event = {
      sender: wc,
      get senderFrame(): never {
        throw new Error('Render frame was disposed');
      },
    } as unknown as IpcMainInvokeEvent;
    expect(requireOwner(event, b)).toBeNull();
  });

  it('returns null for a pip of the owning connection', () => {
    const { record } = setup(A, 1);
    const pip = fakeWc(3);
    bindSender(pip, record.connectionId, 'pip');
    const b = bindOwner('audiocap', refOf(record));
    expect(requireOwner(eventFor(pip, MAIN_FRAME), b)).toBeNull();
  });

  it('returns null for a parentless frame that is not the webContents main frame', () => {
    const { wc, record } = setup(A, 1);
    const b = bindOwner('audiocap', refOf(record));
    expect(requireOwner(eventFor(wc, { ...MAIN_FRAME, frameTreeNodeId: 999 }), b)).toBeNull();
  });

  it('returns null for a detached frame (the outgoing document of the main frame)', () => {
    const { wc, record } = setup(A, 1);
    const b = bindOwner('audiocap', refOf(record));
    expect(requireOwner(eventFor(wc, { ...MAIN_FRAME, detached: true }), b)).toBeNull();
  });
});
