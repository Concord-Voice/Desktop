/**
 * Electron e2e fixture for connection-context isolation (#86 Task 10).
 *
 * Launches the BUILT shell (`npm run build` first) as an unpackaged app with HOME
 * pointed at a fresh temp dir, two in-process stub planes, and a profile seeded with
 * both planes approved and persisted. Nothing here needs a backend.
 *
 * Profile safety, in two layers:
 *   1. Before launch, `fixtures/seedProfile.cjs` runs under the Electron binary with the
 *      same environment, resolves userData through the built `pinUserDataPath`, and
 *      refuses (exit 3) unless it lands beneath the temp root. The shell is never
 *      launched against an unchecked path.
 *   2. After launch, `app.getPath('userData')` is checked again; a mismatch closes the
 *      app and throws before any test body runs.
 *
 * Why the renderer is the Vite dev server on http://localhost:3001: an unpackaged shell
 * (`app.isPackaged` false) loads every view from that fixed dev URL, and `npm run dev`
 * pairs it with exactly this server. Serving `dist/renderer` there instead mixes a dev
 * shell with the production CSP, whose loopback-stripped connect-src (csp-prod-strip.ts)
 * refuses every localhost plane (measured: 'TypeError: Failed to fetch', 0 plane
 * requests). The fixture never edits a CSP; Vite applies the repo's own dev CSP.
 *
 * No production code reads an e2e-only variable. HOME is the OS's own; DEVTOOLS=0 is
 * the existing dev switch that keeps detached DevTools from opening; `--use-mock-keychain`
 * is Chromium's switch that keeps safeStorage off the login keychain.
 */
import { test as base, expect, _electron, type ElectronApplication } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { RENDERER_ORIGIN, startStubPlane, type StubPlane } from './fixtures/controlPlaneStub';

const DESKTOP_DIR = path.resolve(__dirname, '..', '..');
const DIST_MAIN = path.join(DESKTOP_DIR, 'dist', 'main');
const SEED_SCRIPT = path.join(__dirname, 'fixtures', 'seedProfile.cjs');
const RENDERER_PORT = Number(new URL(RENDERER_ORIGIN).port);

// The `electron` package's node entry exports the binary path, not the API.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ELECTRON_BINARY = require('electron') as unknown as string;

export interface Planes {
  a: StubPlane;
  b: StubPlane;
}

interface Fixtures {
  app: ElectronApplication;
  userData: string;
  planes: Planes;
}

interface WorkerFixtures {
  /** The dev renderer every view loads; one per worker so its transform cache is reused. */
  renderer: ViteDevServer;
}

/** Resolves symlinks in the longest existing prefix (macOS: /var -> /private/var). */
function real(p: string): string {
  let head = path.resolve(p);
  const tail: string[] = [];
  while (!fs.existsSync(head)) {
    tail.unshift(path.basename(head));
    head = path.dirname(head);
  }
  return path.join(fs.realpathSync(head), ...tail);
}

export function isBeneath(root: string, candidate: string): boolean {
  const rel = path.relative(real(root), real(candidate));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Starts the repo's Vite dev server where the unpackaged shell looks for it. */
async function startDevRenderer(): Promise<ViteDevServer> {
  const server = await createServer({
    configFile: path.join(DESKTOP_DIR, 'vite.config.ts'),
    root: DESKTOP_DIR,
    clearScreen: false,
    logLevel: 'warn',
    server: { port: RENDERER_PORT, strictPort: true },
  });
  try {
    await server.listen();
  } catch (err) {
    await server.close();
    const code = (err as NodeJS.ErrnoException).code;
    throw code === 'EADDRINUSE' || String(err).includes('already in use')
      ? new Error(`port ${RENDERER_PORT} is in use — stop the other Vite dev server first`)
      : err;
  }
  return server;
}

function launchEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  // An inherited ELECTRON_RUN_AS_NODE would start a bare node, not the shell.
  delete env.ELECTRON_RUN_AS_NODE;
  // The saas view keeps its default dev origin; nothing outside the test may steer it.
  delete env.CONCORD_DEV_API_BASE;
  env.HOME = home;
  // macOS resolves appData through NSHomeDirectory(), which ignores HOME (measured: the
  // seed guard refused with userData under the real ~/Library). CFFIXED_USER_HOME is
  // Foundation's own override; no Concord code reads it.
  env.CFFIXED_USER_HOME = home;
  env.DEVTOOLS = '0';
  return env;
}

/**
 * Chromium's synthetic microphone and camera, so a capture test needs no hardware and
 * raises no macOS TCC prompt. NEVER `--use-fake-ui-for-media-stream`: it grants capture
 * without calling either permission handler (capture-gate spike, results/macos-arm64.md
 * row 5), so every lease test would pass with no gate at all.
 */
const MEDIA_SWITCHES = ['--use-fake-device-for-media-stream'] as const;
const FAKE_UI_SWITCH = 'use-fake-ui-for-media-stream';

/** Refuses to run unless the shell has the fake device and does NOT have the fake UI. */
async function assertMediaSwitches(app: ElectronApplication): Promise<void> {
  const seen = await app.evaluate(
    ({ app: electronApp }, fakeUi) => ({
      argv: process.argv,
      fakeUi: electronApp.commandLine.hasSwitch(fakeUi),
      fakeDevice: electronApp.commandLine.hasSwitch('use-fake-device-for-media-stream'),
    }),
    FAKE_UI_SWITCH
  );
  const fakeUiArg = seen.argv.some((a) => a.startsWith(`--${FAKE_UI_SWITCH}`));
  if (!seen.argv.includes(MEDIA_SWITCHES[0]) || !seen.fakeDevice) {
    throw new Error(`shell launched without ${MEDIA_SWITCHES[0]}: ${JSON.stringify(seen.argv)}`);
  }
  if (fakeUiArg || seen.fakeUi) {
    throw new Error(`shell has --${FAKE_UI_SWITCH}, which bypasses the capture gate — refusing`);
  }
}

function seedProfile(home: string, origins: string[]): { userData: string; serviceIds: string[] } {
  const result = spawnSync(
    ELECTRON_BINARY,
    [SEED_SCRIPT, DIST_MAIN, home, JSON.stringify({ origins })],
    { env: launchEnv(home), encoding: 'utf8', timeout: 60_000 }
  );
  if (result.status !== 0) {
    throw new Error(
      `profile seed refused (exit ${String(result.status)}): ${result.stderr.trim() || 'no output'}`
    );
  }
  const line = result.stdout.trim().split('\n').pop() ?? '';
  return JSON.parse(line) as { userData: string; serviceIds: string[] };
}

export const test = base.extend<Fixtures, WorkerFixtures>({
  renderer: [
    async ({}, use) => {
      const server = await startDevRenderer();
      await use(server);
      await server.close();
    },
    { scope: 'worker' },
  ],

  planes: async ({}, use) => {
    const a = await startStubPlane();
    const b = await startStubPlane();
    await use({ a, b });
    await Promise.all([a.stop(), b.stop()]);
  },

  app: async ({ planes, renderer }, use) => {
    if (!fs.existsSync(path.join(DIST_MAIN, 'main.js'))) {
      throw new Error('dist/main/main.js missing — run `npm run build` first');
    }
    const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'concord-e2e-'));
    if (renderer.httpServer?.listening !== true) throw new Error('dev renderer is not listening');
    let app: ElectronApplication | null = null;
    try {
      const seeded = seedProfile(home, [planes.a.origin, planes.b.origin]);
      if (!isBeneath(home, seeded.userData)) {
        throw new Error(`seeded userData ${seeded.userData} is outside ${home}`);
      }
      app = await _electron.launch({
        args: [...MEDIA_SWITCHES, '--use-mock-keychain', path.join(DIST_MAIN, 'main.js')],
        cwd: DESKTOP_DIR,
        env: launchEnv(home),
        timeout: 60_000,
      });
      await assertMediaSwitches(app);
      await installMainRequire(app);
      const userData = await app.evaluate(({ app: electronApp }) =>
        electronApp.getPath('userData')
      );
      if (!isBeneath(home, userData)) {
        throw new Error(`userData resolved to ${userData}, outside ${home} — refusing to run`);
      }
      const shellLog: string[] = [];
      const keep = (chunk: Buffer): void => {
        shellLog.push(...chunk.toString('utf8').split('\n').filter(Boolean));
        shellLog.splice(0, Math.max(0, shellLog.length - 40));
      };
      app.process().stdout?.on('data', keep);
      app.process().stderr?.on('data', keep);
      for (const origin of [planes.a.origin, planes.b.origin]) {
        const deadline = Date.now() + 60_000;
        for (;;) {
          const state = await viewState(app, origin);
          if (state === 'ready') break;
          // D1: a restored view's FIRST document must boot with an identity. No reload:
          // a null here is the product defect, so it fails the run at once.
          if (state === 'null-identity') {
            throw new Error(`restored view ${origin} booted with whoAmI() === null`);
          }
          if (Date.now() > deadline) {
            throw new Error(
              `view for ${origin} never became ready\nshell: ${JSON.stringify(
                await describeShell(app)
              )}\nlog:\n${shellLog.join('\n')}`
            );
          }
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      await use(app);
    } finally {
      if (app) {
        const child = app.process();
        await app.close().catch(() => undefined);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
      fs.rmSync(home, { recursive: true, force: true });
    }
  },

  userData: async ({ app }, use) => {
    await use(await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData')));
  },
});

export { expect };

// ── Main-process probes ────────────────────────────────────────────────────────────
// Each function below is serialised into the shell's main process by app.evaluate, so
// it must be self-contained. `__e2eRequire` (installed once per launch, test-only) hands
// back the shell's OWN module instances from the require cache and refuses to load a
// module main.ts has not already loaded, so a probe can never read a second copy.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MainRequire = (module: string) => any;

async function installMainRequire(app: ElectronApplication): Promise<void> {
  await app.evaluate((_electron, dir) => {
    const main = (process as unknown as { mainModule?: NodeJS.Module }).mainModule;
    if (!main) throw new Error('no main module in the shell process');
    const join = (main.require('node:path') as typeof import('node:path')).join;
    // Module._cache — the one cache main.ts's own `require` calls populate.
    const cache = (main.constructor as unknown as { _cache: Record<string, unknown> })._cache;
    const e2eRequire = (name: string): unknown => {
      const file = join(dir, `${name}.js`);
      if (!cache[file]) throw new Error(`shell module not loaded: ${name}`);
      return main.require(file);
    };
    (globalThis as unknown as { __e2eRequire: unknown }).__e2eRequire = e2eRequire;
  }, DIST_MAIN);
}

type ViewState = 'pending' | 'ready' | 'null-identity';

/** `ready` once `origin`'s primary view has loaded the renderer and holds an identity. */
export async function viewState(app: ElectronApplication, origin: string): Promise<ViewState> {
  return app.evaluate(async (_electron, o) => {
    const req = (globalThis as unknown as { __e2eRequire: MainRequire }).__e2eRequire;
    const registry = req('connectionRegistry');
    const service = registry.serviceForOrigin(o);
    if (!service) return 'pending';
    const record = registry
      .liveConnections()
      .find((r: { serviceId: string }) => r.serviceId === service.serviceId);
    if (!record || record.webContents.isLoading()) return 'pending';
    if (!record.webContents.getURL().startsWith('http://localhost:3001')) return 'pending';
    try {
      const has = (await record.webContents.executeJavaScript(
        'Boolean(window.electron && window.electron.connection && window.electron.connection.whoAmI())'
      )) as boolean;
      return has ? 'ready' : 'null-identity';
    } catch {
      return 'pending';
    }
  }, origin);
}

/** Services and live connections as main sees them — for failure messages. */
export async function describeShell(app: ElectronApplication): Promise<unknown> {
  return app.evaluate(async () => {
    const req = (globalThis as unknown as { __e2eRequire: MainRequire }).__e2eRequire;
    const registry = req('connectionRegistry');
    const bridges: unknown[] = [];
    const senderMod = req('ipc/connectionSender');
    const frames = req('ipc/frameValidation');
    const ipcRegistry = req('ipc/registry');
    for (const r of registry.liveConnections()) {
      const wc = r.webContents;
      const event = { sender: wc, senderFrame: wc.mainFrame };
      const service = registry.getService(r.serviceId);
      bridges.push({
        frameOk: frames.senderMainFrame(event) !== null,
        bound: registry.boundRecordFor(wc) !== undefined,
        url: wc.mainFrame.url,
        urlOk: frames.isPermittedFrameUrlForKind(
          wc.mainFrame.url,
          service.kind,
          ipcRegistry.currentRemoteSpaOrigin()
        ),
        admitted: senderMod.requireConnectionSender(event) !== null,
      });
      bridges.push(
        await r.webContents
          .executeJavaScript(
            'JSON.stringify({ electron: typeof window.electron, connection: typeof (window.electron && window.electron.connection), whoAmI: window.electron && window.electron.connection ? window.electron.connection.whoAmI() : "absent" })'
          )
          .catch((e: unknown) => `executeJavaScript threw: ${String(e)}`)
      );
    }
    return {
      bridges,
      services: registry
        .allServices()
        .map((s: { serviceId: string; kind: string; origin: string }) => [
          s.serviceId,
          s.kind,
          s.origin,
        ]),
      connections: registry
        .liveConnections()
        .map(
          (r: {
            serviceId: string;
            state: string;
            webContents: { getURL(): string; isLoading(): boolean };
          }) => [r.serviceId, r.state, r.webContents.getURL(), r.webContents.isLoading()]
        ),
    };
  });
}

export async function serviceIdFor(app: ElectronApplication, origin: string): Promise<string> {
  const id = await app.evaluate((_electron, o) => {
    const req = (globalThis as unknown as { __e2eRequire: MainRequire }).__e2eRequire;
    return (req('connectionRegistry').serviceForOrigin(o)?.serviceId ?? null) as string | null;
  }, origin);
  if (id === null) throw new Error(`no service registered for ${origin}`);
  return id;
}

/** The primary webContents id of `serviceId`'s live connection. */
export async function primaryOf(app: ElectronApplication, serviceId: string): Promise<number> {
  const id = await app.evaluate((_electron, sid) => {
    const req = (globalThis as unknown as { __e2eRequire: MainRequire }).__e2eRequire;
    const record = req('connectionRegistry')
      .liveConnections()
      .find((r: { serviceId: string }) => r.serviceId === sid);
    return (record?.webContents.id ?? null) as number | null;
  }, serviceId);
  if (id === null) throw new Error(`no live connection for ${serviceId}`);
  return id;
}

/** Values of every `plane` cookie in `serviceId`'s session jar. */
export async function cookiesFor(app: ElectronApplication, serviceId: string): Promise<string[]> {
  return app.evaluate(async (_electron, sid) => {
    const req = (globalThis as unknown as { __e2eRequire: MainRequire }).__e2eRequire;
    const service = req('connectionRegistry').getService(sid);
    if (!service) throw new Error('unknown service');
    const cookies = (await service.session.cookies.get({ name: 'plane' })) as { value: string }[];
    return cookies.map((c) => c.value);
  }, serviceId);
}

/** A stable identity for a webContents' session: its storage path. */
export async function sessionOf(app: ElectronApplication, webContentsId: number): Promise<string> {
  return app.evaluate(({ webContents, session }, id) => {
    const wc = webContents.fromId(id);
    if (!wc) throw new Error('no such webContents');
    if (wc.session === session.defaultSession) return '<defaultSession>';
    return wc.session.storagePath ?? '<in-memory>';
  }, webContentsId);
}

export interface LiveRef {
  connectionId: string;
  generation: number;
}

/** The current `{ connectionId, generation }` of `serviceId`'s live connection. */
export async function generationOf(app: ElectronApplication, serviceId: string): Promise<LiveRef> {
  const ref = await app.evaluate((_electron, sid) => {
    const req = (globalThis as unknown as { __e2eRequire: MainRequire }).__e2eRequire;
    const record = req('connectionRegistry')
      .liveConnections()
      .find((r: { serviceId: string }) => r.serviceId === sid);
    return record
      ? { connectionId: record.connectionId as string, generation: record.generation as number }
      : null;
  }, serviceId);
  if (ref === null) throw new Error(`no live connection for ${serviceId}`);
  return ref;
}

/** Evaluates `code` in a webContents' main world and returns its (awaited) value. */
export async function execIn<T>(
  app: ElectronApplication,
  webContentsId: number,
  code: string
): Promise<T> {
  return app.evaluate(
    ({ webContents }, { id, src }) => {
      const wc = webContents.fromId(id);
      if (!wc) throw new Error('no such webContents');
      return wc.executeJavaScript(src);
    },
    { id: webContentsId, src: code }
  ) as Promise<T>;
}

// ── Capture-lease helpers (#87 Task 8) ─────────────────────────────────────────────
// `view` is a primary webContents id (see `primaryOf`). Renderer probes run in the
// view's main world through `execIn`, like the rest of this file.

/**
 * Answers the next capture-move ceremonies with `response` (0 Stay, 1 Join) instead of
 * the native dialog, through `captureCeremony`'s e2e seam on the shell's OWN module
 * instance. Each answer bumps `__e2eCeremonies` in main so a test can prove the
 * ceremony actually ran.
 */
export async function injectCeremony(app: ElectronApplication, response: 0 | 1): Promise<void> {
  await app.evaluate((_electron, r) => {
    const req = (globalThis as unknown as { __e2eRequire: MainRequire }).__e2eRequire;
    const g = globalThis as unknown as { __e2eCeremonies?: number };
    g.__e2eCeremonies = 0;
    req('captureCeremony')._setShowMessageBoxForTesting(async () => {
      g.__e2eCeremonies = (g.__e2eCeremonies ?? 0) + 1;
      return { response: r };
    });
  }, response);
}

/** How many ceremonies the injected dialog has answered since `injectCeremony`. */
export async function ceremoniesShown(app: ElectronApplication): Promise<number> {
  return app.evaluate(
    () => (globalThis as unknown as { __e2eCeremonies?: number }).__e2eCeremonies ?? 0
  );
}

/** Installs a `beforeunload` veto in the view's document. */
export async function vetoUnload(app: ElectronApplication, view: number): Promise<void> {
  await execIn<boolean>(
    app,
    view,
    `(() => {
       window.addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = ''; });
       return true;
     })()`
  );
}

/**
 * The hostile holder: schedules an endless loop on the view's main thread and returns
 * before it starts, so the document can never ack a revocation. Touch the view again
 * only after it has been crashed and reloaded.
 */
export async function wedgeRenderer(app: ElectronApplication, view: number): Promise<void> {
  await execIn<boolean>(
    app,
    view,
    `(() => { setTimeout(() => { for (;;) {} }, 0); return true; })()`
  );
}

export type TrackState = 'live' | 'ended';

/** `readyState` of every track the test captured in this document (`window.__e2eTracks`). */
export async function trackStates(app: ElectronApplication, view: number): Promise<TrackState[]> {
  return execIn<TrackState[]>(app, view, '(window.__e2eTracks || []).map((t) => t.readyState)');
}

export interface MainResourceCounts {
  readonly captureHolder: 0 | 1;
  readonly handoffPending: 0 | 1;
  readonly loopbacks: number;
  readonly traySnapshots: number;
  readonly audiocapCapture: 0 | 1;
}

/**
 * `mainResourceCounts()` from the shell's main process. main.ts does not import
 * `mainResourceCounts` itself, so it is not in the require cache; it is loaded here,
 * but only after each module it reads from has been proven loaded, so its imports
 * resolve to the shell's live instances and never to a second copy.
 */
export async function leaseCounts(app: ElectronApplication): Promise<MainResourceCounts> {
  return app.evaluate((_electron, dir) => {
    const req = (globalThis as unknown as { __e2eRequire: MainRequire }).__e2eRequire;
    for (const dep of ['captureLease', 'audiocapHost', 'ipc/sso', 'ipc/trayStatus']) req(dep);
    const main = (process as unknown as { mainModule?: NodeJS.Module }).mainModule;
    if (!main) throw new Error('no main module in the shell process');
    const join = (main.require('node:path') as typeof import('node:path')).join;
    const counts = main.require(join(dir, 'mainResourceCounts.js')) as {
      mainResourceCounts(): MainResourceCounts;
    };
    return counts.mainResourceCounts();
  }, DIST_MAIN);
}
