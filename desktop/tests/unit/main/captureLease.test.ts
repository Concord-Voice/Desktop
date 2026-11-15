// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IpcMainInvokeEvent } from 'electron';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/concord-test-userdata' } }));

import {
  _resetConnectionRegistryForTesting,
  advanceGeneration,
  bindSender,
  disposeConnection,
  foreground,
  openConnection,
  recordFor,
  refOf,
  registerService,
  setForeground,
  type ConnectionRecord,
  type ServiceRecord,
} from '../../../src/main/connectionRegistry';
import type { ConnectionSender } from '../../../src/main/ipc/connectionSender';
import {
  CAPTURE_LEASE_PUSH,
  CAPTURE_LEASE_REVOKED_PUSH,
  type CaptureAcquireResult,
  type CaptureRejectReason,
} from '../../../src/shared/captureLease';
import type { ConnectionRef, GenerationReason } from '../../../src/shared/connectionIdentity';
import {
  HANDOFF_ACK_TIMEOUT_MS,
  NAV_HOLD_MAX_REARMS,
  _holderForTesting,
  _resetCaptureLeaseForTesting,
  acquire,
  captureLeaseCounts,
  crashAndReloadRenderer,
  holderRef,
  initCaptureLease,
  isFree,
  isHolder,
  isLeaseAware,
  legacyAcquire,
  markLeaseAware,
  release,
  shutdownCaptureLeaseForQuit,
  type CaptureLeaseDeps,
} from '../../../src/main/captureLease';

const ORIGIN_A = new URL('https://a.example').origin;
const ORIGIN_B = new URL('https://b.example:8443').origin;
const ORIGIN_C = new URL('https://c.example').origin;
const FRAME_URL = 'app://concord/index.html';

const VOICE = { intent: 'voice-join' } as const;
const TEST = { intent: 'device-test' } as const;
const GRANTED: CaptureAcquireResult = { status: 'granted' };
const DECLINED: CaptureAcquireResult = { status: 'declined' };
const rejected = (reason: CaptureRejectReason): CaptureAcquireResult => ({
  status: 'rejected',
  reason,
});

interface Conn {
  readonly id: number;
  readonly wc: object;
  readonly record: ConnectionRecord;
  readonly service: ServiceRecord;
}

let nextWcId = 1;
function connect(origin: string): Conn {
  const r = registerService(origin, {
    makeSession: () => ({}) as never,
    makeCustody: () => ({}) as never,
    isValidatedSelfHostedApiBase: () => true,
  });
  if (!r.ok) throw new Error(r.reason);
  const id = nextWcId++;
  const wc = Object.assign(new EventEmitter(), {
    id,
    mainFrame: { frameTreeNodeId: id },
    isDestroyed: () => false,
  });
  const o = openConnection(r.service.serviceId, wc as never, null);
  if (!o.ok) throw new Error(o.reason);
  bindSender(wc as never, o.record.connectionId, 'primary');
  return { id, wc, record: o.record, service: r.service };
}

const ref = (c: Conn): ConnectionRef => refOf(c.record);

/** What `registerIpc`'s connection-bound admission hands the handler, built now. */
function senderOf(c: Conn, role: 'primary' | 'pip' = 'primary'): ConnectionSender {
  return Object.freeze({
    record: c.record,
    service: c.service,
    custody: c.service.custody,
    ref: refOf(c.record),
    frame: { url: FRAME_URL } as never,
    role,
  });
}

function eventOf(c: Conn): IpcMainInvokeEvent {
  return {
    sender: c.wc,
    senderFrame: { frameTreeNodeId: c.id, url: FRAME_URL, parent: null },
  } as unknown as IpcMainInvokeEvent;
}

// Rest args, not a default: an explicit `undefined` input must reach the guard.
const inputOf = (rest: unknown[]): unknown => (rest.length > 0 ? rest[0] : VOICE);
const acq = (c: Conn, ...rest: unknown[]) => acquire(senderOf(c), inputOf(rest));
const rel = (c: Conn, ...rest: unknown[]) => release(senderOf(c), eventOf(c), inputOf(rest));
const front = (c: Conn | null) => setForeground(c === null ? null : c.record.connectionId);

interface PendingCeremony {
  readonly from: ConnectionRef;
  readonly to: ConnectionRef;
  readonly signal: AbortSignal;
  answer(a: 'join' | 'stay'): void;
  fail(e: Error): void;
}

let ceremonies: PendingCeremony[] = [];

function makeDeps() {
  const releaseModal = vi.fn();
  return {
    releaseModal,
    foreground: vi.fn<CaptureLeaseDeps['foreground']>(() => foreground()),
    recordFor: vi.fn<CaptureLeaseDeps['recordFor']>((id) => recordFor(id)),
    sendToConnection: vi.fn<CaptureLeaseDeps['sendToConnection']>(() => true),
    setTrayOwner: vi.fn<CaptureLeaseDeps['setTrayOwner']>(),
    revokeAudiocapShare: vi.fn<CaptureLeaseDeps['revokeAudiocapShare']>(),
    serviceMediaCapability: vi.fn<CaptureLeaseDeps['serviceMediaCapability']>(() => undefined),
    isQuitting: vi.fn<CaptureLeaseDeps['isQuitting']>(() => false),
    runCeremony: vi.fn<CaptureLeaseDeps['runCeremony']>(
      (from, to, signal) =>
        new Promise((resolve, reject) => {
          ceremonies.push({ from, to, signal, answer: resolve, fail: reject });
          // Task 3's ceremony resolves an aborted dialog as Stay.
          signal.addEventListener('abort', () => resolve('stay'), { once: true });
        })
    ),
    tryAcquireModal: vi.fn<CaptureLeaseDeps['tryAcquireModal']>(() => releaseModal),
    consumeCeremonyToken: vi.fn<CaptureLeaseDeps['consumeCeremonyToken']>(() => true),
    crashAndReload: vi.fn<(record: ConnectionRecord) => void>(),
  };
}

let d = makeDeps();

function pushes(c: Conn, channel: string): unknown[] {
  return d.sendToConnection.mock.calls
    .filter(([r, ch]) => r.connectionId === c.record.connectionId && ch === channel)
    .map((call) => call[2]);
}

function anyPushTo(c: Conn): boolean {
  return d.sendToConnection.mock.calls.some(([r]) => r.connectionId === c.record.connectionId);
}

function clearSpies(): void {
  for (const value of Object.values(d)) value.mockClear();
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function settledFlag(p: Promise<unknown>): { settled: boolean } {
  const flag = { settled: false };
  void p.then(() => {
    flag.settled = true;
  });
  return flag;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  _resetConnectionRegistryForTesting();
  _resetCaptureLeaseForTesting();
  ceremonies = [];
  d = makeDeps();
  initCaptureLease(d);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** #86 advances a navigating connection twice: at its start, then when it commits. */
function navigateAway(c: Conn): void {
  advanceGeneration(c.record.connectionId, 'document');
  commit(c);
}

/** The commit: `did-navigate` fires (the lease's prepended listener first), then #86 advances. */
function commit(c: Conn): void {
  (c.wc as EventEmitter).emit('did-navigate');
  advanceGeneration(c.record.connectionId, 'document');
}

/** A holds `voice-join` and has left the foreground to B. */
async function heldByAWithBInFront(): Promise<{ a: Conn; b: Conn }> {
  const a = connect(ORIGIN_A);
  const b = connect(ORIGIN_B);
  front(a);
  await expect(acq(a)).resolves.toEqual(GRANTED);
  front(b);
  clearSpies();
  return { a, b };
}

/** B answered Join; A has been told to leave and has not acked yet. */
async function handoffFromAToB() {
  const { a, b } = await heldByAWithBInFront();
  const pending = acq(b);
  ceremonies[0].answer('join');
  await flush();
  return { a, b, pending };
}

describe('acquire: fast paths', () => {
  it('grants a free lease to the foreground, names the tray owner and pushes {held, mine}', async () => {
    const a = connect(ORIGIN_A);
    front(a);
    clearSpies();
    await expect(acq(a)).resolves.toEqual(GRANTED);
    expect(captureLeaseCounts()).toEqual({ holder: 1, handoff: 0, claims: 1, leaseAware: 1 });
    expect(isHolder(ref(a))).toBe(true);
    expect(holderRef()).toEqual(ref(a));
    expect(d.setTrayOwner).toHaveBeenCalledWith(ref(a));
    expect(d.sendToConnection).toHaveBeenCalledTimes(1);
    expect(d.sendToConnection).toHaveBeenCalledWith(ref(a), CAPTURE_LEASE_PUSH, {
      held: true,
      mine: true,
    });
  });

  it("refuses a background acquire with 'not-foreground', before any held check (R5, R6)", async () => {
    const a = connect(ORIGIN_A);
    const b = connect(ORIGIN_B);
    const c = connect(ORIGIN_C);
    front(b);
    await expect(acq(a)).resolves.toEqual(rejected('not-foreground'));
    expect(isFree()).toBe(true);

    front(c);
    await expect(acq(c)).resolves.toEqual(GRANTED);
    clearSpies();
    await expect(acq(a)).resolves.toEqual(rejected('not-foreground'));
    await expect(acq(a, TEST)).resolves.toEqual(rejected('not-foreground'));
    expect(d.runCeremony).not.toHaveBeenCalled();
    expect(anyPushTo(a)).toBe(false);
    expect(isHolder(ref(c))).toBe(true);
  });

  it('lets the holder re-acquire from the background and frees only when every claim is released (R4)', async () => {
    const { a, b } = await heldByAWithBInFront();
    await expect(acq(a, TEST)).resolves.toEqual(GRANTED);
    expect(captureLeaseCounts().claims).toBe(2);
    expect(rel(a, TEST)).toBe(true);
    expect(isHolder(ref(a))).toBe(true);
    expect(pushes(a, CAPTURE_LEASE_PUSH)).toEqual([]);
    expect(d.revokeAudiocapShare).not.toHaveBeenCalled();
    expect(rel(a, VOICE)).toBe(true);
    expect(isFree()).toBe(true);
    expect(d.revokeAudiocapShare).toHaveBeenCalledTimes(1);
    expect(pushes(a, CAPTURE_LEASE_PUSH)).toEqual([{ held: false, mine: false }]);
    expect(pushes(b, CAPTURE_LEASE_PUSH)).toEqual([{ held: false, mine: false }]);
    expect(d.setTrayOwner).toHaveBeenLastCalledWith(null);
  });

  it("refuses 'unavailable' when the service declares media: false, before any ceremony (§3.7)", async () => {
    const { a, b } = await heldByAWithBInFront();
    d.serviceMediaCapability.mockImplementation((id) =>
      id === b.record.connectionId ? false : undefined
    );
    await expect(acq(b)).resolves.toEqual(rejected('unavailable'));
    expect(d.runCeremony).not.toHaveBeenCalled();
    expect(rel(a)).toBe(true);
    await expect(acq(b)).resolves.toEqual(rejected('unavailable'));
    expect(isFree()).toBe(true);
    d.serviceMediaCapability.mockReturnValue(undefined);
    await expect(acq(b)).resolves.toEqual(GRANTED);
  });

  it("answers 'held' to a foreground device test while another connection holds", async () => {
    const { a, b } = await heldByAWithBInFront();
    await expect(acq(b, TEST)).resolves.toEqual({ status: 'held' });
    expect(d.runCeremony).not.toHaveBeenCalled();
    expect(isHolder(ref(a))).toBe(true);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty object', {}],
    ['an unknown intent', { intent: 'screen' }],
    ['an extra key', { intent: 'voice-join', extra: 1 }],
    ['an array', ['voice-join']],
  ])("refuses %s as input with 'untrusted-sender'", async (_label, input) => {
    const a = connect(ORIGIN_A);
    front(a);
    await expect(acq(a, input)).resolves.toEqual(rejected('untrusted-sender'));
    expect(isFree()).toBe(true);
  });

  it("refuses a PiP sender with 'untrusted-sender'", async () => {
    const a = connect(ORIGIN_A);
    front(a);
    await expect(acquire(senderOf(a, 'pip'), VOICE)).resolves.toEqual(rejected('untrusted-sender'));
    expect(isFree()).toBe(true);
  });

  it('a double activation grants twice with one claim, and one release frees (Review Focus 4)', async () => {
    const a = connect(ORIGIN_A);
    front(a);
    const first = acq(a);
    const second = acq(a);
    await expect(first).resolves.toEqual(GRANTED);
    await expect(second).resolves.toEqual(GRANTED);
    expect(captureLeaseCounts().claims).toBe(1);
    expect(rel(a)).toBe(true);
    expect(isFree()).toBe(true);
  });

  it('leave then rejoin in one synchronous sequence cannot reorder (§3.10)', async () => {
    const a = connect(ORIGIN_A);
    front(a);
    await acq(a);
    clearSpies();
    expect(rel(a)).toBe(true);
    const again = acq(a);
    expect(isHolder(ref(a))).toBe(true);
    await expect(again).resolves.toEqual(GRANTED);
    expect(captureLeaseCounts().claims).toBe(1);
    expect(pushes(a, CAPTURE_LEASE_PUSH)).toEqual([
      { held: false, mine: false },
      { held: true, mine: true },
    ]);
  });

  it('resolves every fast path without waiting for a macrotask', async () => {
    const a = connect(ORIGIN_A);
    const b = connect(ORIGIN_B);
    const macrotask = () => new Promise((resolve) => setImmediate(() => resolve('macrotask')));
    front(a);
    expect(await Promise.race([acq(a), macrotask()])).toEqual(GRANTED);
    front(b);
    expect(await Promise.race([acq(b, TEST), macrotask()])).toEqual({ status: 'held' });
    expect(await Promise.race([acquire(senderOf(b, 'pip'), VOICE), macrotask()])).toEqual(
      rejected('untrusted-sender')
    );
    expect(await Promise.race([acq(connect(ORIGIN_C)), macrotask()])).toEqual(
      rejected('not-foreground')
    );
    d.serviceMediaCapability.mockReturnValue(false);
    expect(await Promise.race([acq(b), macrotask()])).toEqual(rejected('unavailable'));
    d.serviceMediaCapability.mockReturnValue(undefined);
    d.tryAcquireModal.mockReturnValue(null);
    expect(await Promise.race([acq(b), macrotask()])).toEqual(rejected('busy'));
  });

  it('refuses an acquire before initCaptureLease, with no state change', async () => {
    _resetCaptureLeaseForTesting();
    const a = connect(ORIGIN_A);
    front(a);
    await expect(acq(a)).resolves.toEqual(rejected('unavailable'));
    expect(rel(a)).toBe(false);
    expect(legacyAcquire(ref(a))).toBe(false);
    expect(isFree()).toBe(true);
  });
});

describe('release', () => {
  it('refuses a non-holder, malformed input, a foreign event and a stale generation', async () => {
    const a = connect(ORIGIN_A);
    const b = connect(ORIGIN_B);
    front(a);
    await acq(a);
    const staleSender = senderOf(a);
    clearSpies();
    expect(rel(b)).toBe(false);
    expect(rel(a, { intent: 'nope' })).toBe(false);
    expect(rel(a, undefined)).toBe(false);
    expect(rel(a, TEST)).toBe(false); // not claimed
    expect(release(senderOf(a), eventOf(b), VOICE)).toBe(false);
    expect(release(senderOf(a, 'pip'), eventOf(a), VOICE)).toBe(false);
    advanceGeneration(a.record.connectionId, 'credential-start');
    expect(release(staleSender, eventOf(a), VOICE)).toBe(false);
    expect(isHolder(ref(a))).toBe(true);
    expect(captureLeaseCounts().claims).toBe(1);
    expect(d.sendToConnection).not.toHaveBeenCalled();
    expect(rel(a)).toBe(true);
    expect(isFree()).toBe(true);
  });

  it('never throws, even for an event with no frame or sender', async () => {
    const a = connect(ORIGIN_A);
    front(a);
    await acq(a);
    const broken = {} as IpcMainInvokeEvent;
    expect(() => release(senderOf(a), broken, VOICE)).not.toThrow();
    expect(release(senderOf(a), broken, VOICE)).toBe(false);
    expect(isHolder(ref(a))).toBe(true);
  });
});

describe('acquire: the ceremony', () => {
  it("runs one ceremony naming holder and requester; 'stay' declines and keeps the holder", async () => {
    const { a, b } = await heldByAWithBInFront();
    const pending = acq(b);
    expect(d.runCeremony).toHaveBeenCalledTimes(1);
    expect(d.runCeremony).toHaveBeenCalledWith(ref(a), ref(b), expect.any(AbortSignal));
    ceremonies[0].answer('stay');
    await expect(pending).resolves.toEqual(DECLINED);
    expect(isHolder(ref(a))).toBe(true);
    expect(d.releaseModal).toHaveBeenCalledTimes(1);
    expect(d.revokeAudiocapShare).not.toHaveBeenCalled();
    expect(pushes(a, CAPTURE_LEASE_REVOKED_PUSH)).toEqual([]);
  });

  it("a requester that left the foreground during the dialog is refused 'not-foreground' and the lease stays free", async () => {
    const { a, b } = await heldByAWithBInFront();
    const c = connect(ORIGIN_C);
    const pending = acq(b);
    expect(d.runCeremony).toHaveBeenCalledTimes(1);
    expect(rel(a)).toBe(true); // the dialog's holder lets go while it is open
    front(c); // the user switches away from B before answering
    ceremonies[0].answer('join');
    await expect(pending).resolves.toEqual(rejected('not-foreground'));
    expect(isFree()).toBe(true);
    expect(isHolder(ref(b))).toBe(false);
  });

  it('a ceremony that throws declines and keeps the holder', async () => {
    const { a, b } = await heldByAWithBInFront();
    const pending = acq(b);
    ceremonies[0].fail(new Error('dialog failed'));
    await expect(pending).resolves.toEqual(DECLINED);
    expect(isHolder(ref(a))).toBe(true);
    expect(d.releaseModal).toHaveBeenCalledTimes(1);
  });

  it("the requester's generation advance aborts the dialog; the reply and a stale retry are 'superseded'", async () => {
    const { a, b } = await heldByAWithBInFront();
    const staleB = senderOf(b);
    const pending = acquire(staleB, VOICE);
    advanceGeneration(b.record.connectionId, 'document');
    expect(ceremonies[0].signal.aborted).toBe(true);
    await expect(pending).resolves.toEqual(rejected('superseded'));
    await expect(acquire(staleB, VOICE)).resolves.toEqual(rejected('superseded'));
    expect(d.runCeremony).toHaveBeenCalledTimes(1);
    expect(isHolder(ref(a))).toBe(true);
  });

  it("answers 'busy' while another main modal is open", async () => {
    const { b } = await heldByAWithBInFront();
    d.tryAcquireModal.mockReturnValue(null);
    await expect(acq(b)).resolves.toEqual(rejected('busy'));
    expect(d.consumeCeremonyToken).not.toHaveBeenCalled();
    expect(d.runCeremony).not.toHaveBeenCalled();
  });

  it("answers 'busy' when the ceremony budget is exhausted, and gives the modal back", async () => {
    const { b } = await heldByAWithBInFront();
    d.consumeCeremonyToken.mockReturnValue(false);
    await expect(acq(b)).resolves.toEqual(rejected('busy'));
    expect(d.releaseModal).toHaveBeenCalledTimes(1);
    expect(d.runCeremony).not.toHaveBeenCalled();
  });

  it("answers 'busy' while a handoff is pending", async () => {
    const { b } = await handoffFromAToB();
    d.runCeremony.mockClear();
    await expect(acq(b)).resolves.toEqual(rejected('busy'));
    expect(d.runCeremony).not.toHaveBeenCalled();
  });

  it("answers 'busy' to a second acquire while the first ceremony is open", async () => {
    const { b } = await heldByAWithBInFront();
    const first = acq(b);
    await expect(acq(b)).resolves.toEqual(rejected('busy'));
    expect(d.runCeremony).toHaveBeenCalledTimes(1);
    ceremonies[0].answer('stay');
    await expect(first).resolves.toEqual(DECLINED);
  });

  it("answers 'busy' when the holder changed during the dialog (no unconsented move)", async () => {
    const { a, b } = await heldByAWithBInFront();
    const c = connect(ORIGIN_C);
    const pending = acq(b);
    front(c);
    expect(rel(a)).toBe(true);
    await expect(acq(c)).resolves.toEqual(GRANTED);
    front(b);
    clearSpies();
    ceremonies[0].answer('join');
    await expect(pending).resolves.toEqual(rejected('busy'));
    expect(isHolder(ref(c))).toBe(true);
    expect(d.revokeAudiocapShare).not.toHaveBeenCalled();
    expect(pushes(c, CAPTURE_LEASE_REVOKED_PUSH)).toEqual([]);
  });

  it("a holder re-keyed by a credential advance during the dialog is still the one 'join' moves", async () => {
    const { a, b } = await heldByAWithBInFront();
    const pending = acq(b);
    advanceGeneration(a.record.connectionId, 'credential-start');
    const rekeyed = ref(a);
    ceremonies[0].answer('join');
    await flush();
    expect(captureLeaseCounts().handoff).toBe(1);
    expect(isHolder(rekeyed)).toBe(false);
    expect(d.sendToConnection).toHaveBeenCalledWith(rekeyed, CAPTURE_LEASE_REVOKED_PUSH, {
      reason: 'moved',
    });
    expect(rel(a)).toBe(true);
    await expect(pending).resolves.toEqual(GRANTED);
  });

  it.each([
    // A release ends any share itself; a reload leaves that to the audiocap listener (RC-4).
    ['leaves voice', (a: Conn) => expect(rel(a)).toBe(true), 1],
    ['reloads', (a: Conn) => navigateAway(a), 0],
  ])(
    "the named holder that %s during the dialog: 'join' grants with no handoff (Review Focus 3)",
    async (_label, end, revokes) => {
      const { a, b } = await heldByAWithBInFront();
      const pending = acq(b);
      end(a);
      ceremonies[0].answer('join');
      await expect(pending).resolves.toEqual(GRANTED);
      expect(isHolder(ref(b))).toBe(true);
      expect(pushes(a, CAPTURE_LEASE_REVOKED_PUSH)).toEqual([]);
      expect(d.revokeAudiocapShare).toHaveBeenCalledTimes(revokes);
      vi.advanceTimersByTime(HANDOFF_ACK_TIMEOUT_MS * 2);
      expect(d.crashAndReload).not.toHaveBeenCalled();
    }
  );

  it("the named holder leaving during the dialog and 'stay' declines and leaves the lease free", async () => {
    const { a, b } = await heldByAWithBInFront();
    const pending = acq(b);
    expect(rel(a)).toBe(true);
    ceremonies[0].answer('stay');
    await expect(pending).resolves.toEqual(DECLINED);
    expect(isFree()).toBe(true);
  });

  it('declines with no dialog while the app is quitting (Review Focus 2)', async () => {
    const { b } = await heldByAWithBInFront();
    d.isQuitting.mockReturnValue(true);
    await expect(acq(b)).resolves.toEqual(DECLINED);
    expect(d.runCeremony).not.toHaveBeenCalled();
    expect(d.tryAcquireModal).not.toHaveBeenCalled();
  });

  it('shutdownCaptureLeaseForQuit aborts an open dialog, which declines', async () => {
    const { a, b } = await heldByAWithBInFront();
    const pending = acq(b);
    shutdownCaptureLeaseForQuit();
    expect(ceremonies[0].signal.aborted).toBe(true);
    await expect(pending).resolves.toEqual(DECLINED);
    expect(isHolder(ref(a))).toBe(true);
  });

  it("declines a dialog aborted by quit even if it answered 'join'", async () => {
    const { a, b } = await heldByAWithBInFront();
    d.runCeremony.mockImplementationOnce(() => Promise.resolve('join'));
    const pending = acq(b);
    shutdownCaptureLeaseForQuit();
    await expect(pending).resolves.toEqual(DECLINED);
    expect(isHolder(ref(a))).toBe(true);
    expect(d.revokeAudiocapShare).not.toHaveBeenCalled();
  });
});

describe('handoff: ack-or-crash (§3.4)', () => {
  it("after 'join' the gate flips at once: A is no holder, nobody is free, A is told to leave", async () => {
    const { a, b } = await handoffFromAToB();
    expect(isHolder(ref(a))).toBe(false);
    expect(isFree()).toBe(false);
    expect(captureLeaseCounts()).toMatchObject({ holder: 0, handoff: 1, claims: 0 });
    expect(d.revokeAudiocapShare).toHaveBeenCalledTimes(1);
    expect(pushes(a, CAPTURE_LEASE_REVOKED_PUSH)).toEqual([{ reason: 'moved' }]);
    expect(pushes(a, CAPTURE_LEASE_PUSH)).toEqual([{ held: false, mine: false }]);
    expect(pushes(b, CAPTURE_LEASE_PUSH)).toEqual([]);
    expect(legacyAcquire(ref(b))).toBe(false);
  });

  it.each([VOICE, TEST])("A's release (%j) is the ack and grants B", async (input) => {
    const { a, b, pending } = await handoffFromAToB();
    expect(rel(a, input)).toBe(true);
    await expect(pending).resolves.toEqual(GRANTED);
    expect(isHolder(ref(b))).toBe(true);
    expect(_holderForTesting()).toEqual({ ref: ref(b), claims: ['voice-join'], legacy: false });
    expect(d.setTrayOwner).toHaveBeenLastCalledWith(ref(b));
    expect(pushes(b, CAPTURE_LEASE_PUSH)).toEqual([{ held: true, mine: true }]);
    vi.advanceTimersByTime(HANDOFF_ACK_TIMEOUT_MS * 2);
    expect(d.crashAndReload).not.toHaveBeenCalled();
  });

  it.each<GenerationReason>(['document', 'renderer-gone', 'disposed'])(
    "A's '%s' advance settles the handoff and grants B",
    async (reason) => {
      const { a, b, pending } = await handoffFromAToB();
      if (reason === 'disposed') disposeConnection(a.record.connectionId);
      else if (reason === 'document') navigateAway(a);
      else advanceGeneration(a.record.connectionId, reason);
      await expect(pending).resolves.toEqual(GRANTED);
      expect(isHolder(ref(b))).toBe(true);
    }
  );

  it('crashes and reloads a holder that does not ack within 5 s, then grants B once it is gone', async () => {
    const { a, b, pending } = await handoffFromAToB();
    const flag = settledFlag(pending);
    vi.advanceTimersByTime(HANDOFF_ACK_TIMEOUT_MS - 1);
    expect(d.crashAndReload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(d.crashAndReload).toHaveBeenCalledTimes(1);
    expect(d.crashAndReload).toHaveBeenCalledWith(a.record);
    await flush();
    expect(flag.settled).toBe(false);
    expect(isFree()).toBe(false);
    advanceGeneration(a.record.connectionId, 'renderer-gone');
    await expect(pending).resolves.toEqual(GRANTED);
    expect(isHolder(ref(b))).toBe(true);
    vi.advanceTimersByTime(HANDOFF_ACK_TIMEOUT_MS * 2);
    expect(d.crashAndReload).toHaveBeenCalledTimes(1);
  });

  it("B's advance mid-handoff answers B 'superseded'; the lease ends free once A is gone", async () => {
    const { a, b, pending } = await handoffFromAToB();
    advanceGeneration(b.record.connectionId, 'document');
    await expect(pending).resolves.toEqual(rejected('superseded'));
    expect(holderRef()).toBeNull();
    // A was told to leave and may still have live tracks: nobody is granted until it acks.
    expect(isFree()).toBe(false);
    expect(rel(a)).toBe(true);
    expect(isFree()).toBe(true);
    expect(isHolder(ref(b))).toBe(false);
    expect(d.setTrayOwner).toHaveBeenLastCalledWith(null);
  });

  it("a B that went to the background during the handoff is refused 'not-foreground' when A acks, and the lease ends free", async () => {
    const { a, b, pending } = await handoffFromAToB();
    front(a);
    expect(rel(a)).toBe(true);
    await expect(pending).resolves.toEqual(rejected('not-foreground'));
    expect(isHolder(ref(b))).toBe(false);
    expect(isFree()).toBe(true);
    expect(d.setTrayOwner).toHaveBeenLastCalledWith(null);
  });

  it("B's advance mid-handoff still crashes an A that never acks", async () => {
    const { a, b, pending } = await handoffFromAToB();
    advanceGeneration(b.record.connectionId, 'credential-end');
    await expect(pending).resolves.toEqual(rejected('superseded'));
    vi.advanceTimersByTime(HANDOFF_ACK_TIMEOUT_MS);
    expect(d.crashAndReload).toHaveBeenCalledWith(a.record);
    advanceGeneration(a.record.connectionId, 'renderer-gone');
    expect(isFree()).toBe(true);
  });

  it('shutdownCaptureLeaseForQuit clears a pending handoff timer, so no renderer is crashed at quit', async () => {
    await handoffFromAToB();
    shutdownCaptureLeaseForQuit();
    vi.advanceTimersByTime(HANDOFF_ACK_TIMEOUT_MS * 2);
    expect(d.crashAndReload).not.toHaveBeenCalled();
  });

  it('a handoff begun after shutdown never arms the crash timer', async () => {
    const a = connect(ORIGIN_A);
    const b = connect(ORIGIN_B);
    front(a);
    await acq(a, TEST);
    shutdownCaptureLeaseForQuit();
    front(b);
    vi.advanceTimersByTime(HANDOFF_ACK_TIMEOUT_MS * 2);
    expect(d.crashAndReload).not.toHaveBeenCalled();
  });
});

describe('navigation hold (Codex Security: a cancelled navigation keeps the old document)', () => {
  it('the START of a holder navigation does not free the lease; another connection gets busy', async () => {
    const { a, b } = await heldByAWithBInFront();
    advanceGeneration(a.record.connectionId, 'document');
    expect(isFree()).toBe(false);
    expect(holderRef()).toBeNull();
    await expect(acq(b)).resolves.toEqual(rejected('busy'));
    expect(d.runCeremony).not.toHaveBeenCalled();
  });

  it('a navigation that never commits is never crashed: the lease returns to the survivor', async () => {
    const { a, b } = await heldByAWithBInFront();
    advanceGeneration(a.record.connectionId, 'document'); // cancelled: no second advance
    vi.advanceTimersByTime(HANDOFF_ACK_TIMEOUT_MS);
    expect(d.crashAndReload).not.toHaveBeenCalled();
    expect(isHolder(ref(a))).toBe(true);
    // Held again, so a competing acquire goes to the ceremony rather than being granted.
    void acq(b);
    await flush();
    expect(d.runCeremony).toHaveBeenCalledTimes(1);
  });

  it('the commit frees the lease at once and cancels the crash', async () => {
    const { a } = await heldByAWithBInFront();
    advanceGeneration(a.record.connectionId, 'document');
    commit(a);
    expect(isFree()).toBe(true);
    vi.advanceTimersByTime(HANDOFF_ACK_TIMEOUT_MS * 2);
    expect(d.crashAndReload).not.toHaveBeenCalled();
  });
});

describe('navigation events decide, not who holds now (sweep F1)', () => {
  it('a commit is a commit even for a connection that took the lease mid-navigation', async () => {
    const a = connect(ORIGIN_A);
    front(a);
    advanceGeneration(a.record.connectionId, 'document'); // started while holding nothing
    await expect(acq(a)).resolves.toEqual(GRANTED); // the old document is still live
    expect(isHolder(ref(a))).toBe(true);
    commit(a); // the document that took it is gone
    expect(isFree()).toBe(true);
    vi.advanceTimersByTime(HANDOFF_ACK_TIMEOUT_MS * 2);
    expect(d.crashAndReload).not.toHaveBeenCalled();
    expect(isFree()).toBe(true);
  });

  it('a release that ends the hold does not make the later commit look like a start', async () => {
    const a = connect(ORIGIN_A);
    front(a);
    await expect(acq(a)).resolves.toEqual(GRANTED);
    advanceGeneration(a.record.connectionId, 'document');
    expect(rel(a)).toBe(true);
    await expect(acq(a)).resolves.toEqual(GRANTED); // reacquired before the commit
    commit(a);
    expect(isFree()).toBe(true);
  });
});

describe('a stale navigation mark does not hide the next start (security review)', () => {
  it('a hold ended by release, then a reacquire, is held again by the next start and restored if cancelled', async () => {
    const a = connect(ORIGIN_A);
    front(a);
    await expect(acq(a)).resolves.toEqual(GRANTED);
    advanceGeneration(a.record.connectionId, 'document'); // navigation 1 starts (never commits)
    expect(rel(a)).toBe(true); // the hold ends by release; the mark remains
    await expect(acq(a)).resolves.toEqual(GRANTED);
    advanceGeneration(a.record.connectionId, 'document'); // navigation 2 starts
    expect(holderRef()).toBeNull(); // held behind the hold, not left open
    expect(isFree()).toBe(false);
    vi.advanceTimersByTime(HANDOFF_ACK_TIMEOUT_MS); // cancelled: nothing loading
    expect(isHolder(ref(a))).toBe(true);
    expect(d.crashAndReload).not.toHaveBeenCalled();
  });
});

describe('a revocation ack survives the holder starting a navigation (sweep F2)', () => {
  it('the document acks under its advanced generation: no crash, the grantee is admitted', async () => {
    const { a, pending } = await handoffFromAToB();
    advanceGeneration(a.record.connectionId, 'document'); // a started navigating after the push
    expect(rel(a)).toBe(true);
    await expect(pending).resolves.toEqual(GRANTED);
    vi.advanceTimersByTime(HANDOFF_ACK_TIMEOUT_MS * 2);
    expect(d.crashAndReload).not.toHaveBeenCalled();
  });
});

describe('foreground loss during a navigation hold (Codex Security P3)', () => {
  it('a device-test-only holder that navigates and is backgrounded is told to stop', async () => {
    const a = connect(ORIGIN_A);
    const b = connect(ORIGIN_B);
    front(a);
    await expect(acq(a, TEST)).resolves.toEqual(GRANTED);
    advanceGeneration(a.record.connectionId, 'document'); // the hold sets the holder aside
    clearSpies();
    front(b);
    expect(pushes(a, CAPTURE_LEASE_REVOKED_PUSH)).toEqual([{ reason: 'backgrounded' }]);
    // Its stop releases the test claim, which ends the hold.
    expect(rel(a, TEST)).toBe(true);
    expect(isFree()).toBe(true);
  });

  it('a hold that also carries a call is not revoked (a call survives the switch)', async () => {
    const a = connect(ORIGIN_A);
    const b = connect(ORIGIN_B);
    front(a);
    await expect(acq(a)).resolves.toEqual(GRANTED);
    await expect(acq(a, TEST)).resolves.toEqual(GRANTED);
    advanceGeneration(a.record.connectionId, 'document');
    clearSpies();
    front(b);
    expect(pushes(a, CAPTURE_LEASE_REVOKED_PUSH)).toEqual([]);
  });
});

describe('a navigation hold still reads as held (sweep F4)', () => {
  it('a connection coming to the front during the hold is told the lease is held', async () => {
    const { a, b } = await heldByAWithBInFront();
    front(a);
    advanceGeneration(a.record.connectionId, 'document');
    clearSpies();
    front(b);
    expect(pushes(b, CAPTURE_LEASE_PUSH)).toEqual([{ held: true, mine: false }]);
  });

  it('a hidden document that releases during the hold is told the lease is gone', async () => {
    const { a } = await heldByAWithBInFront();
    advanceGeneration(a.record.connectionId, 'document');
    clearSpies();
    expect(rel(a)).toBe(true);
    expect(pushes(a, CAPTURE_LEASE_PUSH)).toEqual([{ held: false, mine: false }]);
  });
});

describe('releasing the call from a background connection (Codex P2)', () => {
  it('leaves only a device-test claim on a hidden holder: it is revoked as backgrounded', async () => {
    const a = connect(ORIGIN_A);
    const b = connect(ORIGIN_B);
    front(a);
    await expect(acq(a)).resolves.toEqual(GRANTED);
    await expect(acq(a, TEST)).resolves.toEqual(GRANTED);
    front(b); // both claims survive the switch (a call is running)
    clearSpies();
    expect(isHolder(ref(a))).toBe(true);
    expect(rel(a, VOICE)).toBe(true);
    expect(pushes(a, CAPTURE_LEASE_REVOKED_PUSH)).toEqual([{ reason: 'backgrounded' }]);
    expect(holderRef()).toBeNull();
    // The test's own release is the ack and frees the lease.
    expect(rel(a, TEST)).toBe(true);
    expect(isFree()).toBe(true);
  });

  it('a foreground holder keeps its remaining device-test claim', async () => {
    const a = connect(ORIGIN_A);
    front(a);
    await expect(acq(a)).resolves.toEqual(GRANTED);
    await expect(acq(a, TEST)).resolves.toEqual(GRANTED);
    clearSpies();
    expect(rel(a, VOICE)).toBe(true);
    expect(pushes(a, CAPTURE_LEASE_REVOKED_PUSH)).toEqual([]);
    expect(isHolder(ref(a))).toBe(true);
  });
});

describe('releasing during a navigation hold (Codex P2)', () => {
  it('a release from the surviving document ends the lease: the timeout does not restore it', async () => {
    const { a, b } = await heldByAWithBInFront();
    advanceGeneration(a.record.connectionId, 'document'); // started, will be cancelled
    expect(rel(a)).toBe(true); // under the advanced generation
    expect(isFree()).toBe(true);
    vi.advanceTimersByTime(HANDOFF_ACK_TIMEOUT_MS * 2);
    expect(isFree()).toBe(true);
    expect(d.crashAndReload).not.toHaveBeenCalled();
    await expect(acq(b)).resolves.toEqual(GRANTED);
  });

  it('one of two claims released during the hold: only the other is restored', async () => {
    const a = connect(ORIGIN_A);
    front(a);
    await expect(acq(a)).resolves.toEqual(GRANTED);
    await expect(acq(a, TEST)).resolves.toEqual(GRANTED);
    advanceGeneration(a.record.connectionId, 'document');
    expect(rel(a, TEST)).toBe(true);
    expect(isFree()).toBe(false);
    vi.advanceTimersByTime(HANDOFF_ACK_TIMEOUT_MS);
    expect(isHolder(ref(a))).toBe(true);
    expect(rel(a, TEST)).toBe(false); // already gone
    expect(rel(a, VOICE)).toBe(true);
    expect(isFree()).toBe(true);
  });
});

describe('navigation hold: a cancelled navigation restores the lease (Gitar)', () => {
  it('a cancelled navigation gives the lease back to the same document without a crash', async () => {
    const { a, b } = await heldByAWithBInFront();
    advanceGeneration(a.record.connectionId, 'document'); // started, never commits
    vi.advanceTimersByTime(HANDOFF_ACK_TIMEOUT_MS);
    expect(d.crashAndReload).not.toHaveBeenCalled();
    expect(isHolder(ref(a))).toBe(true);
    expect(isLeaseAware(ref(a))).toBe(true);
    expect(d.setTrayOwner).toHaveBeenLastCalledWith(ref(a));
    void acq(b);
    await flush();
    expect(d.runCeremony).toHaveBeenCalledTimes(1);
    // The holder can still release normally, and a later navigation holds again.
    expect(rel(a)).toBe(true);
    expect(isFree()).toBe(true);
  });

  it('a restored holder can be held through a second navigation (no stale navigating flag)', async () => {
    const { a } = await heldByAWithBInFront();
    advanceGeneration(a.record.connectionId, 'document');
    vi.advanceTimersByTime(HANDOFF_ACK_TIMEOUT_MS);
    advanceGeneration(a.record.connectionId, 'document');
    expect(isFree()).toBe(false); // held again, not ended by the stale flag
    commit(a);
    expect(isFree()).toBe(true);
  });

  it('a second navigation START (a cancelled or superseded one) does not free the lease (Codex P1)', async () => {
    const { a, b } = await heldByAWithBInFront();
    advanceGeneration(a.record.connectionId, 'document');
    advanceGeneration(a.record.connectionId, 'document'); // nav 2 starts, nothing committed
    expect(isFree()).toBe(false);
    void acq(b);
    await flush();
    expect(d.runCeremony).not.toHaveBeenCalled(); // still reserved: busy, no second capture
    expect(holderRef()).toBeNull();
    commit(a);
    expect(isFree()).toBe(true);
  });

  it('a main-frame load failure other than ERR_ABORTED counts as the end of the document', async () => {
    const { a } = await heldByAWithBInFront();
    advanceGeneration(a.record.connectionId, 'document');
    (a.wc as EventEmitter).emit('did-fail-load', {}, -3, '', '', true); // aborted: no commit
    expect(isFree()).toBe(false);
    (a.wc as EventEmitter).emit('did-fail-load', {}, -105, '', '', true);
    advanceGeneration(a.record.connectionId, 'document');
    expect(isFree()).toBe(true);
  });

  it('a document that stays loading is crashed after the bounded re-arms', async () => {
    const { a } = await heldByAWithBInFront();
    (a.wc as { isLoading?: () => boolean }).isLoading = () => true;
    advanceGeneration(a.record.connectionId, 'document');
    vi.advanceTimersByTime(HANDOFF_ACK_TIMEOUT_MS * (NAV_HOLD_MAX_REARMS + 1));
    expect(d.crashAndReload).toHaveBeenCalledTimes(1);
  });

  it('a device-test holder that went to the background during the hold is revoked on restore', async () => {
    const a = connect(ORIGIN_A);
    const b = connect(ORIGIN_B);
    front(a);
    await expect(acq(a, TEST)).resolves.toEqual(GRANTED);
    advanceGeneration(a.record.connectionId, 'document');
    front(b); // R12 found no holder to revoke
    clearSpies();
    vi.advanceTimersByTime(HANDOFF_ACK_TIMEOUT_MS);
    expect(pushes(a, CAPTURE_LEASE_REVOKED_PUSH)).toEqual([{ reason: 'backgrounded' }]);
    expect(holderRef()).toBeNull();
  });

  it('a load still in progress at the deadline re-arms the timer instead of restoring', async () => {
    const { a } = await heldByAWithBInFront();
    let loading = true;
    (a.wc as { isLoading?: () => boolean }).isLoading = () => loading;
    advanceGeneration(a.record.connectionId, 'document');
    vi.advanceTimersByTime(HANDOFF_ACK_TIMEOUT_MS);
    expect(holderRef()).toBeNull();
    expect(d.crashAndReload).not.toHaveBeenCalled();
    loading = false;
    vi.advanceTimersByTime(HANDOFF_ACK_TIMEOUT_MS);
    expect(isHolder(ref(a))).toBe(true);
    expect(d.crashAndReload).not.toHaveBeenCalled();
  });

  it('a handoff completing clears the navigating flag so the next navigation holds', async () => {
    const { a } = await heldByAWithBInFront();
    advanceGeneration(a.record.connectionId, 'renderer-gone');
    expect(isFree()).toBe(true);
    expect(captureLeaseCounts().handoff).toBe(0);
  });
});

describe('generation listener: document-replacing reasons end the holder', () => {
  it.each<GenerationReason>(['document', 'renderer-gone', 'disposed'])(
    "'%s' on the holder clears the lease, the tray owner and tells the foreground",
    async (reason) => {
      const { a, b } = await heldByAWithBInFront();
      if (reason === 'disposed') disposeConnection(a.record.connectionId);
      else if (reason === 'document') navigateAway(a);
      else advanceGeneration(a.record.connectionId, reason);
      expect(isFree()).toBe(true);
      expect(holderRef()).toBeNull();
      expect(d.setTrayOwner).toHaveBeenCalledWith(null);
      expect(pushes(b, CAPTURE_LEASE_PUSH)).toEqual([{ held: false, mine: false }]);
      // #86's own audiocap listener stops the share gracefully (RC-4).
      expect(d.revokeAudiocapShare).not.toHaveBeenCalled();
      expect(pushes(a, CAPTURE_LEASE_PUSH)).toEqual(
        reason === 'disposed' ? [] : [{ held: false, mine: false }]
      );
      if (reason !== 'disposed') {
        expect(d.sendToConnection).toHaveBeenCalledWith(ref(a), CAPTURE_LEASE_PUSH, {
          held: false,
          mine: false,
        });
        expect(isLeaseAware(ref(a))).toBe(false);
      }
    }
  );

  it.each<GenerationReason>(['document', 'renderer-gone', 'disposed'])(
    "'%s' on a non-holder has no effect",
    async (reason) => {
      const { a, b } = await heldByAWithBInFront();
      if (reason === 'disposed') disposeConnection(b.record.connectionId);
      else advanceGeneration(b.record.connectionId, reason);
      expect(isHolder(ref(a))).toBe(true);
      expect(d.setTrayOwner).not.toHaveBeenCalled();
      expect(anyPushTo(a)).toBe(false);
    }
  );
});

describe('generation listener: credential reasons re-key the holder (RC-14)', () => {
  it.each<GenerationReason>(['credential-start', 'credential-end'])(
    "'%s' on the holder keeps the lease with the same document under its new generation",
    async (reason) => {
      const { a, b } = await heldByAWithBInFront();
      const before = ref(a);
      advanceGeneration(a.record.connectionId, reason);
      const after = ref(a);
      expect(isHolder(after)).toBe(true);
      expect(isHolder(before)).toBe(false);
      expect(isFree()).toBe(false);
      expect(captureLeaseCounts().claims).toBe(1);
      expect(d.setTrayOwner).toHaveBeenCalledWith(after);
      expect(d.sendToConnection).not.toHaveBeenCalled();
      expect(d.revokeAudiocapShare).not.toHaveBeenCalled();
      expect(isLeaseAware(after)).toBe(true);

      const pending = acq(b);
      expect(d.runCeremony).toHaveBeenCalledWith(after, ref(b), expect.any(AbortSignal));
      ceremonies[0].answer('stay');
      await expect(pending).resolves.toEqual(DECLINED);

      expect(rel(a)).toBe(true);
      expect(isFree()).toBe(true);
    }
  );

  it.each<GenerationReason>(['credential-start', 'credential-end'])(
    "'%s' on the handing-off holder keeps the handoff; an ack from the new generation grants B",
    async (reason) => {
      const { a, b, pending } = await handoffFromAToB();
      advanceGeneration(a.record.connectionId, reason);
      expect(captureLeaseCounts().handoff).toBe(1);
      vi.advanceTimersByTime(HANDOFF_ACK_TIMEOUT_MS - 1);
      expect(rel(a)).toBe(true);
      await expect(pending).resolves.toEqual(GRANTED);
      expect(isHolder(ref(b))).toBe(true);
    }
  );

  it.each<GenerationReason>(['credential-start', 'credential-end'])(
    "'%s' on the handing-off holder does not stop the 5 s crash",
    async (reason) => {
      const { a } = await handoffFromAToB();
      advanceGeneration(a.record.connectionId, reason);
      vi.advanceTimersByTime(HANDOFF_ACK_TIMEOUT_MS);
      expect(d.crashAndReload).toHaveBeenCalledTimes(1);
      expect(d.crashAndReload).toHaveBeenCalledWith(a.record);
    }
  );

  it.each<GenerationReason>(['credential-start', 'credential-end'])(
    "'%s' on a lease-aware non-holder keeps it lease-aware",
    (reason) => {
      const b = connect(ORIGIN_B);
      front(b);
      markLeaseAware(ref(b));
      advanceGeneration(b.record.connectionId, reason);
      expect(isLeaseAware(ref(b))).toBe(true);
      expect(legacyAcquire(ref(b))).toBe(false);
      expect(isFree()).toBe(true);
      // Control: a document change does drop the mark.
      advanceGeneration(b.record.connectionId, 'document');
      expect(isLeaseAware(ref(b))).toBe(false);
      expect(legacyAcquire(ref(b))).toBe(true);
    }
  );

  it.each<GenerationReason>(['credential-start', 'credential-end'])(
    "'%s' on the requester mid-ceremony aborts it; the reply and a stale retry are 'superseded'",
    async (reason) => {
      const { a, b } = await heldByAWithBInFront();
      const staleB = senderOf(b);
      const pending = acquire(staleB, VOICE);
      advanceGeneration(b.record.connectionId, reason);
      expect(ceremonies[0].signal.aborted).toBe(true);
      await expect(pending).resolves.toEqual(rejected('superseded'));
      await expect(acquire(staleB, VOICE)).resolves.toEqual(rejected('superseded'));
      expect(isHolder(ref(a))).toBe(true);
    }
  );
});

describe('onForegroundChanged', () => {
  it("revokes a device-test-only lease that leaves the foreground with 'backgrounded' (R12)", async () => {
    const a = connect(ORIGIN_A);
    const b = connect(ORIGIN_B);
    front(a);
    await acq(a, TEST);
    clearSpies();
    front(b);
    expect(pushes(a, CAPTURE_LEASE_REVOKED_PUSH)).toEqual([{ reason: 'backgrounded' }]);
    expect(isHolder(ref(a))).toBe(false);
    expect(isFree()).toBe(false);
    expect(pushes(b, CAPTURE_LEASE_PUSH)).toEqual([{ held: false, mine: false }]);
    expect(rel(a, TEST)).toBe(true);
    expect(isFree()).toBe(true);
    await expect(acq(b)).resolves.toEqual(GRANTED);
    expect(d.runCeremony).not.toHaveBeenCalled();
  });

  it('a backgrounded device-test holder that never releases is crashed at 5 s, then the lease frees', async () => {
    const a = connect(ORIGIN_A);
    const b = connect(ORIGIN_B);
    front(a);
    await acq(a, TEST);
    front(b);
    vi.advanceTimersByTime(HANDOFF_ACK_TIMEOUT_MS);
    expect(d.crashAndReload).toHaveBeenCalledWith(a.record);
    advanceGeneration(a.record.connectionId, 'renderer-gone');
    expect(isFree()).toBe(true);
  });

  it('leaves a holder that claims voice-join alone, and tells the new foreground it is held', async () => {
    const a = connect(ORIGIN_A);
    const b = connect(ORIGIN_B);
    front(a);
    await acq(a);
    await acq(a, TEST);
    clearSpies();
    front(b);
    expect(pushes(a, CAPTURE_LEASE_REVOKED_PUSH)).toEqual([]);
    expect(isHolder(ref(a))).toBe(true);
    expect(pushes(b, CAPTURE_LEASE_PUSH)).toEqual([{ held: true, mine: false }]);
    expect(anyPushTo(a)).toBe(false);
    front(a);
    expect(pushes(a, CAPTURE_LEASE_PUSH)).toEqual([{ held: true, mine: true }]);
  });

  it('pushes nothing and does not throw when the foreground becomes null (Review Focus 5)', async () => {
    const a = connect(ORIGIN_A);
    front(a);
    await acq(a);
    clearSpies();
    expect(() => front(null)).not.toThrow();
    expect(d.sendToConnection).not.toHaveBeenCalled();
    expect(isHolder(ref(a))).toBe(true);
  });

  it('a backgrounded revocation whose record is gone clears the lease without throwing', async () => {
    const a = connect(ORIGIN_A);
    const b = connect(ORIGIN_B);
    front(a);
    await acq(a, TEST);
    d.recordFor.mockReturnValue(undefined);
    expect(() => front(b)).not.toThrow();
    expect(isFree()).toBe(true);
    vi.advanceTimersByTime(HANDOFF_ACK_TIMEOUT_MS * 2);
    expect(d.crashAndReload).not.toHaveBeenCalled();
  });

  it('a foreground disposal of a device-test holder ends the lease through the generation listener', async () => {
    const a = connect(ORIGIN_A);
    front(a);
    await acq(a, TEST);
    expect(() => disposeConnection(a.record.connectionId)).not.toThrow();
    expect(isFree()).toBe(true);
    expect(d.revokeAudiocapShare).not.toHaveBeenCalled();
  });
});

describe('legacyAcquire (§5.2)', () => {
  it('grants an implicit lease to a free, foreground, non-lease-aware document and logs once per generation', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const a = connect(ORIGIN_A);
    front(a);
    expect(legacyAcquire(ref(a))).toBe(true);
    expect(_holderForTesting()).toEqual({ ref: ref(a), claims: ['voice-join'], legacy: true });
    expect(d.setTrayOwner).toHaveBeenCalledWith(ref(a));
    expect(legacyAcquire(ref(a))).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[capture] legacy implicit lease');
    navigateAway(a);
    expect(isFree()).toBe(true);
    expect(legacyAcquire(ref(a))).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('refuses a document that has made any capture:* call in its generation', async () => {
    const a = connect(ORIGIN_A);
    const b = connect(ORIGIN_B);
    front(b);
    await expect(acq(a)).resolves.toEqual(rejected('not-foreground'));
    front(a);
    expect(isLeaseAware(ref(a))).toBe(true);
    expect(legacyAcquire(ref(a))).toBe(false);
  });

  it('refuses a background document', () => {
    const a = connect(ORIGIN_A);
    const b = connect(ORIGIN_B);
    front(b);
    expect(legacyAcquire(ref(a))).toBe(false);
    expect(isFree()).toBe(true);
  });

  it('refuses while a handoff is pending', async () => {
    await handoffFromAToB();
    const c = connect(ORIGIN_C);
    front(c);
    expect(legacyAcquire(ref(c))).toBe(false);
  });

  it('refuses a stale ref and a service that declares media: false', () => {
    const a = connect(ORIGIN_A);
    front(a);
    const stale = ref(a);
    advanceGeneration(a.record.connectionId, 'document');
    expect(legacyAcquire(stale)).toBe(false);
    d.serviceMediaCapability.mockReturnValue(false);
    expect(legacyAcquire(ref(a))).toBe(false);
    expect(isFree()).toBe(true);
  });
});

describe('counts and the default crash', () => {
  it('captureLeaseCounts tracks holder, handoff, claims and lease-aware documents', async () => {
    expect(captureLeaseCounts()).toEqual({ holder: 0, handoff: 0, claims: 0, leaseAware: 0 });
    const { a } = await handoffFromAToB();
    expect(captureLeaseCounts()).toEqual({ holder: 0, handoff: 1, claims: 0, leaseAware: 2 });
    disposeConnection(a.record.connectionId);
    expect(captureLeaseCounts()).toEqual({ holder: 1, handoff: 0, claims: 1, leaseAware: 1 });
  });

  it('crashAndReloadRenderer reloads only after the renderer process is gone', () => {
    const order: string[] = [];
    let gone: (() => void) | null = null;
    const record = {
      webContents: {
        isDestroyed: () => false,
        once: (event: string, cb: () => void) => {
          if (event === 'render-process-gone') gone = cb;
        },
        forcefullyCrashRenderer: () => order.push('crash'),
        reload: () => order.push('reload'),
      },
    } as unknown as ConnectionRecord;
    crashAndReloadRenderer(record);
    expect(order).toEqual(['crash']);
    gone?.();
    expect(order).toEqual(['crash', 'reload']);
  });

  it('crashAndReloadRenderer does not reload a webContents destroyed after the crash', () => {
    let destroyed = false;
    let gone: (() => void) | null = null;
    const reload = vi.fn();
    const record = {
      webContents: {
        isDestroyed: () => destroyed,
        once: (_e: string, cb: () => void) => {
          gone = cb;
        },
        forcefullyCrashRenderer: () => undefined,
        reload,
      },
    } as unknown as ConnectionRecord;
    crashAndReloadRenderer(record);
    destroyed = true;
    gone?.();
    expect(reload).not.toHaveBeenCalled();
  });

  it('crashAndReloadRenderer does nothing to a destroyed webContents', () => {
    const crash = vi.fn();
    const record = {
      webContents: { isDestroyed: () => true, forcefullyCrashRenderer: crash, reload: crash },
    } as unknown as ConnectionRecord;
    expect(() => crashAndReloadRenderer(record)).not.toThrow();
    expect(crash).not.toHaveBeenCalled();
  });
});
