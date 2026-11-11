// @vitest-environment node
/**
 * Tests for the `audiocap:start` invoke (#3198 PR 3, plan Task 10).
 *
 * This is the ONE handler the #3198 sender-frame criterion binds (A4, R5). PR 1's
 * `audiocap:capability` is a `webContents.send` PUSH with no sender to validate,
 * so the absence of a check there is design rather than oversight.
 *
 * ONE CASE PER FENCE, and that is the point of the file. The handler's docblock
 * names four fences in a fixed order; a fence with no case is a fence a future
 * edit can delete while the suite stays green -- the exact shape #3198 PR 2's
 * review found four times (dead `:disabled` CSS, the half-applied sanitiser, the
 * Linux copy mirror, the parameter with no call site).
 *
 * Mocking convention follows `tests/unit/main/audiocapHost.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const startAudiocapHost = vi.fn();
const stopAudiocapHost = vi.fn();
/**
 * Mocked although `audiocap.ts` never imports it, so the "graceful, never kill" case can
 * assert its ABSENCE. A spy that the module cannot reach proves the negative it is there
 * to prove — and if a future edit does reach for it, that case goes red rather than the
 * module silently swapping a reap for a stop.
 */
const killAudiocapHost = vi.fn();
const getSources = vi.fn();
const handle = vi.fn();
/**
 * The renderer-loss epoch (#3394 PR 1 fix, red-team VULN-A). A fake counter the test
 * drives directly to stand in for `wireAudiocapRendererLoss` firing on the real host --
 * this file mocks `audiocapHost` wholesale, so there is no real handler to trigger. What
 * matters here is only whether `handleAudiocapStart` READS this value after its await,
 * not how it got bumped.
 */
const audiocapRendererLossEpoch = vi.fn();
/**
 * The host's LIVE generation (`session?.generation ?? 0`). 0 by default: nothing is live,
 * so the busy fence (#86 Task 7B pass 2) never fires in a case that does not ask for it.
 * A case that needs "A's share is live" returns the generation A's start handed the host.
 */
const currentAudiocapGeneration = vi.fn(() => 0);

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/concord-test-userdata' },
  ipcMain: { handle: (...a: unknown[]) => handle(...a) },
  desktopCapturer: { getSources: (...a: unknown[]) => getSources(...a) },
}));

vi.mock('../../../src/main/audiocapHost', () => ({
  startAudiocapHost: (...a: unknown[]) => startAudiocapHost(...a),
  stopAudiocapHost: (...a: unknown[]) => stopAudiocapHost(...a),
  killAudiocapHost: (...a: unknown[]) => killAudiocapHost(...a),
  currentAudiocapGeneration: () => currentAudiocapGeneration(),
  audiocapRendererLossEpoch: (...a: unknown[]) => audiocapRendererLossEpoch(...a),
}));

/**
 * Import fresh per case.
 *
 * NOT decoration: `shareGeneration` is module-local and monotonic, so without a
 * reset the generation a case observes depends on how many EARLIER cases happened
 * to reach the host. Pinning `1` against a shared module would make this file
 * order-coupled -- green today, red the moment a case is inserted above.
 */
async function loadIpc() {
  vi.resetModules();
  const reg = await import('../../../src/main/connectionRegistry');
  const ipcReg = await import('../../../src/main/ipc/registry');
  const mod = await import('../../../src/main/ipc/audiocap');
  ipcReg._resetIpcRegistryForTesting();
  reg._resetConnectionRegistryForTesting();
  // #86 Task 7B re-point: "the main window" is now the saas connection's bound primary.
  // `mainWebContents` is bound as that primary, and the handlers run behind the real
  // `registerIpc` wrapper. The legacy `getMainWindow` argument the cases below still
  // pass is mapped onto the binding: a provider that names a live, undestroyed window
  // whose webContents IS `mainWebContents` leaves the event as it is; anything else
  // (null, destroyed, a throwing getter, another webContents) presents the event from
  // an UNBOUND sender, which is what "no main window" means once admission is the
  // binding. Every assertion below is unchanged.
  const svc = reg.registerService('https://api.concordvoice.chat', {
    makeSession: () => ({}) as never,
    makeCustody: () => ({}) as never,
    isValidatedSelfHostedApiBase: () => true,
  });
  if (!svc.ok) throw new Error(svc.reason);
  const opened = reg.openConnection(svc.service.serviceId, mainWebContents as never, null);
  if (!opened.ok) throw new Error(opened.reason);
  reg.bindSender(mainWebContents as never, opened.record.connectionId, 'primary');
  // #86 Task 7B pass 2 re-point: audiocap:start admits only the FOREGROUND primary, and the
  // pre-#86 main window was the one visible window, so "the main window" is foreground.
  reg.setForeground(opened.record.connectionId);
  let registered = false;
  const register = () => {
    mod.registerAudiocapIpc();
    registered = true;
  };
  const wrapper = (channel: string) => {
    if (!registered) register();
    const calls = handle.mock.calls.filter((c) => c[0] === channel);
    return calls[calls.length - 1][1] as (...a: unknown[]) => unknown;
  };
  const unbound = { mainFrame: { frameTreeNodeId: 1 } };
  const asSender = (event: unknown, provider: () => unknown) => {
    let live = false;
    try {
      const w = provider() as { isDestroyed(): boolean; webContents: unknown } | null;
      live = !!w && !w.isDestroyed() && w.webContents === mainWebContents;
    } catch {
      live = false;
    }
    if (live) return event;
    return new Proxy(event as object, {
      get: (t, p) => (p === 'sender' ? unbound : Reflect.get(t, p)),
    });
  };
  return {
    ...mod,
    reg,
    registerAudiocapIpc: (..._legacy: unknown[]) => register(),
    handleAudiocapStart: (event: unknown, request: unknown, _o: unknown, provider: () => unknown) =>
      wrapper('audiocap:start')(asSender(event, provider), request) as ReturnType<
        typeof mod.handleAudiocapStart
      >,
    handleAudiocapStop: (event: unknown, _o: unknown, provider: () => unknown): void => {
      wrapper('audiocap:stop')(asSender(event, provider));
    },
  };
}

/**
 * THE MAIN WINDOW'S WEB CONTENTS (#3394 PR 1, R5). A plain object identity stand-in for
 * `BrowserWindow.webContents` -- `handleAudiocapStart`/`handleAudiocapStop` admission
 * compares `event.sender` against `getMainWindow()?.webContents` BY REFERENCE, and
 * `event.senderFrame.frameTreeNodeId` against `mainWebContents.mainFrame.frameTreeNodeId`.
 */
const mainWebContents = { mainFrame: { frameTreeNodeId: 1 } };
const getMainWindow = () => ({ isDestroyed: () => false, webContents: mainWebContents }) as never;

/** A sender frame the allowlist accepts, FROM THE MAIN WINDOW'S OWN MAIN FRAME. */
const trustedEvent = {
  senderFrame: { parent: null, url: 'app://concord/index.html', frameTreeNodeId: 1 },
  sender: mainWebContents,
} as never;

/**
 * FOURTH ARGUMENT, REQUIRED (#3394 PR 1, R5). `registerAudiocapIpc(getRemoteSpaOrigin,
 * getMainWindow)`, `handleAudiocapStart(event, request, getRemoteSpaOrigin, getMainWindow)`,
 * `handleAudiocapStop(event, getRemoteSpaOrigin, getMainWindow)`. Admission is now
 * `requireTrustedSender(...)` AND `event.sender === getMainWindow()?.webContents` AND the
 * sender frame is that webContents' own main frame (by `frameTreeNodeId`); a null
 * `senderFrame` is refused, matching every other admission fence in this module.
 */
const getRemoteSpaOrigin = () => 'app://concord';

beforeEach(() => {
  vi.clearAllMocks();
  getSources.mockResolvedValue([{ id: 'window:42:0', name: 'Some App' }]);
  startAudiocapHost.mockResolvedValue({ ok: true, generation: 1, perProcessAudio: true });
  audiocapRendererLossEpoch.mockReset();
  audiocapRendererLossEpoch.mockReturnValue(0);
  currentAudiocapGeneration.mockReset();
  currentAudiocapGeneration.mockReturnValue(0);
});

describe('audiocap:start — fence 1, the sender frame (A4, spec test 4)', () => {
  it('refuses an untrusted origin', async () => {
    const { handleAudiocapStart } = await loadIpc();
    const evt = { senderFrame: { parent: null, url: 'https://evil.example/' } } as never;
    const r = await handleAudiocapStart(
      evt,
      { sourceId: 'window:42:0' },
      getRemoteSpaOrigin,
      getMainWindow
    );
    expect(r).toEqual({ ok: false, reason: 'protocol-fault' });
    expect(startAudiocapHost).not.toHaveBeenCalled();
  });

  it('refuses a null senderFrame', async () => {
    const { handleAudiocapStart } = await loadIpc();
    const evt = { senderFrame: null } as never;
    const r = await handleAudiocapStart(
      evt,
      { sourceId: 'window:42:0' },
      getRemoteSpaOrigin,
      getMainWindow
    );
    expect(r).toEqual({ ok: false, reason: 'protocol-fault' });
    expect(startAudiocapHost).not.toHaveBeenCalled();
  });

  it('reads the frame BEFORE the enumeration, so a hostile sender costs no OS work', async () => {
    const { handleAudiocapStart } = await loadIpc();
    const evt = { senderFrame: { parent: null, url: 'https://evil.example/' } } as never;
    await handleAudiocapStart(evt, { sourceId: 'window:42:0' }, getRemoteSpaOrigin, getMainWindow);
    // The ORDER is the design (A4): a validation that runs after other work is a
    // validation a future edit can reorder past. Asserting the enumeration never
    // ran is how that ordering is observable from outside the function.
    expect(getSources).not.toHaveBeenCalled();
  });
});

describe('audiocap:start — fence 2, the payload shape', () => {
  it.each([
    ['a non-string sourceId', { sourceId: 42 }],
    ['a missing sourceId', {}],
    ['a null payload', null],
  ])('refuses %s with protocol-fault, not target-unresolved', async (_label, payload) => {
    const { handleAudiocapStart } = await loadIpc();
    const r = await handleAudiocapStart(
      trustedEvent,
      payload as never,
      getRemoteSpaOrigin,
      getMainWindow
    );
    // `protocol-fault`, NOT `target-unresolved`: a non-record payload or a
    // non-string sourceId is a CONTRACT violation, not a target problem.
    expect(r).toEqual({ ok: false, reason: 'protocol-fault' });
    expect(startAudiocapHost).not.toHaveBeenCalled();
  });
});

describe('audiocap:start — fences 3 and 4, D6 main-side (A5, spec test 3)', () => {
  it('refuses a screen: id ON FENCE 3, with fence 4 deliberately satisfied', async () => {
    const { handleAudiocapStart } = await loadIpc();
    // THE ENUMERATION CONTAINS THE SCREEN ID, and that is the whole point of this
    // fixture. With the default enumeration (`window:42:0` only) fence 4 would refuse
    // `screen:0:0` as absent, so the case passed whether or not fence 3 existed — a
    // fixture that can fail for two reasons pins neither (tests.md § Vacuity). Listing
    // the id makes fence 4 admit it, so ONLY the `window:` prefix check can produce the
    // refusal.
    getSources.mockResolvedValue([{ id: 'screen:0:0', name: 'Entire Screen' }]);
    const r = await handleAudiocapStart(
      trustedEvent,
      { sourceId: 'screen:0:0' },
      getRemoteSpaOrigin,
      getMainWindow
    );
    expect(r).toEqual({ ok: false, reason: 'target-unresolved' });
    expect(startAudiocapHost).not.toHaveBeenCalled();
    // And prove fence 4 really was satisfied rather than silently doing the work: a
    // `screen:` id never reaches the enumeration at all, because fence 3 returns first.
    expect(getSources).not.toHaveBeenCalled();
  });

  it('refuses a well-formed id for a window absent from the live enumeration', async () => {
    const { handleAudiocapStart } = await loadIpc();
    getSources.mockResolvedValue([{ id: 'window:99:0', name: 'Other App' }]);
    const r = await handleAudiocapStart(
      trustedEvent,
      { sourceId: 'window:42:0' },
      getRemoteSpaOrigin,
      getMainWindow
    );
    expect(r).toEqual({ ok: false, reason: 'target-unresolved' });
    expect(startAudiocapHost).not.toHaveBeenCalled();
  });

  it('enumerates without thumbnails, so the staleness check is not a screenshot', async () => {
    const { handleAudiocapStart } = await loadIpc();
    await handleAudiocapStart(
      trustedEvent,
      { sourceId: 'window:42:0' },
      getRemoteSpaOrigin,
      getMainWindow
    );
    expect(getSources).toHaveBeenCalledWith({
      types: ['window'],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false,
    });
  });
});

describe('audiocap:start — what reaches the host', () => {
  it('ignores an extra systemAudio field rather than honouring it', async () => {
    const { handleAudiocapStart } = await loadIpc();
    const r = await handleAudiocapStart(
      trustedEvent,
      { sourceId: 'window:42:0', systemAudio: true } as never,
      getRemoteSpaOrigin,
      getMainWindow
    );
    expect(r).toEqual({ ok: true, generation: 1, perProcessAudio: true });
    // OBEYED, NOT MERELY PASSED (spec test 9): assert what reached the host, not
    // that an options object was shaped a certain way.
    expect(startAudiocapHost).toHaveBeenCalledWith(
      1,
      42,
      expect.objectContaining({ kind: 'audiocap' })
    );
    expect(JSON.stringify(startAudiocapHost.mock.calls[0])).not.toContain('systemAudio');
  });

  it('VARIES the handle: a different window id reaches the host as a different handle', async () => {
    const { handleAudiocapStart } = await loadIpc();
    getSources.mockResolvedValue([{ id: 'window:1337:0', name: 'Another App' }]);
    await handleAudiocapStart(
      trustedEvent,
      { sourceId: 'window:1337:0' },
      getRemoteSpaOrigin,
      getMainWindow
    );
    // `internal-reference` § "a branch that is OBEYED must be proven REACHED":
    // a single-handle assertion proves the argument EXISTS. Only varying it at the
    // caller proves the value is CARRIED rather than constant-folded. This is the
    // rule #3198 PR 2 wrote after `screenAudioRefusalMessage` gained a `platform`
    // parameter that no call site ever varied.
    expect(startAudiocapHost).toHaveBeenCalledWith(
      1,
      1337,
      expect.objectContaining({ kind: 'audiocap' })
    );
  });

  it('mints a NEW generation per share, so a stale result is distinguishable', async () => {
    const { handleAudiocapStart } = await loadIpc();
    await handleAudiocapStart(
      trustedEvent,
      { sourceId: 'window:42:0' },
      getRemoteSpaOrigin,
      getMainWindow
    );
    await handleAudiocapStart(
      trustedEvent,
      { sourceId: 'window:42:0' },
      getRemoteSpaOrigin,
      getMainWindow
    );
    expect(startAudiocapHost.mock.calls.map((c) => c[0])).toEqual([1, 2]);
    // NOT `currentAudiocapGeneration()`, which returns the LIVE child's number --
    // 0 whenever nothing is live, which is every share start. The mock above
    // returns a constant 1 precisely so that a handler wired to it would fail here.
  });
});

/**
 * RED-TEAM REGRESSION LOCK (#3394 PR 1 fix). Confirmed findings: a renderer that goes away
 * WHILE `desktopCapturer.getSources` is pending -- via `did-navigate` or `render-process-gone`
 * -- lets the enumeration resolve into a start for a document that no longer exists (VULN-A);
 * a `senderFrame` that goes null during the same window, with no loss event, slips past
 * because fence 1 is read only once, before the await.
 *
 * The fix snapshots `audiocapRendererLossEpoch()` beside the existing `operationEpoch`, and
 * after the enumeration re-checks BOTH epochs (falling to `target-unresolved`, matching the
 * pre-existing stop-during-enumeration branch) and then re-runs the sender fence (falling to
 * `protocol-fault`). This file mocks `audiocapHost` wholesale (see the file header), so a real
 * `wireAudiocapRendererLoss` handler cannot fire here -- `audiocapRendererLossEpoch` is driven
 * directly to stand in for it. What is under test is only whether `handleAudiocapStart` READS
 * the value after its await; `tests/unit/main/audiocapHost.test.ts` covers whether the real
 * host handlers correctly bump it.
 */
describe('audiocap:start — renderer-loss and post-await sender re-check (#3394 PR 1 fix)', () => {
  /** Defers `getSources` so the test can act while the enumeration is still in flight. */
  function deferredSources() {
    let release!: (sources: Array<{ id: string; name: string }>) => void;
    const pending = new Promise<Array<{ id: string; name: string }>>((resolve) => {
      release = resolve;
    });
    getSources.mockImplementationOnce(() => pending);
    return (
      sources: Array<{ id: string; name: string }> = [{ id: 'window:42:0', name: 'Some App' }]
    ) => release(sources);
  }

  /** A trusted `IpcMainInvokeEvent` whose `senderFrame` can be made to go null mid-call. */
  function flippableTrustedEvent() {
    let gone = false;
    return {
      // Carries the main window's identity so A3 passes the FIRST fence and reaches the
      // post-await re-check it exists to exercise; without it the new main-frame check
      // refuses at the top and the test goes green without testing anything.
      event: {
        sender: mainWebContents,
        get senderFrame() {
          return gone
            ? null
            : { parent: null, url: 'app://concord/index.html', frameTreeNodeId: 1 };
        },
      } as never,
      documentGone: () => {
        gone = true;
      },
    };
  }

  it('A1: a did-navigate during the pending enumeration refuses the start (target-unresolved, no fork)', async () => {
    const release = deferredSources();
    const { handleAudiocapStart } = await loadIpc();
    const pending = handleAudiocapStart(
      trustedEvent,
      { sourceId: 'window:42:0' },
      getRemoteSpaOrigin,
      getMainWindow
    );
    // Stand-in for `did-navigate` firing on the wired contents while the enumeration is
    // still pending: the real handler would bump `audiocapRendererLossEpoch()` before
    // calling `killAudiocapCapture()`.
    audiocapRendererLossEpoch.mockReturnValue(1);
    release();
    await expect(pending).resolves.toEqual({ ok: false, reason: 'target-unresolved' });
    expect(startAudiocapHost).not.toHaveBeenCalled();
  });

  // C11: renamed from "A2: a render-process-gone during the pending enumeration refuses
  // the start the same way". This file mocks `audiocapHost` wholesale (see the header),
  // so `audiocapRendererLossEpoch` is a bare counter this case drives directly -- it
  // cannot involve a REAL `render-process-gone` event, and its body is byte-identical to
  // A1's. What it actually proves is that the FENCE reacts to the epoch moving at all,
  // regardless of which event bumped it -- a duplicate of A1 at the fence level, kept
  // because that duplication is itself the point: the handler cannot distinguish (and
  // must not try to) which loss event produced the bump.
  it('A2 (duplicate of A1 by design): the epoch fence reacts to ANY bump, not to a specific loss event', async () => {
    const release = deferredSources();
    const { handleAudiocapStart } = await loadIpc();
    const pending = handleAudiocapStart(
      trustedEvent,
      { sourceId: 'window:42:0' },
      getRemoteSpaOrigin,
      getMainWindow
    );
    // Stand-in for `render-process-gone` -- same counter, same fence.
    audiocapRendererLossEpoch.mockReturnValue(1);
    release();
    await expect(pending).resolves.toEqual({ ok: false, reason: 'target-unresolved' });
    expect(startAudiocapHost).not.toHaveBeenCalled();
  });

  it('A3: senderFrame goes null during the pending enumeration with NO loss event refuses protocol-fault', async () => {
    const release = deferredSources();
    const { handleAudiocapStart } = await loadIpc();
    const { event, documentGone } = flippableTrustedEvent();
    const pending = handleAudiocapStart(
      event,
      { sourceId: 'window:42:0' },
      getRemoteSpaOrigin,
      getMainWindow
    );
    // The renderer-loss epoch never moves here -- this is the OTHER way the sender can go
    // away mid-call, which the epoch fence alone cannot see.
    documentGone();
    release();
    await expect(pending).resolves.toEqual({ ok: false, reason: 'protocol-fault' });
    expect(startAudiocapHost).not.toHaveBeenCalled();
  });

  it('A4 (regression): an undisturbed start still resolves ok:true', async () => {
    const { handleAudiocapStart } = await loadIpc();
    const r = await handleAudiocapStart(
      trustedEvent,
      { sourceId: 'window:42:0' },
      getRemoteSpaOrigin,
      getMainWindow
    );
    expect(r).toEqual({ ok: true, generation: 1, perProcessAudio: true });
    expect(startAudiocapHost).toHaveBeenCalledWith(
      1,
      42,
      expect.objectContaining({ kind: 'audiocap' })
    );
  });
});

describe('registerAudiocapIpc', () => {
  it('registers exactly the two audiocap channels', async () => {
    const { registerAudiocapIpc } = await loadIpc();
    registerAudiocapIpc(getRemoteSpaOrigin, getMainWindow);
    // EXACTLY, not "at least". A third channel appearing here is a widened renderer→main
    // surface, which is the thing this assertion exists to make visible in review rather
    // than a count worth keeping accurate for its own sake.
    expect(handle.mock.calls.map((c) => c[0])).toEqual(['audiocap:start', 'audiocap:stop']);
  });
});

describe('audiocap:stop', () => {
  it('cancels a pending start before it can invoke the native host', async () => {
    let releaseSources!: (sources: Array<{ id: string; name: string }>) => void;
    const sourcesReady = new Promise<Array<{ id: string; name: string }>>((resolve) => {
      releaseSources = resolve;
    });
    getSources.mockImplementationOnce(() => sourcesReady);

    const { handleAudiocapStart, handleAudiocapStop } = await loadIpc();
    const pendingStart = handleAudiocapStart(
      trustedEvent,
      { sourceId: 'window:42:0' },
      getRemoteSpaOrigin,
      getMainWindow
    );
    expect(getSources).toHaveBeenCalledTimes(1);

    handleAudiocapStop(trustedEvent, getRemoteSpaOrigin, getMainWindow);
    releaseSources([{ id: 'window:42:0', name: 'Some App' }]);
    await pendingStart;

    expect(
      startAudiocapHost,
      'a trusted audiocap:stop must cancel a pending start before it invokes startAudiocapHost'
    ).not.toHaveBeenCalled();
  });

  it('allows an uncancelled pending start to invoke the native host', async () => {
    let releaseSources!: (sources: Array<{ id: string; name: string }>) => void;
    const sourcesReady = new Promise<Array<{ id: string; name: string }>>((resolve) => {
      releaseSources = resolve;
    });
    getSources.mockImplementationOnce(() => sourcesReady);

    const { handleAudiocapStart } = await loadIpc();
    const pendingStart = handleAudiocapStart(
      trustedEvent,
      { sourceId: 'window:42:0' },
      getRemoteSpaOrigin,
      getMainWindow
    );
    expect(startAudiocapHost).not.toHaveBeenCalled();

    releaseSources([{ id: 'window:42:0', name: 'Some App' }]);
    await pendingStart;
    expect(startAudiocapHost).toHaveBeenCalledWith(
      1,
      42,
      expect.objectContaining({ kind: 'audiocap' })
    );
  });

  it('reaps the child on a trusted sender', async () => {
    const { handleAudiocapStart, handleAudiocapStop } = await loadIpc();
    // #86 Task 7B re-point: stop is owner-only, so this connection starts a share first.
    await handleAudiocapStart(
      trustedEvent,
      { sourceId: 'window:42:0' },
      getRemoteSpaOrigin,
      getMainWindow
    );
    vi.mocked(stopAudiocapHost).mockClear();
    handleAudiocapStop(trustedEvent, getRemoteSpaOrigin, getMainWindow);
    expect(stopAudiocapHost).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an untrusted origin', { senderFrame: { parent: null, url: 'https://evil.example/' } }],
    ['a null senderFrame', { senderFrame: null }],
  ])('refuses %s', async (_label, evt) => {
    const { handleAudiocapStop } = await loadIpc();
    handleAudiocapStop(evt as never, getRemoteSpaOrigin, getMainWindow);
    // This handler reaches a process kill, so an untrusted frame must not be able to end
    // another window's share. Same fence, same position — first statement — as `start`.
    expect(stopAudiocapHost).not.toHaveBeenCalled();
  });

  it('uses the GRACEFUL stop, never the kill', async () => {
    const { handleAudiocapStart, handleAudiocapStop } = await loadIpc();
    // #86 Task 7B re-point: stop is owner-only, so this connection starts a share first.
    await handleAudiocapStart(
      trustedEvent,
      { sourceId: 'window:42:0' },
      getRemoteSpaOrigin,
      getMainWindow
    );
    vi.mocked(stopAudiocapHost).mockClear();
    handleAudiocapStop(trustedEvent, getRemoteSpaOrigin, getMainWindow);
    // `killAudiocapHost` destroys the tap just as well and reads none of the child's
    // teardown evidence: `handleStop` is the only caller of the addon's `status()`, so a
    // kill here would silently retire the R9 silence detector, `quiesceProved` and
    // `destroyFailures` — the shipped-but-unread failure this epic keeps producing.
    expect(stopAudiocapHost).toHaveBeenCalled();
    expect(killAudiocapHost).not.toHaveBeenCalled();
  });
});

/**
 * RED. admission — main window's main frame ONLY (#3394 PR 1, R5).
 *
 * The interface the accompanying engineer PR implements:
 *   `registerAudiocapIpc(getRemoteSpaOrigin, getMainWindow: () => BrowserWindow | null)`
 *   `handleAudiocapStart(event, request, getRemoteSpaOrigin, getMainWindow)`
 *   `handleAudiocapStop(event, getRemoteSpaOrigin, getMainWindow)`
 *
 * Admission = the EXISTING `requireTrustedSender` AND `event.sender ===
 * getMainWindow()?.webContents` AND the sender frame IS that webContents' main frame
 * (compared by `frameTreeNodeId`; a null `senderFrame` is refused).
 *
 * Every case here currently FAILS (RED): production `handleAudiocapStart`/
 * `handleAudiocapStop` check only `requireTrustedSender(event, getRemoteSpaOrigin())` and
 * never read a fourth argument, so a trusted-origin event from ANY webContents — a PiP
 * window, a subframe — is admitted today.
 */
describe('audiocap:start / audiocap:stop admission — main window main frame only (#3394 PR 1, R5)', () => {
  /** A trusted-origin sender that is NOT the main window (e.g. a PiP window). */
  const pipWebContents = { mainFrame: { frameTreeNodeId: 2 } };
  const pipEvent = {
    senderFrame: { parent: null, url: 'app://concord/index.html', frameTreeNodeId: 2 },
    sender: pipWebContents,
  } as never;

  /** A trusted-origin sender whose frame is a SUBFRAME of the main window's webContents. */
  const subframeEvent = {
    senderFrame: { parent: null, url: 'app://concord/index.html', frameTreeNodeId: 999 },
    sender: mainWebContents,
  } as never;

  const noMainWindow = () => null as never;

  it('start: refuses a trusted-origin event from a DIFFERENT webContents (a PiP window)', async () => {
    const { handleAudiocapStart } = await loadIpc();
    const r = await handleAudiocapStart(
      pipEvent,
      { sourceId: 'window:42:0' },
      getRemoteSpaOrigin,
      getMainWindow
    );
    expect(r).toEqual({ ok: false, reason: 'protocol-fault' });
    expect(getSources).not.toHaveBeenCalled();
    expect(startAudiocapHost).not.toHaveBeenCalled();
  });

  it('start: refuses a trusted-origin SUBFRAME of the main window', async () => {
    const { handleAudiocapStart } = await loadIpc();
    const r = await handleAudiocapStart(
      subframeEvent,
      { sourceId: 'window:42:0' },
      getRemoteSpaOrigin,
      getMainWindow
    );
    expect(r).toEqual({ ok: false, reason: 'protocol-fault' });
    expect(startAudiocapHost).not.toHaveBeenCalled();
  });

  it('start: refuses when getMainWindow() returns null', async () => {
    const { handleAudiocapStart } = await loadIpc();
    const r = await handleAudiocapStart(
      trustedEvent,
      { sourceId: 'window:42:0' },
      getRemoteSpaOrigin,
      noMainWindow
    );
    expect(r).toEqual({ ok: false, reason: 'protocol-fault' });
    expect(startAudiocapHost).not.toHaveBeenCalled();
  });

  it("start: admits the main window's own main frame (happy path via getMainWindow)", async () => {
    const { handleAudiocapStart } = await loadIpc();
    const r = await handleAudiocapStart(
      trustedEvent,
      { sourceId: 'window:42:0' },
      getRemoteSpaOrigin,
      getMainWindow
    );
    expect(r).toEqual({ ok: true, generation: 1, perProcessAudio: true });
    expect(startAudiocapHost).toHaveBeenCalledWith(
      1,
      42,
      expect.objectContaining({ kind: 'audiocap' })
    );
  });

  it('start: the post-await re-check also enforces main-window/main-frame — a sender whose frame stops being the main frame is refused', async () => {
    let release!: (sources: Array<{ id: string; name: string }>) => void;
    const pending = new Promise<Array<{ id: string; name: string }>>((resolve) => {
      release = resolve;
    });
    getSources.mockImplementationOnce(() => pending);
    const { handleAudiocapStart } = await loadIpc();

    // A live IPC event whose `.senderFrame` flips to a non-main-frame partway through the
    // call -- e.g. the requesting document is superseded by a PiP taking focus. The FIRST
    // fence (pre-await) sees the main frame; only the RE-CHECK after the await can catch
    // this.
    let flipped = false;
    const flippableEvent = {
      get senderFrame() {
        // #86 Task 7B: `parent: null` so the PRE-await fence admits the main frame and
        // the case reaches the re-check it exists to prove (senderMainFrame refuses a
        // frame without it).
        return flipped
          ? { parent: null, url: 'app://concord/index.html', frameTreeNodeId: 999 }
          : { parent: null, url: 'app://concord/index.html', frameTreeNodeId: 1 };
      },
      get sender() {
        return mainWebContents;
      },
    } as never;

    const pendingStart = handleAudiocapStart(
      flippableEvent,
      { sourceId: 'window:42:0' },
      getRemoteSpaOrigin,
      getMainWindow
    );
    flipped = true;
    release([{ id: 'window:42:0', name: 'Some App' }]);
    await expect(pendingStart).resolves.toEqual({ ok: false, reason: 'protocol-fault' });
    expect(startAudiocapHost).not.toHaveBeenCalled();
  });

  it('start: the post-await re-check refuses a sender whose senderFrame goes null', async () => {
    let release!: (sources: Array<{ id: string; name: string }>) => void;
    const pending = new Promise<Array<{ id: string; name: string }>>((resolve) => {
      release = resolve;
    });
    getSources.mockImplementationOnce(() => pending);
    const { handleAudiocapStart } = await loadIpc();

    let gone = false;
    const flippableEvent = {
      get senderFrame() {
        return gone ? null : { parent: null, url: 'app://concord/index.html', frameTreeNodeId: 1 };
      },
      get sender() {
        return mainWebContents;
      },
    } as never;

    const pendingStart = handleAudiocapStart(
      flippableEvent,
      { sourceId: 'window:42:0' },
      getRemoteSpaOrigin,
      getMainWindow
    );
    gone = true;
    release([{ id: 'window:42:0', name: 'Some App' }]);
    await expect(pendingStart).resolves.toEqual({ ok: false, reason: 'protocol-fault' });
    expect(startAudiocapHost).not.toHaveBeenCalled();
  });

  it('stop: refuses (no-op) a trusted-origin event from a DIFFERENT webContents (a PiP window)', async () => {
    const { handleAudiocapStop } = await loadIpc();
    handleAudiocapStop(pipEvent, getRemoteSpaOrigin, getMainWindow);
    expect(stopAudiocapHost).not.toHaveBeenCalled();
  });

  it('stop: refuses (no-op) a trusted-origin SUBFRAME of the main window', async () => {
    const { handleAudiocapStop } = await loadIpc();
    handleAudiocapStop(subframeEvent, getRemoteSpaOrigin, getMainWindow);
    expect(stopAudiocapHost).not.toHaveBeenCalled();
  });

  it('stop: refuses (no-op) when getMainWindow() returns null', async () => {
    const { handleAudiocapStop } = await loadIpc();
    handleAudiocapStop(trustedEvent, getRemoteSpaOrigin, noMainWindow);
    expect(stopAudiocapHost).not.toHaveBeenCalled();
  });

  it("stop: admits the main window's own main frame (happy path via getMainWindow)", async () => {
    const { handleAudiocapStart, handleAudiocapStop } = await loadIpc();
    // #86 Task 7B re-point: stop is owner-only, so this connection starts a share first.
    await handleAudiocapStart(
      trustedEvent,
      { sourceId: 'window:42:0' },
      getRemoteSpaOrigin,
      getMainWindow
    );
    vi.mocked(stopAudiocapHost).mockClear();
    handleAudiocapStop(trustedEvent, getRemoteSpaOrigin, getMainWindow);
    expect(stopAudiocapHost).toHaveBeenCalledTimes(1);
  });

  /**
   * The `isMainWindowMainFrame` catch branch (#3394 PR 1, R5, ~audiocap.ts:83-93). Reading
   * `.webContents` off a destroyed `BrowserWindow`, or `.mainFrame` off a destroyed
   * `webContents`, throws Electron's "Object has been destroyed" error on property access.
   * Both handlers must land on the SAME `false` a missing window already produces, and must
   * never let that throw escape.
   */
  it('start: refuses (protocol-fault) when getMainWindow() returns a window whose webContents getter throws', async () => {
    const { handleAudiocapStart } = await loadIpc();
    const webContentsGetter = vi.fn(() => {
      throw new Error('Object has been destroyed');
    });
    const destroyedWindow = Object.defineProperty({ isDestroyed: () => false }, 'webContents', {
      get: webContentsGetter,
    });

    const r = await handleAudiocapStart(
      trustedEvent,
      { sourceId: 'window:42:0' },
      getRemoteSpaOrigin,
      () => destroyedWindow as never
    );

    expect(r).toEqual({ ok: false, reason: 'protocol-fault' });
    expect(getSources).not.toHaveBeenCalled();
    expect(startAudiocapHost).not.toHaveBeenCalled();
    // Non-vacuity: proves the case reached the throwing `.webContents` getter rather than
    // being refused earlier by `isDestroyed()`.
    expect(webContentsGetter).toHaveBeenCalled();
  });

  it('stop: is a no-op and does not throw when getMainWindow() returns a window whose webContents getter throws', async () => {
    const { handleAudiocapStop } = await loadIpc();
    const webContentsGetter = vi.fn(() => {
      throw new Error('Object has been destroyed');
    });
    const destroyedWindow = Object.defineProperty({ isDestroyed: () => false }, 'webContents', {
      get: webContentsGetter,
    });

    expect(() =>
      handleAudiocapStop(trustedEvent, getRemoteSpaOrigin, () => destroyedWindow as never)
    ).not.toThrow();
    expect(stopAudiocapHost).not.toHaveBeenCalled();
    // Non-vacuity: proves the case reached the throwing `.webContents` getter rather than
    // being refused earlier by `isDestroyed()`.
    expect(webContentsGetter).toHaveBeenCalled();
  });

  it('start: refuses (protocol-fault) when webContents is live but its mainFrame getter throws', async () => {
    const { handleAudiocapStart } = await loadIpc();
    // `event.sender === contents` must hold for the second half of the admission check --
    // the one that reads `.mainFrame` and throws -- to be reached at all (`&&`
    // short-circuits otherwise). So this event's `sender` IS the same object `getMainWindow`
    // hands back as `webContents`.
    const mainFrameGetter = vi.fn(() => {
      throw new Error('Object has been destroyed');
    });
    // #86 Task 7B re-point: the throwing getter sits on the BOUND primary's webContents
    // (restored below), so admission reaches it instead of refusing an unbound sender.
    const realMainFrame = mainWebContents.mainFrame;
    Object.defineProperty(mainWebContents, 'mainFrame', {
      get: mainFrameGetter,
      configurable: true,
    });
    const contentsWithDestroyedMainFrame = mainWebContents;
    const eventWithDestroyedMainFrame = {
      senderFrame: { parent: null, url: 'app://concord/index.html', frameTreeNodeId: 1 },
      sender: contentsWithDestroyedMainFrame,
    } as never;

    const r = await handleAudiocapStart(
      eventWithDestroyedMainFrame,
      { sourceId: 'window:42:0' },
      getRemoteSpaOrigin,
      () =>
        ({
          isDestroyed: () => false,
          webContents: contentsWithDestroyedMainFrame,
        }) as never
    );

    expect(r).toEqual({ ok: false, reason: 'protocol-fault' });
    expect(getSources).not.toHaveBeenCalled();
    expect(startAudiocapHost).not.toHaveBeenCalled();
    // Non-vacuity: proves the case reached the throwing `.mainFrame` getter rather than
    // being refused earlier by `isDestroyed()` or the `.webContents` getter.
    expect(mainFrameGetter).toHaveBeenCalled();
    Object.defineProperty(mainWebContents, 'mainFrame', {
      value: realMainFrame,
      writable: true,
      configurable: true,
    });
  });

  /**
   * The EXPLICIT `isDestroyed()` guard (#3394 fix), distinct from the catch-branch cases
   * above: a destroyed window refuses via the FIRST statement in the try block, never
   * reaching `.webContents` at all. Proven by a getter spy that must NEVER be invoked --
   * the mirror of the non-vacuity assertions above, which prove the getter WAS reached.
   */
  it('start: refuses (protocol-fault) when getMainWindow() returns a destroyed window, without ever reading .webContents', async () => {
    const { handleAudiocapStart } = await loadIpc();
    const webContentsGetter = vi.fn(() => mainWebContents);
    const destroyedWindow = Object.defineProperty({ isDestroyed: () => true }, 'webContents', {
      get: webContentsGetter,
    });

    const r = await handleAudiocapStart(
      trustedEvent,
      { sourceId: 'window:42:0' },
      getRemoteSpaOrigin,
      () => destroyedWindow as never
    );

    expect(r).toEqual({ ok: false, reason: 'protocol-fault' });
    expect(getSources).not.toHaveBeenCalled();
    expect(startAudiocapHost).not.toHaveBeenCalled();
    expect(webContentsGetter).not.toHaveBeenCalled();
  });

  it('stop: is a no-op when getMainWindow() returns a destroyed window, without ever reading .webContents', async () => {
    const { handleAudiocapStop } = await loadIpc();
    const webContentsGetter = vi.fn(() => mainWebContents);
    const destroyedWindow = Object.defineProperty({ isDestroyed: () => true }, 'webContents', {
      get: webContentsGetter,
    });

    handleAudiocapStop(trustedEvent, getRemoteSpaOrigin, () => destroyedWindow as never);

    expect(stopAudiocapHost).not.toHaveBeenCalled();
    expect(webContentsGetter).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------
// #86 Task 7B: owner binding and binding-derived admission. The sender authority is the
// main-held connection binding (connectionRegistry), never the legacy getMainWindow().
// `getMainWindow` returns null below so the legacy gate can NEVER admit these senders.
// ---------------------------------------------------------------------------------------
describe('audiocap #86 owner binding (Task 7B)', () => {
  const SELF = new URL('https://a.example').origin;

  async function boot() {
    vi.resetModules();
    const reg = await import('../../../src/main/connectionRegistry');
    const cap = await import('../../../src/main/connectionCapability');
    const ipc = await import('../../../src/main/ipc/audiocap');
    const ipcReg = await import('../../../src/main/ipc/registry');
    ipcReg._resetIpcRegistryForTesting();
    reg._resetConnectionRegistryForTesting();
    handle.mockClear();
    const open = (origin: string, id: number) => {
      const r = reg.registerService(origin, {
        makeSession: () => ({}) as never,
        makeCustody: () => ({}) as never,
        isValidatedSelfHostedApiBase: () => true,
      });
      if (!r.ok) throw new Error(r.reason);
      const wc = { id, mainFrame: { frameTreeNodeId: id } } as never;
      const o = reg.openConnection(r.service.serviceId, wc, null);
      if (!o.ok) throw new Error(o.reason);
      reg.bindSender(wc, o.record.connectionId, 'primary');
      return { wc, record: o.record, ref: reg.refOf(o.record) };
    };
    const A = open('https://api.concordvoice.chat', 11);
    const B = open(SELF, 12);
    // #86 Task 7B pass 2 re-point: a start is admitted only from the FOREGROUND primary,
    // so A (the connection every start below comes from unless it says otherwise) is
    // foreground. A case that starts from B, or that needs A hidden, moves it first.
    reg.setForeground(A.record.connectionId);
    ipc.registerAudiocapIpc(getRemoteSpaOrigin, () => null);
    const call = (channel: string) => {
      const h = handle.mock.calls.find((c) => c[0] === channel)?.[1] as
        ((...a: unknown[]) => unknown) | undefined;
      if (!h) throw new Error(channel + ' not registered');
      return h;
    };
    return { reg, cap, ipc, A, B, call };
  }
  const evOf = (c: { wc: unknown }, over: Record<string, unknown> = {}) => {
    const id = (c.wc as { mainFrame: { frameTreeNodeId: number } }).mainFrame.frameTreeNodeId;
    return {
      sender: c.wc,
      senderFrame: {
        url: 'app://concord/index.html',
        parent: null,
        frameTreeNodeId: id,
        detached: false,
        ...over,
      },
    };
  };
  const REQ = { sourceId: 'window:42:0' };

  it('start from the saas primary succeeds and the session is bindOwner("audiocap", ref)', async () => {
    const { cap, A, call } = await boot();
    const r = await call('audiocap:start')(evOf(A), REQ);
    expect(r).toMatchObject({ ok: true });
    expect(startAudiocapHost).toHaveBeenCalledTimes(1);
    // CONTRACT: third argument of startAudiocapHost is the minted OwnerBinding.
    const owner = startAudiocapHost.mock.calls[0][2] as { kind: string; ref: unknown };
    expect(owner.kind).toBe('audiocap');
    expect(owner.ref).toEqual(A.ref);
    expect(cap.isOwnerCurrent(owner as never)).toBe(true);
  });

  it('start from a self-hosted primary succeeds too and binds THAT connection', async () => {
    const { reg, B, call } = await boot();
    reg.setForeground(B.record.connectionId);
    const r = await call('audiocap:start')(evOf(B), REQ);
    expect(r).toMatchObject({ ok: true });
    const owner = startAudiocapHost.mock.calls[0][2] as { ref: unknown };
    expect(owner.ref).toEqual(B.ref);
  });

  it('start from an unbound sender is refused without enumerating sources', async () => {
    const { call } = await boot();
    const stranger = { wc: { id: 99, mainFrame: { frameTreeNodeId: 99 } } };
    const r = await call('audiocap:start')(evOf(stranger), REQ);
    expect(r).not.toMatchObject({ ok: true });
    expect(getSources).not.toHaveBeenCalled();
    expect(startAudiocapHost).not.toHaveBeenCalled();
  });

  it('stop from another connection is refused; from the owner it stops the host', async () => {
    const { A, B, call } = await boot();
    await call('audiocap:start')(evOf(A), REQ);
    await call('audiocap:stop')(evOf(B));
    expect(stopAudiocapHost).not.toHaveBeenCalled();
    await call('audiocap:stop')(evOf(A));
    expect(stopAudiocapHost).toHaveBeenCalledTimes(1);
  });

  it('a start superseded by advanceGeneration on the owner drops its post-await effect', async () => {
    const { reg, A, call } = await boot();
    let release!: (v: unknown) => void;
    getSources.mockReturnValueOnce(new Promise((res) => (release = res)));
    const pending = call('audiocap:start')(evOf(A), REQ) as Promise<unknown>;
    reg.advanceGeneration(A.record.connectionId, 'document');
    release([{ id: 'window:42:0', name: 'Some App' }]);
    const r = await pending;
    expect(startAudiocapHost).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: false });
  });

  it.each([
    ['detached', { detached: true }],
    ['a subframe', { parent: {} }],
  ])('start refuses a %s sender frame before any OS work', async (_n, over) => {
    const { A, call } = await boot();
    const r = await call('audiocap:start')(evOf(A, over), REQ);
    expect(r).not.toMatchObject({ ok: true });
    expect(getSources).not.toHaveBeenCalled();
    expect(startAudiocapHost).not.toHaveBeenCalled();
  });

  it('start refuses a destroyed sender (senderFrame read throws) without throwing', async () => {
    const { A, call } = await boot();
    const ev = evOf(A);
    Object.defineProperty(ev, 'senderFrame', {
      get: () => {
        throw new Error('Object has been destroyed');
      },
    });
    const r = await call('audiocap:start')(ev, REQ);
    expect(r).not.toMatchObject({ ok: true });
    expect(startAudiocapHost).not.toHaveBeenCalled();
  });

  it('stop refuses a detached sender frame even from the owner', async () => {
    const { A, call } = await boot();
    await call('audiocap:start')(evOf(A), REQ);
    await call('audiocap:stop')(evOf(A, { detached: true }));
    expect(stopAudiocapHost).not.toHaveBeenCalled();
  });
  // ACCEPTED SECURITY FINDING (#86 Task 7B pass 2). System-audio capture starts only from
  // the FOREGROUND primary: a hidden connection's view must not start a tap the user cannot
  // see being started. Admission is the registry's (audiocap:start is app-global-mutate).
  it('start from a HIDDEN primary is refused before any OS work', async () => {
    const { reg, A, B, call } = await boot();
    reg.setForeground(B.record.connectionId);
    const r = await call('audiocap:start')(evOf(A), REQ);
    expect(r).toEqual({ ok: false, reason: 'protocol-fault' });
    expect(getSources).not.toHaveBeenCalled();
    expect(startAudiocapHost).not.toHaveBeenCalled();
  });

  it('a start whose connection stops being foreground during the enumeration is refused', async () => {
    const { reg, A, B, call } = await boot();
    let release!: (v: unknown) => void;
    getSources.mockReturnValueOnce(new Promise((res) => (release = res)));
    const pending = call('audiocap:start')(evOf(A), REQ) as Promise<unknown>;
    reg.setForeground(B.record.connectionId);
    release([{ id: 'window:42:0', name: 'Some App' }]);
    expect(await pending).toEqual({ ok: false, reason: 'protocol-fault' });
    expect(startAudiocapHost).not.toHaveBeenCalled();
  });

  // ACCEPTED SECURITY FINDING, second half: no silent replace of another connection's share.
  it('start is refused while ANOTHER connection owns a live share, and that share is not replaced', async () => {
    const { reg, ipc, A, B, call } = await boot();
    expect(await call('audiocap:start')(evOf(A), REQ)).toMatchObject({ ok: true });
    currentAudiocapGeneration.mockReturnValue(startAudiocapHost.mock.calls[0][0] as number);
    reg.setForeground(B.record.connectionId);
    const r = await call('audiocap:start')(evOf(B), REQ);
    expect(r).toEqual({ ok: false, reason: 'protocol-fault' });
    expect(getSources).toHaveBeenCalledTimes(1);
    expect(startAudiocapHost).toHaveBeenCalledTimes(1);
    expect(stopAudiocapHost).not.toHaveBeenCalled();
    expect(ipc.audiocapShareOwner()?.ref).toEqual(A.ref);
  });

  it("the owner restarting its own live share keeps today's behaviour (the new start supersedes)", async () => {
    const { ipc, A, call } = await boot();
    expect(await call('audiocap:start')(evOf(A), REQ)).toMatchObject({ ok: true });
    currentAudiocapGeneration.mockReturnValue(startAudiocapHost.mock.calls[0][0] as number);
    expect(await call('audiocap:start')(evOf(A), REQ)).toMatchObject({ ok: true });
    expect(startAudiocapHost).toHaveBeenCalledTimes(2);
    expect((startAudiocapHost.mock.calls[1][2] as { ref: unknown }).ref).toEqual(A.ref);
    expect(ipc.audiocapShareOwner()?.ref).toEqual(A.ref);
  });

  it("once the other connection's share is no longer live, the foreground connection may start", async () => {
    const { reg, ipc, A, B, call } = await boot();
    expect(await call('audiocap:start')(evOf(A), REQ)).toMatchObject({ ok: true });
    // The host retired A's session on its own (an interrupt or a crash): nothing is live.
    currentAudiocapGeneration.mockReturnValue(0);
    reg.setForeground(B.record.connectionId);
    expect(await call('audiocap:start')(evOf(B), REQ)).toMatchObject({ ok: true });
    expect(ipc.audiocapShareOwner()?.ref).toEqual(B.ref);
  });

  it("stop from the FOREGROUND connection B cannot end A's share; A may still end it while hidden", async () => {
    const { reg, ipc, A, B, call } = await boot();
    expect(await call('audiocap:start')(evOf(A), REQ)).toMatchObject({ ok: true });
    reg.setForeground(B.record.connectionId);
    await call('audiocap:stop')(evOf(B));
    expect(stopAudiocapHost).not.toHaveBeenCalled();
    expect(ipc.audiocapShareOwner()?.ref).toEqual(A.ref);
    await call('audiocap:stop')(evOf(A));
    expect(stopAudiocapHost).toHaveBeenCalledTimes(1);
    expect(ipc.audiocapShareOwner()).toBeNull();
  });
});
