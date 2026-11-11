/**
 * Connection-context isolation, end to end (#86 spec §6, Task 10).
 *
 * Two self-hosted stub planes (A, B) run in-process; the built shell restores one view
 * per plane from a seeded connections.json. Every test owns a fresh shell and profile
 * (see electronFixture.ts). Renderer-side probes run through `webContents
 * .executeJavaScript` in the view's main world — the same world `page.evaluate` uses —
 * because main-side lookup is the only way to name a view by its connection.
 *
 * Run: cd desktop && npm run build && npm run test:e2e:electron
 */
import {
  cookiesFor,
  execIn,
  expect,
  generationOf,
  primaryOf,
  serviceIdFor,
  sessionOf,
  test,
  type MainRequire,
  type Planes,
} from './electronFixture';
import { STUB_USER_ID } from './fixtures/controlPlaneStub';
import type { ElectronApplication } from '@playwright/test';

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

const lit = (v: unknown): string => JSON.stringify(v);

/** Opens a websocket to `port`'s echo from inside a view; resolves once it is OPEN. */
function openSocket(app: ElectronApplication, wc: number, port: number): Promise<boolean> {
  return execIn<boolean>(
    app,
    wc,
    `new Promise((resolve, reject) => {
       const ws = new WebSocket(${lit(`ws://localhost:${port}/ws`)});
       window.__e2eWs = ws;
       ws.onopen = () => resolve(true);
       ws.onerror = () => reject(new Error('websocket failed to open'));
     })`
  );
}

/** Round-trips a message through the view's websocket; proves it is open AND live. */
function echo(app: ElectronApplication, wc: number, text: string): Promise<string> {
  return execIn<string>(
    app,
    wc,
    `new Promise((resolve) => {
       window.__e2eWs.onmessage = (e) => resolve(e.data);
       window.__e2eWs.send(${lit(text)});
     })`
  );
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("cookies set by A are absent from B's jar", async ({ app, planes }) => {
  const v = await views(app, planes);
  const fetchIn = (wc: number, origin: string): Promise<number> =>
    execIn<number>(
      app,
      wc,
      `fetch(${lit(`${origin}/api/v1/client-config`)}, { credentials: 'include' }).then((r) => r.status, (e) => String(e))`
    );
  expect(await fetchIn(v.wcA, planes.a.origin), JSON.stringify(planes.a.requests)).toBe(200);
  expect(await fetchIn(v.wcB, planes.b.origin)).toBe(200);

  const jarA = await cookiesFor(app, v.a);
  const jarB = await cookiesFor(app, v.b);
  // Cookies are not port-scoped: a shared jar would hold one `plane` cookie for
  // `localhost`, overwritten by whichever plane answered last.
  expect(jarA).toContain(String(planes.a.port));
  expect(jarA).not.toContain(String(planes.b.port));
  expect(jarB).toContain(String(planes.b.port));
  expect(jarB).not.toContain(String(planes.a.port));
});

test('localStorage and BroadcastChannel do not cross', async ({ app, planes }) => {
  const v = await views(app, planes);
  const listen = `(() => {
    window.__e2eBc = [];
    window.__e2eChan = new BroadcastChannel('e2e-isolation');
    window.__e2eChan.onmessage = (e) => window.__e2eBc.push(e.data);
    return true;
  })()`;
  await execIn(app, v.wcB, listen);
  await execIn(app, v.wcA, listen);
  await execIn(
    app,
    v.wcA,
    `(() => {
       localStorage.setItem('e2e-isolation', 'from-A');
       new BroadcastChannel('e2e-isolation').postMessage('from-A');
       return true;
     })()`
  );
  // Positive control: the message is deliverable — A's own second channel gets it.
  await expect.poll(() => execIn<string[]>(app, v.wcA, 'window.__e2eBc')).toEqual(['from-A']);
  await settle(500);
  expect(await execIn(app, v.wcA, `localStorage.getItem('e2e-isolation')`)).toBe('from-A');
  // Both views are the same origin (http://localhost:3001); only the session separates them.
  expect(await execIn(app, v.wcB, `localStorage.getItem('e2e-isolation')`)).toBeNull();
  expect(await execIn(app, v.wcB, 'window.__e2eBc')).toEqual([]);
});

test('app://concord loads in a fresh fromPath session', async ({ app, planes }) => {
  test.fixme(
    true,
    'unpackaged launch (dist/main/main.js): connectionSession registerProtocols installs app:// only when app.isPackaged, and a packaged build pins the production API origin, so no stub plane can back it'
  );
  const v = await views(app, planes);
  const url = await app.evaluate(async ({ webContents }, id) => {
    const wc = webContents.fromId(id);
    if (!wc) throw new Error('no view');
    await wc.loadURL('app://concord/index.html');
    return wc.getURL();
  }, v.wcB);
  expect(url.startsWith('app://concord')).toBe(true);
});

test('wrong-owner electron.* call via executeJavaScript is refused', async ({ app, planes }) => {
  const v = await views(app, planes);
  const outcome = await execIn<string>(
    app,
    v.wcA,
    `window.electron.sso.appleSignIn(${lit(planes.b.origin)}).then(
       () => 'resolved',
       (e) => String(e && e.message)
     )`
  );
  expect(outcome).toContain('wrong-owner');
  // Refused before any dial: B never hears about an Apple flow.
  expect(planes.b.requests.filter((r) => r.path.includes('apple'))).toEqual([]);
});

test('superseded request is refused after its await', async ({ app }) => {
  const screen = await app.evaluate(({ systemPreferences }) =>
    systemPreferences.getMediaAccessStatus('screen')
  );
  test.fixme(
    screen !== 'granted',
    `Screen Recording permission for the Electron binary is '${screen}', so audiocap:start refuses before its await and supersession cannot be exercised`
  );
  test.fixme(
    true,
    'the harness has no main-side probe of a live audiocap session, so "no capture running" after the reload cannot be asserted yet'
  );
});

test('logout in A leaves B authenticated with its websocket open', async ({ app, planes }) => {
  const v = await views(app, planes);
  // Success is the CredentialOwner number main publishes; a refusal is { status: 'rejected' }.
  const store = (wc: number, origin: string): Promise<unknown> =>
    execIn(
      app,
      wc,
      `window.electron.storeRefreshToken(${lit({
        refreshToken: `seed-${origin}`,
        rememberMe: false,
        apiBase: origin,
        serverUserId: STUB_USER_ID,
      })})`
    );
  expect(typeof (await store(v.wcA, planes.a.origin))).toBe('number');
  expect(typeof (await store(v.wcB, planes.b.origin))).toBe('number');
  expect(await openSocket(app, v.wcB, planes.b.port)).toBe(true);

  await execIn(app, v.wcA, 'window.electron.logout().then(() => true)');

  const logouts = (p: Planes['a']): number =>
    p.requests.filter((r) => r.method === 'POST' && r.path === '/api/v1/auth/logout').length;
  expect(logouts(planes.a)).toBe(1);
  expect(logouts(planes.b)).toBe(0);
  const refresh = (wc: number): Promise<{ status?: string }> =>
    execIn(app, wc, 'window.electron.refreshToken()');
  expect((await refresh(v.wcA)).status).not.toBe('ok');
  expect((await refresh(v.wcB)).status).toBe('ok');
  expect(await echo(app, v.wcB, 'still-open')).toBe('still-open');
});

test('stale push after A reload is dropped', async ({ app, planes }) => {
  const v = await views(app, planes);
  const before = await generationOf(app, v.a);
  await app.evaluate(({ webContents }, id) => {
    webContents.fromId(id)?.reload();
  }, v.wcA);
  await expect
    .poll(async () => (await generationOf(app, v.a)).generation)
    .toBeGreaterThan(before.generation);
  const after = await generationOf(app, v.a);
  expect(after.connectionId).toBe(before.connectionId);

  const send = (ref: { connectionId: string; generation: number }): Promise<boolean> =>
    app.evaluate((_electron, r) => {
      const req = (globalThis as unknown as { __e2eRequire: MainRequire }).__e2eRequire;
      return req('shellWindow').sendToConnection(r, 'e2e:probe') as boolean;
    }, ref);
  expect(await send(before)).toBe(false);
  // Positive control: the same connection at its current generation still receives.
  expect(await send(after)).toBe(true);
});

test("PiP opened by A is on A's session", async ({ app, planes }) => {
  const v = await views(app, planes);
  await execIn(app, v.wcA, `window.electron.openPipWindow({ id: 'e2e-pip-a' })`);
  const pipsOfA = (): Promise<number[]> =>
    app.evaluate((_electron, sid) => {
      const req = (globalThis as unknown as { __e2eRequire: MainRequire }).__e2eRequire;
      const record = req('connectionRegistry')
        .liveConnections()
        .find((r: { serviceId: string }) => r.serviceId === sid);
      return record ? [...(record.pips as Set<{ id: number }>)].map((wc) => wc.id) : [];
    }, v.a);
  await expect.poll(pipsOfA).toHaveLength(1);
  const [pip] = await pipsOfA();
  const sessionA = await sessionOf(app, v.wcA);
  expect(await sessionOf(app, pip)).toBe(sessionA);
  expect(sessionA).not.toBe(await sessionOf(app, v.wcB));
});

test('outage injected on A bumps no generation and leaves B untouched', async ({ app, planes }) => {
  const v = await views(app, planes);
  expect(await openSocket(app, v.wcA, planes.a.port)).toBe(true);
  expect(await openSocket(app, v.wcB, planes.b.port)).toBe(true);
  await execIn(
    app,
    v.wcA,
    `(() => {
       window.__e2eGen = [];
       window.__e2eWsClosed = false;
       window.__e2eWs.addEventListener('close', () => { window.__e2eWsClosed = true; });
       window.electron.connection.onGenerationChanged((p) => window.__e2eGen.push(p));
       return true;
     })()`
  );
  const genA = await generationOf(app, v.a);
  const genB = await generationOf(app, v.b);

  await planes.a.stop();
  // A saw the outage, so the absence of a push below is not vacuous.
  await expect.poll(() => execIn<boolean>(app, v.wcA, 'window.__e2eWsClosed')).toBe(true);
  await settle(2_000);

  expect(await execIn(app, v.wcA, 'window.__e2eGen')).toEqual([]);
  expect(await generationOf(app, v.a)).toEqual(genA);
  expect(await generationOf(app, v.b)).toEqual(genB);
  expect(await echo(app, v.wcB, 'b-unaffected')).toBe('b-unaffected');
});

test('legacy SPA path', async ({ app, planes }) => {
  test.fixme(
    true,
    'contextBridge exposes window.electron frozen, non-configurable and non-writable (measured after the preload: {frozen:true,configurable:false,writable:false}), so evaluateOnNewDocument cannot remove the connection key, and no production-safe switch boots a v34 preload without it'
  );
  const v = await views(app, planes);
  // Evaluated in A's main world on every new document, before any page script, after
  // the preload: a pre-v34 shell is exactly a bridge without the `connection` key.
  // contextBridge freezes the exposed object (measured: `delete` fails), so the probe
  // can only swap in a shallow copy without the key, and only if `window.electron`
  // is replaceable — measured: it is not.
  const strip = `(() => {
    const e = window.electron;
    const d = Object.getOwnPropertyDescriptor(window, 'electron');
    let removed = false;
    try {
      if (e !== undefined && d && (d.configurable || d.writable)) {
        const { connection, ...rest } = e;
        if (d.configurable) {
          Object.defineProperty(window, 'electron', { value: rest, enumerable: true });
        } else {
          window.electron = rest;
        }
        removed = !('connection' in window.electron) && typeof window.electron.logout === 'function';
      }
    } catch {}
    window.__e2eStrip = {
      electron: typeof e,
      removed,
      frozen: Object.isFrozen(e),
      configurable: d ? d.configurable : null,
      writable: d ? d.writable : null,
    };
  })()`;
  await app.evaluate(
    async ({ webContents }, { id, source }) => {
      const wc = webContents.fromId(id);
      if (!wc) throw new Error('no view');
      wc.debugger.attach('1.3');
      await wc.debugger.sendCommand('Page.enable');
      await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source });
      const loaded = new Promise<void>((resolve) => wc.once('did-finish-load', () => resolve()));
      wc.reload();
      await loaded;
    },
    { id: v.wcA, source: strip }
  );
  const stripped = await execIn<Record<string, unknown>>(app, v.wcA, 'window.__e2eStrip');
  expect(stripped, JSON.stringify(stripped)).toMatchObject({
    electron: 'object',
    removed: true,
  });
  // The SPA's own memoised boot decision: same module URL, so the same instance.
  const bootMode = (wc: number): Promise<string> =>
    execIn<string>(
      app,
      wc,
      `import('/src/renderer/services/system/bootConnection.ts').then((m) => m.bootConnection().mode)`
    );
  expect(await bootMode(v.wcA)).toBe('legacy');
  // Positive control: the untouched view booted in connection mode.
  expect(await bootMode(v.wcB)).toBe('connection');
  // The legacy document still mounts the app rather than failing at boot.
  await expect
    .poll(() =>
      execIn<number>(app, v.wcA, `document.getElementById('root')?.childElementCount ?? 0`)
    )
    .toBeGreaterThan(0);
});

test('duplicate-id fixture', async () => {
  test.fixme(
    true,
    "the stub planes do not implement the SPA's post-login bootstrap (E2EE key bundle, servers, socket.io), so neither view reaches a logged-in userStore or a notification; recording that surface needs a local control plane, which is not available without secrets"
  );
});
