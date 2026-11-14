/**
 * Capture arbitration, end to end (#87 spec §7, Task 8).
 *
 * The built shell with two self-hosted stub planes (A, B) and its saas view; every test
 * owns a fresh shell and profile (electronFixture.ts). Capture is real Chromium capture
 * from `--use-fake-device-for-media-stream`; the fixture refuses to run with
 * `--use-fake-ui-for-media-stream`, which would grant with no permission handler at all.
 *
 * The stub planes run no media plane, so no document can complete a real voice join.
 * A "join" here is what `voiceService` does at the lease boundary: `capture.acquire`
 * through the real bridge, then `getUserMedia`, and on a `moved` revocation the tracks
 * stop (`emergencyCleanup`'s part). The ack is the app's own: `captureRevocation`,
 * installed by `App`, releases the lease after its teardown. Every grant and refusal
 * comes from the shell's real lease, arbiter and permission handlers.
 *
 * Run: cd desktop && npm run build && npm run test:e2e:electron
 */
import type { ElectronApplication } from '@playwright/test';
import {
  ceremoniesShown,
  execIn,
  expect,
  generationOf,
  injectCeremony,
  leaseCounts,
  primaryOf,
  serviceIdFor,
  test,
  trackStates,
  vetoUnload,
  viewState,
  wedgeRenderer,
  type MainRequire,
  type Planes,
} from './electronFixture';

interface Views {
  a: string;
  b: string;
  wcA: number;
  wcB: number;
}

async function views(app: ElectronApplication, planes: Planes): Promise<Views> {
  const a = await serviceIdFor(app, planes.a.origin);
  const b = await serviceIdFor(app, planes.b.origin);
  return { a, b, wcA: await primaryOf(app, a), wcB: await primaryOf(app, b) };
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function activate(app: ElectronApplication, serviceId: string): Promise<void> {
  const ok = await app.evaluate((_electron, sid) => {
    const req = (globalThis as unknown as { __e2eRequire: MainRequire }).__e2eRequire;
    return req('shellWindow').activateConnection(sid) as boolean;
  }, serviceId);
  expect(ok, `activateConnection(${serviceId})`).toBe(true);
}

interface JoinResult {
  acquire: { status: string; reason?: string };
  tracks?: number;
  error?: string;
}

/**
 * `voiceService`'s lease boundary: acquire, then capture. The `moved` listener stops
 * this document's tracks the way `emergencyCleanup` stops a call's.
 */
function join(app: ElectronApplication, view: number): Promise<JoinResult> {
  return execIn<JoinResult>(
    app,
    view,
    `(async () => {
       const acquire = await window.electron.capture.acquire({ intent: 'voice-join' });
       if (acquire.status !== 'granted') return { acquire };
       try {
         const s = await navigator.mediaDevices.getUserMedia({ audio: true });
         window.__e2eTracks = (window.__e2eTracks || []).concat(s.getTracks());
         if (!window.__e2eStopOnMove) {
           window.__e2eStopOnMove = window.electron.capture.onLeaseRevoked((r) => {
             if (r.reason === 'moved') for (const t of window.__e2eTracks) t.stop();
           });
         }
         return { acquire, tracks: s.getTracks().length };
       } catch (e) {
         return { acquire, error: e && e.name };
       }
     })()`
  );
}

/** A bare `getUserMedia`, no acquire: 'granted' (tracks kept) or the error's name. */
function grab(app: ElectronApplication, view: number): Promise<string> {
  return execIn<string>(
    app,
    view,
    `navigator.mediaDevices.getUserMedia({ audio: true }).then(
       (s) => { window.__e2eTracks = (window.__e2eTracks || []).concat(s.getTracks()); return 'granted'; },
       (e) => (e && e.name) || String(e)
     )`
  );
}

const live = (states: string[]): number => states.filter((s) => s === 'live').length;

interface LeaseEvent {
  ev: 'acquire' | 'acquired' | 'release' | 'gone';
  cid: string;
  t: number;
  status?: string;
  released?: boolean;
  reason?: string;
}

/**
 * Records, in main, every capture:acquire result, every capture:release and every
 * `render-process-gone` of the given views. `ipc/capture` calls the lease through the
 * module's exports at call time, so wrapping the exports sees every IPC call.
 */
async function recordLeaseEvents(app: ElectronApplication, viewIds: number[]): Promise<void> {
  await app.evaluate(({ webContents }, ids) => {
    const req = (globalThis as unknown as { __e2eRequire: MainRequire }).__e2eRequire;
    const g = globalThis as unknown as { __e2eLeaseLog: unknown[] };
    g.__e2eLeaseLog = [];
    const log = g.__e2eLeaseLog;
    const lease = req('captureLease');
    const acquire = lease.acquire;
    const release = lease.release;
    lease.acquire = (sender: { ref: { connectionId: string } }, input: unknown) => {
      const cid = sender.ref.connectionId;
      log.push({ ev: 'acquire', cid, t: Date.now() });
      const p = acquire(sender, input) as Promise<{ status: string }>;
      void p.then((r) => log.push({ ev: 'acquired', cid, t: Date.now(), status: r.status }));
      return p;
    };
    lease.release = (sender: { ref: { connectionId: string } }, event: unknown, input: unknown) => {
      const released = release(sender, event, input) as boolean;
      log.push({ ev: 'release', cid: sender.ref.connectionId, t: Date.now(), released });
      return released;
    };
    const registry = req('connectionRegistry');
    for (const id of ids) {
      const wc = webContents.fromId(id);
      const record = registry
        .liveConnections()
        .find((r: { webContents: { id: number } }) => r.webContents.id === id);
      if (!wc || !record) throw new Error('no such view');
      const cid = record.connectionId as string;
      wc.once('render-process-gone', (_e, d) => {
        log.push({ ev: 'gone', cid, t: Date.now(), reason: d.reason });
      });
    }
  }, viewIds);
}

function leaseLog(app: ElectronApplication): Promise<LeaseEvent[]> {
  return app.evaluate(
    () => (globalThis as unknown as { __e2eLeaseLog: LeaseEvent[] }).__e2eLeaseLog
  );
}

async function holderId(app: ElectronApplication): Promise<string | null> {
  return app.evaluate(() => {
    const req = (globalThis as unknown as { __e2eRequire: MainRequire }).__e2eRequire;
    return (req('captureLease').holderRef()?.connectionId ?? null) as string | null;
  });
}

/** A's lease and live track, from a foreground acquire. Positive control for every row. */
async function aJoins(app: ElectronApplication, v: Views): Promise<void> {
  await activate(app, v.a);
  const a = await join(app, v.wcA);
  expect(a, 'A, foreground and the lease free, is granted and captures').toEqual({
    acquire: { status: 'granted' },
    tracks: 1,
  });
  expect(await trackStates(app, v.wcA)).toEqual(['live']);
  expect((await leaseCounts(app)).captureHolder).toBe(1);
}

test('B getUserMedia while A holds rejects NotAllowedError', async ({ app, planes }) => {
  const v = await views(app, planes);
  await aJoins(app, v);
  await activate(app, v.b);
  // B is foreground and has never called capture:*, so only the lease can refuse it.
  expect(await grab(app, v.wcB)).toBe('NotAllowedError');
  expect(await trackStates(app, v.wcB)).toEqual([]);
  expect(await trackStates(app, v.wcA)).toEqual(['live']);
  expect(await holderId(app)).toBe((await generationOf(app, v.a)).connectionId);
});

test('injected Join: A acks or is gone before B is granted; B tracks live after; A banner flag set', async ({
  app,
  planes,
}) => {
  const v = await views(app, planes);
  await aJoins(app, v);
  const cidA = (await generationOf(app, v.a)).connectionId;
  const cidB = (await generationOf(app, v.b)).connectionId;
  await recordLeaseEvents(app, [v.wcA, v.wcB]);
  await injectCeremony(app, 1);
  await activate(app, v.b);

  const b = await join(app, v.wcB);
  expect(b).toEqual({ acquire: { status: 'granted' }, tracks: 1 });
  expect(await ceremoniesShown(app)).toBe(1);

  const log = await leaseLog(app);
  const granted = log.findIndex((e) => e.cid === cidB && e.ev === 'acquired');
  const ackOrGone = log.findIndex(
    (e) => e.cid === cidA && ((e.ev === 'release' && e.released === true) || e.ev === 'gone')
  );
  expect(log[granted]?.status, JSON.stringify(log)).toBe('granted');
  expect(ackOrGone, JSON.stringify(log)).toBeGreaterThanOrEqual(0);
  expect(
    ackOrGone,
    `A must ack or be gone before B is granted: ${JSON.stringify(log)}`
  ).toBeLessThan(granted);

  expect(await trackStates(app, v.wcB)).toEqual(['live']);
  expect(await trackStates(app, v.wcA)).toEqual(['ended']);
  expect(await holderId(app)).toBe(cidB);
  await expect
    .poll(() =>
      execIn<boolean>(
        app,
        v.wcA,
        `import('/src/renderer/stores/voice/voiceStore.ts').then((m) => m.useVoiceStore.getState().captureMovedNotice)`
      )
    )
    .toBe(true);
  expect(await leaseCounts(app)).toMatchObject({ captureHolder: 1, handoffPending: 0 });
});

test('injected Stay: A unaffected; B control idle', async ({ app, planes }) => {
  const v = await views(app, planes);
  await aJoins(app, v);
  await injectCeremony(app, 0);
  await activate(app, v.b);
  // Through the app's own lease client, which owns the join control's aria-busy.
  const r = await execIn<{ during: boolean; after: boolean; status: string }>(
    app,
    v.wcB,
    `import('/src/renderer/services/voice/captureLeaseClient.ts').then(async (c) => {
       const p = c.acquire('voice-join');
       const during = c.isAcquirePending();
       const res = await p;
       return { during, after: c.isAcquirePending(), status: res.status };
     })`
  );
  expect(r).toEqual({ during: true, after: false, status: 'declined' });
  expect(await ceremoniesShown(app)).toBe(1);
  expect(await trackStates(app, v.wcA)).toEqual(['live']);
  expect(await holderId(app)).toBe((await generationOf(app, v.a)).connectionId);
  expect(await grab(app, v.wcB)).toBe('NotAllowedError');
  expect(
    await execIn<number>(app, v.wcB, `document.querySelectorAll('[aria-busy="true"]').length`)
  ).toBe(0);
});

test('hostile holder (beforeunload veto + wedged renderer) is crashed and reloaded at 5 s, then B granted', async ({
  app,
  planes,
}) => {
  const v = await views(app, planes);
  await aJoins(app, v);
  const cidA = (await generationOf(app, v.a)).connectionId;
  const cidB = (await generationOf(app, v.b)).connectionId;
  // Sticky activation, so Chromium would honour the veto on a plain reload (spike row 4).
  await app.evaluate(({ webContents }, id) => {
    const wc = webContents.fromId(id);
    wc?.sendInputEvent({ type: 'mouseDown', x: 1, y: 1, button: 'left', clickCount: 1 });
    wc?.sendInputEvent({ type: 'mouseUp', x: 1, y: 1, button: 'left', clickCount: 1 });
  }, v.wcA);
  await vetoUnload(app, v.wcA);
  await recordLeaseEvents(app, [v.wcA, v.wcB]);
  await injectCeremony(app, 1);
  await activate(app, v.b);
  await wedgeRenderer(app, v.wcA);

  const b = await join(app, v.wcB);
  expect(b).toEqual({ acquire: { status: 'granted' }, tracks: 1 });

  const log = await leaseLog(app);
  const asked = log.find((e) => e.cid === cidB && e.ev === 'acquire');
  const gone = log.find((e) => e.cid === cidA && e.ev === 'gone');
  const granted = log.find((e) => e.cid === cidB && e.ev === 'acquired');
  expect(gone?.reason, JSON.stringify(log)).toBe('killed');
  expect(
    log.some((e) => e.cid === cidA && e.ev === 'release'),
    'the wedged A never acked'
  ).toBe(false);
  if (!asked || !gone || !granted) throw new Error(`incomplete lease log: ${JSON.stringify(log)}`);
  const crashAfter = gone.t - asked.t;
  expect(crashAfter, 'crashed at the 5 s ack timeout').toBeGreaterThanOrEqual(4_900);
  expect(crashAfter).toBeLessThan(8_000);
  expect(granted.t).toBeGreaterThanOrEqual(gone.t);
  expect(granted.status).toBe('granted');

  // main reloads A from render-process-gone: a fresh document with no tracks.
  await expect.poll(() => viewState(app, planes.a.origin), { timeout: 30_000 }).toBe('ready');
  expect(await trackStates(app, await primaryOf(app, v.a))).toEqual([]);
  expect(await trackStates(app, v.wcB)).toEqual(['live']);
  expect(await holderId(app)).toBe(cidB);
});

test('A reload releases the lease', async ({ app, planes }) => {
  const v = await views(app, planes);
  await aJoins(app, v);
  const before = await generationOf(app, v.a);
  await app.evaluate(({ webContents }, id) => {
    webContents.fromId(id)?.reload();
  }, v.wcA);
  await expect
    .poll(async () => (await generationOf(app, v.a)).generation)
    .toBeGreaterThan(before.generation);
  await expect.poll(async () => (await leaseCounts(app)).captureHolder).toBe(0);
  expect(await holderId(app)).toBeNull();
});

test('three services: at most one document has live tracks at any sampled instant; audiocapCapture only in the holder', async ({
  app,
  planes,
}) => {
  const v = await views(app, planes);
  // The third service is the shell's own saas connection.
  const third = await app.evaluate(
    (_electron, ids) => {
      const req = (globalThis as unknown as { __e2eRequire: MainRequire }).__e2eRequire;
      const record = req('connectionRegistry')
        .liveConnections()
        .find((r: { serviceId: string }) => !ids.includes(r.serviceId));
      return record
        ? { sid: record.serviceId as string, wc: record.webContents.id as number }
        : null;
    },
    [v.a, v.b]
  );
  if (third === null) throw new Error('no third live connection in the shell');
  await expect
    .poll(
      () =>
        execIn<string>(
          app,
          third.wc,
          'typeof (window.electron && window.electron.capture && window.electron.capture.acquire)'
        ).catch(() => 'pending'),
      { timeout: 60_000 }
    )
    .toBe('function');
  const docs = [v.wcA, v.wcB, third.wc];

  await aJoins(app, v);
  await injectCeremony(app, 1);
  await activate(app, v.b);

  interface Sample {
    live: number[];
    holder: 0 | 1;
    audiocap: 0 | 1;
  }
  const samples: Sample[] = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const [states, counts] = await Promise.all([
        Promise.all(docs.map((wc) => trackStates(app, wc))),
        leaseCounts(app),
      ]);
      samples.push({
        live: states.map(live),
        holder: counts.captureHolder,
        audiocap: counts.audiocapCapture,
      });
      await settle(250);
    }
  })();
  // The background third service keeps trying to capture across the whole handoff.
  let probing = true;
  const thirdTries: string[] = [];
  const prober = (async () => {
    while (probing) {
      thirdTries.push(await grab(app, third.wc));
      await settle(250);
    }
  })();

  const b = await join(app, v.wcB);
  await settle(1_500);
  sampling = false;
  probing = false;
  await Promise.all([sampler, prober]);

  expect(b).toEqual({ acquire: { status: 'granted' }, tracks: 1 });
  expect(samples.length, 'sampled across the handoff').toBeGreaterThanOrEqual(4);
  for (const s of samples) {
    const docsLive = s.live.filter((n) => n > 0).length;
    expect(docsLive, JSON.stringify(samples)).toBeLessThanOrEqual(1);
    expect(s.audiocap, 'no audiocap capture without the holder').toBeLessThanOrEqual(s.holder);
  }
  // Positive controls: A was live at the first sample and B at the last.
  expect(samples[0]?.live[0]).toBe(1);
  expect(samples[samples.length - 1]?.live[1]).toBe(1);
  expect(thirdTries.length).toBeGreaterThan(0);
  expect(new Set(thirdTries)).toEqual(new Set(['NotAllowedError']));
  expect(await trackStates(app, third.wc)).toEqual([]);
});

test('50x loopback start/cancel churn on B leaves A untouched and counts return to baseline', async ({
  app,
  planes,
}) => {
  const v = await views(app, planes);
  await aJoins(app, v);
  // A holds a loopback of its own through the churn (A1: B can never close it).
  const portA = await execIn<number>(
    app,
    v.wcA,
    'window.electron.sso.startLoopback().then((r) => r.port)'
  );
  expect(portA).toBeGreaterThan(0);
  await activate(app, v.b);
  await settle(500);
  const genA = await generationOf(app, v.a);
  const baseline = await leaseCounts(app);
  expect(baseline).toMatchObject({ captureHolder: 1, handoffPending: 0, loopbacks: 1 });

  const peak = await execIn<number>(
    app,
    v.wcB,
    `(async () => {
       let ports = 0;
       for (let i = 0; i < 50; i++) {
         const { port } = await window.electron.sso.startLoopback();
         if (port > 0) ports++;
         window.electron.sso.cancelLoopback(port);
       }
       return ports;
     })()`
  );
  expect(peak).toBe(50);
  await expect.poll(() => leaseCounts(app)).toEqual(baseline);
  expect(await trackStates(app, v.wcA)).toEqual(['live']);
  expect(await generationOf(app, v.a)).toEqual(genA);
  expect(await holderId(app)).toBe(genA.connectionId);
  await execIn(
    app,
    v.wcA,
    `(() => { window.electron.sso.cancelLoopback(${portA}); return true; })()`
  );
});

test('legacy view captures when free and foreground; refused when background', () => {
  test.fixme(
    true,
    'legacy SPA without the capture key cannot be booted: contextBridge freezes window.electron (ADR-0051 Known gaps 2)'
  );
});
