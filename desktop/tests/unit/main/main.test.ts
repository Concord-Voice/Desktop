// @vitest-environment node
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, type Mock } from 'vitest';
import { deferred } from '../../helpers/deferred';

// ── Hoisted mocks (available during vi.mock factory execution) ─────────

// #86 Task 4: the main window is a `BaseWindow` (`mockMainWindow`) whose `saas`
// connection is one `WebContentsView` (`mockView`, contents `mockWebContents`).
// `BrowserWindow` now builds PiP windows only; each gets its OWN webContents
// (`makePipContents`), because a PiP is bound 'pip' and the registry refuses to
// bind another connection's primary. The window-level spies a PiP test asserts on
// are shared across every PiP (`mockPipWindow`), so the per-test deltas still read.
const {
  mockMainWindow,
  mockWebContents,
  mockView,
  mockPipWindow,
  pipFrame,
  makePipContents,
  MockBrowserWindow,
  MockBaseWindow,
  MockWebContentsView,
} = vi.hoisted(() => {
  const mockWebContents = {
    openDevTools: vi.fn(),
    closeDevTools: vi.fn(),
    isDevToolsOpened: vi.fn(() => false),
    setWindowOpenHandler: vi.fn(),
    send: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    getURL: vi.fn(() => ''),
    loadURL: vi.fn().mockResolvedValue(undefined),
    loadFile: vi.fn().mockResolvedValue(undefined),
    isDestroyed: vi.fn(() => false),
    close: vi.fn(),
    focus: vi.fn(),
    mainFrame: { url: 'http://localhost:3001/', frameTreeNodeId: 77 },
  };
  const mockView = {
    webContents: mockWebContents,
    setBounds: vi.fn(),
    setVisible: vi.fn(),
    setBackgroundColor: vi.fn(),
  };
  const mockMainWindow = {
    once: vi.fn(),
    on: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    minimize: vi.fn(),
    maximize: vi.fn(),
    destroy: vi.fn(),
    close: vi.fn(),
    focus: vi.fn(),
    isMinimized: vi.fn(() => false),
    isFocused: vi.fn(() => false),
    isDestroyed: vi.fn(() => false),
    restore: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    setContentProtection: vi.fn(),
    flashFrame: vi.fn(),
    getContentBounds: vi.fn(() => ({ x: 0, y: 0, width: 1280, height: 720 })),
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  };
  // The PiP's own main frame. A getter on each PiP's contents reads it, so a test
  // can move the PiP's document (an SPA transition) after the window exists.
  const pipFrame = {
    current: { url: 'http://localhost:3001/', frameTreeNodeId: 88, parent: null as null },
  };
  function makePipContents(): Record<string, unknown> {
    return {
      on: vi.fn(),
      once: vi.fn(),
      send: vi.fn(),
      isDestroyed: vi.fn(() => false),
      setWindowOpenHandler: vi.fn(),
      getURL: vi.fn(() => ''),
      get mainFrame() {
        return pipFrame.current;
      },
    };
  }
  const mockPipWindow = {
    loadURL: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    once: vi.fn(),
    destroy: vi.fn(),
    close: vi.fn(),
    focus: vi.fn(),
    isDestroyed: vi.fn(() => false),
    setAlwaysOnTop: vi.fn(),
    setContentProtection: vi.fn(),
  };
  // Use mockImplementation (not mockReturnValue) — Vitest requires this for `new` calls
  const bw = vi.fn().mockImplementation(function () {
    return { ...mockPipWindow, webContents: makePipContents() };
  });
  // Static method used by activate handler
  (bw as Record<string, unknown>).getAllWindows = vi.fn(() => [mockMainWindow]);
  const base = vi.fn().mockImplementation(function () {
    return mockMainWindow;
  });
  (base as Record<string, unknown>).getAllWindows = vi.fn(() => [mockMainWindow]);
  const wcv = vi.fn().mockImplementation(function () {
    return mockView;
  });
  return {
    mockMainWindow,
    mockWebContents,
    mockView,
    mockPipWindow,
    pipFrame,
    makePipContents,
    MockBrowserWindow: bw,
    MockBaseWindow: base,
    MockWebContentsView: wcv,
  };
});

// #86 adaptation of main's #178 PiP fixtures: a PiP child must own a webContents
// distinct from the saas primary's, or createPipWindow's 'pip' binding refuses it.
let nextPipChildContents = 7000;
function pipChildContents(): unknown {
  const id = (nextPipChildContents += 1);
  return {
    ...mockWebContents,
    id,
    send: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    mainFrame: { url: 'http://localhost:3001/', frameTreeNodeId: id, parent: null },
  };
}

/** The webContents of the PiP window `pip:open` built most recently. */
function lastPipContents(): { mainFrame: { url: string; frameTreeNodeId: number } } {
  const results = (MockBrowserWindow as Mock).mock.results;
  return results[results.length - 1].value.webContents;
}

// ── SSO flow teardown spies (#975: window-close tears down BOTH flows) ──
const { mockCancelAppleFlow, mockCancelGoogleFlow } = vi.hoisted(() => ({
  mockCancelAppleFlow: vi.fn(),
  mockCancelGoogleFlow: vi.fn(),
}));
const { mockRevealLoadFailure } = vi.hoisted(() => ({
  mockRevealLoadFailure: vi.fn(),
}));
const { mockProbeSelfHostedServer } = vi.hoisted(() => ({
  mockProbeSelfHostedServer: vi.fn(),
}));
// #2354: the native approval ceremony + its pre-resolution seam.
const { mockShowMessageBox, mockResolveForDisplay, approvalStore } = vi.hoisted(() => ({
  mockShowMessageBox: vi.fn(async () => ({ response: 1 })),
  mockResolveForDisplay: vi.fn(async () => ({
    ok: true,
    address: '10.0.0.5',
    addresses: ['10.0.0.5'],
    decision: { tier: 'tier2', reason: 'private' },
  })),
  // `failAppend` simulates a durable-write failure (safeStorage/fs), so the
  // approval_not_saved path stays reachable after the commit moved behind the probe.
  approvalStore: { records: [] as { origin: string }[], failAppend: false },
}));
const { mockMaybePromptMove } = vi.hoisted(() => ({
  mockMaybePromptMove: vi.fn(() => false),
}));

// ── concord-audiocap capability probe (#3195) ──────────────────────────
// The app-start probe forks a real utilityProcess, so the electron mock needs
// one. The stub delivers a valid `hello` as soon as the host subscribes to
// 'message', which makes the probe settle inside beforeAll's 100 ms drain and
// therefore before any test reads it -- rather than leaving the outcome to
// whichever test happens to run before the 10 s handshake timer.
//
// `protocol: 1` restates AUDIOCAP_PROTOCOL because a vi.hoisted factory runs
// before this file's imports are evaluated. It is self-checking: were the
// constant to move, the strict `isAudiocapHello` narrowing would refuse this
// payload and the probe would record `protocol-fault`, reddening the assertion
// below rather than passing on a stale literal.
const { mockUtilityFork, audiocapChildStub } = vi.hoisted(() => {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  const hello = {
    kind: 'hello',
    protocol: 1,
    capability: {
      platform: 'darwin',
      osVersion: '15.0',
      perProcessAudio: true,
      reason: 'ok',
    },
    resourcesPathPresent: true,
    envKeys: ['PATH'],
  };
  const stub = {
    handlers,
    // `kill` returns TRUE, matching a child that HAS spawned. Returning
    // `undefined` sent `reapChild` down its not-yet-spawned branch, which calls
    // `child.once` -- absent from this stub -- and surfaced as an unhandled
    // rejection inside a teardown hook (#3245). `UtilityProcess` is an
    // EventEmitter in production, so `once` belongs here regardless.
    kill: vi.fn(() => true),
    once: vi.fn(),
    postMessage: vi.fn(),
    pid: 4242,
    on(event: string, cb: (...args: unknown[]) => void) {
      handlers[event] = cb;
      if (event === 'message') queueMicrotask(() => cb(hello));
      return this;
    },
  };
  return { mockUtilityFork: vi.fn(() => stub), audiocapChildStub: stub };
});
vi.mock('../../../src/main/oauth/apple/appleFlow', () => ({
  cancelActiveAppleFlow: mockCancelAppleFlow,
  runAppleSignIn: vi.fn(),
}));
vi.mock('../../../src/main/oauth/google/googleFlow', () => ({
  cancelActiveGoogleFlow: mockCancelGoogleFlow,
  runGoogleSignIn: vi.fn(),
}));

// ── Electron mock ──────────────────────────────────────────────────────

vi.mock('electron', () => ({
  BrowserWindow: MockBrowserWindow,
  BaseWindow: MockBaseWindow,
  WebContentsView: MockWebContentsView,
  Menu: {
    buildFromTemplate: vi.fn((template: unknown) => ({ template })),
    setApplicationMenu: vi.fn(),
    getApplicationMenu: vi.fn(() => null),
  },
  net: { fetch: vi.fn() },
  nativeImage: {
    createFromPath: vi.fn(() => ({
      isEmpty: vi.fn(() => false),
      toDataURL: vi.fn(() => 'data:image/png;base64,MOCKICON'),
    })),
  },
  autoUpdater: { on: vi.fn() },
  app: {
    getPath: vi.fn(() => '/tmp/test-userdata'),
    setPath: vi.fn(), // pinUserDataPath.ts calls app.setPath at import time (#1291)
    getAppPath: vi.fn(() => '/tmp/test-app'),
    getVersion: vi.fn(() => '1.0.0-test'),
    requestSingleInstanceLock: vi.fn(() => true),
    whenReady: vi.fn(() => Promise.resolve()),
    isPackaged: false,
    commandLine: { appendSwitch: vi.fn() },
    disableHardwareAcceleration: vi.fn(),
    quit: vi.fn(),
    relaunch: vi.fn(),
    setBadgeCount: vi.fn(),
    on: vi.fn(),
    getGPUInfo: vi.fn(() =>
      Promise.resolve({
        gpuDevice: [
          {
            vendorId: 0x10de,
            deviceId: 0x1234,
            driverVendor: 'NVIDIA',
            driverDescription: 'GeForce GTX 1080',
          },
        ],
      })
    ),
  },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  utilityProcess: { fork: mockUtilityFork },
  clipboard: { writeText: vi.fn() },
  desktopCapturer: {
    getSources: vi.fn(() =>
      Promise.resolve([
        {
          id: 'screen:1',
          name: 'Screen 1',
          thumbnail: { toDataURL: () => 'data:image/png;base64,thumb' },
          appIcon: { toDataURL: () => 'data:image/png;base64,icon' },
        },
      ])
    ),
  },
  screen: {
    getAllDisplays: vi.fn(() => [
      {
        id: 1,
        size: { width: 1920, height: 1080 },
        scaleFactor: 2,
        displayFrequency: 120,
        colorDepth: 24,
        colorSpace: 'srgb',
      },
    ]),
    getPrimaryDisplay: vi.fn(() => ({ id: 1 })),
  },
  session: {
    defaultSession: {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setDevicePermissionHandler: vi.fn(),
      setCertificateVerifyProc: vi.fn(),
      on: vi.fn(),
      webRequest: {
        onBeforeSendHeaders: vi.fn(),
      },
      protocol: { handle: vi.fn() },
      fetch: vi.fn(),
    },
    // #86: a self-hosted service's own session (registered in dev from approvals).
    fromPath: vi.fn(() => ({
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setDevicePermissionHandler: vi.fn(),
      on: vi.fn(),
      webRequest: { onBeforeSendHeaders: vi.fn() },
      protocol: { handle: vi.fn() },
      fetch: vi.fn(),
    })),
  },
  shell: { openExternal: vi.fn(() => Promise.resolve()) },
  powerMonitor: { on: vi.fn() },
  dialog: { showMessageBox: mockShowMessageBox },
}));

// ── Node / internal module mocks ───────────────────────────────────────

vi.mock('node:fs', () => ({
  default: {
    readFileSync: vi.fn((filePath: string) =>
      filePath.includes('content-protection.json')
        ? JSON.stringify({ enabled: false })
        : JSON.stringify({ enabled: true })
    ),
    writeFileSync: vi.fn(),
    existsSync: vi.fn(() => false),
    statSync: vi.fn(() => ({ isDirectory: () => false })),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
}));

// Mock node:http — make dev server check fail so createWindow falls back to loadFile
vi.mock('node:http', () => {
  const mockGet = vi.fn(
    (_url: string, _opts: Record<string, unknown>, _cb: (res: unknown) => void) => {
      const req = {
        on: vi.fn((event: string, handler: (err?: Error) => void) => {
          if (event === 'error') {
            // Fire error asynchronously to simulate ECONNREFUSED
            Promise.resolve().then(() => handler(new Error('ECONNREFUSED')));
          }
          return req;
        }),
        destroy: vi.fn(),
      };
      return req;
    }
  );
  return { default: { get: mockGet }, get: mockGet };
});

vi.mock('electron-squirrel-startup', () => ({ default: false }));

vi.mock('../../../src/main/tokenManager', () => {
  // #86 Task 5: main.ts reaches custody through the transitional routers, and
  // each hands back this one mocked set, so assertions on its members still hold.
  const custody = {
    storeRefreshToken: vi.fn(() => 41),
    // Async like the real functions: a sync mock would let main.ts drop its
    // `await` and still pass, since awaiting a plain value changes nothing.
    restoreRefreshToken: vi.fn(async () => ({
      status: 'ok',
      token: 'mock-token',
      apiBase: 'http://localhost:8080',
      rememberMe: true,
    })),
    performRefresh: vi.fn(() =>
      Promise.resolve({ status: 'ok', accessToken: 'mock-access', sessionId: 'mock-session' })
    ),
    performLogout: vi.fn(() => Promise.resolve()),
    clearTokens: vi.fn(),
    clearTokensIfOwner: vi.fn((owner: number) => owner === 41),
    getCapabilities: vi.fn(() => ({ safeStorage: true, secureKeychain: true })),
    storeE2EEKeys: vi.fn(),
    storeE2EEKeysIfOwner: vi.fn((_data: unknown, owner: number) => owner === 41),
    restoreE2EEKeys: vi.fn(async () => ({
      wrappingKeyBase64: 'key',
      preferencesKeyBase64: 'pkey',
      wrappedPrivateKeyBase64: 'wpk',
    })),
    getCredentialCustodyState: vi.fn(() => ({
      credentialOwner: 41,
      pendingE2EEUnlock: false,
    })),
    setProactiveRefreshCallback: vi.fn(),
    onSystemResume: vi.fn(),
    getCachedAccessToken: vi.fn(() => null),
    getApiBaseOrigin: vi.fn(() => null),
    // #86 Task 4: each connection view subscribes for its R6 generation bumps.
    onCredentialEvent: vi.fn(() => () => undefined),
  };
  return {
    ...custody,
    custodyFor: vi.fn(() => custody),
    custodyForApiBase: vi.fn(() => custody),
    liveCustody: vi.fn(() => custody),
    restoreTargetCustody: vi.fn(() => custody),
  };
});

vi.mock('../../../src/main/machineId', () => ({
  getMachineId: vi.fn(() => 'mock-machine-id'),
}));

// #86 Task 6: the startup migration's own connections.json write would otherwise land
// in the mocked fs and interleave with the writes these suites assert on.
vi.mock('../../../src/main/connectionMigration', () => ({
  runConnectionMigration: vi.fn(() => ({ entries: [], derived: false })),
}));

vi.mock('../../../src/main/selfHostedProbe', async (importActual) => ({
  // normalizeSelfHostedUrl stays REAL — the ceremony keys its approval on the same
  // normalized origin the probe will dial.
  ...((await importActual()) as Record<string, unknown>),
  probeSelfHostedServer: mockProbeSelfHostedServer,
}));

// In-memory approval store so the ceremony's durable writer stays hermetic here.
vi.mock('../../../src/main/selfHostedApprovals', () => ({
  readApprovalsFile: () => approvalStore.records,
  appendApprovalRecord: (r: { origin: string }) => {
    if (approvalStore.failAppend) return false;
    approvalStore.records.push(r);
    return true;
  },
  // Most-recent-wins, matching the real append-only reader.
  findApprovalRecord: (origin: string) =>
    [...approvalStore.records].reverse().find((r) => r.origin === origin),
  _resetApprovalsCacheForTesting: () => {
    approvalStore.records.length = 0;
  },
}));

vi.mock('../../../src/main/guardedRequest', () => ({
  resolveForDisplay: mockResolveForDisplay,
}));

vi.mock('../../../src/main/updater', () => ({
  initAutoUpdater: vi.fn(),
  stopAutoUpdater: vi.fn(),
  setUpdateFeedUrl: vi.fn(),
  checkForUpdates: vi.fn(() => Promise.resolve({ updateAvailable: false })),
  downloadUpdate: vi.fn(() => Promise.resolve()),
  safeQuitAndInstall: vi.fn(() => Promise.resolve()),
  getAllowPrerelease: vi.fn(() => false),
  setAllowPrerelease: vi.fn(),
  forceCheckForUpdates: vi.fn(() => Promise.resolve()),
  getUpdateLogger: vi.fn(() => null),
  getUpdateLogPath: vi.fn(() => '/tmp/test-logs/update-2026-03-25.log'),
}));

vi.mock('../../../src/main/updateSafety', () => ({
  checkUpdateSentinel: vi.fn(() => ({ type: 'none' })),
  finalizeUpdate: vi.fn(() => Promise.resolve()),
  finalizeRollback: vi.fn(() => Promise.resolve()),
  runDeferredCleanup: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../../src/main/userDataMigration', () => ({
  migrateUserData: vi.fn(),
}));

vi.mock('../../../src/main/splashWindow', () => ({
  showSplash: vi.fn(),
  closeSplash: vi.fn(),
  updateSplashError: vi.fn(),
}));

vi.mock('../../../src/main/loadFailureVisibility', () => ({
  revealLoadFailure: mockRevealLoadFailure,
}));

vi.mock('../../../src/main/applicationsFolderGate', () => ({
  maybePromptMove: mockMaybePromptMove,
}));

vi.mock('../../../src/main/spaLoader', () => ({
  resolveSpaSource: vi.fn(() => Promise.resolve({ mode: 'bundled', reason: 'test' })),
  isUnexpectedBundled: vi.fn(() => false),
  isTransientRemoteFailure: vi.fn(() => false),
  captureSpaHash: vi.fn(() => Promise.resolve()),
  hashEntryHtml: vi.fn(() => Promise.resolve('sha256:available')),
  SPA_NO_CACHE_LOAD_OPTIONS: {
    extraHeaders: 'Cache-Control: no-cache\nPragma: no-cache\n',
  },
}));

vi.mock('../../../src/main/ipcContract', () => ({
  IPC_CONTRACT_VERSION: '1.0',
}));

vi.mock('../../../src/main/permissionManager', () => ({
  registerIpcHandlers: vi.fn(),
}));

vi.mock('../../../src/main/billing/billingWindow', () => ({
  isBillingWebContents: vi.fn(() => false),
  openBillingWindow: vi.fn(),
  validateBillingUrl: vi.fn(),
}));

// ── Import + extract ───────────────────────────────────────────────────

type HandlerFn = (...args: unknown[]) => unknown;
type CallbackFn = (...args: unknown[]) => void;
let handlers: Map<string, HandlerFn>;
// #86 7B: the saas view's own main frame. Handlers registered through registerIpc
// admit only a bound connection sender, so the trusted fixture is the bound saas view.
const trustedIpcEvent = {
  sender: mockWebContents,
  // A main frame has parent === null (senderMainFrame refuses anything else).
  senderFrame: { url: 'http://localhost:3001/', frameTreeNodeId: 77, parent: null },
};
// #86 Task 7B (DEV-BUILD ORIGIN ruling): main pins the saas service's origin at startup to
// the first-party API base. This fixture is unpackaged with no CONCORD_DEV_API_BASE, so
// saas is the dev control plane; production is just another origin here.
const SAAS_DEV_API_BASE = 'http://localhost:8080';
// #86 R8: pip:open admits only a bound connection PRIMARY, and the saas view's
// contents is the one this file's window opens. Same trusted frame as above.
const pipOpenerEvent = { sender: mockWebContents, senderFrame: trustedIpcEvent.senderFrame };
// The same saas main frame on the bundled document (packaged builds admit app://concord,
// never a localhost dev server).
const saasAppFrameEvent = {
  sender: mockWebContents,
  senderFrame: { url: 'app://concord/index.html', frameTreeNodeId: 77, parent: null },
};
// Main's "live main window main frame" fixture (#195/#198/#199), adapted for #86 to the
// bound foreground saas primary's main frame.
const probeEvent = trustedIpcEvent;
const foreignIpcEvent = {
  sender: { id: 99 },
  senderFrame: { url: 'https://evil.example/', frameTreeNodeId: 99 },
};
// #86 Task 7B: a bound primary of a self-hosted service, registered and bound the way
// shellWindow does it. The pre-#86 probe cases assert that a probe returns the probe's own
// result. Under #86 that holds only when the probed origin is the SENDER'S OWN service:
// another origin opens in its own connection, which '#86 … probeServer from the saas view'
// locks. So those cases probe from a primary of the service they probe. `dispose()` closes
// the connection and gives the foreground back to whoever held it.
let nextSelfHostedFrame = 8800;
function bindSelfHostedPrimary(origin: string, opts: { foreground?: boolean } = {}) {
  const frameUrl = 'app://concord/index.html';
  const svc = connectionRegistry.registerService(origin, {
    makeSession: () => ({}) as never,
    makeCustody: () => ({}) as never,
    isValidatedSelfHostedApiBase: () => true,
  });
  if (!svc.ok) throw new Error(`registerService refused ${origin}: ${svc.reason}`);
  const frameTreeNodeId = (nextSelfHostedFrame += 1);
  const wc = {
    id: frameTreeNodeId,
    send: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    getURL: vi.fn(() => frameUrl),
    loadURL: vi.fn().mockResolvedValue(undefined),
    isDestroyed: vi.fn(() => false),
    mainFrame: { url: frameUrl, frameTreeNodeId },
  };
  const opened = connectionRegistry.openConnection(svc.service.serviceId, wc as never, null);
  if (!opened.ok) throw new Error(`openConnection refused ${origin}: ${opened.reason}`);
  connectionRegistry.bindSender(wc as never, opened.record.connectionId, 'primary');
  const before = connectionRegistry.foreground()?.connectionId ?? null;
  if (opts.foreground) connectionRegistry.setForeground(opened.record.connectionId);
  return {
    event: { sender: wc, senderFrame: { url: frameUrl, frameTreeNodeId, parent: null } },
    makeForeground: () => connectionRegistry.setForeground(opened.record.connectionId),
    dispose: () => {
      connectionRegistry.disposeConnection(opened.record.connectionId);
      if (before) connectionRegistry.setForeground(before);
    },
  };
}
let appOnCallbacks: Map<string, CallbackFn>;
let sessionHandlers: {
  permissionRequest?: CallbackFn;
  permissionCheck?: CallbackFn;
  devicePermission?: CallbackFn;
  hidSelect?: CallbackFn;
};
let klipyInterceptor: {
  filter: { urls: string[] };
  callback: (
    details: { url: string; requestHeaders: Record<string, string> },
    cb: (opts: { requestHeaders: Record<string, string> }) => void
  ) => void;
} | null = null;

// Fake `contents` passed to the `web-contents-created` callback. Every window's
// contents now gets a window-open handler registered on it (the PiP-gap fix —
// see externalizeWindowOpen in main.ts), so a fake missing setWindowOpenHandler
// throws the instant the callback under test runs.
//
// #86: the navigation gate admits nothing for an UNBOUND contents (fail closed;
// connectionSession.test.ts pins that). Every fake here stands for a document of
// the live saas connection, so it is bound as one of its PiPs.
let connectionRegistry: typeof import('../../../src/main/connectionRegistry');
let saasServiceId: import('../../../src/shared/connectionIdentity').ServiceId;
function createMockContents(): { on: Mock; setWindowOpenHandler: Mock } {
  const contents = { on: vi.fn(), setWindowOpenHandler: vi.fn() };
  const live = connectionRegistry.liveConnections().find((r) => r.serviceId === saasServiceId);
  if (!live) throw new Error('createMockContents: no live saas connection');
  connectionRegistry.bindSender(contents as never, live.connectionId, 'pip');
  return contents;
}

// #2354: dialog calls attributable to main.ts's module load + init, captured before
// any test can add its own. Order-independent, unlike reading the mock later.
let dialogCallsAfterImport = -1;

// #2354: the approval-prompt bucket is module-level state in the real (unmocked)
// selfHostedCeremonyBudget, so without this every ceremony in this file spends from
// one shared 10-minute window and later tests would throttle on earlier ones.
// Content protection is macOS/Windows-only and main now refuses the call
// elsewhere. The CI runner is `linux`, so without pinning a supported platform
// every positive content-protection assertion here exercises the refusal path
// instead of the behaviour it names — green on a macOS laptop, red on CI, and
// silently vacuous if the refusal were ever removed. Tests that need a
// different platform set it themselves and restore to 'darwin'.
const REAL_PLATFORM = process.platform;
function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

// Pinned at MODULE scope, not just in beforeEach: createWindow runs inside
// beforeAll, which fires before any beforeEach, so a per-test pin lands too
// late for the window-creation path and that test alone stays red on CI.
setPlatform('darwin');

beforeEach(async () => {
  setPlatform('darwin');
  const { _resetCeremonyBudgetForTesting } =
    await import('../../../src/main/selfHostedCeremonyBudget');
  _resetCeremonyBudgetForTesting();
  const { _resetPipOpenBudgetForTesting } = await import('../../../src/main/pipOpenPolicy');
  _resetPipOpenBudgetForTesting();
});

afterEach(() => {
  setPlatform(REAL_PLATFORM);
});

beforeAll(async () => {
  // Import triggers all module-scope side effects + whenReady resolves
  await import('../../../src/main/main');
  connectionRegistry = await import('../../../src/main/connectionRegistry');
  const saasBinding = connectionRegistry.bindingFor(mockWebContents as never);
  const saasRecord = saasBinding ? connectionRegistry.recordFor(saasBinding.connectionId) : null;
  if (!saasRecord) throw new Error('beforeAll: createWindow did not open the saas view');
  saasServiceId = saasRecord.serviceId;
  dialogCallsAfterImport = mockShowMessageBox.mock.calls.length;

  // Allow async operations to settle (createWindow, whenReady callback)
  await new Promise((resolve) => setTimeout(resolve, 100));

  const electron = await import('electron');

  // Extract IPC handlers from ipcMain.handle mock calls
  handlers = new Map();
  for (const call of (electron.ipcMain.handle as Mock).mock.calls) {
    handlers.set(call[0] as string, call[1] as HandlerFn);
  }

  // Extract app.on callbacks
  appOnCallbacks = new Map();
  for (const call of (electron.app.on as Mock).mock.calls) {
    appOnCallbacks.set(call[0] as string, call[1] as CallbackFn);
  }

  // Extract session permission handlers
  const sess = electron.session.defaultSession;
  sessionHandlers = {};
  const prh = (sess.setPermissionRequestHandler as Mock).mock.calls;
  if (prh.length > 0) sessionHandlers.permissionRequest = prh[0][0] as CallbackFn;
  const pch = (sess.setPermissionCheckHandler as Mock).mock.calls;
  if (pch.length > 0) sessionHandlers.permissionCheck = pch[0][0] as CallbackFn;
  const dph = (sess.setDevicePermissionHandler as Mock).mock.calls;
  if (dph.length > 0) sessionHandlers.devicePermission = dph[0][0] as CallbackFn;
  const hid = (sess.on as Mock).mock.calls.find((c: unknown[]) => c[0] === 'select-hid-device');
  if (hid) sessionHandlers.hidSelect = hid[1] as CallbackFn;

  // Extract KLIPY media proxy webRequest interceptor (#626)
  const wrCalls = (sess.webRequest.onBeforeSendHeaders as Mock).mock.calls;
  if (wrCalls.length > 0) {
    klipyInterceptor = {
      filter: wrCalls[0][0] as { urls: string[] },
      callback: wrCalls[0][1] as NonNullable<typeof klipyInterceptor>['callback'],
    };
  }
});

// ── Tests ──────────────────────────────────────────────────────────────

describe('main.ts', () => {
  describe('module initialization', () => {
    it('calls migrateUserData on startup (before app.whenReady)', async () => {
      const { migrateUserData } = await import('../../../src/main/userDataMigration');
      expect(migrateUserData).toHaveBeenCalled();
    });

    it('reads hardware acceleration preference on startup', async () => {
      const fs = (await import('node:fs')).default;
      expect(fs.readFileSync).toHaveBeenCalled();
    });

    it('applies initial content protection before loading renderer content', () => {
      const protectionOrder = mockMainWindow.setContentProtection.mock.invocationCallOrder[0];
      const rendererLoadOrders = [
        mockWebContents.loadURL.mock.invocationCallOrder[0],
        mockWebContents.loadFile.mock.invocationCallOrder[0],
      ].filter((order): order is number => order !== undefined);

      expect(protectionOrder).toBeDefined();
      expect(rendererLoadOrders.length).toBeGreaterThan(0);
      expect(protectionOrder).toBeLessThan(Math.min(...rendererLoadOrders));
    });

    it('appends accelerated video flags when hw accel enabled', async () => {
      const { app } = await import('electron');
      expect(app.commandLine.appendSwitch).toHaveBeenCalledWith(
        'enable-features',
        'AcceleratedVideoEncoder,AcceleratedVideoDecodeLinuxGL,WebRtcAV1HWEncode'
      );
    });

    it('sets autoplay policy for WebRTC', async () => {
      const { app } = await import('electron');
      expect(app.commandLine.appendSwitch).toHaveBeenCalledWith(
        'autoplay-policy',
        'no-user-gesture-required'
      );
    });

    it('requests single instance lock', async () => {
      const { app } = await import('electron');
      expect(app.requestSingleInstanceLock).toHaveBeenCalled();
    });

    it('registers second-instance handler when lock acquired', () => {
      expect(appOnCallbacks.has('second-instance')).toBe(true);
    });

    it('registers web-contents-created handler', () => {
      expect(appOnCallbacks.has('web-contents-created')).toBe(true);
    });

    it('registers window-all-closed handler', () => {
      expect(appOnCallbacks.has('window-all-closed')).toBe(true);
    });

    it('registers before-quit handler', () => {
      expect(appOnCallbacks.has('before-quit')).toBe(true);
    });

    it('checks Applications-folder relocation before creating the shell window', () => {
      const gateOrder = mockMaybePromptMove.mock.invocationCallOrder[0];
      const windowOrder = MockBaseWindow.mock.invocationCallOrder[0];

      expect(gateOrder).toBeDefined();
      expect(windowOrder).toBeDefined();
      expect(gateOrder).toBeLessThan(windowOrder);
    });
  });

  describe('IPC: app info', () => {
    it('registers content-protection getter and setter channels', () => {
      expect(handlers.has('app:getContentProtection')).toBe(true);
      expect(handlers.has('app:setContentProtection')).toBe(true);
    });

    it('returns false for absent or malformed content-protection preferences', async () => {
      const fs = (await import('node:fs')).default;
      (fs.readFileSync as Mock).mockImplementation(() => '{"enabled":"yes"}');
      await expect(handlers.get('app:getContentProtection')!(trustedIpcEvent)).resolves.toBe(false);
      (fs.readFileSync as Mock).mockImplementation(
        () => '{"enabled":true,"previousEnabled":false,"staged":false}'
      );
      await expect(handlers.get('app:getContentProtection')!(trustedIpcEvent)).resolves.toBe(false);
      (fs.readFileSync as Mock).mockImplementation((filePath: string) =>
        filePath.includes('content-protection.json') ? '{"enabled":false}' : '{"enabled":true}'
      );
    });

    it('returns false when content-protection preferences cannot be read', async () => {
      const fs = (await import('node:fs')).default;
      (fs.readFileSync as Mock).mockImplementation((filePath: string) => {
        if (filePath.includes('content-protection.json')) throw new Error('unreadable');
        return JSON.stringify({ enabled: true });
      });

      await expect(handlers.get('app:getContentProtection')!(trustedIpcEvent)).resolves.toBe(false);
      (fs.readFileSync as Mock).mockImplementation((filePath: string) =>
        filePath.includes('content-protection.json')
          ? JSON.stringify({ enabled: false })
          : JSON.stringify({ enabled: true })
      );
    });

    it('stays silent for a never-set preference but warns when one is unreadable', async () => {
      const fs = (await import('node:fs')).default;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // ENOENT is the opt-in default — OFF is correct and unremarkable.
      const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
      (fs.readFileSync as Mock).mockImplementation((filePath: string) => {
        if (filePath.includes('content-protection.json')) throw missing;
        return JSON.stringify({ enabled: true });
      });
      await expect(handlers.get('app:getContentProtection')!(trustedIpcEvent)).resolves.toBe(false);
      expect(warn).not.toHaveBeenCalled();

      // Any other failure is an enabled privacy control silently going OFF.
      (fs.readFileSync as Mock).mockImplementation((filePath: string) => {
        if (filePath.includes('content-protection.json'))
          // A realistic Node fs message: it CONTAINS the userData path, so the
          // no-path assertions below are load-bearing rather than trivially
          // true. `new Error('denied')` would pass them even if main logged
          // error.message verbatim. (#2990 review, CodeRabbit.)
          throw Object.assign(
            new Error(
              "EACCES: permission denied, open '/Users/testuser/Library/Application Support/Concord Voice/content-protection.json'"
            ),
            { code: 'EACCES' }
          );
        return JSON.stringify({ enabled: true });
      });
      await expect(handlers.get('app:getContentProtection')!(trustedIpcEvent)).resolves.toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('preference unreadable'), 'EACCES');
      // The log must carry the errno code and nothing path-shaped: Node's fs
      // message embeds the full userData path, which contains the OS account
      // name on macOS and Windows.
      const logged = warn.mock.calls.flat().join(' ');
      expect(logged).not.toContain('/');
      expect(logged).not.toContain('content-protection.json');

      warn.mockRestore();
      (fs.readFileSync as Mock).mockImplementation((filePath: string) =>
        filePath.includes('content-protection.json')
          ? JSON.stringify({ enabled: false })
          : JSON.stringify({ enabled: true })
      );
    });

    it('warns when the preference parses but has an unrecognized shape', async () => {
      const fs = (await import('node:fs')).default;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Parses fine, fails the shape guard — the one path out of the reader
      // that used to return OFF in complete silence.
      (fs.readFileSync as Mock).mockImplementation((filePath: string) =>
        filePath.includes('content-protection.json')
          ? '{"enabled":true,"extra":1}'
          : JSON.stringify({ enabled: true })
      );
      await expect(handlers.get('app:getContentProtection')!(trustedIpcEvent)).resolves.toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('unrecognized shape'));

      // The rejected object is user-writable content and must not be echoed.
      const logged = warn.mock.calls.flat().join(' ');
      expect(logged).not.toContain('extra');

      warn.mockRestore();
      (fs.readFileSync as Mock).mockImplementation((filePath: string) =>
        filePath.includes('content-protection.json')
          ? JSON.stringify({ enabled: false })
          : JSON.stringify({ enabled: true })
      );
    });

    it('refuses to claim content protection on a platform that cannot enforce it', async () => {
      const fs = (await import('node:fs')).default;
      setPlatform('linux');
      (fs.writeFileSync as Mock).mockClear();
      mockMainWindow.setContentProtection.mockClear();
      try {
        // setContentProtection is a silent no-op off macOS/Windows. Returning
        // true would tell the caller a screen-capture protection is in force.
        await expect(
          handlers.get('app:setContentProtection')!(trustedIpcEvent, true)
        ).resolves.toBe(false);
        expect(fs.writeFileSync).not.toHaveBeenCalled();
        expect(mockMainWindow.setContentProtection).not.toHaveBeenCalled();

        await expect(handlers.get('app:getContentProtection')!(trustedIpcEvent)).resolves.toBe(
          false
        );
      } finally {
        setPlatform('darwin');
      }
    });

    it('persists a trusted boolean before updating live windows', async () => {
      const fs = (await import('node:fs')).default;
      const pip = {
        isDestroyed: vi.fn(() => false),
        setContentProtection: vi.fn(),
        webContents: makePipContents(),
      };
      Object.assign(pip, {
        loadURL: vi.fn().mockResolvedValue(undefined),
        on: vi.fn(),
        focus: vi.fn(),
        destroy: vi.fn(),
      });
      (MockBrowserWindow as Mock).mockImplementationOnce(function () {
        return pip;
      });
      await handlers.get('pip:open')!(pipOpenerEvent, { id: 'content-protection-pip' });
      (fs.writeFileSync as Mock).mockClear();
      mockMainWindow.setContentProtection.mockClear();
      pip.setContentProtection.mockClear();
      const result = await handlers.get('app:setContentProtection')!(trustedIpcEvent, true);
      expect(result).toBe(true);
      expect(fs.writeFileSync).toHaveBeenNthCalledWith(
        1,
        expect.stringMatching(/content-protection\.json\.\d+\.tmp$/),
        JSON.stringify({ enabled: true, previousEnabled: false, staged: true }),
        'utf-8'
      );
      expect(fs.renameSync).toHaveBeenNthCalledWith(
        1,
        expect.stringMatching(/content-protection\.json\.\d+\.tmp$/),
        expect.stringContaining('content-protection.json')
      );
      expect(fs.writeFileSync).toHaveBeenNthCalledWith(
        2,
        expect.stringMatching(/content-protection\.json\.\d+\.tmp$/),
        JSON.stringify({ enabled: true }),
        'utf-8'
      );
      expect(mockMainWindow.setContentProtection).toHaveBeenCalledWith(true);
      expect(pip.setContentProtection).toHaveBeenCalledWith(true);
      expect(fs.renameSync.mock.invocationCallOrder[0]).toBeLessThan(
        mockMainWindow.setContentProtection.mock.invocationCallOrder[0]
      );
      expect(fs.renameSync.mock.invocationCallOrder[0]).toBeLessThan(
        pip.setContentProtection.mock.invocationCallOrder[0]
      );
      // #86 RT5: close it, so this PiP does not hold a slot of the saas connection's cap
      // for the rest of the file.
      for (const [event, listener] of pip.on.mock.calls) if (event === 'closed') listener();
    });

    it('canonicalizes the target value only after every live window accepts it', async () => {
      const fs = (await import('node:fs')).default;
      let durable = JSON.stringify({ enabled: false });
      (fs.readFileSync as Mock).mockImplementation((filePath: string) =>
        filePath.includes('content-protection.json') ? durable : JSON.stringify({ enabled: true })
      );
      let temporary = '';
      (fs.writeFileSync as Mock).mockImplementation((_filePath: string, contents: string) => {
        temporary = contents;
      });
      (fs.renameSync as Mock).mockImplementation(() => {
        durable = temporary;
      });

      await expect(handlers.get('app:setContentProtection')!(trustedIpcEvent, true)).resolves.toBe(
        true
      );
      expect(durable).toBe(JSON.stringify({ enabled: true }));
      await expect(handlers.get('app:getContentProtection')!(trustedIpcEvent)).resolves.toBe(true);

      (fs.readFileSync as Mock).mockImplementation((filePath: string) =>
        filePath.includes('content-protection.json')
          ? JSON.stringify({ enabled: false })
          : '{"enabled":true}'
      );
      (fs.writeFileSync as Mock).mockImplementation(() => undefined);
      (fs.renameSync as Mock).mockImplementation(() => undefined);
    });

    it('keeps the staged previous value durable when a native content-protection call fails', async () => {
      const fs = (await import('node:fs')).default;
      const pip = {
        isDestroyed: vi.fn(() => false),
        setContentProtection: vi.fn(),
        webContents: makePipContents(),
        loadURL: vi.fn().mockResolvedValue(undefined),
        on: vi.fn(),
        focus: vi.fn(),
        destroy: vi.fn(),
      };
      (MockBrowserWindow as Mock).mockImplementationOnce(function () {
        return pip;
      });
      await handlers.get('pip:open')!(pipOpenerEvent, { id: 'content-protection-rollback-pip' });
      (fs.writeFileSync as Mock).mockImplementation(() => undefined);
      mockMainWindow.setContentProtection.mockReset();
      pip.setContentProtection.mockReset();
      pip.setContentProtection.mockImplementation(() => {
        throw new Error('native failure');
      });
      const result = await handlers.get('app:setContentProtection')!(trustedIpcEvent, true);
      expect(result).toBe(false);
      expect(mockMainWindow.setContentProtection).toHaveBeenLastCalledWith(false);
      expect(fs.writeFileSync).toHaveBeenLastCalledWith(
        expect.stringMatching(/content-protection\.json\.\d+\.tmp$/),
        JSON.stringify({ enabled: true, previousEnabled: false, staged: true }),
        'utf-8'
      );
      // #86 RT5: close it, so this PiP does not hold a slot of the saas connection's cap
      // for the rest of the file.
      for (const [event, listener] of pip.on.mock.calls) if (event === 'closed') listener();
    });

    it('reads the old value from a staged record after native failure in either direction', async () => {
      const fs = (await import('node:fs')).default;
      let durable = JSON.stringify({ enabled: true });
      let temporary = '';
      (fs.readFileSync as Mock).mockImplementation((filePath: string) =>
        filePath.includes('content-protection.json') ? durable : JSON.stringify({ enabled: true })
      );
      (fs.writeFileSync as Mock).mockImplementation((_filePath: string, contents: string) => {
        temporary = contents;
      });
      (fs.renameSync as Mock).mockImplementation(() => {
        durable = temporary;
      });
      mockMainWindow.setContentProtection.mockImplementationOnce(() => {
        throw new Error('native failure');
      });

      await expect(handlers.get('app:setContentProtection')!(trustedIpcEvent, false)).resolves.toBe(
        false
      );
      expect(durable).toBe(JSON.stringify({ enabled: false, previousEnabled: true, staged: true }));
      await expect(handlers.get('app:getContentProtection')!(trustedIpcEvent)).resolves.toBe(true);

      (fs.readFileSync as Mock).mockImplementation((filePath: string) =>
        filePath.includes('content-protection.json')
          ? JSON.stringify({ enabled: false })
          : '{"enabled":true}'
      );
      (fs.writeFileSync as Mock).mockImplementation(() => undefined);
      (fs.renameSync as Mock).mockImplementation(() => undefined);
      mockMainWindow.setContentProtection.mockImplementation(() => undefined);
    });

    it('rolls back live windows and keeps the old value durable when canonicalization fails', async () => {
      const fs = (await import('node:fs')).default;
      let durable = JSON.stringify({ enabled: false });
      let temporary = '';
      let renames = 0;
      (fs.readFileSync as Mock).mockImplementation((filePath: string) =>
        filePath.includes('content-protection.json') ? durable : JSON.stringify({ enabled: true })
      );
      (fs.writeFileSync as Mock).mockImplementation((_filePath: string, contents: string) => {
        temporary = contents;
      });
      (fs.renameSync as Mock).mockImplementation(() => {
        renames += 1;
        if (renames === 2) throw new Error('canonicalization failed');
        durable = temporary;
      });
      mockMainWindow.setContentProtection.mockClear();

      await expect(handlers.get('app:setContentProtection')!(trustedIpcEvent, true)).resolves.toBe(
        false
      );
      expect(mockMainWindow.setContentProtection).toHaveBeenNthCalledWith(1, true);
      expect(mockMainWindow.setContentProtection).toHaveBeenLastCalledWith(false);
      expect(durable).toBe(JSON.stringify({ enabled: true, previousEnabled: false, staged: true }));
      await expect(handlers.get('app:getContentProtection')!(trustedIpcEvent)).resolves.toBe(false);

      (fs.readFileSync as Mock).mockImplementation((filePath: string) =>
        filePath.includes('content-protection.json')
          ? JSON.stringify({ enabled: false })
          : '{"enabled":true}'
      );
      (fs.writeFileSync as Mock).mockImplementation(() => undefined);
      (fs.renameSync as Mock).mockImplementation(() => undefined);
    });

    it('preserves the previous enabled value when disabling cannot be canonicalized', async () => {
      const fs = (await import('node:fs')).default;
      let durable = JSON.stringify({ enabled: true });
      let temporary = '';
      let renames = 0;
      (fs.readFileSync as Mock).mockImplementation((filePath: string) =>
        filePath.includes('content-protection.json') ? durable : JSON.stringify({ enabled: true })
      );
      (fs.writeFileSync as Mock).mockImplementation((_filePath: string, contents: string) => {
        temporary = contents;
      });
      (fs.renameSync as Mock).mockImplementation(() => {
        renames += 1;
        if (renames === 2) throw new Error('canonicalization failed');
        durable = temporary;
      });
      mockMainWindow.setContentProtection.mockClear();

      await expect(handlers.get('app:setContentProtection')!(trustedIpcEvent, false)).resolves.toBe(
        false
      );
      expect(mockMainWindow.setContentProtection).toHaveBeenNthCalledWith(1, false);
      expect(mockMainWindow.setContentProtection).toHaveBeenLastCalledWith(true);
      expect(durable).toBe(JSON.stringify({ enabled: false, previousEnabled: true, staged: true }));
      await expect(handlers.get('app:getContentProtection')!(trustedIpcEvent)).resolves.toBe(true);

      (fs.readFileSync as Mock).mockImplementation((filePath: string) =>
        filePath.includes('content-protection.json')
          ? JSON.stringify({ enabled: false })
          : '{"enabled":true}'
      );
      (fs.writeFileSync as Mock).mockImplementation(() => undefined);
      (fs.renameSync as Mock).mockImplementation(() => undefined);
      mockMainWindow.setContentProtection.mockImplementation(() => undefined);
    });

    it('keeps the staged destination authoritative when canonical temp write mutates then fails', async () => {
      const fs = (await import('node:fs')).default;
      let durable = JSON.stringify({ enabled: true });
      let temporary = '';
      let writes = 0;
      (fs.readFileSync as Mock).mockImplementation((filePath: string) =>
        filePath.includes('content-protection.json') ? durable : JSON.stringify({ enabled: true })
      );
      (fs.writeFileSync as Mock).mockImplementation((_filePath: string, contents: string) => {
        temporary = contents;
        writes += 1;
        if (writes === 2) throw new Error('canonical temp write reached disk then failed');
      });
      (fs.renameSync as Mock).mockImplementation(() => {
        durable = temporary;
      });
      mockMainWindow.setContentProtection.mockClear();

      await expect(handlers.get('app:setContentProtection')!(trustedIpcEvent, false)).resolves.toBe(
        false
      );
      expect(durable).toBe(JSON.stringify({ enabled: false, previousEnabled: true, staged: true }));
      await expect(handlers.get('app:getContentProtection')!(trustedIpcEvent)).resolves.toBe(true);
      expect(mockMainWindow.setContentProtection).toHaveBeenNthCalledWith(1, false);
      expect(mockMainWindow.setContentProtection).toHaveBeenLastCalledWith(true);

      (fs.readFileSync as Mock).mockImplementation((filePath: string) =>
        filePath.includes('content-protection.json')
          ? JSON.stringify({ enabled: false })
          : '{"enabled":true}'
      );
      (fs.writeFileSync as Mock).mockImplementation(() => undefined);
      (fs.renameSync as Mock).mockImplementation(() => undefined);
      mockMainWindow.setContentProtection.mockImplementation(() => undefined);
    });

    it.each([
      { previous: false, target: true },
      { previous: true, target: false },
    ])(
      'keeps the existing authority when the staged temp write fails after mutation ($previous → $target)',
      async ({ previous, target }) => {
        const fs = (await import('node:fs')).default;
        let durable = JSON.stringify({ enabled: previous });
        let temporary = '';
        (fs.readFileSync as Mock).mockImplementation((filePath: string) =>
          filePath.includes('content-protection.json') ? durable : JSON.stringify({ enabled: true })
        );
        (fs.writeFileSync as Mock).mockImplementation((_filePath: string, contents: string) => {
          temporary = contents;
          throw new Error('temp write reached disk then failed');
        });
        (fs.renameSync as Mock).mockClear();
        mockMainWindow.setContentProtection.mockClear();

        await expect(
          handlers.get('app:setContentProtection')!(trustedIpcEvent, target)
        ).resolves.toBe(false);
        await expect(handlers.get('app:getContentProtection')!(trustedIpcEvent)).resolves.toBe(
          previous
        );
        expect(temporary).toBe(
          JSON.stringify({ enabled: target, previousEnabled: previous, staged: true })
        );
        expect(fs.renameSync).not.toHaveBeenCalled();
        expect(fs.unlinkSync).toHaveBeenCalledWith(
          expect.stringMatching(/content-protection\.json\.\d+\.tmp$/)
        );
        expect(mockMainWindow.setContentProtection).not.toHaveBeenCalled();

        (fs.readFileSync as Mock).mockImplementation((filePath: string) =>
          filePath.includes('content-protection.json')
            ? JSON.stringify({ enabled: false })
            : '{"enabled":true}'
        );
        (fs.writeFileSync as Mock).mockImplementation(() => undefined);
        (fs.renameSync as Mock).mockImplementation(() => undefined);
      }
    );

    it.each([
      { previous: false, target: true },
      { previous: true, target: false },
    ])(
      'keeps the existing authority when the staged rename fails ($previous → $target)',
      async ({ previous, target }) => {
        const fs = (await import('node:fs')).default;
        let durable = JSON.stringify({ enabled: previous });
        (fs.readFileSync as Mock).mockImplementation((filePath: string) =>
          filePath.includes('content-protection.json') ? durable : JSON.stringify({ enabled: true })
        );
        (fs.writeFileSync as Mock).mockImplementation(() => undefined);
        (fs.renameSync as Mock).mockImplementation(() => {
          throw new Error('rename failed');
        });
        mockMainWindow.setContentProtection.mockClear();

        await expect(
          handlers.get('app:setContentProtection')!(trustedIpcEvent, target)
        ).resolves.toBe(false);
        await expect(handlers.get('app:getContentProtection')!(trustedIpcEvent)).resolves.toBe(
          previous
        );
        expect(fs.unlinkSync).toHaveBeenCalledWith(
          expect.stringMatching(/content-protection\.json\.\d+\.tmp$/)
        );
        expect(mockMainWindow.setContentProtection).not.toHaveBeenCalled();

        (fs.readFileSync as Mock).mockImplementation((filePath: string) =>
          filePath.includes('content-protection.json')
            ? JSON.stringify({ enabled: false })
            : '{"enabled":true}'
        );
        (fs.renameSync as Mock).mockImplementation(() => undefined);
      }
    );

    it('applies a persisted enabled value to a new PiP before loading it', async () => {
      const fs = (await import('node:fs')).default;
      (fs.readFileSync as Mock).mockImplementation((filePath: string) =>
        filePath.includes('content-protection.json') ? '{"enabled":true}' : '{"enabled":true}'
      );
      const pip = {
        isDestroyed: vi.fn(() => false),
        setContentProtection: vi.fn(),
        webContents: makePipContents(),
        loadURL: vi.fn().mockResolvedValue(undefined),
        on: vi.fn(),
        focus: vi.fn(),
        destroy: vi.fn(),
      };
      (MockBrowserWindow as Mock).mockImplementationOnce(function () {
        return pip;
      });
      await handlers.get('pip:open')!(pipOpenerEvent, { id: 'content-protection-persisted-pip' });
      expect(pip.setContentProtection).toHaveBeenCalledWith(true);
      expect(pip.setContentProtection.mock.invocationCallOrder[0]).toBeLessThan(
        pip.loadURL.mock.invocationCallOrder[0]
      );
      // #86 RT5: close it, so this PiP does not hold a slot of the saas connection's cap
      // for the rest of the file.
      for (const [event, listener] of pip.on.mock.calls) if (event === 'closed') listener();
    });

    it('rejects an untrusted sender and non-boolean payload without side effects', async () => {
      const fs = (await import('node:fs')).default;
      (fs.writeFileSync as Mock).mockClear();
      mockMainWindow.setContentProtection.mockClear();
      await expect(handlers.get('app:setContentProtection')!(foreignIpcEvent, true)).resolves.toBe(
        false
      );
      await expect(
        handlers.get('app:setContentProtection')!(trustedIpcEvent, 'true')
      ).resolves.toBe(false);
      expect(fs.writeFileSync).not.toHaveBeenCalled();
      expect(mockMainWindow.setContentProtection).not.toHaveBeenCalled();
    });

    it('returns false on a preference write failure without native calls', async () => {
      const fs = (await import('node:fs')).default;
      (fs.writeFileSync as Mock).mockImplementation(() => {
        throw new Error('disk full');
      });
      mockMainWindow.setContentProtection.mockClear();
      await expect(handlers.get('app:setContentProtection')!(trustedIpcEvent, true)).resolves.toBe(
        false
      );
      expect(mockMainWindow.setContentProtection).not.toHaveBeenCalled();
      (fs.writeFileSync as Mock).mockImplementation(() => undefined);
    });

    it('app:getVersion returns version', async () => {
      const result = await handlers.get('app:getVersion')!(trustedIpcEvent);
      expect(result).toBe('1.0.0-test');
    });

    it('app:getPlatform returns platform', async () => {
      const result = await handlers.get('app:getPlatform')!(trustedIpcEvent);
      expect(result).toBe(process.platform);
    });

    it('app:getIpcContract returns contract version', async () => {
      const result = await handlers.get('app:getIpcContract')!(trustedIpcEvent);
      expect(result).toBe('1.0');
    });

    it('app:getSystemInfo returns system details', async () => {
      const result = (await handlers.get('app:getSystemInfo')!(trustedIpcEvent)) as Record<
        string,
        string
      >;
      expect(result).toHaveProperty('platform');
      expect(result).toHaveProperty('arch');
      expect(result).toHaveProperty('electronVersion');
      expect(result).toHaveProperty('chromiumVersion');
      expect(result).toHaveProperty('nodeVersion');
    });
  });

  describe('IPC: hardware acceleration', () => {
    it('app:getHardwareAcceleration returns current pref', async () => {
      const result = await handlers.get('app:getHardwareAcceleration')!(trustedIpcEvent);
      expect(result).toBe(true);
    });

    it('app:setHardwareAcceleration writes pref file', async () => {
      const fs = (await import('node:fs')).default;
      await handlers.get('app:setHardwareAcceleration')!(trustedIpcEvent, false);
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('hw-accel.json'),
        JSON.stringify({ enabled: false }),
        'utf-8'
      );
    });

    it('app:relaunch restarts the app', async () => {
      const { app } = await import('electron');
      await handlers.get('app:relaunch')!(probeEvent);
      expect(app.relaunch).toHaveBeenCalled();
      expect(app.quit).toHaveBeenCalled();
    });

    it.each(['app:quit', 'app:relaunch'])(
      '%s refuses a same-origin PiP sender',
      async (channel) => {
        const { app } = await import('electron');
        (app.quit as Mock).mockClear();
        (app.relaunch as Mock).mockClear();
        await handlers.get(channel)!({
          sender: {},
          senderFrame: { url: 'http://localhost:3001/', frameTreeNodeId: 77 },
        });
        expect(app.quit).not.toHaveBeenCalled();
        expect(app.relaunch).not.toHaveBeenCalled();
      }
    );

    it.each(['app:quit', 'app:relaunch'])(
      '%s rejects untrusted, subframe and missing senders',
      async (channel) => {
        const { app } = await import('electron');
        (app.quit as Mock).mockClear();
        (app.relaunch as Mock).mockClear();
        for (const event of [
          {
            sender: mockWebContents,
            senderFrame: { url: 'http://localhost:3001/', frameTreeNodeId: 999 },
          },
          {
            sender: mockWebContents,
            senderFrame: { url: 'https://evil.example/', frameTreeNodeId: 77 },
          },
          { sender: mockWebContents, senderFrame: null },
        ])
          await handlers.get(channel)!(event);
        expect(app.quit).not.toHaveBeenCalled();
        expect(app.relaunch).not.toHaveBeenCalled();
      }
    );

    it('app:quit exits the app', async () => {
      const { app } = await import('electron');
      (app.quit as Mock).mockClear();
      await handlers.get('app:quit')!(trustedIpcEvent);
      expect(app.quit).toHaveBeenCalled();
    });
  });

  describe('IPC: GPU info', () => {
    it('gpu:getInfo returns vendor and device', async () => {
      const { app } = await import('electron');
      const result = (await handlers.get('gpu:getInfo')!(trustedIpcEvent)) as {
        vendor: string;
        device: string;
        encodeProfiles: string[];
      } | null;
      expect(result).not.toBeNull();
      expect(result!.vendor).toBe('NVIDIA');
      expect(result!.device).toBe('GeForce GTX 1080');
      expect(result!.encodeProfiles).toEqual([]);
      expect(app.getGPUInfo).toHaveBeenCalledWith('complete');
    });

    it('gpu:getInfo returns null on failure', async () => {
      const { app } = await import('electron');
      (app.getGPUInfo as Mock).mockRejectedValueOnce(new Error('fail'));
      const result = await handlers.get('gpu:getInfo')!(trustedIpcEvent);
      expect(result).toBeNull();
    });
  });

  describe('IPC: screen info', () => {
    it('screen:getDisplayInfo returns display list', async () => {
      const result = (await handlers.get('screen:getDisplayInfo')!(trustedIpcEvent)) as Array<{
        width: number;
        height: number;
        refreshRate: number;
        isPrimary: boolean;
      }>;
      expect(result).toHaveLength(1);
      expect(result[0].width).toBe(3840); // 1920 * 2 (scaleFactor)
      expect(result[0].height).toBe(2160);
      expect(result[0].refreshRate).toBe(120);
      expect(result[0].isPrimary).toBe(true);
    });
  });

  describe('IPC: media & clipboard', () => {
    it('media:getDesktopSources returns source list', async () => {
      const result = (await handlers.get('media:getDesktopSources')!(trustedIpcEvent)) as Array<{
        id: string;
        name: string;
        thumbnail: string;
      }>;
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('screen:1');
      expect(result[0].name).toBe('Screen 1');
      expect(result[0].thumbnail).toContain('data:image');
    });

    it('clipboard:writeText refuses a same-origin PiP sender', async () => {
      const { clipboard } = await import('electron');
      (clipboard.writeText as Mock).mockClear();
      await expect(
        Promise.resolve().then(() =>
          handlers.get('clipboard:writeText')!(
            { sender: {}, senderFrame: { url: 'http://localhost:3001/', frameTreeNodeId: 77 } },
            'synthetic'
          )
        )
      ).rejects.toThrow('Clipboard write denied');
      expect(clipboard.writeText).not.toHaveBeenCalled();
    });

    it('clipboard:writeText rejects subframes and invalid data', async () => {
      const { clipboard } = await import('electron');
      (clipboard.writeText as Mock).mockClear();
      for (const [event, text] of [
        [
          {
            sender: mockWebContents,
            senderFrame: { url: 'http://localhost:3001/', frameTreeNodeId: 999 },
          },
          'text',
        ],
        [probeEvent, { value: 'text' }],
      ])
        await expect(
          Promise.resolve().then(() => handlers.get('clipboard:writeText')!(event, text))
        ).rejects.toThrow('Clipboard write denied');
      expect(clipboard.writeText).not.toHaveBeenCalled();
    });

    it('propagates a native clipboard rejection instead of reporting success', async () => {
      const { clipboard } = await import('electron');
      (clipboard.writeText as Mock).mockImplementationOnce(() => {
        throw new Error('synthetic failure');
      });
      await expect(
        Promise.resolve().then(() => handlers.get('clipboard:writeText')!(probeEvent, 'text'))
      ).rejects.toThrow('synthetic failure');
    });

    it('allows empty and Unicode strings for the live main frame', async () => {
      const { clipboard } = await import('electron');
      (clipboard.writeText as Mock).mockClear();
      await handlers.get('clipboard:writeText')!(probeEvent, '');
      await handlers.get('clipboard:writeText')!(probeEvent, 'Grüße 🌍');
      expect(clipboard.writeText).toHaveBeenNthCalledWith(1, '');
      expect(clipboard.writeText).toHaveBeenNthCalledWith(2, 'Grüße 🌍');
    });

    it('clipboard:writeText writes to clipboard', async () => {
      const { clipboard } = await import('electron');
      await handlers.get('clipboard:writeText')!(probeEvent, 'hello');
      expect(clipboard.writeText).toHaveBeenCalledWith('hello');
    });
  });

  describe('IPC: auth (tokenManager passthrough)', () => {
    it('auth:storeRefreshToken stores token and sets update feed', async () => {
      const { storeRefreshToken } = await import('../../../src/main/tokenManager');
      const { setUpdateFeedUrl } = await import('../../../src/main/updater');
      const data = { refreshToken: 'tok', rememberMe: true, apiBase: 'http://localhost:8080' };
      const result = await handlers.get('auth:storeRefreshToken')!(trustedIpcEvent, data);
      expect(result).toBe(41);
      expect(storeRefreshToken).toHaveBeenCalledWith(data);
      expect(setUpdateFeedUrl).toHaveBeenCalledWith('http://localhost:8080');
    });

    // #86 Task 9: serverUserId is renderer-supplied and is only ever input to the hash.
    it('auth:storeRefreshToken passes a valid serverUserId through to the custody', async () => {
      const { storeRefreshToken } = await import('../../../src/main/tokenManager');
      (storeRefreshToken as Mock).mockClear();
      const data = {
        refreshToken: 'tok',
        rememberMe: true,
        apiBase: 'http://localhost:8080',
        serverUserId: 'user-123',
      };
      const result = await handlers.get('auth:storeRefreshToken')!(trustedIpcEvent, data);
      expect(result).toBe(41);
      expect(storeRefreshToken).toHaveBeenCalledWith(data);
    });

    it.each([
      ['empty', ''],
      ['too long', 'x'.repeat(257)],
      ['control character', 'user\u0001id'],
      ['NUL', 'user\0id'],
      ['newline', 'user\nid'],
      ['not a string', 42],
      ['object', { id: 'u' }],
    ])('auth:storeRefreshToken rejects a serverUserId that is %s', async (_label, serverUserId) => {
      const { storeRefreshToken } = await import('../../../src/main/tokenManager');
      (storeRefreshToken as Mock).mockClear();
      const result = await handlers.get('auth:storeRefreshToken')!(trustedIpcEvent, {
        refreshToken: 'tok',
        rememberMe: true,
        apiBase: 'http://localhost:8080',
        serverUserId,
      });
      expect(result).toEqual({ status: 'rejected' });
      expect(storeRefreshToken).not.toHaveBeenCalled();
    });

    it('auth:storeRefreshToken never logs the serverUserId in clear', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      await handlers.get('auth:storeRefreshToken')!(trustedIpcEvent, {
        refreshToken: 'tok',
        rememberMe: true,
        apiBase: 'http://localhost:8080',
        serverUserId: 'secret-user\u0001',
      });
      const logged = JSON.stringify([...warn.mock.calls, ...log.mock.calls]);
      expect(logged).not.toContain('secret-user');
      warn.mockRestore();
      log.mockRestore();
    });

    it('auth:storeRefreshToken rejects untrusted sender frames', async () => {
      const { storeRefreshToken } = await import('../../../src/main/tokenManager');
      (storeRefreshToken as Mock).mockClear();
      const result = await handlers.get('auth:storeRefreshToken')!(
        { senderFrame: { url: 'https://evil.example/' } },
        { refreshToken: 'tok', rememberMe: true, apiBase: 'http://localhost:8080' }
      );
      expect(result).toEqual({ status: 'rejected', reason: 'untrusted-sender' });
      expect(storeRefreshToken).not.toHaveBeenCalled();
    });

    // #86 Task 7B ruling (DEV-BUILD ORIGIN): an unpackaged build's saas origin is the dev
    // base main pinned at startup. The test above stores against it; every other origin,
    // production included, names a different service and is refused before custody.
    it.each(['https://api.concordvoice.chat', 'http://localhost:8081', 'https://evil.example'])(
      'auth:storeRefreshToken from the unpackaged saas view refuses %s',
      async (apiBase) => {
        const { storeRefreshToken } = await import('../../../src/main/tokenManager');
        const { setUpdateFeedUrl } = await import('../../../src/main/updater');
        (storeRefreshToken as Mock).mockClear();
        (setUpdateFeedUrl as Mock).mockClear();
        const result = await handlers.get('auth:storeRefreshToken')!(trustedIpcEvent, {
          refreshToken: 'tok',
          rememberMe: true,
          apiBase,
        });
        expect(result).toEqual({ status: 'rejected', reason: 'wrong-owner' });
        expect(storeRefreshToken).not.toHaveBeenCalled();
        expect(setUpdateFeedUrl).not.toHaveBeenCalled();
      }
    );

    it('auth:storeRefreshToken rejects malformed payloads', async () => {
      const { storeRefreshToken } = await import('../../../src/main/tokenManager');
      const { setUpdateFeedUrl } = await import('../../../src/main/updater');
      (storeRefreshToken as Mock).mockClear();
      (setUpdateFeedUrl as Mock).mockClear();

      const result = await handlers.get('auth:storeRefreshToken')!(trustedIpcEvent, {
        refreshToken: 'tok',
        rememberMe: true,
        apiBase: 'javascript:alert(1)',
      });

      // #86 D3: its origin is 'null', which names no service, so the cross-check refuses it.
      expect(result).toEqual({ status: 'rejected', reason: 'wrong-owner' });
      expect(storeRefreshToken).not.toHaveBeenCalled();
      expect(setUpdateFeedUrl).not.toHaveBeenCalled();
    });

    it.each([
      ['an oversized refresh token', { refreshToken: 'r'.repeat(8193) }],
      ['an oversized access token', { refreshToken: 'tok', accessToken: 'a'.repeat(8193) }],
    ])('auth:storeRefreshToken rejects %s', async (_label, fields) => {
      const { storeRefreshToken } = await import('../../../src/main/tokenManager');
      (storeRefreshToken as Mock).mockClear();

      const result = await handlers.get('auth:storeRefreshToken')!(trustedIpcEvent, {
        rememberMe: true,
        apiBase: SAAS_DEV_API_BASE,
        ...fields,
      });

      expect(result).toEqual({ status: 'rejected' });
      expect(storeRefreshToken).not.toHaveBeenCalled();
    });

    it('auth:storeRefreshToken accepts a token at the size cap', async () => {
      const { storeRefreshToken } = await import('../../../src/main/tokenManager');
      (storeRefreshToken as Mock).mockClear();

      await handlers.get('auth:storeRefreshToken')!(trustedIpcEvent, {
        refreshToken: 'r'.repeat(8192),
        rememberMe: true,
        apiBase: SAAS_DEV_API_BASE,
      });

      expect(storeRefreshToken).toHaveBeenCalledTimes(1);
    });

    it('auth:storeRefreshToken rejects unvalidated non-SaaS apiBase values in packaged builds (#1872)', async () => {
      const { storeRefreshToken } = await import('../../../src/main/tokenManager');
      const { setUpdateFeedUrl } = await import('../../../src/main/updater');
      const electron = await import('electron');
      // Same object main.ts holds (destructured from the mocked module); flipping
      // it exercises the isPackaged-gated host pin in isValidApiBase.
      const app = electron.app as unknown as { isPackaged: boolean };
      (storeRefreshToken as Mock).mockClear();
      (setUpdateFeedUrl as Mock).mockClear();

      app.isPackaged = true;
      try {
        // Attacker host rejected even with a trusted frame + well-formed https URL.
        const evil = await handlers.get('auth:storeRefreshToken')!(trustedIpcEvent, {
          refreshToken: 'tok',
          rememberMe: true,
          apiBase: 'https://evil.example',
        });
        // #86 D3: refused as naming another service before the payload guard runs.
        expect(evil).toEqual({ status: 'rejected', reason: 'wrong-owner' });
        expect(storeRefreshToken).not.toHaveBeenCalled();
        expect(setUpdateFeedUrl).not.toHaveBeenCalled();
        // A packaged build accepting production is pinned where the origin is decided:
        // apiBaseUrl.test.ts ("a packaged build pins production ..."). This fixture's
        // saas origin was fixed unpackaged at startup, and flipping isPackaged now
        // cannot move it.
      } finally {
        app.isPackaged = false;
      }
    });

    // #86 D3 re-point: before #86 the one global custody stored whatever validated
    // origin the renderer named. Now the saas view's custody is saas's alone, so a
    // validated self-hosted origin from it names a different service and is refused.
    it('auth:storeRefreshToken refuses a validated self-hosted apiBase from the saas view (#86 D3)', async () => {
      const { storeRefreshToken } = await import('../../../src/main/tokenManager');
      const { setUpdateFeedUrl } = await import('../../../src/main/updater');
      const { _resetSelfHostedProfileForTesting, commitSelfHostedApproval } =
        await import('../../../src/main/selfHostedProfile');
      const electron = await import('electron');
      const app = electron.app as unknown as { isPackaged: boolean };
      (storeRefreshToken as Mock).mockClear();
      (setUpdateFeedUrl as Mock).mockClear();
      _resetSelfHostedProfileForTesting();
      commitSelfHostedApproval('https://homelab.lan/setup', '10.0.0.5');

      app.isPackaged = true;
      try {
        const data = {
          refreshToken: 'tok',
          rememberMe: true,
          apiBase: 'https://homelab.lan',
        };
        const result = await handlers.get('auth:storeRefreshToken')!(trustedIpcEvent, data);
        expect(result).toEqual({ status: 'rejected', reason: 'wrong-owner' });
        expect(storeRefreshToken).not.toHaveBeenCalled();
        expect(setUpdateFeedUrl).not.toHaveBeenCalled();
      } finally {
        app.isPackaged = false;
        _resetSelfHostedProfileForTesting();
      }
    });

    it('auth:restoreSession restores and refreshes token', async () => {
      const result = (await handlers.get('auth:restoreSession')!(trustedIpcEvent)) as {
        status: string;
        accessToken?: string;
        rememberMe?: boolean;
      };
      expect(result.status).toBe('restored');
      expect(result.accessToken).toBe('mock-access');
      expect(result.rememberMe).toBe(true);
      expect(result).toMatchObject({ credentialOwner: 41, pendingE2EEUnlock: false });
    });

    it('auth:restoreSession reports owner-bound E2EE custody as pending', async () => {
      const { getCredentialCustodyState, restoreE2EEKeys } =
        await import('../../../src/main/tokenManager');
      (restoreE2EEKeys as Mock).mockResolvedValueOnce(null);
      (getCredentialCustodyState as Mock)
        .mockReturnValueOnce({ credentialOwner: 41, pendingE2EEUnlock: true })
        .mockReturnValueOnce({ credentialOwner: 41, pendingE2EEUnlock: true })
        .mockReturnValueOnce({ credentialOwner: 41, pendingE2EEUnlock: true });

      const result = await handlers.get('auth:restoreSession')!(trustedIpcEvent);

      expect(result).toMatchObject({
        status: 'restored',
        accessToken: 'mock-access',
        credentialOwner: 41,
        pendingE2EEUnlock: true,
        e2eeKeys: null,
      });
    });

    it('auth:restoreSession never pairs an old refresh result with successor E2EE custody', async () => {
      const { getCredentialCustodyState, restoreE2EEKeys } =
        await import('../../../src/main/tokenManager');
      (getCredentialCustodyState as Mock)
        .mockReturnValueOnce({ credentialOwner: 41, pendingE2EEUnlock: true })
        .mockReturnValueOnce({ credentialOwner: 42, pendingE2EEUnlock: false });
      (restoreE2EEKeys as Mock).mockClear();

      const result = await handlers.get('auth:restoreSession')!(trustedIpcEvent);

      expect(result).toEqual({ status: 'refresh_failed' });
      expect(restoreE2EEKeys).not.toHaveBeenCalled();
    });

    it('auth:restoreSession refuses keys when a login lands during the key restore', async () => {
      const { getCredentialCustodyState, restoreE2EEKeys } =
        await import('../../../src/main/tokenManager');
      (restoreE2EEKeys as Mock).mockClear();
      // Owner read at restore, re-checked after the refresh, then after the
      // restoreE2EEKeys await: a login inside that await changes the third read.
      (getCredentialCustodyState as Mock)
        .mockReturnValueOnce({ credentialOwner: 41, pendingE2EEUnlock: true })
        .mockReturnValueOnce({ credentialOwner: 41, pendingE2EEUnlock: true })
        .mockReturnValueOnce({ credentialOwner: 42, pendingE2EEUnlock: false });

      const result = await handlers.get('auth:restoreSession')!(trustedIpcEvent);

      expect(restoreE2EEKeys).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ status: 'refresh_failed' });
    });

    it('auth:restoreSession stops at a tampered token without refreshing', async () => {
      const { restoreRefreshToken, performRefresh } =
        await import('../../../src/main/tokenManager');
      (performRefresh as Mock).mockClear();
      (restoreRefreshToken as Mock).mockResolvedValueOnce({ status: 'tampered' });

      const result = await handlers.get('auth:restoreSession')!(trustedIpcEvent);

      expect(result).toEqual({ status: 'tampered' });
      expect(performRefresh).not.toHaveBeenCalled();
    });

    it('auth:restoreSession returns rememberMe=false for memory-only sessions', async () => {
      const { restoreRefreshToken } = await import('../../../src/main/tokenManager');
      (restoreRefreshToken as Mock).mockResolvedValueOnce({
        status: 'ok',
        token: 'memory-token',
        apiBase: 'http://localhost:8080',
        rememberMe: false,
      });

      const result = (await handlers.get('auth:restoreSession')!(trustedIpcEvent)) as {
        status: string;
        rememberMe?: boolean;
      };

      expect(result.status).toBe('restored');
      expect(result.rememberMe).toBe(false);
    });

    it('auth:restoreSession clears single-flight cache after the restore settles', async () => {
      const { restoreRefreshToken, performRefresh } =
        await import('../../../src/main/tokenManager');
      (restoreRefreshToken as Mock).mockClear();
      (performRefresh as Mock).mockClear();

      const event = trustedIpcEvent;
      await handlers.get('auth:restoreSession')!(event);
      await handlers.get('auth:restoreSession')!(event);

      expect(restoreRefreshToken).toHaveBeenCalledTimes(2);
      expect(performRefresh).toHaveBeenCalledTimes(2);
    });

    it('auth:restoreSession rejects untrusted sender frames', async () => {
      const { restoreRefreshToken } = await import('../../../src/main/tokenManager');
      (restoreRefreshToken as Mock).mockClear();
      const result = await handlers.get('auth:restoreSession')!({
        senderFrame: { url: 'https://evil.example/' },
      });
      expect(result).toEqual({ status: 'rejected', reason: 'untrusted-sender' });
      expect(restoreRefreshToken).not.toHaveBeenCalled();
    });

    it('auth:storeE2EEKeys stores keys', async () => {
      const { storeE2EEKeys } = await import('../../../src/main/tokenManager');
      const data = {
        wrappingKeyBase64: 'a',
        preferencesKeyBase64: 'b',
        wrappedPrivateKeyBase64: 'c',
      };
      await handlers.get('auth:storeE2EEKeys')!(trustedIpcEvent, data);
      expect(storeE2EEKeys).toHaveBeenCalledWith(data);
    });

    it('auth:storeE2EEKeys rejects untrusted sender frames', async () => {
      const { storeE2EEKeys } = await import('../../../src/main/tokenManager');
      (storeE2EEKeys as Mock).mockClear();
      const result = await handlers.get('auth:storeE2EEKeys')!(
        { senderFrame: { url: 'https://evil.example/' } },
        { wrappingKeyBase64: 'a', preferencesKeyBase64: 'b', wrappedPrivateKeyBase64: 'c' }
      );
      expect(result).toEqual({ status: 'rejected', reason: 'untrusted-sender' });
      expect(storeE2EEKeys).not.toHaveBeenCalled();
    });

    it('auth:storeE2EEKeys rejects malformed payloads', async () => {
      const { storeE2EEKeys } = await import('../../../src/main/tokenManager');
      (storeE2EEKeys as Mock).mockClear();

      const result = await handlers.get('auth:storeE2EEKeys')!(trustedIpcEvent, {
        wrappingKeyBase64: 'a',
        preferencesKeyBase64: 42,
        wrappedPrivateKeyBase64: 'c',
      });

      expect(result).toEqual({ status: 'rejected' });
      expect(storeE2EEKeys).not.toHaveBeenCalled();
    });

    it('auth:storeE2EEKeysIfOwner delegates an owner-scoped key write', async () => {
      const { storeE2EEKeysIfOwner } = await import('../../../src/main/tokenManager');
      const data = {
        wrappingKeyBase64: 'a',
        preferencesKeyBase64: 'b',
        wrappedPrivateKeyBase64: 'c',
      };

      const result = await handlers.get('auth:storeE2EEKeysIfOwner')!(trustedIpcEvent, data, 41);

      expect(result).toBe(true);
      expect(storeE2EEKeysIfOwner).toHaveBeenCalledWith(data, 41);
    });

    it.each([
      ['wrappingKeyBase64', 1025],
      ['preferencesKeyBase64', 1025],
      ['wrappedPrivateKeyBase64', 16_385],
    ])('auth:storeE2EEKeysIfOwner rejects an oversized %s', async (field, length) => {
      const { storeE2EEKeysIfOwner } = await import('../../../src/main/tokenManager');
      (storeE2EEKeysIfOwner as Mock).mockClear();
      const data = {
        wrappingKeyBase64: 'a',
        preferencesKeyBase64: 'b',
        wrappedPrivateKeyBase64: 'c',
        [field]: 'k'.repeat(length),
      };

      const result = await handlers.get('auth:storeE2EEKeysIfOwner')!(trustedIpcEvent, data, 41);

      expect(result).toEqual({ status: 'rejected' });
      expect(storeE2EEKeysIfOwner).not.toHaveBeenCalled();
    });

    it('auth:storeE2EEKeysIfOwner accepts keys at the size caps', async () => {
      const { storeE2EEKeysIfOwner } = await import('../../../src/main/tokenManager');
      (storeE2EEKeysIfOwner as Mock).mockClear();

      await handlers.get('auth:storeE2EEKeysIfOwner')!(
        trustedIpcEvent,
        {
          wrappingKeyBase64: 'k'.repeat(1024),
          preferencesKeyBase64: 'k'.repeat(1024),
          wrappedPrivateKeyBase64: 'k'.repeat(16_384),
        },
        41
      );

      expect(storeE2EEKeysIfOwner).toHaveBeenCalledTimes(1);
    });

    it('auth:storeE2EEKeysIfOwner rejects invalid owners', async () => {
      const { storeE2EEKeysIfOwner } = await import('../../../src/main/tokenManager');
      (storeE2EEKeysIfOwner as Mock).mockClear();

      const result = await handlers.get('auth:storeE2EEKeysIfOwner')!(
        trustedIpcEvent,
        {
          wrappingKeyBase64: 'a',
          preferencesKeyBase64: 'b',
          wrappedPrivateKeyBase64: 'c',
        },
        0
      );

      expect(result).toEqual({ status: 'rejected' });
      expect(storeE2EEKeysIfOwner).not.toHaveBeenCalled();
    });

    it('auth:storeE2EEKeysIfOwner rejects untrusted sender frames', async () => {
      const { storeE2EEKeysIfOwner } = await import('../../../src/main/tokenManager');
      (storeE2EEKeysIfOwner as Mock).mockClear();

      const result = await handlers.get('auth:storeE2EEKeysIfOwner')!(
        { senderFrame: { url: 'https://evil.example/' } },
        {
          wrappingKeyBase64: 'a',
          preferencesKeyBase64: 'b',
          wrappedPrivateKeyBase64: 'c',
        },
        41
      );

      expect(result).toEqual({ status: 'rejected', reason: 'untrusted-sender' });
      expect(storeE2EEKeysIfOwner).not.toHaveBeenCalled();
    });

    it('auth:refreshToken delegates to performRefresh', async () => {
      const result = (await handlers.get('auth:refreshToken')!(trustedIpcEvent)) as {
        status: string;
      };
      expect(result.status).toBe('ok');
    });

    it('auth:refreshToken rejects untrusted sender frames', async () => {
      const { performRefresh } = await import('../../../src/main/tokenManager');
      (performRefresh as Mock).mockClear();
      const result = await handlers.get('auth:refreshToken')!({
        senderFrame: { url: 'https://evil.example/' },
      });
      expect(result).toEqual({ status: 'rejected', reason: 'untrusted-sender' });
      expect(performRefresh).not.toHaveBeenCalled();
    });

    it('auth:logout delegates to performLogout', async () => {
      const { performLogout } = await import('../../../src/main/tokenManager');
      await handlers.get('auth:logout')!(trustedIpcEvent, { accessToken: 'tok' });
      expect(performLogout).toHaveBeenCalledWith('tok');
    });

    it('auth:logout rejects untrusted sender frames', async () => {
      const { performLogout } = await import('../../../src/main/tokenManager');
      (performLogout as Mock).mockClear();
      const result = await handlers.get('auth:logout')!(
        { senderFrame: { url: 'https://evil.example/' } },
        { accessToken: 'tok' }
      );
      expect(result).toEqual({ status: 'rejected', reason: 'untrusted-sender' });
      expect(performLogout).not.toHaveBeenCalled();
    });

    it('auth:logout rejects malformed payloads', async () => {
      const { performLogout } = await import('../../../src/main/tokenManager');
      (performLogout as Mock).mockClear();
      const result = await handlers.get('auth:logout')!(trustedIpcEvent, { accessToken: 42 });
      expect(result).toEqual({ status: 'rejected' });
      expect(performLogout).not.toHaveBeenCalled();
    });

    it('auth:clearTokens delegates to clearTokens', async () => {
      const { clearTokens } = await import('../../../src/main/tokenManager');
      await handlers.get('auth:clearTokens')!(trustedIpcEvent);
      expect(clearTokens).toHaveBeenCalled();
    });

    it('auth:clearTokens rejects untrusted sender frames', async () => {
      const { clearTokens } = await import('../../../src/main/tokenManager');
      (clearTokens as Mock).mockClear();
      const result = await handlers.get('auth:clearTokens')!({
        senderFrame: { url: 'https://evil.example/' },
      });
      expect(result).toEqual({ status: 'rejected', reason: 'untrusted-sender' });
      expect(clearTokens).not.toHaveBeenCalled();
    });

    it('auth:clearTokensIfOwner delegates conditional credential clearing', async () => {
      const { clearTokensIfOwner } = await import('../../../src/main/tokenManager');

      const cleared = await handlers.get('auth:clearTokensIfOwner')!(trustedIpcEvent, 41);
      const preserved = await handlers.get('auth:clearTokensIfOwner')!(trustedIpcEvent, 40);

      expect(cleared).toBe(true);
      expect(preserved).toBe(false);
      expect(clearTokensIfOwner).toHaveBeenNthCalledWith(1, 41);
      expect(clearTokensIfOwner).toHaveBeenNthCalledWith(2, 40);
    });

    it('auth:clearTokensIfOwner rejects invalid owners', async () => {
      const { clearTokensIfOwner } = await import('../../../src/main/tokenManager');
      (clearTokensIfOwner as Mock).mockClear();

      const result = await handlers.get('auth:clearTokensIfOwner')!(trustedIpcEvent, Number.NaN);

      expect(result).toEqual({ status: 'rejected' });
      expect(clearTokensIfOwner).not.toHaveBeenCalled();
    });

    it('auth:clearTokensIfOwner rejects untrusted sender frames', async () => {
      const { clearTokensIfOwner } = await import('../../../src/main/tokenManager');
      (clearTokensIfOwner as Mock).mockClear();

      const result = await handlers.get('auth:clearTokensIfOwner')!(
        { senderFrame: { url: 'https://evil.example/' } },
        41
      );

      expect(result).toEqual({ status: 'rejected', reason: 'untrusted-sender' });
      expect(clearTokensIfOwner).not.toHaveBeenCalled();
    });

    it('auth:getCapabilities returns capabilities for a trusted sender', async () => {
      const result = (await handlers.get('auth:getCapabilities')!(trustedIpcEvent)) as {
        safeStorage: boolean;
      };
      expect(result.safeStorage).toBe(true);
    });

    it('auth:getCapabilities rejects untrusted sender frames (fails closed)', async () => {
      const result = await handlers.get('auth:getCapabilities')!({
        senderFrame: { url: 'https://evil.example/' },
      });
      expect(result).toEqual({ persistAvailable: false });
    });

    it('auth:getMachineId returns machine id', async () => {
      const { getMachineId } = await import('../../../src/main/machineId');
      const result = await handlers.get('auth:getMachineId')!(trustedIpcEvent);
      expect(result).toBe('mock-machine-id');
      // #86: the id is per service, always the sender's own (#1618).
      expect(getMachineId).toHaveBeenCalledWith(SAAS_DEV_API_BASE);
    });

    it('auth:getMachineId admits the saas view naming its own dev origin', async () => {
      const { getMachineId } = await import('../../../src/main/machineId');
      (getMachineId as Mock).mockClear();
      const result = await handlers.get('auth:getMachineId')!(trustedIpcEvent, SAAS_DEV_API_BASE);
      expect(result).toBe('mock-machine-id');
      expect(getMachineId).toHaveBeenCalledWith(SAAS_DEV_API_BASE);
    });

    // #86 D3 re-point: a validated self-hosted origin named from the saas view is another
    // service's, so it is refused before any id is read or minted.
    it('auth:getMachineId refuses a validated self-hosted apiBase from the saas view (#86 D3)', async () => {
      const { getMachineId } = await import('../../../src/main/machineId');
      const { commitSelfHostedApproval } = await import('../../../src/main/selfHostedProfile');
      (getMachineId as Mock).mockClear();
      commitSelfHostedApproval('https://homelab.lan', '10.0.0.5');

      const result = await handlers.get('auth:getMachineId')!(
        trustedIpcEvent,
        'https://homelab.lan'
      );

      expect(result).toBe('');
      expect(getMachineId).not.toHaveBeenCalled();
    });

    it('auth:getMachineId rejects untrusted sender frames', async () => {
      const result = await handlers.get('auth:getMachineId')!({
        senderFrame: { url: 'https://evil.example/' },
      });
      expect(result).toBe('');
    });

    it('selfHosted:probeServer delegates for trusted sender frames', async () => {
      const { probeSelfHostedServer } = await import('../../../src/main/selfHostedProbe');
      (probeSelfHostedServer as Mock).mockResolvedValueOnce({
        status: 'ok',
        apiBase: 'https://homelab.lan',
        clientConfig: {},
        capabilities: {},
      });

      // #86 7B: the probed origin is the sender's own service (see bindSelfHostedPrimary).
      const homelab = bindSelfHostedPrimary('https://homelab.lan', { foreground: true });
      try {
        const result = await handlers.get('selfHosted:probeServer')!(
          homelab.event,
          'https://homelab.lan'
        );

        expect(result).toEqual({
          status: 'ok',
          apiBase: 'https://homelab.lan',
          clientConfig: {},
          capabilities: {},
        });
        expect(probeSelfHostedServer).toHaveBeenCalledWith('https://homelab.lan');
      } finally {
        homelab.dispose();
      }
    });

    it('selfHosted:probeServer rejects an event carrying no sender id (Gitar, #2668)', async () => {
      // The single-flight key was `event.sender?.id ?? -1`, which collapsed every
      // sender-less event onto ONE bucket — unrelated frames would then refuse each
      // other's probes as 'busy'. Fail closed instead, and with 'rejected' rather than
      // 'busy': 'busy' advertises a transient state the caller should retry, and this
      // is not transient. Electron always populates `sender` for ipcMain.handle today;
      // this guards the refactor or harness where it does not.
      const { probeSelfHostedServer } = await import('../../../src/main/selfHostedProbe');
      (probeSelfHostedServer as Mock).mockClear();
      // #86: no sender means no binding, so admission refuses it before the handler.
      const result = await handlers.get('selfHosted:probeServer')!(
        { senderFrame: { url: 'app://concord/index.html' } },
        'https://real.lan'
      );
      expect(result).toEqual({
        status: 'error',
        code: 'rejected',
        message: 'Self-hosted server probing is not available from this frame.',
      });
      // Refused before any side effect: no probe, no ceremony.
      expect(probeSelfHostedServer).not.toHaveBeenCalled();
    });

    it('selfHosted:probeServer rejects another permitted window', async () => {
      const { probeSelfHostedServer } = await import('../../../src/main/selfHostedProbe');
      (probeSelfHostedServer as Mock).mockClear();
      const result = await handlers.get('selfHosted:probeServer')!(
        {
          sender: { id: 600 },
          senderFrame: { url: 'app://concord/index.html', frameTreeNodeId: 600 },
        },
        'https://homelab.lan'
      );
      expect(result).toEqual({
        status: 'error',
        code: 'rejected',
        message: 'Self-hosted server probing is not available from this frame.',
      });
      expect(probeSelfHostedServer).not.toHaveBeenCalled();
    });

    it('selfHosted:probeServer rejects a same-origin subframe', async () => {
      const { probeSelfHostedServer } = await import('../../../src/main/selfHostedProbe');
      (probeSelfHostedServer as Mock).mockClear();
      const result = await handlers.get('selfHosted:probeServer')!(
        {
          sender: mockWebContents,
          senderFrame: { url: mockWebContents.mainFrame.url, frameTreeNodeId: 999 },
        },
        'https://homelab.lan'
      );
      expect(result).toEqual({
        status: 'error',
        code: 'rejected',
        message: 'Self-hosted server probing is not available from this frame.',
      });
      expect(probeSelfHostedServer).not.toHaveBeenCalled();
    });

    it('selfHosted:probeServer rejects untrusted sender frames', async () => {
      const { probeSelfHostedServer } = await import('../../../src/main/selfHostedProbe');
      (probeSelfHostedServer as Mock).mockClear();

      const result = await handlers.get('selfHosted:probeServer')!(
        { senderFrame: { url: 'https://evil.example/' } },
        'https://homelab.lan'
      );

      expect(result).toEqual({
        status: 'error',
        code: 'rejected',
        message: 'Self-hosted server probing is not available from this frame.',
      });
      expect(probeSelfHostedServer).not.toHaveBeenCalled();
    });
  });

  describe('approval dialog copy (#2354)', () => {
    // The §8.4 forbidden-vocabulary list is scoped to RENDERER-visible strings. The
    // `resolve` stem is deliberately NOT asserted here: §7.2 mandates this native
    // dialog's copy verbatim, and that copy carries the `Resolves to:` label.
    const FORBIDDEN = [
      'DNS',
      'lookup',
      'denylist',
      'blocklist',
      'tier',
      'CIDR',
      'RFC1918',
      'private network',
      'loopback',
      'origin',
      'IPC',
      'SSRF',
      'socket',
      'agent',
      'redirect hop',
    ];

    it('renders the loopback variant with identical weight and no softening', async () => {
      const { buildApprovalDialogCopy } = await import('../../../src/main/main');
      const { classifyAddress } = await import('../../../src/main/egressPolicy');
      const { message, detail } = buildApprovalDialogCopy({
        host: 'concord.lan',
        address: '127.0.0.1',
        decision: classifyAddress('127.0.0.1'),
      });
      expect(message).toContain('Trust concord.lan?');
      expect(detail).toContain('Host:         concord.lan');
      expect(detail).toContain('127.0.0.1, on this device');
      expect(detail).toContain('store your sign-in on this device');
      expect(detail).toContain('Concord Voice will remember this choice on this device.');
      expect(detail).not.toContain('You will not be asked again');
    });

    it('renders the LAN / CGNAT / public suffixes', async () => {
      const { buildApprovalDialogCopy } = await import('../../../src/main/main');
      const { classifyAddress } = await import('../../../src/main/egressPolicy');
      expect(
        buildApprovalDialogCopy({
          host: 'a',
          address: '10.0.0.5',
          decision: classifyAddress('10.0.0.5'),
        }).detail
      ).toContain('10.0.0.5, on your network');
      expect(
        buildApprovalDialogCopy({
          host: 'a',
          address: '100.64.0.1',
          decision: classifyAddress('100.64.0.1'),
        }).detail
      ).toContain("100.64.0.1, on your provider's network");
      expect(
        buildApprovalDialogCopy({
          host: 'a',
          address: '93.184.216.34',
          decision: classifyAddress('93.184.216.34'),
        }).detail
      ).toContain('93.184.216.34, on the internet');
    });

    it('uses no forbidden mechanism vocabulary and never decodes punycode', async () => {
      const { buildApprovalDialogCopy } = await import('../../../src/main/main');
      const { classifyAddress } = await import('../../../src/main/egressPolicy');
      const { message, detail } = buildApprovalDialogCopy({
        host: 'xn--bcher-kva.example',
        address: '203.0.113.4',
        decision: classifyAddress('203.0.113.4'),
      });
      const text = `${message}\n${detail}`.toLowerCase();
      for (const word of FORBIDDEN) expect(text).not.toContain(word.toLowerCase());
      expect(detail).toContain('xn--bcher-kva.example'); // punycode preserved verbatim
    });
  });

  // Every assertion here locks #14a — "main introduces no trigger of its own" — and only
  // that. None of them measures renderer-side anchoring, which ADR-0035 § "Non-property
  // #14b" records as a property this design does not have.
  describe('#14a — main introduces no ceremony trigger of its own (#2354)', () => {
    it('shows no dialog at module import or main init (no startup/revalidation trigger)', () => {
      // Captured immediately after the import in beforeAll, so this cannot be
      // satisfied or broken by test-execution order.
      expect(dialogCallsAfterImport).toBe(0);
    });

    it('refuses a tier-1 address with no dialog and no probe', async () => {
      const { probeSelfHostedServer } = await import('../../../src/main/selfHostedProbe');
      const { _resetSelfHostedProfileForTesting } =
        await import('../../../src/main/selfHostedProfile');
      _resetSelfHostedProfileForTesting();
      approvalStore.records.length = 0;
      (probeSelfHostedServer as Mock).mockClear();
      mockShowMessageBox.mockClear();
      mockResolveForDisplay.mockResolvedValueOnce({
        ok: false,
        kind: 'tier1',
        reason: 'metadata_link_local',
      } as never);

      const result = await handlers.get('selfHosted:probeServer')!(
        trustedIpcEvent,
        'https://metadata.invalid'
      );

      expect(result).toEqual({
        status: 'error',
        code: 'address_not_allowed',
        message: 'metadata_link_local',
      });
      expect(mockShowMessageBox).not.toHaveBeenCalled();
      expect(probeSelfHostedServer).not.toHaveBeenCalled();
    });

    it('declining the ceremony mints nothing and never probes', async () => {
      const { probeSelfHostedServer } = await import('../../../src/main/selfHostedProbe');
      const { _resetSelfHostedProfileForTesting, isValidatedSelfHostedApiBase } =
        await import('../../../src/main/selfHostedProfile');
      _resetSelfHostedProfileForTesting();
      approvalStore.records.length = 0;
      (probeSelfHostedServer as Mock).mockClear();
      mockShowMessageBox.mockClear();
      mockShowMessageBox.mockResolvedValueOnce({ response: 0 });

      const result = await handlers.get('selfHosted:probeServer')!(
        trustedIpcEvent,
        'https://declined.lan'
      );

      expect(result).toEqual({
        status: 'error',
        code: 'approval_declined',
        message: 'Connection cancelled.',
      });
      expect(mockShowMessageBox).toHaveBeenCalledTimes(1);
      expect(probeSelfHostedServer).not.toHaveBeenCalled();
      expect(isValidatedSelfHostedApiBase('https://declined.lan')).toBe(false);
      expect(approvalStore.records).toHaveLength(0);
    });

    // Consent alone used to mint the durable grant, so EVERY post-consent failure — a
    // non-Concord server, TLS, ECONNREFUSED, HTTP 500, an oversized body — left the origin
    // permanently in the approved set and the approvals file, gating auth:storeRefreshToken
    // and the SSO exchange with no in-app revocation. A compromised renderer only needed the
    // user to approve some origin once; it never had to make that origin behave like Concord.
    it('a probe that fails after consent mints nothing durable (#2354 review item 3)', async () => {
      const { probeSelfHostedServer } = await import('../../../src/main/selfHostedProbe');
      const { _resetSelfHostedProfileForTesting, isValidatedSelfHostedApiBase } =
        await import('../../../src/main/selfHostedProfile');
      _resetSelfHostedProfileForTesting();
      approvalStore.records.length = 0;
      mockShowMessageBox.mockClear();
      (probeSelfHostedServer as Mock).mockClear();
      const failure = {
        status: 'error',
        code: 'client_config_failed',
        message: 'The server did not respond like a Concord server.',
      };
      (probeSelfHostedServer as Mock).mockResolvedValueOnce(failure);

      const result = await handlers.get('selfHosted:probeServer')!(
        trustedIpcEvent,
        'https://not-concord.lan'
      );

      // The user consented and the probe ran on the provisional grant …
      expect(mockShowMessageBox).toHaveBeenCalledTimes(1);
      expect(probeSelfHostedServer).toHaveBeenCalledTimes(1);
      expect(result).toEqual(failure);
      // … but nothing durable was minted, so the origin holds no credential or SSO trust.
      expect(isValidatedSelfHostedApiBase('https://not-concord.lan')).toBe(false);
      expect(approvalStore.records).toHaveLength(0);
    });

    it('a successful probe still mints, and still reports a failed durable write', async () => {
      const { probeSelfHostedServer } = await import('../../../src/main/selfHostedProbe');
      const { _resetSelfHostedProfileForTesting, isValidatedSelfHostedApiBase } =
        await import('../../../src/main/selfHostedProfile');
      _resetSelfHostedProfileForTesting();
      approvalStore.records.length = 0;
      mockShowMessageBox.mockClear();
      (probeSelfHostedServer as Mock).mockClear();
      const ok = { status: 'ok', apiBase: 'https://real.lan' };
      (probeSelfHostedServer as Mock).mockResolvedValue(ok);

      // #86 7B: the probed origin is the sender's own service (see bindSelfHostedPrimary).
      const real = bindSelfHostedPrimary('https://real.lan', { foreground: true });
      try {
        expect(
          await handlers.get('selfHosted:probeServer')!(real.event, 'https://real.lan')
        ).toEqual(ok);
      } finally {
        real.dispose();
      }
      expect(isValidatedSelfHostedApiBase('https://real.lan')).toBe(true);
      expect(approvalStore.records).toHaveLength(1);

      // approval_not_saved must survive the reorder: a durable-write failure on an
      // otherwise-successful probe is still surfaced, not silently swallowed.
      _resetSelfHostedProfileForTesting();
      approvalStore.records.length = 0;
      approvalStore.failAppend = true;
      try {
        expect(
          await handlers.get('selfHosted:probeServer')!(trustedIpcEvent, 'https://unwritable.lan')
        ).toEqual({
          status: 'error',
          code: 'approval_not_saved',
          message: "Concord couldn't save your choice.",
        });
      } finally {
        approvalStore.failAppend = false;
      }
      expect(isValidatedSelfHostedApiBase('https://unwritable.lan')).toBe(false);
    });

    it('approving mints once, then a second probe of the same origin does not re-prompt', async () => {
      const { probeSelfHostedServer } = await import('../../../src/main/selfHostedProbe');
      const { _resetSelfHostedProfileForTesting, isValidatedSelfHostedApiBase } =
        await import('../../../src/main/selfHostedProfile');
      _resetSelfHostedProfileForTesting();
      approvalStore.records.length = 0;
      mockShowMessageBox.mockClear();
      (probeSelfHostedServer as Mock).mockClear();
      (probeSelfHostedServer as Mock).mockResolvedValue({ status: 'ok' });

      await handlers.get('selfHosted:probeServer')!(trustedIpcEvent, 'https://approved.lan');
      await handlers.get('selfHosted:probeServer')!(trustedIpcEvent, 'https://approved.lan');

      expect(mockShowMessageBox).toHaveBeenCalledTimes(1); // rarity: once per origin
      expect(isValidatedSelfHostedApiBase('https://approved.lan')).toBe(true);
      expect(approvalStore.records).toHaveLength(1);
      expect(probeSelfHostedServer).toHaveBeenCalledTimes(2);
    });

    it('re-runs the ceremony when a public-approved origin now resolves into tier 2', async () => {
      const { probeSelfHostedServer } = await import('../../../src/main/selfHostedProbe');
      const { _resetSelfHostedProfileForTesting } =
        await import('../../../src/main/selfHostedProfile');
      _resetSelfHostedProfileForTesting();
      approvalStore.records.length = 0;
      mockShowMessageBox.mockClear();
      (probeSelfHostedServer as Mock).mockClear();
      (probeSelfHostedServer as Mock).mockResolvedValue({ status: 'ok' });

      // First connect: the ceremony displays a public address; consent is 'public'.
      mockResolveForDisplay.mockResolvedValueOnce({
        ok: true,
        address: '203.0.113.10',
        addresses: ['203.0.113.10'],
        decision: { tier: 'public' },
      } as never);
      await handlers.get('selfHosted:probeServer')!(trustedIpcEvent, 'https://moved.lan');
      expect(approvalStore.records).toEqual([
        expect.objectContaining({ tierAtApproval: 'public' }),
      ]);

      // Second connect: the same name now resolves onto the LAN. Consent taken against
      // a public address never authorized that, so the user is asked again — showing
      // the private address this time — rather than the dial being silently permitted.
      mockResolveForDisplay.mockResolvedValueOnce({
        ok: true,
        address: '10.0.0.5',
        addresses: ['10.0.0.5'],
        decision: { tier: 'tier2', reason: 'private' },
      } as never);
      await handlers.get('selfHosted:probeServer')!(trustedIpcEvent, 'https://moved.lan');

      expect(mockShowMessageBox).toHaveBeenCalledTimes(2);
      expect(approvalStore.records).toHaveLength(2);
      expect(approvalStore.records[1]).toEqual(
        expect.objectContaining({ tierAtApproval: 'tier2' })
      );
    });

    it('does not re-prompt a public-approved origin that still resolves public', async () => {
      const { probeSelfHostedServer } = await import('../../../src/main/selfHostedProbe');
      const { _resetSelfHostedProfileForTesting } =
        await import('../../../src/main/selfHostedProfile');
      _resetSelfHostedProfileForTesting();
      approvalStore.records.length = 0;
      mockShowMessageBox.mockClear();
      (probeSelfHostedServer as Mock).mockClear();
      (probeSelfHostedServer as Mock).mockResolvedValue({ status: 'ok' });

      const publicResolution = {
        ok: true,
        address: '203.0.113.10',
        addresses: ['203.0.113.10'],
        decision: { tier: 'public' },
      } as never;
      mockResolveForDisplay.mockResolvedValueOnce(publicResolution);
      await handlers.get('selfHosted:probeServer')!(trustedIpcEvent, 'https://steady.lan');
      mockResolveForDisplay.mockResolvedValueOnce(publicResolution);
      await handlers.get('selfHosted:probeServer')!(trustedIpcEvent, 'https://steady.lan');

      // Rarity invariant: an approved origin produces no prompt on repeat connect.
      expect(mockShowMessageBox).toHaveBeenCalledTimes(1);
      expect(approvalStore.records).toHaveLength(1);
      expect(probeSelfHostedServer).toHaveBeenCalledTimes(2);
    });

    // Assertion 4 of #14a. This locks that the dialog answers THIS SPECIFIC INVOCATION —
    // an invocation, not a user action. It does not, and cannot, show a human initiated
    // it: see ADR-0035 § "Non-property #14b".
    it('resolves an approval from the dialog that same invocation asked to show', async () => {
      const { requestSelfHostedApproval } = await import('../../../src/main/main');
      const showMessageBox = vi.fn().mockResolvedValue({ response: 1 });
      const approved = await requestSelfHostedApproval(
        {},
        {
          host: 'concord.lan',
          address: '10.0.0.5',
          decision: { tier: 'tier2', reason: 'private' },
        },
        { showMessageBox }
      );
      expect(showMessageBox).toHaveBeenCalledTimes(1);
      expect(approved).toBe(true);
    });

    it('treats Cancel (response 0) and dismiss as decline', async () => {
      const { requestSelfHostedApproval } = await import('../../../src/main/main');
      const showMessageBox = vi.fn().mockResolvedValue({ response: 0 });
      const approved = await requestSelfHostedApproval(
        {},
        {
          host: 'concord.lan',
          address: '127.0.0.1',
          decision: { tier: 'tier2', reason: 'loopback' },
        },
        { showMessageBox }
      );
      expect(approved).toBe(false);
    });

    it('passes a destructive-safe button configuration', async () => {
      const { requestSelfHostedApproval } = await import('../../../src/main/main');
      const showMessageBox = vi.fn().mockResolvedValue({ response: 0 });
      await requestSelfHostedApproval(
        {},
        {
          host: 'concord.lan',
          address: '10.0.0.5',
          decision: { tier: 'tier2', reason: 'private' },
        },
        { showMessageBox }
      );
      const options = showMessageBox.mock.calls[0][1] as Record<string, unknown>;
      expect(options.type).toBe('warning');
      expect(options.buttons).toEqual(['Cancel', 'Trust This Server']);
      expect(options.defaultId).toBe(0);
      expect(options.cancelId).toBe(0);
      expect(options.noLink).toBe(true);
      expect(options.icon).toBeUndefined();
      // A decision, not an omission — ADR-0035 § "Non-property #14b". MessageBoxOptions
      // cannot gate the affirmative on checkbox state, so an unchecked accept becomes a
      // silent no-op that a native dialog cannot explain or validate inline.
      expect(options.checkboxLabel).toBeUndefined();
    });
  });

  describe('ceremony budget (#2354)', () => {
    // The bucket rations DIALOGS, not probes: an approved origin re-probes freely.
    it('refuses a ceremony past the budget while an approved origin still probes', async () => {
      const { probeSelfHostedServer } = await import('../../../src/main/selfHostedProbe');
      const { _resetSelfHostedProfileForTesting } =
        await import('../../../src/main/selfHostedProfile');
      const { CEREMONY_BUDGET } = await import('../../../src/main/selfHostedCeremonyBudget');
      _resetSelfHostedProfileForTesting();
      approvalStore.records.length = 0;
      mockShowMessageBox.mockClear();
      (probeSelfHostedServer as Mock).mockReset();
      (probeSelfHostedServer as Mock).mockResolvedValue({ status: 'ok' });

      // Each distinct origin is a fresh ceremony.
      for (let i = 0; i < CEREMONY_BUDGET; i++) {
        await handlers.get('selfHosted:probeServer')!(probeEvent, `https://burst${i}.lan`);
      }
      expect(mockShowMessageBox).toHaveBeenCalledTimes(CEREMONY_BUDGET);

      const refused = await handlers.get('selfHosted:probeServer')!(
        probeEvent,
        'https://burst-over.lan'
      );
      expect(refused).toEqual({ status: 'error', code: 'too_many_prompts', message: '' });
      expect(mockShowMessageBox).toHaveBeenCalledTimes(CEREMONY_BUDGET);

      // An origin approved before the bucket drained is unaffected — no dialog, so
      // no token, so the throttle must not touch it. #86 7B: probed from its own
      // service's primary. #195 (merged from main) admits only the foreground primary,
      // approved origin or not.
      const burst0 = bindSelfHostedPrimary('https://burst0.lan', { foreground: true });
      try {
        const approved = await handlers.get('selfHosted:probeServer')!(
          burst0.event,
          'https://burst0.lan'
        );
        expect(approved).toEqual({ status: 'ok' });
      } finally {
        burst0.dispose();
      }
      expect(mockShowMessageBox).toHaveBeenCalledTimes(CEREMONY_BUDGET);
    });
  });

  // #87 R13: the approval dialog and the capture-move dialog share one main-owned modal
  // slot. The probe handler has no 'busy' shape, so a taken slot is its rejected shape.
  describe('cross-kind modal mutex (#87)', () => {
    async function freshProbeState() {
      const { probeSelfHostedServer } = await import('../../../src/main/selfHostedProbe');
      const { _resetSelfHostedProfileForTesting } =
        await import('../../../src/main/selfHostedProfile');
      const mutex = await import('../../../src/main/modalMutex');
      const budget = await import('../../../src/main/selfHostedCeremonyBudget');
      _resetSelfHostedProfileForTesting();
      approvalStore.records.length = 0;
      mockShowMessageBox.mockClear();
      (probeSelfHostedServer as Mock).mockReset();
      (probeSelfHostedServer as Mock).mockResolvedValue({ status: 'ok' });
      mutex._resetModalMutexForTesting();
      return { probeSelfHostedServer, mutex, budget };
    }

    afterEach(async () => {
      const { _resetModalMutexForTesting } = await import('../../../src/main/modalMutex');
      _resetModalMutexForTesting();
    });

    it('refuses with probeRejected() while the capture modal is held, spending no token', async () => {
      const { probeSelfHostedServer, mutex, budget } = await freshProbeState();
      const releaseCapture = mutex.tryAcquireModal('capture');

      const result = await handlers.get('selfHosted:probeServer')!(probeEvent, 'https://held.lan');

      expect(result).toEqual({
        status: 'error',
        code: 'rejected',
        message: 'Self-hosted server probing is not available from this frame.',
      });
      expect(mockShowMessageBox).not.toHaveBeenCalled();
      expect(probeSelfHostedServer).not.toHaveBeenCalled();
      expect(approvalStore.records).toHaveLength(0);
      expect(mutex.modalInFlight()).toBe('capture');

      // No token was spent: the whole bucket is still there.
      releaseCapture?.();
      for (let i = 0; i < budget.CEREMONY_BUDGET; i++) {
        expect(budget.consumeCeremonyToken()).toBe(true);
      }
      expect(budget.consumeCeremonyToken()).toBe(false);
    });

    it('holds the self-hosted-approval slot while the dialog is open, then releases it', async () => {
      const { mutex } = await freshProbeState();
      let during: string | null = null;
      mockShowMessageBox.mockImplementationOnce(async () => {
        during = mutex.modalInFlight();
        return { response: 0 };
      });

      const result = await handlers.get('selfHosted:probeServer')!(probeEvent, 'https://slot.lan');

      expect(result).toMatchObject({ code: 'approval_declined' });
      expect(during).toBe('self-hosted-approval');
      expect(mutex.modalInFlight()).toBeNull();
    });

    it('releases the slot when the dialog throws', async () => {
      const { mutex } = await freshProbeState();
      let during: string | null = null;
      mockShowMessageBox.mockImplementationOnce(async () => {
        during = mutex.modalInFlight();
        throw new Error('native dialog failed');
      });

      await expect(
        handlers.get('selfHosted:probeServer')!(probeEvent, 'https://throws.lan')
      ).rejects.toThrow('native dialog failed');

      expect(during).toBe('self-hosted-approval');
      expect(mutex.modalInFlight()).toBeNull();
      expect(mutex.tryAcquireModal('capture')).not.toBeNull();
    });

    it('releases the slot when the ceremony budget refuses', async () => {
      const { mutex, budget } = await freshProbeState();
      for (let i = 0; i < budget.CEREMONY_BUDGET; i++) budget.consumeCeremonyToken();

      const result = await handlers.get('selfHosted:probeServer')!(probeEvent, 'https://over.lan');

      expect(result).toEqual({ status: 'error', code: 'too_many_prompts', message: '' });
      expect(mockShowMessageBox).not.toHaveBeenCalled();
      expect(mutex.modalInFlight()).toBeNull();
    });

    it('an approved origin shows no dialog, so it re-probes while the capture modal is held', async () => {
      const { mutex } = await freshProbeState();
      await handlers.get('selfHosted:probeServer')!(probeEvent, 'https://known.lan');
      expect(mockShowMessageBox).toHaveBeenCalledTimes(1);

      mutex.tryAcquireModal('capture');
      const known = bindSelfHostedPrimary('https://known.lan', { foreground: true });
      try {
        expect(
          await handlers.get('selfHosted:probeServer')!(known.event, 'https://known.lan')
        ).toEqual({ status: 'ok' });
      } finally {
        known.dispose();
      }
      expect(mockShowMessageBox).toHaveBeenCalledTimes(1);
      expect(mutex.modalInFlight()).toBe('capture');
    });
  });

  describe('probe single-flight (#2354)', () => {
    // resolveForDisplay's dns.lookup is a libuv-threadpool job that cannot be
    // cancelled, so concurrency here is a resource-exhaustion lever, not a
    // convenience issue. The gate must therefore cover the WHOLE handler.
    it('refuses concurrent probes while one probe is in flight', async () => {
      const { probeSelfHostedServer } = await import('../../../src/main/selfHostedProbe');
      const { _resetSelfHostedProfileForTesting } =
        await import('../../../src/main/selfHostedProfile');
      _resetSelfHostedProfileForTesting();
      approvalStore.records.length = 0;
      mockShowMessageBox.mockClear();
      (probeSelfHostedServer as Mock).mockReset();

      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      (probeSelfHostedServer as Mock).mockImplementation(async () => {
        await gate;
        return { status: 'ok' };
      });

      // #195 re-expressed for #86: ONE slot process-wide. A is the foreground primary;
      // B, a second connection, becomes foreground while A's probe is in flight, so it
      // passes admission and must still meet the busy slot. Both origins are approved
      // up front so neither path raises a dialog.
      const { commitSelfHostedApproval } = await import('../../../src/main/selfHostedProfile');
      commitSelfHostedApproval('https://inflight.lan', '10.0.0.4');
      commitSelfHostedApproval('https://third.lan', '10.0.0.5');
      const A = bindSelfHostedPrimary('https://inflight.lan', { foreground: true });
      const B = bindSelfHostedPrimary('https://third.lan');
      try {
        const first = handlers.get('selfHosted:probeServer')!(A.event, 'https://inflight.lan');
        const refused = await handlers.get('selfHosted:probeServer')!(A.event, 'https://other.lan');
        B.makeForeground();
        const third = handlers.get('selfHosted:probeServer')!(B.event, 'https://third.lan');

        expect(refused).toEqual({ status: 'error', code: 'busy', message: '' });

        release();
        await expect(first).resolves.toEqual({ status: 'ok' });
        await expect(third).resolves.toEqual({ status: 'error', code: 'busy', message: '' });
        // The refused calls must not have dialled or prompted for their own origin.
        expect(probeSelfHostedServer).toHaveBeenCalledTimes(1);
      } finally {
        release();
        B.dispose();
        A.dispose();
      }
    });

    it('keeps the global probe slot while the owner window is destroyed', async () => {
      // #86: a destroyed owner window is an unbound sender. It is rejected before the
      // slot, and the slot stays held until the first lookup settles.
      let release: ((value: unknown) => void) | undefined;
      mockResolveForDisplay.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }) as never
      );
      const A = bindSelfHostedPrimary('https://slot.lan', { foreground: true });
      try {
        const first = handlers.get('selfHosted:probeServer')!(A.event, 'https://slot.lan');
        const unbound = { ...A.event, sender: { ...A.event.sender, id: 99_001 } };
        await expect(
          handlers.get('selfHosted:probeServer')!(unbound, 'https://other.lan')
        ).resolves.toMatchObject({ code: 'rejected' });
        await expect(
          handlers.get('selfHosted:probeServer')!(A.event, 'https://other.lan')
        ).resolves.toMatchObject({ code: 'busy' });
        release?.({ ok: false, kind: 'unreachable' });
        await expect(first).resolves.toMatchObject({ code: 'unreachable' });
      } finally {
        release?.({ ok: false, kind: 'unreachable' });
        A.dispose();
      }
    });

    it('releases the slot after a probe settles, including on rejection', async () => {
      const { probeSelfHostedServer } = await import('../../../src/main/selfHostedProbe');
      const { _resetSelfHostedProfileForTesting } =
        await import('../../../src/main/selfHostedProfile');
      _resetSelfHostedProfileForTesting();
      approvalStore.records.length = 0;
      mockShowMessageBox.mockClear();
      (probeSelfHostedServer as Mock).mockReset();
      (probeSelfHostedServer as Mock).mockRejectedValueOnce(new Error('boom'));

      // #86 7B: one bound connection probing its own service (see bindSelfHostedPrimary).
      const flaky = bindSelfHostedPrimary('https://flaky.lan', { foreground: true });
      try {
        await expect(
          handlers.get('selfHosted:probeServer')!(flaky.event, 'https://flaky.lan')
        ).rejects.toThrow('boom');

        (probeSelfHostedServer as Mock).mockResolvedValueOnce({ status: 'ok' });
        await expect(
          handlers.get('selfHosted:probeServer')!(flaky.event, 'https://flaky.lan')
        ).resolves.toEqual({ status: 'ok' });
      } finally {
        flaky.dispose();
      }
    });
  });

  describe('IPC: auto-update', () => {
    it('update:check delegates to checkForUpdates', async () => {
      const result = (await handlers.get('update:check')!(trustedIpcEvent)) as {
        updateAvailable: boolean;
      };
      expect(result.updateAvailable).toBe(false);
    });

    it('update:download delegates to downloadUpdate', async () => {
      await handlers.get('update:download')!(trustedIpcEvent);
      const { downloadUpdate } = await import('../../../src/main/updater');
      expect(downloadUpdate).toHaveBeenCalled();
    });

    it('update:install rejects PiP and same-origin subframes', async () => {
      const { safeQuitAndInstall } = await import('../../../src/main/updater');
      (safeQuitAndInstall as Mock).mockClear();
      await handlers.get('update:install')!({
        sender: {},
        senderFrame: { url: 'http://localhost:3001/', frameTreeNodeId: 77 },
      });
      await handlers.get('update:install')!({
        sender: mockWebContents,
        senderFrame: { url: 'http://localhost:3001/', frameTreeNodeId: 999 },
      });
      expect(safeQuitAndInstall).not.toHaveBeenCalled();
    });

    it('update:install delegates to safeQuitAndInstall', async () => {
      await handlers.get('update:install')!(probeEvent);
      const { safeQuitAndInstall } = await import('../../../src/main/updater');
      expect(safeQuitAndInstall).toHaveBeenCalled();
    });

    it('update:getAllowPrerelease returns current setting', async () => {
      const result = await handlers.get('update:getAllowPrerelease')!(trustedIpcEvent);
      expect(result).toBe(false);
    });

    it('update:setAllowPrerelease updates setting', async () => {
      await handlers.get('update:setAllowPrerelease')!(trustedIpcEvent, true);
      const { setAllowPrerelease } = await import('../../../src/main/updater');
      expect(setAllowPrerelease).toHaveBeenCalledWith(true);
    });

    it.each([foreignIpcEvent, { senderFrame: null }])(
      'rejects an untrusted or missing sender before privileged work',
      async (event) => {
        const electron = await import('electron');
        const fs = (await import('node:fs')).default;
        const updater = await import('../../../src/main/updater');
        const sideEffects = [
          electron.desktopCapturer.getSources,
          electron.clipboard.writeText,
          fs.writeFileSync,
          electron.app.relaunch,
          electron.app.quit,
          updater.checkForUpdates,
          updater.downloadUpdate,
          updater.safeQuitAndInstall,
          updater.setAllowPrerelease,
          updater.forceCheckForUpdates,
          mockWebContents.openDevTools,
          mockWebContents.closeDevTools,
        ] as Mock[];
        sideEffects.forEach((effect) => effect.mockClear());

        await handlers.get('media:getDesktopSources')!(event);
        await expect(
          Promise.resolve().then(() => handlers.get('clipboard:writeText')!(event, 'secret'))
        ).rejects.toThrow('Clipboard write denied');
        await handlers.get('app:setHardwareAcceleration')!(event, false);
        await handlers.get('app:relaunch')!(event);
        await handlers.get('update:check')!(event);
        await handlers.get('update:download')!(event);
        await handlers.get('update:install')!(event);
        await handlers.get('update:setAllowPrerelease')!(event, true);
        await handlers.get('updater:force-check')!(event, 'user_triggered');
        await handlers.get('app:setDeveloperMode')!(event, true);

        sideEffects.forEach((effect) => expect(effect).not.toHaveBeenCalled());
      }
    );
  });

  // T7 boy-scout hardening (tray-status spec §4, AC15): the three desktop
  // notification helpers were the last renderer-reachable app:* handlers with no
  // sender check and no payload shape check.
  describe('IPC: notification helpers (AC15)', () => {
    it('app:setBadgeCount sets an in-range integer for a trusted sender', async () => {
      const { app } = await import('electron');
      (app.setBadgeCount as Mock).mockClear();
      await handlers.get('app:setBadgeCount')!(trustedIpcEvent, 3);
      await handlers.get('app:setBadgeCount')!(trustedIpcEvent, 0);
      await handlers.get('app:setBadgeCount')!(trustedIpcEvent, 9999);
      expect((app.setBadgeCount as Mock).mock.calls).toEqual([[3], [0], [9999]]);
    });

    it('app:setBadgeCount clamps a real total above 9999 instead of dropping it', async () => {
      const { app } = await import('electron');
      (app.setBadgeCount as Mock).mockClear();
      await handlers.get('app:setBadgeCount')!(trustedIpcEvent, 10000);
      expect((app.setBadgeCount as Mock).mock.calls).toEqual([[9999]]);
    });

    it.each([1.5, -1, '3', Number.NaN, null, undefined])(
      'app:setBadgeCount rejects %s',
      async (count) => {
        const { app } = await import('electron');
        (app.setBadgeCount as Mock).mockClear();
        await handlers.get('app:setBadgeCount')!(trustedIpcEvent, count);
        expect(app.setBadgeCount).not.toHaveBeenCalled();
      }
    );

    it('app:flashFrame passes a boolean and rejects anything else', async () => {
      mockMainWindow.flashFrame.mockClear();
      await handlers.get('app:flashFrame')!(trustedIpcEvent, true);
      expect(mockMainWindow.flashFrame).toHaveBeenCalledWith(true);
      mockMainWindow.flashFrame.mockClear();
      await handlers.get('app:flashFrame')!(trustedIpcEvent, 'yes');
      await handlers.get('app:flashFrame')!(trustedIpcEvent, 1);
      expect(mockMainWindow.flashFrame).not.toHaveBeenCalled();
    });

    it('app:focusWindow restores and focuses for a trusted sender', async () => {
      mockMainWindow.focus.mockClear();
      mockMainWindow.restore.mockClear();
      mockMainWindow.isMinimized.mockReturnValueOnce(true);
      await handlers.get('app:focusWindow')!(trustedIpcEvent);
      expect(mockMainWindow.restore).toHaveBeenCalledTimes(1);
      expect(mockMainWindow.focus).toHaveBeenCalledTimes(1);
    });

    it.each([foreignIpcEvent, { senderFrame: null }])(
      'all three reject an untrusted or missing sender',
      async (event) => {
        const { app } = await import('electron');
        (app.setBadgeCount as Mock).mockClear();
        mockMainWindow.flashFrame.mockClear();
        mockMainWindow.focus.mockClear();
        mockMainWindow.restore.mockClear();
        await handlers.get('app:setBadgeCount')!(event, 1);
        await handlers.get('app:flashFrame')!(event, true);
        await handlers.get('app:focusWindow')!(event);
        expect(app.setBadgeCount).not.toHaveBeenCalled();
        expect(mockMainWindow.flashFrame).not.toHaveBeenCalled();
        expect(mockMainWindow.focus).not.toHaveBeenCalled();
        expect(mockMainWindow.restore).not.toHaveBeenCalled();
      }
    );
  });

  describe('status-aware tray wiring (tray-status spec §4, R17)', () => {
    it('registers the tray reset hooks on the main window webContents', () => {
      const events = mockWebContents.on.mock.calls.map((c: unknown[]) => c[0]);
      expect(events).toEqual(
        expect.arrayContaining([
          'did-navigate',
          'did-fail-load',
          'unresponsive',
          'responsive',
          'destroyed',
          'render-process-gone',
        ])
      );
    });

    it('feeds window focus to the tray', () => {
      const events = mockMainWindow.on.mock.calls.map((c: unknown[]) => c[0]);
      expect(events).toEqual(expect.arrayContaining(['focus', 'blur']));
      const focus = mockMainWindow.on.mock.calls.find((c: unknown[]) => c[0] === 'focus');
      const blur = mockMainWindow.on.mock.calls.find((c: unknown[]) => c[0] === 'blur');
      expect(() => (focus![1] as () => void)()).not.toThrow();
      expect(() => (blur![1] as () => void)()).not.toThrow();
    });

    it('tray:setStatus refuses a foreign sender without throwing', async () => {
      await expect(
        Promise.resolve(handlers.get('tray:setStatus')!(foreignIpcEvent, {}))
      ).resolves.toBe(true);
    });
  });

  describe('IPC: PiP window management', () => {
    it('rejects a same-origin PiP renderer attempting to create another window', async () => {
      const { BrowserWindow } = await import('electron');
      const before = (BrowserWindow as unknown as Mock).mock.calls.length;
      const firstNewCall = mockMainWindow.on.mock.calls.length;
      await expect(
        handlers.get('pip:open')!(
          {
            sender: { id: 999 },
            senderFrame: { url: 'http://localhost:3001/#/pip/other', frameTreeNodeId: 999 },
          },
          { id: 'pip-escape-repro' }
        )
      ).rejects.toThrow('PiP could not be opened');
      const closed = mockMainWindow.on.mock.calls
        .slice(firstNewCall)
        .find((call) => call[0] === 'closed')?.[1] as (() => void) | undefined;
      closed?.();
      expect((BrowserWindow as unknown as Mock).mock.calls).toHaveLength(before);
    });
    it('refuses pip:open from a BACKGROUND connection primary and builds no window (#86, foreground-only PiP)', async () => {
      const { BrowserWindow } = await import('electron');
      const before = (BrowserWindow as unknown as Mock).mock.calls.length;
      // Another connection takes the foreground; the saas view is now a hidden primary.
      const other = bindSelfHostedPrimary('https://pip-foreground.lan', { foreground: true });
      try {
        await expect(
          handlers.get('pip:open')!(
            {
              sender: mockWebContents,
              senderFrame: { url: 'http://localhost:3001/', frameTreeNodeId: 77, parent: null },
            },
            { id: 'background-opener-pip' }
          )
        ).rejects.toThrow();
        expect((BrowserWindow as unknown as Mock).mock.calls).toHaveLength(before);
      } finally {
        other.dispose();
      }
    });
    // pip:open requires a valid senderFrame URL post-#815 (isValidPipOpenSender
    // defense-in-depth). In this test environment isPackaged=false, so a
    // localhost URL satisfies the validator.
    //
    // #86 R8: the opener must also be a bound connection primary — both frames
    // below live in the saas view's contents. A PiP has its own contents, so its
    // main-frame events are built from `lastPipContents()`, never from the opener.
    const pipOwnerEvent = {
      sender: mockWebContents,
      senderFrame: { url: 'http://localhost:3001/', frameTreeNodeId: 77, parent: null },
    };
    const otherPermittedPipEvent = {
      sender: mockWebContents,
      senderFrame: { url: 'http://localhost:3001/', frameTreeNodeId: 99 },
    };
    function pipMainFrame(): { sender: unknown; senderFrame: unknown } {
      const contents = lastPipContents();
      return { sender: contents, senderFrame: contents.mainFrame };
    }

    // Electron runs EVERY 'closed' listener; shellWindow.ts and main.ts each add one.
    async function openPip(id: string, event = pipOwnerEvent): Promise<() => void> {
      const firstNewCall = mockPipWindow.on.mock.calls.length;
      await handlers.get('pip:open')!(event, { id });
      const closedListeners = mockPipWindow.on.mock.calls
        .slice(firstNewCall)
        .filter((call) => call[0] === 'closed')
        .map((call) => call[1] as () => void);
      expect(closedListeners.length).toBeGreaterThan(0);
      return () => {
        for (const listener of closedListeners) listener();
      };
    }

    it('rejects a same-origin subframe in the main web contents', async () => {
      const before = (MockBrowserWindow as Mock).mock.calls.length;
      await expect(
        handlers.get('pip:open')!(
          {
            sender: mockWebContents,
            senderFrame: { url: 'http://localhost:3001/', frameTreeNodeId: 99 },
          },
          { id: 'subframe-test' }
        )
      ).rejects.toThrow('PiP could not be opened');
      expect((MockBrowserWindow as Mock).mock.calls).toHaveLength(before);
    });

    it('does not let a legacy caller hide controls after a refused pop-out', async () => {
      let hidden = false;
      try {
        await handlers.get('pip:open')!(pipOwnerEvent, { id: 'bad/id' });
        hidden = true;
      } catch {
        // Older renderers stop before setting the popped-out state on rejection.
      }
      expect(hidden).toBe(false);
    });

    it.each([false, true])(
      'revokes and untracks a PiP whose load rejects (closed event: %s)',
      async (emitClosed) => {
        const failedLoad = Promise.reject(new Error('load failed'));
        failedLoad.catch(() => undefined);
        const child = {
          ...mockMainWindow,
          webContents: pipChildContents(),
          destroy: vi.fn(),
          on: vi.fn(),
          loadURL: vi.fn(() => failedLoad),
        };
        if (emitClosed) {
          child.destroy.mockImplementation(() => {
            const closed = child.on.mock.calls.find((call) => call[0] === 'closed')?.[1] as
              (() => void) | undefined;
            closed?.();
          });
        }
        (MockBrowserWindow as Mock).mockImplementationOnce(function () {
          return child;
        });
        mockWebContents.send.mockClear();
        await expect(
          handlers.get('pip:open')!(pipOwnerEvent, { id: 'async-load-failure' })
        ).rejects.toThrow();
        expect(child.destroy).toHaveBeenCalledOnce();
        expect(
          mockWebContents.send.mock.calls
            .filter((call) => call[0] === 'pip:opened' || call[0] === 'pip:closed')
            .map((call) => call[0])
        ).toEqual(['pip:opened', 'pip:closed']);
        const reopened = await openPip('async-load-failure');
        reopened();
      }
    );

    it('charges failed loads against the window-creation budget', async () => {
      const before = (MockBrowserWindow as Mock).mock.calls.length;
      for (let n = 0; n < 8; n++) {
        (MockBrowserWindow as Mock).mockImplementationOnce(function () {
          return {
            ...mockMainWindow,
            webContents: pipChildContents(),
            on: vi.fn(),
            destroy: vi.fn(),
            loadURL: vi.fn().mockRejectedValue(new Error('load failed')),
          };
        });
        await expect(
          handlers.get('pip:open')!(pipOwnerEvent, { id: `failed-load-${n}` })
        ).rejects.toThrow();
      }
      expect((MockBrowserWindow as Mock).mock.calls).toHaveLength(before + 8);
      await expect(
        handlers.get('pip:open')!(pipOwnerEvent, { id: 'failed-load-ninth' })
      ).rejects.toThrow();
      expect((MockBrowserWindow as Mock).mock.calls).toHaveLength(before + 8);
    });

    it('settles duplicate opens while the first PiP is still loading', async () => {
      const gate = deferred();
      const child = {
        ...mockMainWindow,
        webContents: pipChildContents(),
        on: vi.fn(),
        focus: vi.fn(),
        loadURL: vi.fn(() => gate.promise),
      };
      (MockBrowserWindow as Mock).mockImplementationOnce(function () {
        return child;
      });
      mockWebContents.send.mockClear();
      const first = handlers.get('pip:open')!(pipOwnerEvent, {
        id: 'pending-pip',
      }) as Promise<void>;
      const duplicates = Array.from(
        { length: 64 },
        () => handlers.get('pip:open')!(pipOwnerEvent, { id: 'pending-pip' }) as Promise<void>
      );
      let settled = 0;
      for (const duplicate of duplicates) {
        void duplicate.then(
          () => {
            settled += 1;
          },
          () => {
            settled += 1;
          }
        );
      }
      try {
        await vi.waitFor(() => expect(settled).toBe(duplicates.length), { timeout: 500 });
        expect(child.focus).toHaveBeenCalledTimes(duplicates.length);
        expect(mockWebContents.send).toHaveBeenCalledWith(
          'pip:opened',
          expect.objectContaining({ id: 'pending-pip' })
        );
      } finally {
        gate.resolve();
        await Promise.allSettled([first, ...duplicates]);
        // shellWindow.ts and main.ts each add a 'closed' listener; run them all, or main's
        // entry outlives the window and holds a slot of the saas cap (#86 RT5).
        for (const [event, listener] of child.on.mock.calls) if (event === 'closed') listener();
      }
    });

    it('destroys a newly created PiP if loading throws synchronously', async () => {
      const child = {
        ...mockMainWindow,
        webContents: pipChildContents(),
        destroy: vi.fn(),
        loadURL: vi.fn(() => {
          throw new Error('load failed');
        }),
      };
      (MockBrowserWindow as Mock).mockImplementationOnce(function () {
        return child;
      });
      await expect(
        handlers.get('pip:open')!(pipOwnerEvent, { id: 'load-failure' })
      ).rejects.toThrow();
      expect(child.destroy).toHaveBeenCalledOnce();
    });

    it.each([
      undefined,
      null,
      {},
      { id: 'x'.repeat(129) },
      { id: 'valid', width: 999999 },
      { id: 'valid', title: 'x'.repeat(129) },
    ])('rejects invalid PiP options before creating a window', async (opts) => {
      const before = (MockBrowserWindow as Mock).mock.calls.length;
      await expect(handlers.get('pip:open')!(pipOwnerEvent, opts)).rejects.toThrow();
      expect((MockBrowserWindow as Mock).mock.calls).toHaveLength(before);
    });

    it('limits simultaneous PiPs, still focuses an existing one, and reuses a closed slot', async () => {
      const { MAX_PIP_WINDOWS, MAX_PIP_WINDOWS_PER_CONNECTION, _resetPipOpenBudgetForTesting } =
        await import('../../../src/main/pipOpenPolicy');
      const opened: Array<{ id: string; close: () => void }> = [];
      try {
        for (let n = 0; n <= MAX_PIP_WINDOWS; n++) {
          _resetPipOpenBudgetForTesting();
          const before = mockPipWindow.on.mock.calls.length;
          const id = `cap-test-${n}`;
          try {
            await handlers.get('pip:open')!(pipOwnerEvent, { id });
          } catch {
            break;
          }
          // #86: shellWindow.ts and main.ts each add a 'closed' listener; run them all.
          const closeListeners = mockPipWindow.on.mock.calls
            .slice(before)
            .filter((call) => call[0] === 'closed')
            .map((call) => call[1] as () => void);
          const close = (
            closeListeners.length > 0
              ? () => closeListeners.forEach((listener) => listener())
              : undefined
          ) as () => void;
          expect(close).toBeDefined();
          opened.push({ id, close });
        }
        // #86 RT5: one connection alone stops at its own cap, below the process-wide ceiling.
        expect(opened).toHaveLength(MAX_PIP_WINDOWS_PER_CONNECTION);
        _resetPipOpenBudgetForTesting();
        await expect(
          handlers.get('pip:open')!(pipOwnerEvent, { id: 'over-cap' })
        ).rejects.toThrow();
        mockPipWindow.focus.mockClear();
        await expect(
          handlers.get('pip:open')!(pipOwnerEvent, { id: opened[0].id })
        ).resolves.toBeUndefined();
        expect(mockPipWindow.focus).toHaveBeenCalledOnce();
        await handlers.get('pip:close')!(pipOwnerEvent, { id: opened[0].id });
        await expect(
          handlers.get('pip:open')!(pipOwnerEvent, { id: 'still-at-cap' })
        ).rejects.toThrow();
        opened.shift()!.close();
        const closeNew = await openPip('reused-cap-slot');
        closeNew();
      } finally {
        for (const entry of opened) entry.close();
      }
    });

    it('limits repeated create-and-close churn', async () => {
      for (let n = 0; n < 8; n++) {
        const close = await openPip(`burst-${n}`);
        close();
      }
      await expect(
        handlers.get('pip:open')!(pipOwnerEvent, { id: 'burst-ninth' })
      ).rejects.toThrow();
    });

    it('creates the PiP window sandboxed with contextIsolation and no Node integration', async () => {
      const { BrowserWindow } = await import('electron');
      const before = (BrowserWindow as unknown as Mock).mock.calls.length;
      const closed = await openPip('sandbox-lock-pip');
      const pipCall = (BrowserWindow as unknown as Mock).mock.calls[before];
      expect(pipCall[0].webPreferences.sandbox).toBe(true);
      expect(pipCall[0].webPreferences.contextIsolation).toBe(true);
      expect(pipCall[0].webPreferences.nodeIntegration).toBe(false);
      closed();
    });

    it('allows the main frame to open PiP from the signed SPA cache', async () => {
      const { app } = await import('electron');
      const { setRemoteSpaState } = await import('../../../src/main/spaState');
      const originalMainFrame = mockWebContents.mainFrame;
      const testApp = app as unknown as { isPackaged: boolean };
      testApp.isPackaged = true;
      setRemoteSpaState(null);
      mockWebContents.mainFrame = { url: 'spa-cache://concord/index.html', frameTreeNodeId: 77 };
      mockWebContents.getURL.mockReturnValue('spa-cache://concord/index.html');
      try {
        // #86: the bound saas primary's main frame (parent === null) on the cache origin.
        const closed = await openPip('cache-main', {
          sender: mockWebContents,
          senderFrame: { url: 'spa-cache://concord/index.html', frameTreeNodeId: 77, parent: null },
        });
        expect(mockPipWindow.loadURL).toHaveBeenCalledWith(
          'spa-cache://concord/index.html#/pip/cache-main'
        );
        closed();
      } finally {
        mockWebContents.getURL.mockReturnValue('');
        mockWebContents.mainFrame = originalMainFrame;
        testApp.isPackaged = false;
      }
    });

    it('lets the opener focus, update, and close its PiP window', async () => {
      const { BrowserWindow } = await import('electron');
      const before = (BrowserWindow as unknown as Mock).mock.calls.length;
      const closed = await openPip('owner-controls-pip');
      expect((BrowserWindow as unknown as Mock).mock.calls.length).toBe(before + 1);

      mockPipWindow.focus.mockClear();
      mockPipWindow.setAlwaysOnTop.mockClear();
      mockPipWindow.close.mockClear();
      await handlers.get('pip:open')!(pipOwnerEvent, { id: 'owner-controls-pip' });
      expect((BrowserWindow as unknown as Mock).mock.calls.length).toBe(before + 1);
      await handlers.get('pip:setAlwaysOnTop')!(pipOwnerEvent, {
        id: 'owner-controls-pip',
        flag: false,
      });
      await handlers.get('pip:close')!(pipOwnerEvent, { id: 'owner-controls-pip' });
      expect(mockPipWindow.focus).toHaveBeenCalled();
      expect(mockPipWindow.setAlwaysOnTop).toHaveBeenCalledWith(false);
      expect(mockPipWindow.close).toHaveBeenCalled();
      closed();
    });

    it('lets the PiP window main frame update and close itself', async () => {
      const closed = await openPip('child-controls-pip');
      const pipMainFrameEvent = pipMainFrame();
      mockPipWindow.setAlwaysOnTop.mockClear();
      mockPipWindow.close.mockClear();

      await handlers.get('pip:setAlwaysOnTop')!(pipMainFrameEvent, {
        id: 'child-controls-pip',
        flag: false,
      });
      await handlers.get('pip:close')!(pipMainFrameEvent, { id: 'child-controls-pip' });

      expect(mockPipWindow.setAlwaysOnTop).toHaveBeenCalledWith(false);
      expect(mockPipWindow.close).toHaveBeenCalled();
      closed();
    });

    it.each([foreignIpcEvent, { senderFrame: null }])(
      'rejects an untrusted or missing sender for every PiP mutation',
      async (event) => {
        // Use call-count delta (not mockClear) so the BrowserWindow mock's
        // history remains intact for downstream tests (e.g. createWindow's
        // "called during module init" assertion).
        const { BrowserWindow } = await import('electron');
        const before = (BrowserWindow as unknown as Mock).mock.calls.length;
        mockPipWindow.close.mockClear();
        mockPipWindow.setAlwaysOnTop.mockClear();
        await expect(handlers.get('pip:open')!(event, { id: 'rejected-pip' })).rejects.toThrow();
        await handlers.get('pip:close')!(event, { id: 'rejected-pip' });
        await handlers.get('pip:setAlwaysOnTop')!(event, { id: 'rejected-pip', flag: false });
        const after = (BrowserWindow as unknown as Mock).mock.calls.length;
        expect(after).toBe(before);
        expect(mockPipWindow.close).not.toHaveBeenCalled();
        expect(mockPipWindow.setAlwaysOnTop).not.toHaveBeenCalled();
      }
    );

    it('rejects another permitted frame with a different frameTreeNodeId', async () => {
      const { BrowserWindow } = await import('electron');
      const before = (BrowserWindow as unknown as Mock).mock.calls.length;
      const closed = await openPip('frame-owned-pip');
      expect((BrowserWindow as unknown as Mock).mock.calls.length).toBe(before + 1);
      mockPipWindow.focus.mockClear();
      mockPipWindow.close.mockClear();
      mockPipWindow.setAlwaysOnTop.mockClear();

      await expect(
        handlers.get('pip:open')!(otherPermittedPipEvent, { id: 'frame-owned-pip' })
      ).rejects.toThrow();
      expect((BrowserWindow as unknown as Mock).mock.calls.length).toBe(before + 1);
      await handlers.get('pip:close')!(otherPermittedPipEvent, { id: 'frame-owned-pip' });
      await handlers.get('pip:setAlwaysOnTop')!(otherPermittedPipEvent, {
        id: 'frame-owned-pip',
        flag: false,
      });

      expect(mockPipWindow.focus).not.toHaveBeenCalled();
      expect(mockPipWindow.close).not.toHaveBeenCalled();
      expect(mockPipWindow.setAlwaysOnTop).not.toHaveBeenCalled();
      closed();
    });

    // ── #3104 D6: the per-window PiP session capability ──────────────
    //
    // `pip:session` is the ONLY disclosure path for the token that authenticates
    // the `concord-pip` RPC channel. Everything below is a negative control on
    // that disclosure: a frame that is not the PiP's own main frame must get
    // `null`, not a token, because a token is a working capability.

    it('pushes pip:opened with a per-window token to the main window', async () => {
      mockWebContents.send.mockClear();
      const closedA = await openPip('token-push-a');
      const closedB = await openPip('token-push-b');

      const opened = mockWebContents.send.mock.calls.filter((c) => c[0] === 'pip:opened');
      expect(opened).toHaveLength(2);
      expect(opened[0][1].id).toBe('token-push-a');
      expect(opened[1][1].id).toBe('token-push-b');
      expect(typeof opened[0][1].token).toBe('string');
      expect(opened[0][1].token.length).toBeGreaterThanOrEqual(32);
      // Distinct windows never share a capability.
      expect(opened[0][1].token).not.toBe(opened[1][1].token);

      closedA();
      closedB();
    });

    it('returns the token ONLY to the PiP window own main frame', async () => {
      mockWebContents.send.mockClear();
      const closed = await openPip('session-token-pip');
      const pushed = mockWebContents.send.mock.calls.find((c) => c[0] === 'pip:opened')?.[1] as {
        id: string;
        token: string;
      };

      const pipMainFrameEvent = pipMainFrame();
      const granted = await handlers.get('pip:session')!(pipMainFrameEvent, {
        id: 'session-token-pip',
      });
      expect(granted).toEqual({ token: pushed.token });
      closed();
    });

    it.each([
      ['the opener frame', () => pipOwnerEvent],
      ['another permitted frame', () => otherPermittedPipEvent],
      ['an untrusted origin', () => foreignIpcEvent],
      ['a frameless sender', () => ({ senderFrame: null })],
    ])('refuses pip:session to %s', async (_label, makeEvent) => {
      const child = {
        ...mockMainWindow,
        // #86: the shell is a BaseWindow without loadURL; a PiP is a BrowserWindow.
        loadURL: vi.fn().mockResolvedValue(undefined),
        on: vi.fn(),
        webContents: {
          ...mockWebContents,
          // #86: its own identity, or the 'pip' binding collides with the saas primary.
          id: 900,
          mainFrame: {
            url: 'http://localhost:3001/#/pip/session-denied-pip',
            frameTreeNodeId: 900,
          },
        },
      };
      (MockBrowserWindow as Mock).mockImplementationOnce(function () {
        return child;
      });
      await handlers.get('pip:open')!(pipOwnerEvent, { id: 'session-denied-pip' });
      // #86: shellWindow.ts and main.ts each add a 'closed' listener; run them all.
      const closedListeners = child.on.mock.calls
        .filter((call) => call[0] === 'closed')
        .map((call) => call[1] as () => void);
      const closed = (
        closedListeners.length > 0
          ? () => closedListeners.forEach((listener) => listener())
          : undefined
      ) as () => void;
      expect(closed).toBeDefined();
      const result = await handlers.get('pip:session')!(makeEvent(), {
        id: 'session-denied-pip',
      });
      expect(result).toBeNull();
      closed();
    });

    it('refuses pip:session for an unknown or already-closed PiP id', async () => {
      expect(
        await handlers.get('pip:session')!(
          { sender: mockWebContents, senderFrame: trustedIpcEvent.senderFrame },
          { id: 'never-opened-pip' }
        )
      ).toBeNull();

      const closed = await openPip('transient-session-pip');
      // The closed PiP's OWN main frame: the one sender that held the token.
      const pipMainFrameEvent = pipMainFrame();
      closed();
      expect(
        await handlers.get('pip:session')!(pipMainFrameEvent, { id: 'transient-session-pip' })
      ).toBeNull();
    });

    it('refuses pip:session for a malformed id payload', async () => {
      const closed = await openPip('malformed-session-pip');
      const pipMainFrameEvent = pipMainFrame();
      for (const payload of [undefined, null, {}, { id: 42 }, { id: '' }]) {
        expect(await handlers.get('pip:session')!(pipMainFrameEvent, payload)).toBeNull();
      }
      closed();
    });

    // A remote-SPA PiP keeps its own controls only while the origin main loaded it
    // from is still the current one: turning the remote SPA off, or moving it to
    // another origin, revokes them. A bundled PiP's app:// frame needs no remote
    // origin, so it keeps them when the remote SPA comes up.
    it.each([
      {
        name: 'remote to bundled',
        initialRemoteSpaUrl: 'https://spa.example.test/spa/a/index.html',
        nextRemoteSpaUrl: null,
        senderFrameUrl: 'https://spa.example.test/spa/a/index.html#/pip/transition-pip',
        admitted: false,
      },
      {
        name: 'remote to another remote origin',
        initialRemoteSpaUrl: 'https://spa.example.test/spa/a/index.html',
        nextRemoteSpaUrl: 'https://spa-b.example.test/index.html',
        senderFrameUrl: 'https://spa.example.test/spa/a/index.html#/pip/transition-pip',
        admitted: false,
      },
      {
        name: 'bundled to remote',
        initialRemoteSpaUrl: null,
        nextRemoteSpaUrl: 'https://spa.example.test/spa/b/index.html',
        senderFrameUrl: 'app://concord/index.html#/pip/transition-pip',
        admitted: true,
      },
    ])(
      'PiP self controls across a $name SPA transition (admitted: $admitted)',
      async (transition) => {
        const { app } = await import('electron');
        const { setRemoteSpaState } = await import('../../../src/main/spaState');
        const originalPipFrame = pipFrame.current;
        const testApp = app as unknown as { isPackaged: boolean };
        testApp.isPackaged = true;
        setRemoteSpaState(transition.initialRemoteSpaUrl);
        pipFrame.current = {
          url: transition.senderFrameUrl,
          frameTreeNodeId: 88,
          parent: null,
        };

        let closed: (() => void) | undefined;
        try {
          closed = await openPip('transition-pip', {
            sender: mockWebContents,
            senderFrame: {
              url: transition.senderFrameUrl,
              frameTreeNodeId: 77,
              parent: null,
            },
          });
          const pipMainFrameEvent = pipMainFrame();
          setRemoteSpaState(transition.nextRemoteSpaUrl);
          mockPipWindow.setAlwaysOnTop.mockClear();
          mockPipWindow.close.mockClear();

          await handlers.get('pip:setAlwaysOnTop')!(pipMainFrameEvent, {
            id: 'transition-pip',
            flag: false,
          });
          await handlers.get('pip:close')!(pipMainFrameEvent, { id: 'transition-pip' });

          expect(mockPipWindow.setAlwaysOnTop.mock.calls).toEqual(
            transition.admitted ? [[false]] : []
          );
          expect(mockPipWindow.close).toHaveBeenCalledTimes(transition.admitted ? 1 : 0);
        } finally {
          closed?.();
          setRemoteSpaState(null);
          testApp.isPackaged = false;
          pipFrame.current = originalPipFrame;
        }
      }
    );

    // A remote-SPA PiP whose pinned origin stops being current is refused on every
    // pip-scoped channel, its own pip:close included, and it is frameless, so main
    // tears it down at the transition rather than strand it until quit. A PiP whose
    // pin is still the current origin (same origin, new hash) stays open.
    it.each([
      {
        name: 'remote to bundled',
        initialRemoteSpaUrl: 'https://spa.example.test/spa/a/index.html',
        nextRemoteSpaUrl: null,
        senderFrameUrl: 'https://spa.example.test/spa/a/index.html#/pip/stale-pin-pip',
        closesPip: true,
      },
      {
        name: 'remote to another remote origin',
        initialRemoteSpaUrl: 'https://spa.example.test/spa/a/index.html',
        nextRemoteSpaUrl: 'https://spa-b.example.test/index.html',
        senderFrameUrl: 'https://spa.example.test/spa/a/index.html#/pip/stale-pin-pip',
        closesPip: true,
      },
      {
        name: 'remote to the same origin at a new hash',
        initialRemoteSpaUrl: 'https://spa.example.test/spa/a/index.html',
        nextRemoteSpaUrl: 'https://spa.example.test/spa/b/index.html',
        senderFrameUrl: 'https://spa.example.test/spa/a/index.html#/pip/stale-pin-pip',
        closesPip: false,
      },
      {
        name: 'bundled to remote',
        initialRemoteSpaUrl: null,
        nextRemoteSpaUrl: 'https://spa.example.test/spa/b/index.html',
        senderFrameUrl: 'app://concord/index.html#/pip/stale-pin-pip',
        closesPip: false,
      },
    ])(
      'a $name SPA transition closes the PiP only if its pin went stale (closes: $closesPip)',
      async (transition) => {
        const { app } = await import('electron');
        const { setRemoteSpaState } = await import('../../../src/main/spaState');
        const originalPipFrame = pipFrame.current;
        const testApp = app as unknown as { isPackaged: boolean };
        testApp.isPackaged = true;
        setRemoteSpaState(transition.initialRemoteSpaUrl);
        pipFrame.current = { url: transition.senderFrameUrl, frameTreeNodeId: 88, parent: null };

        let closed: (() => void) | undefined;
        try {
          closed = await openPip('stale-pin-pip', {
            sender: mockWebContents,
            senderFrame: { url: transition.senderFrameUrl, frameTreeNodeId: 77, parent: null },
          });
          mockPipWindow.destroy.mockClear();
          mockPipWindow.close.mockClear();
          const pushesBefore = mockWebContents.send.mock.calls.length;

          setRemoteSpaState(transition.nextRemoteSpaUrl);
          // The same state written again (a re-entered fallback) before Electron
          // emits 'closed' must not tear the window down a second time.
          setRemoteSpaState(transition.nextRemoteSpaUrl);

          expect(mockPipWindow.destroy).toHaveBeenCalledTimes(transition.closesPip ? 1 : 0);
          // Not close(): a renderer beforeunload guard must not be able to veto it.
          expect(mockPipWindow.close).not.toHaveBeenCalled();

          // Electron guarantees 'closed' after destroy(); its handling runs once.
          closed();
          closed = undefined;
          const closedPushes = mockWebContents.send.mock.calls
            .slice(pushesBefore)
            .filter((call) => call[0] === 'pip:closed');
          expect(closedPushes).toEqual([['pip:closed', { id: 'stale-pin-pip' }]]);
        } finally {
          closed?.();
          setRemoteSpaState(null);
          testApp.isPackaged = false;
          pipFrame.current = originalPipFrame;
        }
      }
    );

    it('leaves a PiP that pinned no remote origin open across every SPA transition', async () => {
      const { app } = await import('electron');
      const { setRemoteSpaState } = await import('../../../src/main/spaState');
      const originalPipFrame = pipFrame.current;
      const testApp = app as unknown as { isPackaged: boolean };
      testApp.isPackaged = true;
      setRemoteSpaState(null);
      const frameUrl = 'app://concord/index.html#/pip/unpinned-pip';
      pipFrame.current = { url: frameUrl, frameTreeNodeId: 88, parent: null };

      let closed: (() => void) | undefined;
      try {
        closed = await openPip('unpinned-pip', {
          sender: mockWebContents,
          senderFrame: { url: frameUrl, frameTreeNodeId: 77, parent: null },
        });
        mockPipWindow.destroy.mockClear();
        mockPipWindow.close.mockClear();
        for (const url of [
          'https://spa.example.test/spa/a/index.html',
          'https://spa.example.test/spa/b/index.html',
          'https://spa-b.example.test/index.html',
          null,
          null,
        ]) {
          setRemoteSpaState(url);
        }
        expect(mockPipWindow.destroy).not.toHaveBeenCalled();
        expect(mockPipWindow.close).not.toHaveBeenCalled();
      } finally {
        closed?.();
        setRemoteSpaState(null);
        testApp.isPackaged = false;
        pipFrame.current = originalPipFrame;
      }
    });

    // #86 R8: only a bound primary's MAIN frame may open a PiP, so the second
    // opener is another connection's primary rather than a second frame of the
    // saas view (which senderMainFrame now refuses before any PiP logic runs).
    it('assigns a fresh owner when a closed PiP ID is reused', async () => {
      const svc = connectionRegistry.registerService('https://pip-reuse.example', {
        makeSession: () => ({}) as never,
        makeCustody: () => ({}) as never,
        isValidatedSelfHostedApiBase: () => true,
      });
      if (!svc.ok) throw new Error(svc.reason);
      const otherFrame = { url: 'http://localhost:3001/', frameTreeNodeId: 8801, parent: null };
      const otherWc = {
        id: 8801,
        send: vi.fn(),
        on: vi.fn(),
        once: vi.fn(),
        isDestroyed: vi.fn(() => false),
        getURL: vi.fn(() => otherFrame.url),
        mainFrame: otherFrame,
      };
      const opened = connectionRegistry.openConnection(
        svc.service.serviceId,
        otherWc as never,
        null
      );
      if (!opened.ok) throw new Error(opened.reason);
      connectionRegistry.bindSender(otherWc as never, opened.record.connectionId, 'primary');
      const otherOwnerEvent = { sender: otherWc, senderFrame: otherFrame };

      try {
        const closeFirst = await openPip('reused-pip');
        closeFirst();
        // pip:open is foreground-only (#86): the other connection must be foreground to open.
        const priorForeground = connectionRegistry.foreground()?.connectionId ?? null;
        connectionRegistry.setForeground(opened.record.connectionId);
        const closeSecond = await openPip('reused-pip', otherOwnerEvent as never);
        if (priorForeground) connectionRegistry.setForeground(priorForeground);
        mockPipWindow.setAlwaysOnTop.mockClear();

        await handlers.get('pip:setAlwaysOnTop')!(pipOwnerEvent, {
          id: 'reused-pip',
          flag: false,
        });
        expect(mockPipWindow.setAlwaysOnTop).not.toHaveBeenCalled();
        await handlers.get('pip:setAlwaysOnTop')!(otherOwnerEvent, {
          id: 'reused-pip',
          flag: false,
        });
        expect(mockPipWindow.setAlwaysOnTop).toHaveBeenCalledWith(false);
        closeSecond();
      } finally {
        connectionRegistry.disposeConnection(opened.record.connectionId);
        connectionRegistry.unregisterService(svc.service.serviceId);
      }
    });

    // #178 (merged from main): the opener's main frame may reopen a closed PiP ID; the
    // reopened window is its own, and a second permitted frame still cannot mutate it.
    it('allows the main frame to reopen a closed PiP ID', async () => {
      const closeFirst = await openPip('reused-pip');
      closeFirst();
      const closeSecond = await openPip('reused-pip');
      mockPipWindow.setAlwaysOnTop.mockClear();

      await handlers.get('pip:setAlwaysOnTop')!(pipOwnerEvent, {
        id: 'reused-pip',
        flag: false,
      });
      expect(mockPipWindow.setAlwaysOnTop).toHaveBeenCalledWith(false);
      mockPipWindow.setAlwaysOnTop.mockClear();
      await handlers.get('pip:setAlwaysOnTop')!(otherPermittedPipEvent, {
        id: 'reused-pip',
        flag: false,
      });
      expect(mockPipWindow.setAlwaysOnTop).not.toHaveBeenCalled();
      closeSecond();
    });

    // #86 Phase-4 red team, RT4 and RT5 (PoCs PIP-1 to PIP-5): the PiP id namespace and the
    // open budget are per connection, under the process-wide ceiling. pip:open is
    // foreground-only, so every opener below is made foreground for its own opens.
    describe('#86 RT4/RT5: PiP ids and open budgets are per connection', () => {
      let nextRtOrigin = 0;
      let nextRtFrame = 9400;
      const windowsBuilt = (): number => (MockBrowserWindow as Mock).mock.calls.length;
      function saasConnectionId(): string {
        const id = connectionRegistry.bindingFor(mockWebContents as never)?.connectionId;
        if (!id) throw new Error('the saas view is not bound');
        return id;
      }
      // A bound self-hosted primary on a localhost frame, which the unpackaged
      // isValidPipOpenSender admits exactly as it would app://concord in a packaged build.
      function selfHostedOpener() {
        const svc = connectionRegistry.registerService(
          `https://pip-rt-${(nextRtOrigin += 1)}.example`,
          {
            makeSession: () => ({}) as never,
            makeCustody: () => ({}) as never,
            isValidatedSelfHostedApiBase: () => true,
          }
        );
        if (!svc.ok) throw new Error(svc.reason);
        const frameTreeNodeId = (nextRtFrame += 1);
        const frame = { url: 'http://localhost:3001/', frameTreeNodeId, parent: null };
        const wc = {
          id: frameTreeNodeId,
          send: vi.fn(),
          on: vi.fn(),
          once: vi.fn(),
          isDestroyed: vi.fn(() => false),
          getURL: vi.fn(() => frame.url),
          mainFrame: frame,
        };
        const opened = connectionRegistry.openConnection(svc.service.serviceId, wc as never, null);
        if (!opened.ok) throw new Error(opened.reason);
        connectionRegistry.bindSender(wc as never, opened.record.connectionId, 'primary');
        return {
          wc,
          connectionId: opened.record.connectionId as string,
          event: { sender: wc, senderFrame: frame },
          dispose: () => {
            connectionRegistry.disposeConnection(opened.record.connectionId);
            connectionRegistry.unregisterService(svc.service.serviceId);
          },
        };
      }
      const closers: Array<() => void> = [];
      async function openAs(
        connectionId: string,
        event: unknown,
        id: string
      ): Promise<'opened' | 'refused'> {
        connectionRegistry.setForeground(connectionId as never);
        try {
          closers.push(await openPip(id, event as never));
          return 'opened';
        } catch {
          return 'refused';
        } finally {
          connectionRegistry.setForeground(saasConnectionId() as never);
        }
      }
      function tokenPushed(send: Mock, id: string): string | undefined {
        const push = send.mock.calls.filter((c) => c[0] === 'pip:opened').at(-1)?.[1] as
          { id: string; token: string } | undefined;
        return push?.id === id ? push.token : undefined;
      }
      afterEach(() => {
        while (closers.length > 0) closers.pop()?.();
        connectionRegistry.setForeground(saasConnectionId() as never);
      });

      it("RT4 (PIP-1): another connection cannot squat the saas pop-out id 'controls-main'", async () => {
        const evil = selfHostedOpener();
        try {
          expect(await openAs(evil.connectionId, evil.event, 'controls-main')).toBe('opened');
          const before = windowsBuilt();
          // The user pops out the saas voice controls (PersistentVoiceBar.tsx's fixed id).
          expect(await openAs(saasConnectionId(), pipOwnerEvent, 'controls-main')).toBe('opened');
          expect(windowsBuilt() - before).toBe(1);
        } finally {
          while (closers.length > 0) closers.pop()?.();
          evil.dispose();
        }
      });

      it("RT4 (PIP-2): another connection's live PiP id looks exactly like an absent one", async () => {
        const evil = selfHostedOpener();
        try {
          expect(await openAs(saasConnectionId(), pipOwnerEvent, 'controls-main')).toBe('opened');
          mockPipWindow.focus.mockClear();
          const before = windowsBuilt();
          const probeLiveId = await openAs(evil.connectionId, evil.event, 'controls-main');
          const probeIdleId = await openAs(evil.connectionId, evil.event, 'never-used-id');
          expect({ probeLiveId, built: windowsBuilt() - before }).toEqual({
            probeLiveId: probeIdleId,
            built: 2,
          });
          // The saas PiP was neither focused nor otherwise touched by the probe.
          expect(mockPipWindow.focus).not.toHaveBeenCalled();
        } finally {
          while (closers.length > 0) closers.pop()?.();
          evil.dispose();
        }
      });

      it('RT4 (PIP-4): with colliding ids each connection reaches only its own PiP', async () => {
        const evil = selfHostedOpener();
        const results = (MockBrowserWindow as Mock).mock.results;
        try {
          expect(await openAs(saasConnectionId(), pipOwnerEvent, 'controls-main')).toBe('opened');
          const saasWindow = results[results.length - 1].value;
          const saasToken = tokenPushed(mockWebContents.send, 'controls-main');
          expect(await openAs(evil.connectionId, evil.event, 'controls-main')).toBe('opened');
          const evilWindow = results[results.length - 1].value;
          const evilToken = tokenPushed(evil.wc.send, 'controls-main');
          expect(typeof saasToken).toBe('string');
          expect(evilToken).not.toBe(saasToken);
          const evilPipEvent = {
            sender: evilWindow.webContents,
            senderFrame: evilWindow.webContents.mainFrame,
          };
          const saasPipEvent = {
            sender: saasWindow.webContents,
            senderFrame: saasWindow.webContents.mainFrame,
          };
          // The attacker's own PiP frame gets ITS token for the shared id, never the saas one.
          expect(
            await handlers.get('pip:session')!(evilPipEvent as never, { id: 'controls-main' })
          ).toEqual({ token: evilToken });
          mockPipWindow.setAlwaysOnTop.mockClear();
          mockPipWindow.close.mockClear();
          await handlers.get('pip:setAlwaysOnTop')!(evil.event as never, {
            id: 'controls-main',
            flag: false,
          });
          await handlers.get('pip:close')!(evil.event as never, { id: 'controls-main' });
          expect(mockPipWindow.setAlwaysOnTop.mock.contexts).toEqual([evilWindow]);
          expect(mockPipWindow.close.mock.contexts).toEqual([evilWindow]);
          // The attacker's PiP closes (its 'closed' listeners run); the saas entry survives it.
          closers.pop()?.();
          expect(
            await handlers.get('pip:session')!(saasPipEvent as never, { id: 'controls-main' })
          ).toEqual({ token: saasToken });
        } finally {
          while (closers.length > 0) closers.pop()?.();
          evil.dispose();
        }
      });

      it('RT5 (PIP-3): another connection cannot exhaust the saas PiP window budget', async () => {
        const { MAX_PIP_WINDOWS_PER_CONNECTION } = await import('../../../src/main/pipOpenPolicy');
        const evil = selfHostedOpener();
        try {
          let attackerOpened = 0;
          for (let n = 0; n < 12; n++) {
            if ((await openAs(evil.connectionId, evil.event, `flood-${n}`)) !== 'opened') break;
            attackerOpened += 1;
          }
          const saasResult = await openAs(saasConnectionId(), pipOwnerEvent, 'controls-main');
          expect(saasResult).toBe('opened');
          expect(attackerOpened).toBe(MAX_PIP_WINDOWS_PER_CONNECTION);
        } finally {
          while (closers.length > 0) closers.pop()?.();
          evil.dispose();
        }
      });

      it("RT5: another connection's open-and-close churn spends none of the saas tokens", async () => {
        const evil = selfHostedOpener();
        try {
          for (let n = 0; n < 8; n++) {
            expect(await openAs(evil.connectionId, evil.event, `churn-${n}`)).toBe('opened');
            closers.pop()?.();
          }
          // The attacker's own bucket is spent...
          expect(await openAs(evil.connectionId, evil.event, 'churn-ninth')).toBe('refused');
          // ...and the saas connection's is untouched.
          expect(await openAs(saasConnectionId(), pipOwnerEvent, 'controls-main')).toBe('opened');
        } finally {
          while (closers.length > 0) closers.pop()?.();
          evil.dispose();
        }
      });

      it('RT5: the process-wide ceiling still bounds every connection together', async () => {
        const { MAX_PIP_WINDOWS, MAX_PIP_WINDOWS_PER_CONNECTION } =
          await import('../../../src/main/pipOpenPolicy');
        const first = selfHostedOpener();
        const second = selfHostedOpener();
        try {
          const openUntilRefused = async (
            connectionId: string,
            event: unknown,
            prefix: string
          ): Promise<number> => {
            let opened = 0;
            while ((await openAs(connectionId, event, `${prefix}-${opened}`)) === 'opened') {
              opened += 1;
            }
            return opened;
          };
          const perConnection = [
            await openUntilRefused(saasConnectionId(), pipOwnerEvent, 'ceiling-saas'),
            await openUntilRefused(first.connectionId, first.event, 'ceiling-first'),
          ];
          expect(perConnection).toEqual([
            MAX_PIP_WINDOWS_PER_CONNECTION,
            MAX_PIP_WINDOWS - MAX_PIP_WINDOWS_PER_CONNECTION,
          ]);
          const before = windowsBuilt();
          expect(await openAs(second.connectionId, second.event, 'over-ceiling')).toBe('refused');
          expect(windowsBuilt()).toBe(before);
          // A freed slot is reusable by a connection under its own cap.
          closers.pop()?.();
          expect(await openAs(second.connectionId, second.event, 'freed-slot')).toBe('opened');
        } finally {
          while (closers.length > 0) closers.pop()?.();
          first.dispose();
          second.dispose();
        }
      });

      it('RT5: disposing a connection releases its open budget', async () => {
        const { _pipOpenBudgetHeldForTesting } = await import('../../../src/main/pipOpenPolicy');
        const evil = selfHostedOpener();
        try {
          expect(await openAs(evil.connectionId, evil.event, 'budget-held')).toBe('opened');
          closers.pop()?.();
          expect(_pipOpenBudgetHeldForTesting(evil.connectionId as never)).toBe(true);
        } finally {
          evil.dispose();
        }
        expect(_pipOpenBudgetHeldForTesting(evil.connectionId as never)).toBe(false);
      });
    });
  });

  describe('permission handlers', () => {
    it('denies web clipboard write permissions to PiP and subframes', () => {
      const callback = vi.fn();
      sessionHandlers.permissionRequest!({}, 'clipboard-sanitized-write', callback, {
        isMainFrame: true,
        requestingUrl: 'http://localhost:3001/',
      });
      expect(callback).toHaveBeenCalledWith(false);
      const result = sessionHandlers.permissionCheck!(
        mockWebContents,
        'clipboard-sanitized-write',
        'http://localhost:3001',
        { isMainFrame: false, requestingUrl: 'http://localhost:3001/' }
      );
      expect(result).toBe(false);
    });

    it.each(['clipboard-sanitized-write', 'clipboard-read'])(
      'grants %s only to the trusted main window main frame',
      (permission) => {
        const valid = { isMainFrame: true, requestingUrl: 'http://localhost:3001/' };
        const invalid = [
          [{}, valid],
          [mockWebContents, { ...valid, isMainFrame: false }],
          [mockWebContents, { ...valid, requestingUrl: 'https://evil.example/' }],
          [mockWebContents, undefined],
        ] as const;
        const callback = vi.fn();
        sessionHandlers.permissionRequest!(mockWebContents, permission, callback, valid);
        expect(callback).toHaveBeenLastCalledWith(true);
        expect(
          sessionHandlers.permissionCheck!(
            mockWebContents,
            permission,
            'http://localhost:3001',
            valid
          )
        ).toBe(true);
        for (const [sender, details] of invalid) {
          sessionHandlers.permissionRequest!(sender, permission, callback, details);
          expect(callback).toHaveBeenLastCalledWith(false);
          expect(
            sessionHandlers.permissionCheck!(sender, permission, 'http://localhost:3001', details)
          ).toBe(false);
        }
        // #86: a destroyed main window is, for a bound view, one no longer foreground.
        const fg = connectionRegistry.foreground()?.connectionId ?? null;
        connectionRegistry.setForeground(null);
        try {
          expect(
            sessionHandlers.permissionCheck!(
              mockWebContents,
              permission,
              'http://localhost:3001',
              valid
            )
          ).toBe(false);
        } finally {
          connectionRegistry.setForeground(fg);
        }
      }
    );

    it('denies geolocation requests', () => {
      expect(sessionHandlers.permissionRequest).toBeDefined();
      const callback = vi.fn();
      sessionHandlers.permissionRequest!(mockWebContents, 'geolocation', callback);
      expect(callback).toHaveBeenCalledWith(false);
    });

    it('allows camera requests', () => {
      const callback = vi.fn();
      sessionHandlers.permissionRequest!(mockWebContents, 'media', callback);
      expect(callback).toHaveBeenCalledWith(true);
    });

    it('allows notification requests', () => {
      const callback = vi.fn();
      sessionHandlers.permissionRequest!(mockWebContents, 'notifications', callback);
      expect(callback).toHaveBeenCalledWith(true);
    });

    it('allows speaker-selection requests', () => {
      const callback = vi.fn();
      sessionHandlers.permissionRequest!(mockWebContents, 'speaker-selection', callback);
      expect(callback).toHaveBeenCalledWith(true);
    });

    it('permission check denies geolocation', () => {
      expect(sessionHandlers.permissionCheck).toBeDefined();
      const result = sessionHandlers.permissionCheck!(null, 'geolocation');
      expect(result).toBe(false);
    });

    it('permission check allows camera', () => {
      const result = sessionHandlers.permissionCheck!(null, 'media');
      expect(result).toBe(true);
    });

    it('permission check allows speaker-selection', () => {
      const result = sessionHandlers.permissionCheck!(null, 'speaker-selection');
      expect(result).toBe(true);
    });

    it('device permission allows camera/microphone/speaker/hid', () => {
      expect(sessionHandlers.devicePermission).toBeDefined();
      expect(sessionHandlers.devicePermission!({ deviceType: 'camera' })).toBe(true);
      expect(sessionHandlers.devicePermission!({ deviceType: 'microphone' })).toBe(true);
      expect(sessionHandlers.devicePermission!({ deviceType: 'speaker' })).toBe(true);
      expect(sessionHandlers.devicePermission!({ deviceType: 'hid' })).toBe(true);
    });

    it('device permission denies unknown types', () => {
      expect(sessionHandlers.devicePermission!({ deviceType: 'serial' })).toBe(false);
    });

    it('HID device selection picks first device', () => {
      expect(sessionHandlers.hidSelect).toBeDefined();
      const event = { preventDefault: vi.fn() };
      const callback = vi.fn();
      sessionHandlers.hidSelect!(event, { deviceList: [{ deviceId: 'dev-1' }] }, callback);
      expect(event.preventDefault).toHaveBeenCalled();
      expect(callback).toHaveBeenCalledWith('dev-1');
    });

    it('HID device selection returns empty when no devices', () => {
      const event = { preventDefault: vi.fn() };
      const callback = vi.fn();
      sessionHandlers.hidSelect!(event, { deviceList: [] }, callback);
      expect(callback).toHaveBeenCalledWith('');
    });
  });

  describe('app lifecycle callbacks', () => {
    it('before-quit stops auto-updater and force-destroys PiP windows', async () => {
      const { stopAutoUpdater } = await import('../../../src/main/updater');
      const beforeQuit = appOnCallbacks.get('before-quit');
      expect(beforeQuit).toBeDefined();
      // #86 R8: the opener must be the bound saas view's MAIN frame (parent null,
      // its frameTreeNodeId); a bare-url frame is refused and opens no PiP.
      await handlers.get('pip:open')!(
        {
          sender: mockWebContents,
          senderFrame: { url: 'http://localhost:3001/', frameTreeNodeId: 77, parent: null },
        },
        { id: 'before-quit-pip' }
      );
      mockPipWindow.destroy.mockClear();

      beforeQuit!();

      expect(stopAutoUpdater).toHaveBeenCalled();
      expect(mockPipWindow.destroy).toHaveBeenCalled();
    });

    it('before-quit-for-update force-destroys PiP windows', async () => {
      const { autoUpdater } = await import('electron');
      const beforeQuitForUpdate = (autoUpdater.on as Mock).mock.calls.find(
        (call) => call[0] === 'before-quit-for-update'
      )?.[1] as (() => void) | undefined;
      expect(beforeQuitForUpdate).toBeDefined();
      // #86 R8: the opener must be the bound saas view's MAIN frame (parent null,
      // its frameTreeNodeId); a bare-url frame is refused and opens no PiP.
      await handlers.get('pip:open')!(
        {
          sender: mockWebContents,
          senderFrame: { url: 'http://localhost:3001/', frameTreeNodeId: 77, parent: null },
        },
        { id: 'before-update-quit-pip' }
      );
      mockPipWindow.destroy.mockClear();

      beforeQuitForUpdate!();

      expect(mockPipWindow.destroy).toHaveBeenCalled();
    });

    it('window-all-closed quits on non-macOS', async () => {
      const { app } = await import('electron');
      (app.quit as Mock).mockClear();
      const windowAllClosed = appOnCallbacks.get('window-all-closed');
      expect(windowAllClosed).toBeDefined();
      // Assert the non-macOS branch explicitly. Gating on the runner's own OS
      // made this assertion silently vanish on a macOS laptop — the test named
      // "quits on non-macOS" was the one platform where it checked nothing.
      setPlatform('linux');
      windowAllClosed!();
      expect(app.quit).toHaveBeenCalled();
    });

    it('proactive refresh callback sends to renderer', async () => {
      const { setProactiveRefreshCallback } = await import('../../../src/main/tokenManager');
      const cb = (setProactiveRefreshCallback as Mock).mock.calls[0]?.[0] as (
        ...args: unknown[]
      ) => void;
      expect(cb).toBeDefined();
      mockWebContents.send.mockClear();
      cb('new-access-token', 'new-session-id', 'previous-session-id');
      expect(mockWebContents.send).toHaveBeenCalledWith('auth:token-refreshed', {
        accessToken: 'new-access-token',
        sessionId: 'new-session-id',
        previousSessionId: 'previous-session-id',
      });
    });

    it('resume handler triggers onSystemResume', async () => {
      const { powerMonitor } = await import('electron');
      const { onSystemResume } = await import('../../../src/main/tokenManager');
      const resumeCall = (powerMonitor.on as Mock).mock.calls.find(
        (c: unknown[]) => c[0] === 'resume'
      );
      expect(resumeCall).toBeDefined();
      (onSystemResume as Mock).mockClear();
      resumeCall![1]();
      expect(onSystemResume).toHaveBeenCalled();
    });
  });

  describe('createWindow', () => {
    it('creates the shell BaseWindow and the saas WebContentsView', async () => {
      const { BaseWindow, WebContentsView } = await import('electron');
      // Both were constructed during module init (createWindow from whenReady).
      expect(BaseWindow).toHaveBeenCalled();
      expect(WebContentsView).toHaveBeenCalled();
      expect(mockMainWindow.contentView.addChildView).toHaveBeenCalledWith(mockView);
    });

    it('registers the first-load handler on the saas view', () => {
      // A BaseWindow has no 'ready-to-show'; the saas view's first did-finish-load
      // stands in for it.
      expect(mockWebContents.once).toHaveBeenCalledWith('did-finish-load', expect.any(Function));
    });

    it('constructs the main window sandboxed with contextIsolation and no Node integration (dev build)', async () => {
      const { BaseWindow, WebContentsView, session } = await import('electron');
      // The window carries no web preferences: its views do.
      const windowCall = (BaseWindow as unknown as Mock).mock.calls[0];
      expect(windowCall?.[0]?.webPreferences).toBeUndefined();
      const mainCall = (WebContentsView as unknown as Mock).mock.calls.find((c) =>
        (c[0]?.webPreferences?.preload as string | undefined)?.endsWith('preload/preload.js')
      );
      expect(mainCall).toBeDefined();
      const webPreferences = mainCall![0].webPreferences;
      expect(webPreferences.sandbox).toBe(true);
      expect(webPreferences.contextIsolation).toBe(true);
      expect(webPreferences.nodeIntegration).toBe(false);
      // R1: the saas view runs on defaultSession.
      expect(webPreferences.session).toBe(session.defaultSession);
    });

    it('registers closed handler', () => {
      expect(mockMainWindow.on).toHaveBeenCalledWith('closed', expect.any(Function));
    });

    it('registers window open handler for external links', async () => {
      // The handler is registered per-contents inside the `web-contents-created`
      // callback (externalizeWindowOpen, main.ts), not directly on the main
      // window's webContents — invoke that callback to observe it.
      const { app } = await import('electron');
      const webContentsCreated = (app.on as Mock).mock.calls.find(
        (c: unknown[]) => c[0] === 'web-contents-created'
      );
      expect(webContentsCreated).toBeDefined();
      const mockContents = createMockContents();
      webContentsCreated![1]({}, mockContents);
      expect(mockContents.setWindowOpenHandler).toHaveBeenCalled();
    });
  });

  describe('GPU_VENDORS mapping', () => {
    it('maps Intel vendor ID', async () => {
      const { app } = await import('electron');
      (app.getGPUInfo as Mock).mockResolvedValueOnce({
        gpuDevice: [{ vendorId: 0x8086, deviceId: 0x5678 }],
      });
      const result = (await handlers.get('gpu:getInfo')!(trustedIpcEvent)) as {
        vendor: string;
      } | null;
      expect(result!.vendor).toBe('Intel');
    });

    it('maps Apple vendor ID', async () => {
      const { app } = await import('electron');
      (app.getGPUInfo as Mock).mockResolvedValueOnce({
        gpuDevice: [{ vendorId: 0x106b, deviceId: 0x0001 }],
      });
      const result = (await handlers.get('gpu:getInfo')!(trustedIpcEvent)) as {
        vendor: string;
      } | null;
      expect(result!.vendor).toBe('Apple');
    });

    it('maps AMD vendor ID', async () => {
      const { app } = await import('electron');
      (app.getGPUInfo as Mock).mockResolvedValueOnce({
        gpuDevice: [{ vendorId: 0x1002, deviceId: 0x0001 }],
      });
      const result = (await handlers.get('gpu:getInfo')!(trustedIpcEvent)) as {
        vendor: string;
      } | null;
      expect(result!.vendor).toBe('AMD');
    });

    it('handles unknown vendor ID', async () => {
      const { app } = await import('electron');
      (app.getGPUInfo as Mock).mockResolvedValueOnce({
        gpuDevice: [{ vendorId: 0x9999, deviceId: 0x0001 }],
      });
      const result = (await handlers.get('gpu:getInfo')!(trustedIpcEvent)) as {
        vendor: string;
      } | null;
      expect(result!.vendor).toContain('Unknown');
    });

    it('returns null when no GPU device', async () => {
      const { app } = await import('electron');
      (app.getGPUInfo as Mock).mockResolvedValueOnce({ gpuDevice: [] });
      const result = await handlers.get('gpu:getInfo')!(trustedIpcEvent);
      expect(result).toBeNull();
    });

    it('skips hex-only driverVendor on macOS', async () => {
      const { app } = await import('electron');
      (app.getGPUInfo as Mock).mockResolvedValueOnce({
        gpuDevice: [
          { vendorId: 0x106b, deviceId: 0x0001, driverVendor: '0x106b', driverDescription: 'M1' },
        ],
      });
      const result = (await handlers.get('gpu:getInfo')!(trustedIpcEvent)) as {
        vendor: string;
      } | null;
      expect(result!.vendor).toBe('Apple'); // Falls back to vendor map, not hex string
    });

    it('maps interleaved Chromium encode profiles by exact value', async () => {
      const { app } = await import('electron');
      (app.getGPUInfo as Mock).mockResolvedValueOnce({
        gpuDevice: [{ vendorId: 0x10de, deviceId: 0x0001 }],
        videoEncodeAcceleratorSupportedProfiles: [
          { profile: 24 }, // AV1, not HEVC
          { profile: 16 }, // HEVC
          { profile: 23 }, // Theora, ignored
          { profile: 27 }, // Dolby Vision, ignored
          { profile: 35 }, // HEVC extension profile
          { profile: 11 }, // VP8
        ],
      });
      const result = (await handlers.get('gpu:getInfo')!(trustedIpcEvent)) as {
        encodeProfiles: string[];
      } | null;
      expect(result!.encodeProfiles.sort()).toEqual(['video/AV1', 'video/HEVC', 'video/VP8']);
    });
  });

  describe('deep-link queue (#945)', () => {
    // Valid codes only — deepLink.ts rejects I/O/l/0/1 and anything but 8 chars.
    const TEN_CODES = [
      'AAAAAAA2',
      'AAAAAAA3',
      'AAAAAAA4',
      'AAAAAAA5',
      'AAAAAAA6',
      'AAAAAAA7',
      'AAAAAAA8',
      'AAAAAAA9',
      'AAAAAAB2',
      'AAAAAAB3',
    ];
    const FRIEND_CODE = 'AbCdEfGh';
    const INVITE_CODE = 'AbCdEfGj';
    const rendererEvent = trustedIpcEvent;

    let DEEP_LINK_EMIT_WINDOW_MS: number;
    let deliverDeepLink: (url: string) => void;
    let signalInviteReady: CallbackFn;
    let signalFriendReady: CallbackFn;
    let simulateReload: CallbackFn;

    beforeAll(async () => {
      const { ipcMain } = await import('electron');
      const ipcListener = (channel: string): CallbackFn => {
        const call = (ipcMain.on as Mock).mock.calls.find((c: unknown[]) => c[0] === channel);
        expect(call, `ipcMain.on('${channel}') was never registered`).toBeDefined();
        return call![1] as CallbackFn;
      };
      signalInviteReady = ipcListener('invite:renderer-ready');
      signalFriendReady = ipcListener('deeplink:renderer-ready');

      const didStartLoading = mockWebContents.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'did-start-loading'
      )?.[1] as CallbackFn | undefined;
      expect(didStartLoading).toBeDefined();
      simulateReload = didStartLoading!;

      const openUrl = appOnCallbacks.get('open-url');
      expect(openUrl).toBeDefined();
      deliverDeepLink = (url: string) => openUrl!({ preventDefault: vi.fn() }, url);

      // Import the window rather than restating 1000: a burst test that
      // advanced a stale literal would leave a real deferred send to fire
      // mid-suite and pollute a later test's send assertions.
      ({ DEEP_LINK_EMIT_WINDOW_MS } = await import('../../../src/main/main'));
    });

    // The queue and both readiness flags are module state in main.ts that
    // outlives a single test. Arm both flags so a drain empties whatever a
    // previous test left queued, then drop both the way a renderer reload does.
    // Synchronous on purpose: an await here would let createWindow's 1s
    // deferred drain interleave with a test's own arm/drain sequence.
    // Drains to quiescence rather than assuming one ready+reload empties things.
    // Since #945 (M0/Md3) the gate holds a bounded FIFO and releases ONE code per
    // emit window, and a lifecycle reset re-queues whatever is still held instead
    // of relying on a timer it has just cleared — so after a burst test a single
    // ready+reload leaves codes queued, and they surfaced in whichever test ran
    // next. Cycling ready + one window until the buffers are empty is what makes
    // each case independent again.
    function resetDeepLinkState(): void {
      vi.useFakeTimers();
      try {
        // Loop to QUIESCENCE, not a fixed count: switching back to real timers
        // destroys any still-pending flush, which would strand a held code that
        // the closing reload then re-queues — the leak this helper exists to
        // prevent. A cycle that emits nothing means both buffers are empty.
        for (let i = 0; i < 40; i += 1) {
          const before = mockWebContents.send.mock.calls.length;
          // Reload FIRST. A prior test usually leaves readiness already true, so
          // signalling it again drains nothing and the quiescence check would
          // break out on cycle 0 with codes still queued. The reload drops both
          // flags (and re-queues anything held), so the signals below are always
          // a false->true transition and always force a drain.
          simulateReload();
          signalInviteReady(rendererEvent);
          signalFriendReady(rendererEvent);
          vi.advanceTimersByTime(DEEP_LINK_EMIT_WINDOW_MS);
          if (mockWebContents.send.mock.calls.length === before) break;
        }
      } finally {
        vi.useRealTimers();
      }
      simulateReload();
      mockWebContents.send.mockClear();
    }

    function sentOn(channel: string): string[] {
      return mockWebContents.send.mock.calls
        .filter((c: unknown[]) => c[0] === channel)
        .map((c: unknown[]) => (c[1] as { code: string }).code);
    }

    it('caps the pending queue at 8 entries, dropping oldest', () => {
      resetDeepLinkState();
      vi.useFakeTimers();
      try {
        for (const code of TEN_CODES) deliverDeepLink(`concord://invite/${code}`);

        signalInviteReady(rendererEvent);

        // The two oldest were dropped by the cap, so the drain leads with the
        // third code and not the first — that is the drop-oldest proof.
        expect(sentOn('invite:received')).toEqual([TEN_CODES[2]]);

        // #945 (M0): the rest are released IN ORDER, one per window — they are no
        // longer collapsed to the newest. This assertion previously read
        // `[TEN_CODES[2], TEN_CODES[9]]`, and that collapse is exactly the silent
        // drop the fix removes: six codes the user clicked vanished with no log
        // and no trace, while both the gate comment and spec §6a asserted a
        // different code is deferred and never dropped.
        vi.advanceTimersByTime(DEEP_LINK_EMIT_WINDOW_MS);
        expect(sentOn('invite:received')).toEqual([TEN_CODES[2], TEN_CODES[3]]);

        // Drain the remainder to prove every queued code arrives, in click order.
        for (let i = 0; i < 6; i += 1) vi.advanceTimersByTime(DEEP_LINK_EMIT_WINDOW_MS);
        expect(sentOn('invite:received')).toEqual(TEN_CODES.slice(2));
      } finally {
        vi.useRealTimers();
      }
    });

    // VULN-005: one shared queue let friend traffic spend the invite allowance.
    // The kinds arrive from the same untrusted surfaces but wait on independent
    // readiness flags, so they get independent queues — the same reasoning that
    // gave the friend WAF rule its own ref and counter.
    it('keeps a queued invite when a friend burst fills the friend queue', () => {
      resetDeepLinkState();
      vi.useFakeTimers();
      try {
        // The user clicks a genuine invite during cold start...
        deliverDeepLink(`concord://invite/${INVITE_CODE}`);
        // ...and a page they have open fires a full cap's worth of friend codes.
        for (const code of TEN_CODES.slice(0, 8)) deliverDeepLink(`concord://friend/${code}`);

        signalInviteReady(rendererEvent);
        expect(sentOn('invite:received')).toEqual([INVITE_CODE]);

        signalFriendReady(rendererEvent);
        // The friend queue kept its own eight, and #945 (M0) releases them IN
        // ORDER, one per window — previously this asserted
        // `[TEN_CODES[0], TEN_CODES[7]]`, collapsing the burst to its newest and
        // silently discarding the six between.
        vi.advanceTimersByTime(DEEP_LINK_EMIT_WINDOW_MS);
        expect(sentOn('deeplink:friend-code')).toEqual([TEN_CODES[0], TEN_CODES[1]]);

        // Every one of the eight arrives, in click order — the invariant the
        // gate comment and spec §6a both assert.
        for (let i = 0; i < 6; i += 1) vi.advanceTimersByTime(DEEP_LINK_EMIT_WINDOW_MS);
        expect(sentOn('deeplink:friend-code')).toEqual(TEN_CODES.slice(0, 8));
      } finally {
        vi.useRealTimers();
      }
    });

    // VULN-006: post-readiness delivery was unbounded — N deliveries meant N IPC
    // sends, N forced AddFriendModal re-opens, and N authenticated
    // previewFriendCode calls, from a page the user merely visited.
    it('collapses a post-readiness burst of one code into a single send', () => {
      resetDeepLinkState();
      signalFriendReady(rendererEvent);
      vi.useFakeTimers();
      try {
        for (let i = 0; i < 250; i += 1) deliverDeepLink(`concord://friend/${FRIEND_CODE}`);
        expect(sentOn('deeplink:friend-code')).toEqual([FRIEND_CODE]);

        // Nothing is waiting at the window edge: re-sending the code the
        // renderer is already showing would change nothing.
        vi.advanceTimersByTime(DEEP_LINK_EMIT_WINDOW_MS);
        expect(sentOn('deeplink:friend-code')).toEqual([FRIEND_CODE]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('defers, never drops, a different code arriving inside the window', () => {
      resetDeepLinkState();
      signalInviteReady(rendererEvent);
      vi.useFakeTimers();
      try {
        deliverDeepLink(`concord://invite/${INVITE_CODE}`);
        deliverDeepLink(`concord://invite/${TEN_CODES[9]}`);
        // Invite B is held back by the window, not discarded...
        expect(sentOn('invite:received')).toEqual([INVITE_CODE]);

        vi.advanceTimersByTime(DEEP_LINK_EMIT_WINDOW_MS);
        // ...so a user who clicks invite A then invite B still lands on B.
        expect(sentOn('invite:received')).toEqual([INVITE_CODE, TEN_CODES[9]]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('terminates the drain when only the invite renderer is ready', () => {
      resetDeepLinkState();
      deliverDeepLink(`concord://friend/${FRIEND_CODE}`);
      deliverDeepLink(`concord://invite/${INVITE_CODE}`);

      signalInviteReady(rendererEvent);

      // A blind re-queue of the unemittable friend entry would re-enter the
      // queue in this same tick and loop forever. A filtered drain emits
      // exactly the one emittable entry and stops.
      expect(mockWebContents.send).toHaveBeenCalledTimes(1);
      expect(mockWebContents.send).toHaveBeenCalledWith('invite:received', { code: INVITE_CODE });
    });

    it('preserves a friend entry across an invite-only drain', () => {
      resetDeepLinkState();
      deliverDeepLink(`concord://friend/${FRIEND_CODE}`);
      deliverDeepLink(`concord://invite/${INVITE_CODE}`);

      signalInviteReady(rendererEvent);
      expect(sentOn('deeplink:friend-code')).toEqual([]);

      signalFriendReady(rendererEvent);
      expect(sentOn('deeplink:friend-code')).toEqual([FRIEND_CODE]);
      expect(mockWebContents.send).toHaveBeenCalledTimes(2);
    });

    it('emits ZERO invite:received for a friend deep link (old-SPA safety lock)', () => {
      resetDeepLinkState();
      deliverDeepLink(`concord://friend/${FRIEND_CODE}`);

      // A pre-22 SPA subscribes to invite:received and never calls
      // friendRendererReady. It must receive NOTHING — a widened
      // invite:received payload would instead open JoinServerModal with a
      // friend code (spec X1). Repeat the signal: every drain site must stay
      // silent, not just the first.
      signalInviteReady(rendererEvent);
      signalInviteReady(rendererEvent);

      expect(mockWebContents.send).not.toHaveBeenCalled();
      expect(sentOn('invite:received')).toEqual([]);
    });

    it('keeps invite:received emitting a bare { code } payload', () => {
      resetDeepLinkState();
      signalInviteReady(rendererEvent);
      deliverDeepLink(`concord://invite/${INVITE_CODE}`);

      const call = mockWebContents.send.mock.calls.find(
        (c: unknown[]) => c[0] === 'invite:received'
      );
      expect(call).toBeDefined();
      // toEqual, not toMatchObject — a `kind` field would fail this.
      expect(call![1]).toEqual({ code: INVITE_CODE });
    });

    it('ignores a friend readiness signal from an untrusted sender', () => {
      resetDeepLinkState();
      deliverDeepLink(`concord://friend/${FRIEND_CODE}`);

      signalFriendReady({ sender: { id: 99 } });
      expect(mockWebContents.send).not.toHaveBeenCalled();

      signalFriendReady(rendererEvent);
      expect(sentOn('deeplink:friend-code')).toEqual([FRIEND_CODE]);
    });

    it('logs only the rejection reason, never the code', () => {
      resetDeepLinkState();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        deliverDeepLink('concord://friend/nope');
        expect(warn).toHaveBeenCalled();
        for (const call of warn.mock.calls) {
          expect(JSON.stringify(call)).not.toContain('nope');
        }
      } finally {
        warn.mockRestore();
      }
    });

    // ── #2363: carry a delivered invite code across a main-initiated SPA swap ──
    describe('main-initiated SPA swap carry (#2363)', () => {
      // Not yet implemented in production: main.ts exports no primitive for
      // arming the carry. Driving the real spa:reloadLatest handler cannot
      // substitute — mockWebContents.loadURL is a bare vi.fn that resolves
      // without ever invoking the captured did-start-loading listener (see
      // the harness above at :2094-2098 and the spa:reloadLatest coverage at
      // :2860-2872, which asserts loadURL was called but never that reload
      // fired). So this imports the not-yet-existing carryDeepLinkAcrossNextLoad
      // export directly, per spec §8 Q1 / plan Task 1 step 5.
      //
      // Pre-fix this export does not exist. The guard lets the assertion run,
      // so each test below fails on the OBSERVABLE (one send where two are
      // expected, or vice versa) rather than on a missing symbol — a
      // missing-symbol error reads like a falsification and is not one.
      // Post-fix the guard is inert (the export exists and is called) and the
      // assertion is the whole test.
      async function armDeepLinkCarryForTest(): Promise<() => void> {
        const mainModule = await import('../../../src/main/main');
        const carry = (mainModule as unknown as { carryDeepLinkAcrossNextLoad?: () => unknown })
          .carryDeepLinkAcrossNextLoad;
        if (typeof carry !== 'function') return () => {};
        const release = carry();
        return typeof release === 'function' ? (release as () => void) : () => {};
      }

      it('re-delivers a spent invite code across a main-initiated SPA swap (regression for #2363)', async () => {
        resetDeepLinkState();
        signalInviteReady(rendererEvent);
        deliverDeepLink(`concord://invite/${INVITE_CODE}`);
        expect(sentOn('invite:received')).toEqual([INVITE_CODE]);

        // Main initiates a source swap: arm the carry, then fire the real
        // did-start-loading listener the window registers at main.ts:723.
        const releaseCarry = await armDeepLinkCarryForTest();
        simulateReload();
        releaseCarry();
        signalInviteReady(rendererEvent);

        expect(sentOn('invite:received')).toEqual([INVITE_CODE, INVITE_CODE]);
      });

      it('does NOT re-deliver a spent invite code across an ordinary reload (regression for #2363)', () => {
        resetDeepLinkState();
        signalInviteReady(rendererEvent);
        deliverDeepLink(`concord://invite/${INVITE_CODE}`);
        expect(sentOn('invite:received')).toEqual([INVITE_CODE]);

        simulateReload(); // carry NOT armed — an ordinary reload
        signalInviteReady(rendererEvent);

        expect(sentOn('invite:received')).toEqual([INVITE_CODE]);
      });

      // INVERTED (CODEX P2, round 8). This originally asserted that
      // auth:clearTokens forgets, and that was wrong: not one of its three
      // renderer callers is unambiguously a logout. useSSOFlow.begin() calls it
      // immediately BEFORE starting SSO, so forgetting there destroys an invite
      // queued while the app was closed — the click-invite-then-sign-in flow,
      // which is the primary path #2363 exists to repair. App.tsx's
      // ownerless-credential rejection and gracefulReset's rememberMe path are
      // login-side too. Real logout has auth:logout, which does forget, so
      // narrowing costs nothing.
      //
      // The second handler to be wrongly read as a logout edge. The first was
      // auth:clearTokensIfOwner, and the test below it is this one's twin.
      // The one caller of auth:clearTokens that IS a logout: nuclearReset(), on a
      // refresh failure with rememberMe === false. It reaches this handler through
      // gracefulReset and never calls auth:logout, so without the opt-in user A's
      // code survived into user B's session (CODEX P2, round 10).
      it('auth:clearTokens forgets BY DEFAULT — an older SPA sends no argument (#2363)', async () => {
        resetDeepLinkState();
        signalInviteReady(rendererEvent);
        deliverDeepLink(`concord://invite/${INVITE_CODE}`);
        expect(sentOn('invite:received')).toEqual([INVITE_CODE]);

        await handlers.get('auth:clearTokens')!(trustedIpcEvent);

        const releaseCarry = await armDeepLinkCarryForTest();
        simulateReload();
        releaseCarry();
        signalInviteReady(rendererEvent);

        expect(sentOn('invite:received')).toEqual([INVITE_CODE]);
      });

      // The flag is renderer-supplied, so it is read strictly: anything that is
      // not the literal `true` fails to opt out, and the forgetting default
      // applies. Strictness points at the SAFE side — a malformed opt-out loses
      // an invite, where a lenient one would carry a code across accounts.
      it('auth:clearTokens treats a truthy-but-not-true keepDeepLinks as no (#2363)', async () => {
        resetDeepLinkState();
        signalInviteReady(rendererEvent);
        deliverDeepLink(`concord://invite/${INVITE_CODE}`);

        await handlers.get('auth:clearTokens')!(trustedIpcEvent, { keepDeepLinks: 'yes' });

        const releaseCarry = await armDeepLinkCarryForTest();
        simulateReload();
        releaseCarry();
        signalInviteReady(rendererEvent);

        expect(sentOn('invite:received')).toEqual([INVITE_CODE]);
      });

      it('auth:clearTokens does NOT forget when the caller opts out (#2363)', async () => {
        resetDeepLinkState();
        signalInviteReady(rendererEvent);
        deliverDeepLink(`concord://invite/${INVITE_CODE}`);
        expect(sentOn('invite:received')).toEqual([INVITE_CODE]);

        await handlers.get('auth:clearTokens')!(trustedIpcEvent, { keepDeepLinks: true });

        const releaseCarry = await armDeepLinkCarryForTest();
        simulateReload();
        releaseCarry();
        signalInviteReady(rendererEvent);

        // The invite survives an SSO-start token clear and is carried into the
        // successor document, which is the whole point of the feature.
        expect(sentOn('invite:received')).toEqual([INVITE_CODE, INVITE_CODE]);
      });

      // Companion fence for the path the app ACTUALLY takes on a user-initiated
      // logout. userStore.logout() calls electron.logout() -> auth:logout ->
      // performLogout(), which clears credentials inside tokenManager and never
      // reaches the auth:clearTokens handler the case above drives. The same
      // logout does reach it eventually, but only through nuclearReset()'s
      // doubly-optional-chained `globalThis.electron?.clearTokens?.()`
      // (resetService.ts) — a renderer-side call ordering that no main-process
      // test can observe and that a refactor could drop with nothing going red.
      // So spec §5.2 must hold at the auth:logout edge on its own, and this is
      // what says so.
      it('does not re-deliver a delivered code after auth:logout, even with the carry armed (fence for #2363 spec §5.2)', async () => {
        resetDeepLinkState();
        signalInviteReady(rendererEvent);
        deliverDeepLink(`concord://invite/${INVITE_CODE}`);
        expect(sentOn('invite:received')).toEqual([INVITE_CODE]);

        await handlers.get('auth:logout')!(trustedIpcEvent, { accessToken: 'tok' });

        const releaseCarry = await armDeepLinkCarryForTest();
        simulateReload();
        releaseCarry();
        signalInviteReady(rendererEvent);

        expect(sentOn('invite:received')).toEqual([INVITE_CODE]);
      });

      // Companion fence for the auth:clearTokensIfOwner edge (#2363). Every
      // caller of this handler is login-side (aborted SSO, interrupted email
      // verification, cancelled account-link/passphrase-setup, aborted login
      // continuation, eager-unlock cleanup) — never logout — so unlike the two
      // fences above it must NOT forget a deliverable code: a
      // `concord://invite/CODE` queued before any window existed would
      // otherwise be erased by an aborted SSO sign-in.
      it('auth:clearTokensIfOwner does NOT forget a delivered invite code (regression for #2363)', async () => {
        resetDeepLinkState();
        signalInviteReady(rendererEvent);
        deliverDeepLink(`concord://invite/${INVITE_CODE}`);
        expect(sentOn('invite:received')).toEqual([INVITE_CODE]);

        const cleared = await handlers.get('auth:clearTokensIfOwner')!(trustedIpcEvent, 41);
        expect(cleared).toBe(true);

        const releaseCarry = await armDeepLinkCarryForTest();
        try {
          simulateReload();
        } finally {
          releaseCarry();
        }
        signalInviteReady(rendererEvent);

        expect(sentOn('invite:received')).toEqual([INVITE_CODE, INVITE_CODE]);
      });

      // Companion fence for #2363: forgetDeliveredDeepLinks must clear
      // gate.held, not just gate.lastCode. resetDeepLinkDelivery re-queues
      // WHATEVER is in gate.held on every reload, carried or not (see main.ts
      // "for (const code of carried) queueDeepLink(...)" — unconditional), so
      // an un-cleared held FIFO leaks into the very next ordinary reload after
      // logout, no carry required. Advancing timers alone does not observe
      // this (nothing re-arms the cancelled flush timer without a reload),
      // which is why the reload below is load-bearing, not incidental.
      it('auth:logout forgets codes still held in gate.held, not just the delivered one (regression for #2363)', async () => {
        resetDeepLinkState();
        signalInviteReady(rendererEvent);
        vi.useFakeTimers();
        try {
          deliverDeepLink(`concord://invite/${INVITE_CODE}`);
          expect(sentOn('invite:received')).toEqual([INVITE_CODE]);

          // Inside the emit window: held back by the gate, not dropped.
          const held = TEN_CODES.slice(0, 3);
          for (const code of held) deliverDeepLink(`concord://invite/${code}`);

          await handlers.get('auth:logout')!(trustedIpcEvent, { accessToken: 'tok' });

          // An ORDINARY reload — no carry armed. If `held` had survived the
          // logout it would be re-queued here regardless, and the drain below
          // would deliver it into what is meant to be a fresh session.
          simulateReload();
          signalInviteReady(rendererEvent);
          vi.advanceTimersByTime(DEEP_LINK_EMIT_WINDOW_MS * 5);
          expect(sentOn('invite:received')).toEqual([INVITE_CODE]);
        } finally {
          vi.useRealTimers();
        }
      });

      // Companion fence for #2363: forgetDeliveredDeepLinks must run BEFORE
      // performLogout's await, not after — performLogout clears credentials on
      // its first line and then issues an unbounded network POST, so a forget
      // placed after the await leaves a deliverable code exposed for the width
      // of that request.
      it('auth:logout forgets deep links BEFORE performLogout resolves, not after (regression for #2363)', async () => {
        const { performLogout } = await import('../../../src/main/tokenManager');
        resetDeepLinkState();
        signalInviteReady(rendererEvent);
        deliverDeepLink(`concord://invite/${INVITE_CODE}`);
        expect(sentOn('invite:received')).toEqual([INVITE_CODE]);

        const logoutPost = deferred<void>();
        (performLogout as Mock).mockImplementationOnce(() => logoutPost.promise);

        const handlerPromise = handlers.get('auth:logout')!(trustedIpcEvent, {
          accessToken: 'tok',
        });

        // The POST is still in flight — the forget must already have run.
        const releaseCarry = await armDeepLinkCarryForTest();
        try {
          simulateReload();
        } finally {
          releaseCarry();
        }
        signalInviteReady(rendererEvent);
        expect(sentOn('invite:received')).toEqual([INVITE_CODE]);

        logoutPost.resolve();
        await handlerPromise;
      });

      // ── Red-team regression guards (#2363 adversarial pass) ──────────────
      // Three exploits were built against the carry as first written and are
      // now closed. Each guard below pins ONE of those fixes. They are not
      // redundant with the four tests above: those pin the FEATURE (a spent
      // code is carried across a main-initiated swap and not across an
      // ordinary reload, and never across a logout). These pin the BOUNDS
      // that stop the same feature being turned against the user.

      // F1. The carry re-queues the delivered code FIRST, into a queue whose
      // overflow policy is drop-OLDEST at PENDING_DEEP_LINK_CAP — the same
      // value as DEEP_LINK_HELD_MAX. That made the carried code the guaranteed
      // eviction victim whenever a hostile page had filled gate.held: a web
      // page firing 8 concord:// links deleted the invite the user actually
      // clicked and put 8 attacker-chosen prefilled join modals in its place.
      // The fix trims the oldest HELD codes instead. Delete this and that
      // substitution comes back silently.
      it('F1 (red-team): a hostile 8-code burst must NOT evict the carried invite — oldest HELD codes drop instead', async () => {
        const { DEEP_LINK_HELD_MAX } = await import('../../../src/main/main');
        resetDeepLinkState();
        vi.useFakeTimers();
        try {
          signalInviteReady(rendererEvent);
          // The user clicks a real invite: sent immediately, gate.lastCode = it.
          deliverDeepLink(`concord://invite/${INVITE_CODE}`);
          expect(sentOn('invite:received')).toEqual([INVITE_CODE]);

          // A hostile page fills gate.held to capacity inside the emit window.
          const burst = TEN_CODES.slice(0, DEEP_LINK_HELD_MAX);
          for (const code of burst) deliverDeepLink(`concord://invite/${code}`);

          // Main swaps the SPA source on its own initiative.
          const releaseCarry = await armDeepLinkCarryForTest();
          simulateReload();
          releaseCarry();
          signalInviteReady(rendererEvent);
          vi.advanceTimersByTime(DEEP_LINK_EMIT_WINDOW_MS * (DEEP_LINK_HELD_MAX + 4));

          const afterSwap = sentOn('invite:received').slice(1);
          // The code the user acted on survives, and arrives FIRST.
          expect(afterSwap[0]).toBe(INVITE_CODE);
          // Exactly one code was dropped, and it is the OLDEST HELD one.
          expect(afterSwap).not.toContain(burst[0]);
          expect(afterSwap).toEqual([INVITE_CODE, ...burst.slice(1)]);
        } finally {
          vi.useRealTimers();
        }
      });

      // F1 control. One code below DEEP_LINK_HELD_MAX nothing is trimmed at
      // all. This is what isolates the cap as the cause rather than some other
      // property of a burst — without it, a future change that dropped a held
      // code unconditionally would still satisfy the guard above.
      it('F1 CONTROL (red-team): a 7-code burst trims nothing — isolates DEEP_LINK_HELD_MAX as the cause', async () => {
        const { DEEP_LINK_HELD_MAX } = await import('../../../src/main/main');
        resetDeepLinkState();
        vi.useFakeTimers();
        try {
          signalInviteReady(rendererEvent);
          deliverDeepLink(`concord://invite/${INVITE_CODE}`);
          const burst = TEN_CODES.slice(0, DEEP_LINK_HELD_MAX - 1);
          for (const code of burst) deliverDeepLink(`concord://invite/${code}`);

          const releaseCarry = await armDeepLinkCarryForTest();
          simulateReload();
          releaseCarry();
          signalInviteReady(rendererEvent);
          vi.advanceTimersByTime(DEEP_LINK_EMIT_WINDOW_MS * (DEEP_LINK_HELD_MAX + 4));

          expect(sentOn('invite:received').slice(1)).toEqual([INVITE_CODE, ...burst]);
        } finally {
          vi.useRealTimers();
        }
      });

      // F2. The arming used to be a boolean that resetDeepLinkDelivery consumed
      // on the FIRST reset. applySpaDecision awaits a navigation, and other
      // navigations land in that window — a renderer location.reload(), a
      // crash-reload, and applySpaDecision's OWN remote->cache->bundled
      // fallback, which issues two loadURL calls inside one armed wrapper. Any
      // of them spent the arming, so main's own swap carried nothing and #2363
      // reproduced with no error and no log. This test is the one that catches
      // a revert to a boolean: it asserts the arming SURVIVES a foreign reset.
      it('F2 (red-team): an unrelated navigation inside the armed window must NOT spend the arming', async () => {
        resetDeepLinkState();
        vi.useFakeTimers();
        try {
          signalInviteReady(rendererEvent);
          deliverDeepLink(`concord://invite/${INVITE_CODE}`);
          expect(sentOn('invite:received')).toEqual([INVITE_CODE]);

          // applySpaDecisionCarryingDeepLink has armed and is mid-await.
          const releaseCarry = await armDeepLinkCarryForTest();

          // A navigation main did NOT initiate lands first.
          simulateReload();
          signalInviteReady(rendererEvent);
          vi.advanceTimersByTime(DEEP_LINK_EMIT_WINDOW_MS * 2);
          expect(sentOn('invite:received')).toEqual([INVITE_CODE, INVITE_CODE]);

          // Main's own navigation finally starts. The arming must still be live.
          simulateReload();
          signalInviteReady(rendererEvent);
          vi.advanceTimersByTime(DEEP_LINK_EMIT_WINDOW_MS * 2);
          releaseCarry(); // applySpaDecision resolved; the wrapper's finally runs

          expect(sentOn('invite:received')).toEqual([INVITE_CODE, INVITE_CODE, INVITE_CODE]);
        } finally {
          vi.useRealTimers();
        }
      });

      // F3. gate.lastCode is set at send time and main is never told the modal
      // was closed, so the carry had no notion of CONSUMPTION: every later
      // main-initiated swap re-presented an attacker-chosen prefilled join
      // modal after an explicit decline, indefinitely and on a schedule
      // (SPA_RETRY_DELAYS_MS, plus every "Load latest UI" click) an attacker
      // can predict. DEEP_LINK_CARRY_MAX_AGE_MS encodes the recency condition
      // the carry's own rationale always assumed. BOTH halves are asserted on
      // purpose — a one-sided "is not re-presented" is satisfied by the carry
      // being broken outright.
      it('F3 (red-team): a code older than DEEP_LINK_CARRY_MAX_AGE_MS is NOT re-presented; a fresh one IS', async () => {
        const { DEEP_LINK_CARRY_MAX_AGE_MS } = await import('../../../src/main/main');

        // Inside the window: the #2363 repair still works.
        resetDeepLinkState();
        vi.useFakeTimers();
        try {
          signalInviteReady(rendererEvent);
          deliverDeepLink(`concord://invite/${INVITE_CODE}`);
          expect(sentOn('invite:received')).toEqual([INVITE_CODE]);

          vi.advanceTimersByTime(DEEP_LINK_CARRY_MAX_AGE_MS - DEEP_LINK_EMIT_WINDOW_MS);
          const releaseCarry = await armDeepLinkCarryForTest();
          simulateReload();
          releaseCarry();
          signalInviteReady(rendererEvent);
          vi.advanceTimersByTime(DEEP_LINK_EMIT_WINDOW_MS * 2);

          expect(sentOn('invite:received')).toEqual([INVITE_CODE, INVITE_CODE]);
        } finally {
          vi.useRealTimers();
        }

        // Outside the window: a dismissed invite stays dismissed.
        resetDeepLinkState();
        vi.useFakeTimers();
        try {
          signalInviteReady(rendererEvent);
          deliverDeepLink(`concord://invite/${INVITE_CODE}`);
          expect(sentOn('invite:received')).toEqual([INVITE_CODE]);

          vi.advanceTimersByTime(DEEP_LINK_CARRY_MAX_AGE_MS + DEEP_LINK_EMIT_WINDOW_MS);
          const releaseCarry = await armDeepLinkCarryForTest();
          simulateReload();
          releaseCarry();
          signalInviteReady(rendererEvent);
          vi.advanceTimersByTime(DEEP_LINK_EMIT_WINDOW_MS * 2);

          expect(sentOn('invite:received')).toEqual([INVITE_CODE]);
        } finally {
          vi.useRealTimers();
        }
      });

      // CODEX P1. The fence was a hand-picked 15 s documented as covering the
      // cold-start retry schedule "with margin". It covered nothing: the delays
      // are SEQUENTIAL and each attempt first awaits resolveSpaSource, so the
      // second attempt's swap lands at 4 s + T + 10 s + T. The fence then
      // declined the carry on the exact recovery path it exists to repair —
      // silently, presenting as #2363 itself. This reds on any return to a
      // literal: 15 s against a 24 s worst case.
      it('CODEX P1 (red-team): the carry window exceeds the WORST-CASE cold-start retry schedule', async () => {
        const { DEEP_LINK_CARRY_MAX_AGE_MS } = await import('../../../src/main/main');
        // From the shared module, never a mirrored literal: a mirror here would
        // pass while production under-covered, which is the whole defect.
        const { CONFIG_TIMEOUT_MS, SPA_RETRY_DELAYS_MS } =
          await import('../../../src/main/spaTiming');

        // Every BOUNDED step of the chain, not just the delays. The first retry
        // is scheduled only after the initial applySpaDecision resolves, and each
        // attempt schedules its successor only after its own does — and every
        // applySpaDecision awaits a captureSpaHash bounded by the same timeout.
        // So: one hash before the chain, then per attempt one config fetch AND
        // one hash. Counting only the config fetches is what left the previous
        // version of this fence short (CODEX P2, round 6).
        const worstCase =
          SPA_RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0) +
          (2 * SPA_RETRY_DELAYS_MS.length + 1) * CONFIG_TIMEOUT_MS;

        expect(DEEP_LINK_CARRY_MAX_AGE_MS).toBeGreaterThan(worstCase);
      });

      // The forget-only channel (#2363, v25). Every other edge that forgets also
      // destroys credentials; a rememberMe teardown must forget WITHOUT doing so,
      // because the disk tokens stay for the next launch to retry. Without it main
      // kept the code alive across that teardown and a swap replayed user A's
      // invite into user B's renderer.
      it('deeplink:forget clears deliverable state without a credential clear', async () => {
        resetDeepLinkState();
        signalInviteReady(rendererEvent);
        deliverDeepLink(`concord://invite/${INVITE_CODE}`);
        expect(sentOn('invite:received')).toEqual([INVITE_CODE]);

        await handlers.get('deeplink:forget')!(trustedIpcEvent);

        const releaseCarry = await armDeepLinkCarryForTest();
        simulateReload();
        releaseCarry();
        signalInviteReady(rendererEvent);

        expect(
          sentOn('invite:received'),
          'the forgotten code must not survive into the successor document'
        ).toEqual([INVITE_CODE]);
      });

      // Supervisor Q (2026-08-28): are the scheduled SPA retry and spa:reloadLatest
      // two entry points to the same replay? Structurally they are ONE — both reach
      // the carry only through applySpaDecisionCarryingDeepLink, so the forget
      // zeroes the state both would read. What they can differ on is TIMING, and
      // that is what this covers: the retry is already in flight (carry armed,
      // applySpaDecision pending) when the refresh failure fires the forget. Its
      // release token then lands AFTER the forget. The epoch advance in
      // forgetDeliveredDeepLinks exists for exactly that token and had no test.
      //
      // The failure it prevents is a lost invite, not a leak: a stale token that
      // still decrements drives the depth to -1, and the NEXT genuine swap arms it
      // back to 0, where resetDeepLinkDelivery's `depth > 0` check declines to
      // carry. So the assertion is on the swap AFTER the forget, not on the forget.
      it('a carry token issued before the forget cannot disarm the swap after it', async () => {
        const OTHER_CODE = 'ZZZZZZAC';
        resetDeepLinkState();
        signalInviteReady(rendererEvent);
        deliverDeepLink(`concord://invite/${INVITE_CODE}`);

        // The in-flight retry, armed while user A's code was still live.
        const staleRelease = await armDeepLinkCarryForTest();

        await handlers.get('deeplink:forget')!(trustedIpcEvent);
        staleRelease();

        // A later, unrelated swap — user B has signed in and clicked their own invite.
        signalInviteReady(rendererEvent);
        deliverDeepLink(`concord://invite/${OTHER_CODE}`);
        const liveRelease = await armDeepLinkCarryForTest();
        simulateReload();
        liveRelease();
        signalInviteReady(rendererEvent);

        expect(
          sentOn('invite:received').filter((code) => code === OTHER_CODE),
          'a stale token that still decremented would leave the depth at -1, and this swap would decline to carry'
        ).toEqual([OTHER_CODE, OTHER_CODE]);
      });

      // Codex P2 on PR #2967, and the reason deeplink:forget alone is not enough.
      // spaLoader's version gate is deliberately one-directional -- it refuses an
      // SPA NEWER than the shell and loads an older one indefinitely -- so a
      // renderer built before contract 25 never calls the forget channel at all.
      // On those SPAs a rememberMe refresh failure still leaves main holding user
      // A's code, and a scheduled retry inside the 44 s carry window replays it
      // into whoever signed in next.
      //
      // The fence is therefore MAIN-side and reads the credential store, which
      // every SPA must go through regardless of its contract version: a code
      // retained under owner A is not deliverable once a DIFFERENT owner is
      // current. No renderer cooperation, so SPA age stops mattering.
      it('does not deliver a code retained under one owner to a different owner', async () => {
        const { getCredentialCustodyState } = await import('../../../src/main/tokenManager');
        (getCredentialCustodyState as Mock).mockReturnValue({
          credentialOwner: 41,
          pendingE2EEUnlock: false,
        });
        resetDeepLinkState();
        signalInviteReady(rendererEvent);
        deliverDeepLink(`concord://invite/${INVITE_CODE}`);
        expect(sentOn('invite:received')).toEqual([INVITE_CODE]);

        // The rememberMe refresh failure on an OLD SPA: no deeplink:forget call,
        // and clearTokens is not called either, so main is told nothing at all.
        // Then user B signs in -- storeRefreshToken mints the next owner.
        (getCredentialCustodyState as Mock).mockReturnValue({
          credentialOwner: 42,
          pendingE2EEUnlock: false,
        });

        const releaseCarry = await armDeepLinkCarryForTest();
        simulateReload();
        releaseCarry();
        signalInviteReady(rendererEvent);

        expect(
          sentOn('invite:received'),
          "user A's code must not reach user B's renderer, whatever the SPA's contract version"
        ).toEqual([INVITE_CODE]);
      });

      // The positive control, and the flow the fence could most easily break.
      // A code queued before anyone signed in belongs to NOBODY, and delivering it
      // to the account that then signs in IS the feature (click invite -> sign in
      // -> join). Its owner tag is null, so the fence must never fire for it.
      it('still delivers a code queued before sign-in to the account that signs in', async () => {
        const { getCredentialCustodyState } = await import('../../../src/main/tokenManager');
        (getCredentialCustodyState as Mock).mockReturnValue({
          credentialOwner: null,
          pendingE2EEUnlock: false,
        });
        resetDeepLinkState();
        // Logged out, no window ready: the code sits in the pending queue.
        deliverDeepLink(`concord://invite/${INVITE_CODE}`);
        expect(sentOn('invite:received')).toEqual([]);

        // The user signs in; a fresh owner is minted.
        (getCredentialCustodyState as Mock).mockReturnValue({
          credentialOwner: 42,
          pendingE2EEUnlock: false,
        });
        signalInviteReady(rendererEvent);

        expect(
          sentOn('invite:received'),
          'an invite clicked while logged out is exactly what the user is signing in to accept'
        ).toEqual([INVITE_CODE]);
      });

      // Each fence site below covers a delivery path the others do not reach.
      // Written because a mutation sweep found both of them uncovered: dropping
      // either fence left the suite green.

      // flushDeepLinkGate calls sendDeepLink DIRECTLY (main.ts) — not through the
      // drain, not through emitDeepLink — so a code sitting in gate.held when the
      // window timer fires reaches the renderer on a path nothing else fences.
      it('does not flush a held code to an owner that did not receive it', async () => {
        const { getCredentialCustodyState } = await import('../../../src/main/tokenManager');
        (getCredentialCustodyState as Mock).mockReturnValue({
          credentialOwner: 41,
          pendingE2EEUnlock: false,
        });
        resetDeepLinkState();
        signalInviteReady(rendererEvent);
        vi.useFakeTimers();
        try {
          deliverDeepLink(`concord://invite/${INVITE_CODE}`);
          // Inside the emit window, so this one is HELD rather than sent.
          deliverDeepLink(`concord://invite/${TEN_CODES[9]}`);
          expect(sentOn('invite:received')).toEqual([INVITE_CODE]);

          (getCredentialCustodyState as Mock).mockReturnValue({
            credentialOwner: 42,
            pendingE2EEUnlock: false,
          });
          vi.advanceTimersByTime(DEEP_LINK_EMIT_WINDOW_MS);

          expect(
            sentOn('invite:received'),
            'the held code belongs to the owner who clicked it, not to whoever the timer finds'
          ).toEqual([INVITE_CODE]);
        } finally {
          vi.useRealTimers();
        }
      });

      // The arrival fence. Without it, noteDeepLinkOwner tags the whole retained
      // set with the NEW owner as B's own click comes in, and the drain then sees
      // a matching owner and hands A's queued codes over too — the fence
      // disarming itself one call before it was needed.
      it('a new owner clicking their own link does not inherit the previous owner queue', async () => {
        const { getCredentialCustodyState } = await import('../../../src/main/tokenManager');
        (getCredentialCustodyState as Mock).mockReturnValue({
          credentialOwner: 41,
          pendingE2EEUnlock: false,
        });
        resetDeepLinkState();
        // Renderer not ready: A's code waits in the pending queue.
        deliverDeepLink(`concord://invite/${INVITE_CODE}`);

        (getCredentialCustodyState as Mock).mockReturnValue({
          credentialOwner: 42,
          pendingE2EEUnlock: false,
        });
        deliverDeepLink(`concord://invite/${TEN_CODES[9]}`);
        signalInviteReady(rendererEvent);

        expect(sentOn('invite:received'), "B gets B's invite and only B's invite").toEqual([
          TEN_CODES[9],
        ]);
      });

      // The current === null carve-out, which is a documented behaviour rather
      // than a defensive default: an aborted SSO, a cancelled account-link and an
      // interrupted email verification all clear credentials WITHOUT minting a
      // successor. Those are login-side, and forgetting there deletes the invite
      // the user is about to retry with (internal-reference).
      it('keeps a queued code when credentials are cleared with no successor owner', async () => {
        const { getCredentialCustodyState } = await import('../../../src/main/tokenManager');
        (getCredentialCustodyState as Mock).mockReturnValue({
          credentialOwner: 41,
          pendingE2EEUnlock: false,
        });
        resetDeepLinkState();
        deliverDeepLink(`concord://invite/${INVITE_CODE}`);

        // Credentials gone, nobody replaced them.
        (getCredentialCustodyState as Mock).mockReturnValue({
          credentialOwner: null,
          pendingE2EEUnlock: false,
        });
        signalInviteReady(rendererEvent);

        expect(
          sentOn('invite:received'),
          'an aborted login must not delete the invite it was aborting in the middle of'
        ).toEqual([INVITE_CODE]);
      });

      // noteDeepLinkOwner refuses to write a NULL tag, and that refusal is the
      // fence's own laundering guard rather than a null-check for tidiness. A
      // logged-out arrival is exempt from the fence by the tag-null carve-out, so
      // if it also RESET the tag, it would hand user A's still-queued code the
      // same exemption — and the next owner to sign in would receive both.
      // Plausible on a shared machine: sign out, click a link, hand over the laptop.
      it('a logged-out arrival does not launder the previous owner retained code', async () => {
        const { getCredentialCustodyState } = await import('../../../src/main/tokenManager');
        (getCredentialCustodyState as Mock).mockReturnValue({
          credentialOwner: 41,
          pendingE2EEUnlock: false,
        });
        resetDeepLinkState();
        deliverDeepLink(`concord://invite/${INVITE_CODE}`);

        // Signed out — no owner at all.
        (getCredentialCustodyState as Mock).mockReturnValue({
          credentialOwner: null,
          pendingE2EEUnlock: false,
        });
        deliverDeepLink(`concord://invite/${TEN_CODES[9]}`);

        // Someone else signs in.
        (getCredentialCustodyState as Mock).mockReturnValue({
          credentialOwner: 42,
          pendingE2EEUnlock: false,
        });
        signalInviteReady(rendererEvent);

        expect(
          sentOn('invite:received'),
          "a signed-out click must not re-open user A's retained code to the next account"
        ).not.toContain(INVITE_CODE);
      });

      // Codex P2, main.ts:688. The tag-null carve-out is what lets a pre-login
      // code reach whoever signs in -- but the tag was only ever written at OS
      // ARRIVAL, so after that delivery it stayed null and the exemption never
      // expired. The primary flow (click invite -> sign in -> join) therefore
      // produced a permanently ownerless code: A receives it, and on a pre-v25
      // SPA a later swap could still replay it to B. Delivery binds it now.
      it('binds a pre-login code to the account that actually receives it', async () => {
        const { getCredentialCustodyState } = await import('../../../src/main/tokenManager');
        (getCredentialCustodyState as Mock).mockReturnValue({
          credentialOwner: null,
          pendingE2EEUnlock: false,
        });
        resetDeepLinkState();
        deliverDeepLink(`concord://invite/${INVITE_CODE}`);

        // User A signs in and receives it — the feature, and it must still work.
        (getCredentialCustodyState as Mock).mockReturnValue({
          credentialOwner: 42,
          pendingE2EEUnlock: false,
        });
        signalInviteReady(rendererEvent);
        expect(sentOn('invite:received')).toEqual([INVITE_CODE]);

        // A's session ends without telling main (old SPA), B signs in, swap.
        (getCredentialCustodyState as Mock).mockReturnValue({
          credentialOwner: 43,
          pendingE2EEUnlock: false,
        });
        const releaseCarry = await armDeepLinkCarryForTest();
        simulateReload();
        releaseCarry();
        signalInviteReady(rendererEvent);

        expect(
          sentOn('invite:received'),
          "once A has received it the code is A's, and the pre-login exemption is spent"
        ).toEqual([INVITE_CODE]);
      });

      // Codex P2, main.ts:924. `handleInviteDeepLink` is NOT the only OS entry
      // point: on Windows and Linux a protocol activation against a running app
      // arrives as `second-instance` -> handleInviteDeepLinksFromArgv, which
      // called queueDeepLink directly and so met neither the fence nor the bind.
      //
      // The DELIVERY bind already covers a code that gets DELIVERED, so the
      // reproducing shape is the ARRIVAL fence — and the symptom is the opposite
      // of the one reported. Without a fence at the argv arrival, B's code is
      // queued while the tag is still A's, and the drain fence then fires once
      // and forgets EVERYTHING pending: A's retained code AND B's own fresh
      // click. B loses the invite they just opened. Confirmed by a positive
      // control (drop B's arrival and the queue still drains to nothing), which
      // is the only reason this was not read as a broken harness.
      //
      // The startup `process.argv` call shares this path deliberately and is
      // unaffected: at cold start both the tag and the current owner are null,
      // so the fence and the bind are each a no-op there.
      it('fences an argv deep link from a second instance (Windows/Linux)', async () => {
        const { getCredentialCustodyState } = await import('../../../src/main/tokenManager');
        (getCredentialCustodyState as Mock).mockReturnValue({
          credentialOwner: 41,
          pendingE2EEUnlock: false,
        });
        resetDeepLinkState();
        // Renderer not ready: A's code waits in the pending queue.
        deliverDeepLink(`concord://invite/${INVITE_CODE}`);

        // B signs in and clicks their own link, which reaches the running app
        // through second-instance rather than open-url.
        (getCredentialCustodyState as Mock).mockReturnValue({
          credentialOwner: 42,
          pendingE2EEUnlock: false,
        });
        appOnCallbacks.get('second-instance')!({}, [
          'concord.exe',
          `concord://invite/${TEN_CODES[9]}`,
        ]);
        signalInviteReady(rendererEvent);

        expect(
          sentOn('invite:received'),
          'an argv arrival is an OS arrival and must fence like any other'
        ).toEqual([TEN_CODES[9]]);
      });

      // Codex P2, main.ts:621, and the round-15 test below with ONE step added:
      // an unrelated reset between the re-click and the flood. That is the whole
      // finding. Round 15 split `reservedCode` from `carriedCode` so a re-click
      // keeps its exemption; the reset branch then read `carriedStillPending` --
      // false *because carriedCode is null* -- and cleared the reservation of a
      // code that was still queued, re-tying the two fields it had just split.
      it('keeps the eviction reservation across a reset that carries nothing', async () => {
        const { PENDING_DEEP_LINK_CAP } = await import('../../../src/main/main');
        resetDeepLinkState();
        vi.useFakeTimers();
        try {
          signalInviteReady(rendererEvent);
          deliverDeepLink(`concord://invite/${INVITE_CODE}`);

          const release = await armDeepLinkCarryForTest();
          simulateReload();
          release();

          // The re-click retires the carried marker and keeps the reservation.
          deliverDeepLink(`concord://invite/${INVITE_CODE}`);

          // An ordinary reload that carries nothing -- the step round 15 lacked.
          simulateReload();

          const SAFE = 'ABCDEFGHJKMNPQRS';
          for (let i = 0; i < PENDING_DEEP_LINK_CAP; i += 1) {
            deliverDeepLink(`concord://invite/ZZZZZZB${SAFE[i % SAFE.length]}`);
          }

          signalInviteReady(rendererEvent);
          vi.advanceTimersByTime(DEEP_LINK_EMIT_WINDOW_MS * 40);

          const deliveries = sentOn('invite:received').filter((c) => c === INVITE_CODE);
          expect(
            deliveries.length,
            'a reset that carries nothing must not spend a reservation whose code is still queued'
          ).toBeGreaterThanOrEqual(2);
        } finally {
          vi.useRealTimers();
        }
      });

      // Codex P2, main.ts:702, and a fair hit on the laundering test above: it
      // asserts A's code is ABSENT and never that the fresh one SURVIVED.
      //
      // On a pre-v25 SPA the teardown leaves A's tag in place. A link clicked
      // while logged out could not clear it -- noteDeepLinkOwner refuses to write
      // null, deliberately -- so the fresh code joined A's queue under A's tag,
      // and when B's credential was minted the drain fence swept the whole queue
      // including the link the user had just opened.
      //
      // Arrival is the separating boundary, and it needs no per-entry ownership:
      // at a logged-out arrival everything ALREADY queued belongs to the retained
      // tag and the arriving code does not.
      it('a logged-out arrival keeps its own code while discarding the retained owner queue', async () => {
        const { getCredentialCustodyState } = await import('../../../src/main/tokenManager');
        (getCredentialCustodyState as Mock).mockReturnValue({
          credentialOwner: 41,
          pendingE2EEUnlock: false,
        });
        resetDeepLinkState();
        deliverDeepLink(`concord://invite/${INVITE_CODE}`);

        // A's session ends on an old SPA: nothing tells main, so the tag stays 41.
        (getCredentialCustodyState as Mock).mockReturnValue({
          credentialOwner: null,
          pendingE2EEUnlock: false,
        });
        deliverDeepLink(`concord://invite/${TEN_CODES[9]}`);

        // B's credential is minted -- an SSO completion during a reload.
        (getCredentialCustodyState as Mock).mockReturnValue({
          credentialOwner: 42,
          pendingE2EEUnlock: false,
        });
        signalInviteReady(rendererEvent);

        const delivered = sentOn('invite:received');
        expect(delivered, "A's retained code must still not cross").not.toContain(INVITE_CODE);
        expect(
          delivered,
          'but the link the user clicked while logged out is the one they are signing in to accept'
        ).toContain(TEN_CODES[9]);
      });

      // Codex P2, main.ts:713, and a fair hit on the delivery-bind test above:
      // that test mints the owner BEFORE signalling readiness, which is not the
      // order a cold start uses. App.tsx signals invite-readiness from a mount
      // effect keyed on [isPipWindow] -- unconditionally, before anyone signs in
      // -- and the authenticated replay that opens the modal is renderer-local
      // and never calls back into main. So the real startup order delivers the
      // code while the owner is still null, noteDeepLinkOwner declines to write,
      // and the tag stays null forever: the delivery bind fixed a case that does
      // not occur and left the one that does.
      //
      // Vacuity mode 7 -- sensitive to the mutation I imagined, blind to the
      // ordering that actually ships.
      it('binds a startup code when authentication later succeeds', async () => {
        const { getCredentialCustodyState } = await import('../../../src/main/tokenManager');
        (getCredentialCustodyState as Mock).mockReturnValue({
          credentialOwner: null,
          pendingE2EEUnlock: false,
        });
        resetDeepLinkState();
        deliverDeepLink(`concord://invite/${INVITE_CODE}`);
        // The REAL order: the renderer is ready before anyone has signed in.
        signalInviteReady(rendererEvent);
        expect(sentOn('invite:received')).toEqual([INVITE_CODE]);

        // A signs in. Main learns of it here and nowhere else -- the renderer's
        // own replay into the modal is local and sends no IPC.
        (getCredentialCustodyState as Mock).mockReturnValue({
          credentialOwner: 42,
          pendingE2EEUnlock: false,
        });
        await handlers.get('auth:storeRefreshToken')!(trustedIpcEvent, {
          refreshToken: 'tok',
          rememberMe: true,
          apiBase: 'http://localhost:8080',
        });

        // A's teardown on an old SPA tells main nothing; B signs in; swap.
        (getCredentialCustodyState as Mock).mockReturnValue({
          credentialOwner: 43,
          pendingE2EEUnlock: false,
        });
        const releaseCarry = await armDeepLinkCarryForTest();
        simulateReload();
        releaseCarry();
        signalInviteReady(rendererEvent);

        expect(
          sentOn('invite:received'),
          'a startup code the user signed in to accept belongs to that account afterwards'
        ).toEqual([INVITE_CODE]);
      });

      // The fence must run BEFORE the bind at every auth point, or signing in
      // ADOPTS the previous owner's retained queue instead of discarding it --
      // turning the remedy for a cross-account replay into a cause of one.
      it('a sign-in discards the previous owner queue rather than adopting it', async () => {
        const { getCredentialCustodyState } = await import('../../../src/main/tokenManager');
        (getCredentialCustodyState as Mock).mockReturnValue({
          credentialOwner: 41,
          pendingE2EEUnlock: false,
        });
        resetDeepLinkState();
        // A's code waits in the queue; the renderer never became ready.
        deliverDeepLink(`concord://invite/${INVITE_CODE}`);

        (getCredentialCustodyState as Mock).mockReturnValue({
          credentialOwner: 42,
          pendingE2EEUnlock: false,
        });
        await handlers.get('auth:storeRefreshToken')!(trustedIpcEvent, {
          refreshToken: 'tok',
          rememberMe: true,
          apiBase: 'http://localhost:8080',
        });
        signalInviteReady(rendererEvent);

        expect(
          sentOn('invite:received'),
          "signing in must not adopt the previous account's queued codes"
        ).toEqual([]);
      });

      // The restore path is the likelier of the two in practice: a remembered
      // session at launch is exactly when a startup deep link is waiting.
      it('binds a startup code when a remembered session is restored', async () => {
        const { getCredentialCustodyState } = await import('../../../src/main/tokenManager');
        (getCredentialCustodyState as Mock).mockReturnValue({
          credentialOwner: null,
          pendingE2EEUnlock: false,
        });
        resetDeepLinkState();
        deliverDeepLink(`concord://invite/${INVITE_CODE}`);
        signalInviteReady(rendererEvent);
        expect(sentOn('invite:received')).toEqual([INVITE_CODE]);

        (getCredentialCustodyState as Mock).mockReturnValue({
          credentialOwner: 42,
          pendingE2EEUnlock: false,
        });
        // #86: a restore from an UNBOUND sender is refused before it binds
        // anything, so the restore comes from the bound saas view.
        await handlers.get('auth:restoreSession')!(trustedIpcEvent);

        (getCredentialCustodyState as Mock).mockReturnValue({
          credentialOwner: 43,
          pendingE2EEUnlock: false,
        });
        const releaseCarry = await armDeepLinkCarryForTest();
        simulateReload();
        releaseCarry();
        signalInviteReady(rendererEvent);

        expect(
          sentOn('invite:received'),
          'a restored session owns the startup code it was launched with'
        ).toEqual([INVITE_CODE]);
      });

      it('deeplink:forget rejects an untrusted sender frame', async () => {
        resetDeepLinkState();
        signalInviteReady(rendererEvent);
        deliverDeepLink(`concord://invite/${INVITE_CODE}`);

        await handlers.get('deeplink:forget')!(foreignIpcEvent);

        const releaseCarry = await armDeepLinkCarryForTest();
        simulateReload();
        releaseCarry();
        signalInviteReady(rendererEvent);

        // Refused, so the carry still works — a hostile frame cannot wipe a
        // pending invite even though forgetting is the fail-safe direction.
        expect(sentOn('invite:received')).toEqual([INVITE_CODE, INVITE_CODE]);
      });

      // CODEX P2 (round 15). Round 14 refreshed the re-clicked code's clock and
      // marker but left its single occurrence at index 0. Retiring the marker also
      // retires the eviction reservation, so the entry was then the oldest AND
      // unexempt — the next different link overflowed the cap and evicted the
      // fresh re-click. The fix honoured the action and then threw it away.
      // Moving the entry to the FIFO tail — the obvious remedy — does NOT work:
      // at re-click time it is usually the only entry, so the move is a no-op and
      // the later links still append after it. The reservation had to be split
      // from the replay marker instead.
      it('CODEX P2 (red-team): a refreshed re-click keeps its eviction reservation', async () => {
        const { PENDING_DEEP_LINK_CAP } = await import('../../../src/main/main');
        expect(PENDING_DEEP_LINK_CAP).toBeGreaterThan(0);
        resetDeepLinkState();
        vi.useFakeTimers();
        try {
          signalInviteReady(rendererEvent);
          deliverDeepLink(`concord://invite/${INVITE_CODE}`);

          const release = await armDeepLinkCarryForTest();
          simulateReload();
          release();

          // The user re-clicks the carried code while the successor is loading...
          deliverDeepLink(`concord://invite/${INVITE_CODE}`);

          // ...then enough different links arrive to overflow the cap.
          const SAFE = 'ABCDEFGHJKMNPQRS';
          for (let i = 0; i < PENDING_DEEP_LINK_CAP; i += 1) {
            deliverDeepLink(`concord://invite/ZZZZZZB${SAFE[i % SAFE.length]}`);
          }

          signalInviteReady(rendererEvent);
          vi.advanceTimersByTime(DEEP_LINK_EMIT_WINDOW_MS * 40);

          const deliveries = sentOn('invite:received').filter((c) => c === INVITE_CODE);
          expect(
            deliveries.length,
            'the deliberate re-click must not be evicted as the oldest entry'
          ).toBeGreaterThanOrEqual(2);
        } finally {
          vi.useRealTimers();
        }
      });

      // CODEX P2 (round 14). An interaction between two earlier fixes, neither
      // wrong alone. The pending-queue dedupe (round 11) discarded a duplicate of
      // the carried code; the drain-time expiry (round 13) then dropped the stale
      // original. Together, a user who re-opens the same link while the successor
      // is still loading got NOTHING — both fences firing on the same code and
      // cancelling each other out.
      it('CODEX P2 (red-team): a re-click behind a queued carried code still opens', async () => {
        const { DEEP_LINK_CARRY_MAX_AGE_MS } = await import('../../../src/main/main');

        resetDeepLinkState();
        vi.useFakeTimers();
        try {
          signalInviteReady(rendererEvent);
          deliverDeepLink(`concord://invite/${INVITE_CODE}`);
          expect(sentOn('invite:received')).toEqual([INVITE_CODE]);

          // Carried and queued; the successor never signals ready.
          const release = await armDeepLinkCarryForTest();
          simulateReload();
          release();

          // The user opens the same link again, deliberately.
          deliverDeepLink(`concord://invite/${INVITE_CODE}`);

          // Long past the ORIGINAL delivery's window — the replay would expire.
          vi.advanceTimersByTime(DEEP_LINK_CARRY_MAX_AGE_MS * 2);
          signalInviteReady(rendererEvent);
          vi.advanceTimersByTime(DEEP_LINK_EMIT_WINDOW_MS * 4);

          expect(
            sentOn('invite:received'),
            'the deliberate re-click must reach the renderer, not be eaten by the replay it queued behind'
          ).toEqual([INVITE_CODE, INVITE_CODE]);
        } finally {
          vi.useRealTimers();
        }
      });

      // CODEX P2 (round 13). The age was checked where the code was QUEUED and
      // never again. Pending-queue residence is unbounded — the successor
      // renderer signals readiness when it is ready — so a stalled init left a
      // carried code sitting in the queue and the drain replayed it on the
      // strength of the marker alone. The fence passed once and was never asked
      // again, which is how a dismissed invite reappears hours later.
      it('CODEX P2 (red-team): a carried code that ages out IN the queue is not replayed', async () => {
        const { DEEP_LINK_CARRY_MAX_AGE_MS } = await import('../../../src/main/main');

        resetDeepLinkState();
        vi.useFakeTimers();
        try {
          signalInviteReady(rendererEvent);
          deliverDeepLink(`concord://invite/${INVITE_CODE}`);
          expect(sentOn('invite:received')).toEqual([INVITE_CODE]);

          // Carried well inside the window, so it is queued...
          const release = await armDeepLinkCarryForTest();
          simulateReload();
          release();

          // ...but the successor never signals ready until long after it expired.
          vi.advanceTimersByTime(DEEP_LINK_CARRY_MAX_AGE_MS * 3);
          signalInviteReady(rendererEvent);
          vi.advanceTimersByTime(DEEP_LINK_EMIT_WINDOW_MS * 4);

          expect(
            sentOn('invite:received'),
            'a code that expired while queued must not be replayed on drain'
          ).toEqual([INVITE_CODE]);
        } finally {
          vi.useRealTimers();
        }
      });

      // CODEX P2 (round 11). The reservation matched by VALUE, so every copy of
      // the carried code was exempt. A page that knows that code — its own, if it
      // fired the link that got carried — could fill the queue with duplicates,
      // leaving a later legitimate link as the only non-reserved entry and thus
      // the immediate eviction victim: suppression rather than substitution.
      it('CODEX P2 (red-team): duplicates of the carried code cannot starve a later link', async () => {
        const { PENDING_DEEP_LINK_CAP } = await import('../../../src/main/main');
        expect(PENDING_DEEP_LINK_CAP).toBeGreaterThan(0);
        resetDeepLinkState();
        vi.useFakeTimers();
        try {
          signalInviteReady(rendererEvent);
          deliverDeepLink(`concord://invite/${INVITE_CODE}`);

          const release = await armDeepLinkCarryForTest();
          simulateReload();
          release();

          // Flood with copies of the CARRIED code, then one different, legitimate
          // link that must not be the one thrown away.
          for (let i = 0; i < PENDING_DEEP_LINK_CAP * 2; i += 1) {
            deliverDeepLink(`concord://invite/${INVITE_CODE}`);
          }
          const LATER_CODE = 'ZZZZZZAB';
          deliverDeepLink(`concord://invite/${LATER_CODE}`);

          signalInviteReady(rendererEvent);
          vi.advanceTimersByTime(DEEP_LINK_EMIT_WINDOW_MS * 40);

          const sent = sentOn('invite:received');
          expect(sent, 'the carried invite still survives').toContain(INVITE_CODE);
          expect(sent, 'and so does the later legitimate one').toContain(LATER_CODE);
        } finally {
          vi.useRealTimers();
        }
      });

      // CODEX P2 (round 7). F1 reserved the carried code in the HOLD buffer and
      // left the PENDING queue open — and the carried code is re-queued first, so
      // it is the oldest entry and the guaranteed drop-oldest victim once the cap
      // is exceeded while the successor document loads. Any page can fire that
      // burst, so the carry silently hands the user the attacker's invites in
      // place of their own: F1's exact defect, one queue over.
      it('CODEX P2 (red-team): a burst during the successor load cannot evict the carried code', async () => {
        const { PENDING_DEEP_LINK_CAP } = await import('../../../src/main/main');
        // The import is load-bearing and was silently undefined once: `i < NaN`
        // is false, so the burst never ran and this test passed on zero attacker
        // links. Assert the fixture before using it.
        expect(PENDING_DEEP_LINK_CAP).toBeGreaterThan(0);
        resetDeepLinkState();
        vi.useFakeTimers();
        try {
          signalInviteReady(rendererEvent);
          deliverDeepLink(`concord://invite/${INVITE_CODE}`);
          expect(sentOn('invite:received')).toEqual([INVITE_CODE]);

          const release = await armDeepLinkCarryForTest();
          simulateReload();
          release();

          // The successor has NOT signalled ready, so everything queues behind
          // the carried code. Overflow the cap several times over.
          //
          // Codes must be EXACTLY 8 chars from deepLink.ts's alphabet (no
          // I/O/l/0/1). The first version of this burst used `ATTACKER00`-style
          // strings, every one of which the parser rejected — so the burst never
          // happened and the test passed against plain drop-oldest.
          const SAFE = 'ABCDEFGHJKMNPQRS';
          const burst = Array.from(
            { length: PENDING_DEEP_LINK_CAP * 2 },
            (_unused, i) => `ZZZZZZA${SAFE[i % SAFE.length]}`
          );
          for (const code of burst) deliverDeepLink(`concord://invite/${code}`);

          signalInviteReady(rendererEvent);
          vi.advanceTimersByTime(DEEP_LINK_EMIT_WINDOW_MS * 40);

          // COUNT, do not merely contain. The original pre-reload delivery is
          // already in this list, so `toContain` is satisfied whether or not the
          // carry survived — which is exactly how the first version of this test
          // passed against plain drop-oldest.
          const deliveries = sentOn('invite:received').filter((code) => code === INVITE_CODE);
          expect(
            deliveries.length,
            "the user's own invite must be re-delivered after a burst it was queued before"
          ).toBeGreaterThanOrEqual(2);
        } finally {
          vi.useRealTimers();
        }
      });

      // CODEX P2 (round 6). Two main-owned swaps can overlap — the case the
      // depth count exists for — and the SECOND reset sees lastCode === null
      // because the first already cleared it. Clearing carriedCode there erased
      // the replay marker and the clock for a code still sitting in the pending
      // queue, so it drained as a "fresh" delivery and restarted its own window:
      // the recency bound defeated for the third time, by its own repair.
      it('CODEX P2 (red-team): a second reset before ready does not reset the carried clock', async () => {
        const { DEEP_LINK_CARRY_MAX_AGE_MS } = await import('../../../src/main/main');

        resetDeepLinkState();
        vi.useFakeTimers();
        try {
          signalInviteReady(rendererEvent);
          deliverDeepLink(`concord://invite/${INVITE_CODE}`);
          expect(sentOn('invite:received')).toEqual([INVITE_CODE]);

          // Two resets, both BEFORE the successor signals ready. The first
          // carries; the second must not erase what the first recorded.
          const releaseA = await armDeepLinkCarryForTest();
          simulateReload();
          const releaseB = await armDeepLinkCarryForTest();
          simulateReload();
          releaseA();
          releaseB();

          // The timing is the whole test. The code sits in the pending queue for
          // most of the window, so the REPLAY is late while the ORIGINAL delivery
          // is later still. A version that restarts the clock at drain time then
          // measures from the replay and happily carries; one that keeps the
          // original clock is already past the fence. Draining and asserting at
          // the same instant — the first shape of this test — makes both versions
          // decline, and passes on the bug.
          const beforeDrain = Math.floor(DEEP_LINK_CARRY_MAX_AGE_MS * 0.8);
          const afterDrain = Math.floor(DEEP_LINK_CARRY_MAX_AGE_MS * 0.4);

          vi.advanceTimersByTime(beforeDrain);
          signalInviteReady(rendererEvent);
          vi.advanceTimersByTime(DEEP_LINK_EMIT_WINDOW_MS * 2);
          expect(
            sentOn('invite:received'),
            'the carried code must still reach the renderer, or this proves nothing'
          ).toEqual([INVITE_CODE, INVITE_CODE]);

          // 1.2x the window since FIRST delivery, but only 0.4x since the replay.
          vi.advanceTimersByTime(afterDrain);
          const releaseC = await armDeepLinkCarryForTest();
          simulateReload();
          releaseC();
          signalInviteReady(rendererEvent);
          vi.advanceTimersByTime(DEEP_LINK_EMIT_WINDOW_MS * 2);

          expect(sentOn('invite:received')).toEqual([INVITE_CODE, INVITE_CODE]);
        } finally {
          vi.useRealTimers();
        }
      });

      // CODEX P2 (round 5). The first version of the replay test asked "is this
      // the same code as last time", which conflated a REPLAY with a deliberate
      // RE-CLICK. A user who dismisses an invite and then opens the same link
      // again is making a fresh delivery; inheriting the old clock meant the new
      // modal was born stale and would not survive a swap — the carry declining
      // the very thing it exists to protect, one more time.
      it('CODEX P2 (red-team): a deliberate re-click starts a NEW recency window', async () => {
        const { DEEP_LINK_CARRY_MAX_AGE_MS } = await import('../../../src/main/main');

        resetDeepLinkState();
        vi.useFakeTimers();
        try {
          signalInviteReady(rendererEvent);
          deliverDeepLink(`concord://invite/${INVITE_CODE}`);
          expect(sentOn('invite:received')).toEqual([INVITE_CODE]);

          // Long past the window: this code is stale and must not be carried...
          vi.advanceTimersByTimeAsync(0);
          vi.advanceTimersByTime(DEEP_LINK_CARRY_MAX_AGE_MS * 2);

          // ...but the user opens the SAME link again, deliberately.
          deliverDeepLink(`concord://invite/${INVITE_CODE}`);
          vi.advanceTimersByTime(DEEP_LINK_EMIT_WINDOW_MS * 2);
          expect(
            sentOn('invite:received'),
            'the re-click itself must reach the renderer, or this test proves nothing'
          ).toEqual([INVITE_CODE, INVITE_CODE]);

          const release = await armDeepLinkCarryForTest();
          simulateReload();
          release();
          signalInviteReady(rendererEvent);
          vi.advanceTimersByTime(DEEP_LINK_EMIT_WINDOW_MS * 2);

          // The re-click is fresh, so the swap must carry it.
          expect(sentOn('invite:received')).toEqual([INVITE_CODE, INVITE_CODE, INVITE_CODE]);
        } finally {
          vi.useRealTimers();
        }
      });

      // CODEX P2. sendDeepLink refreshes gate.lastAt on EVERY delivery, a
      // carry's own replay included, so measuring the fence off lastAt made it a
      // SLIDING window: a dismissed attacker-supplied invite stayed eligible
      // forever as long as main-initiated swaps ("Load latest UI" clicks) kept
      // landing inside it. The clock must run from the FIRST delivery.
      it('CODEX P2 (red-team): the recency window runs from FIRST delivery, not from the last carry', async () => {
        const { DEEP_LINK_CARRY_MAX_AGE_MS } = await import('../../../src/main/main');

        resetDeepLinkState();
        vi.useFakeTimers();
        try {
          signalInviteReady(rendererEvent);
          deliverDeepLink(`concord://invite/${INVITE_CODE}`);
          expect(sentOn('invite:received')).toEqual([INVITE_CODE]);

          // Two hops, each well INSIDE the window on its own, together past it.
          const hop = Math.floor(DEEP_LINK_CARRY_MAX_AGE_MS * 0.6);

          vi.advanceTimersByTime(hop);
          let release = await armDeepLinkCarryForTest();
          simulateReload();
          release();
          signalInviteReady(rendererEvent);
          vi.advanceTimersByTime(DEEP_LINK_EMIT_WINDOW_MS * 2);
          // Positive control: the first carry is legitimate and MUST happen, or
          // the assertion below would pass on a carry that is simply broken.
          expect(sentOn('invite:received')).toEqual([INVITE_CODE, INVITE_CODE]);

          vi.advanceTimersByTime(hop);
          release = await armDeepLinkCarryForTest();
          simulateReload();
          release();
          signalInviteReady(rendererEvent);
          vi.advanceTimersByTime(DEEP_LINK_EMIT_WINDOW_MS * 2);
          // 1.2x the window has elapsed since FIRST delivery. Off lastAt the
          // replay would have restarted the clock and a third send would land.
          expect(sentOn('invite:received')).toEqual([INVITE_CODE, INVITE_CODE]);
        } finally {
          vi.useRealTimers();
        }
      });
    });
  });

  describe('createWindow callbacks', () => {
    it('the saas view first load shows the window', () => {
      const readyCall = mockWebContents.once.mock.calls.find(
        (c: unknown[]) => c[0] === 'did-finish-load'
      );
      expect(readyCall).toBeDefined();
      readyCall![1](); // invoke the callback
      expect(mockMainWindow.show).toHaveBeenCalled();
    });

    it('closed handler tears down both SSO flows and nulls mainWindow', () => {
      const closedCall = mockMainWindow.on.mock.calls.find((c: unknown[]) => c[0] === 'closed');
      expect(closedCall).toBeDefined();
      mockWebContents.close.mockClear();
      closedCall![1](); // invoke — disposes every connection view
      // #974/#975: a window-less SSO flow has no UI for its result, so the
      // 'closed' handler must tear down BOTH provider flows (else the loopback
      // listener + 5-min deadline outlive the renderer). Regression guard for
      // the google-parity gap.
      expect(mockCancelAppleFlow).toHaveBeenCalled();
      expect(mockCancelGoogleFlow).toHaveBeenCalled();
      // #86 invariant 4 (Task 0: a child view outlives its BaseWindow's close):
      // the saas view's renderer is closed explicitly, not orphaned.
      expect(mockWebContents.close).toHaveBeenCalled();
      expect(connectionRegistry.liveConnections()).toEqual([]);

      // Restore the fixture every later test shares: the dock 'activate' path
      // re-creates the window (and its saas view) once no shell window exists.
      appOnCallbacks.get('activate')!();
      expect(connectionRegistry.bindingFor(mockWebContents as never)?.role).toBe('primary');
    });

    it('window open handler allows https and denies others', async () => {
      // The handler is externalizeWindowOpen, registered per-contents inside
      // the `web-contents-created` callback — read it off a fake contents
      // rather than off mockWebContents directly (see the registration test
      // above).
      const { app, shell } = await import('electron');
      const webContentsCreated = (app.on as Mock).mock.calls.find(
        (c: unknown[]) => c[0] === 'web-contents-created'
      );
      expect(webContentsCreated).toBeDefined();
      const mockContents = createMockContents();
      webContentsCreated![1]({}, mockContents);

      const handlerCall = mockContents.setWindowOpenHandler.mock.calls[0];
      expect(handlerCall).toBeDefined();
      const handler = handlerCall[0] as (details: { url: string }) => { action: string };

      // HTTPS opens external
      (shell.openExternal as Mock).mockClear();
      const result1 = handler({ url: 'https://example.com' });
      expect(shell.openExternal).toHaveBeenCalledWith('https://example.com');
      expect(result1.action).toBe('deny');

      // Invalid URL is ignored
      (shell.openExternal as Mock).mockClear();
      const result2 = handler({ url: 'not-a-url' });
      expect(shell.openExternal).not.toHaveBeenCalled();
      expect(result2.action).toBe('deny');

      // javascript: protocol is blocked
      (shell.openExternal as Mock).mockClear();
      const result3 = handler({ url: 'javascript:alert(1)' });
      expect(shell.openExternal).not.toHaveBeenCalled();
      expect(result3.action).toBe('deny');

      // http: protocol is rejected (was accepted pre-#754 tightening)
      (shell.openExternal as Mock).mockClear();
      const result4 = handler({ url: 'http://example.com/foo' });
      expect(shell.openExternal).not.toHaveBeenCalled();
      expect(result4.action).toBe('deny');

      // data: URL is blocked
      (shell.openExternal as Mock).mockClear();
      const result5 = handler({ url: 'data:text/html,<script>alert(1)</script>' });
      expect(shell.openExternal).not.toHaveBeenCalled();
      expect(result5.action).toBe('deny');
    });

    // Regression for the PiP gap: the window-open handler is registered on
    // EVERY web contents via `web-contents-created`, not only the main
    // window's — a PiP window (or any other window) must get the same policy.
    it('registers a window open handler on every window, not only the main window', async () => {
      const { app } = await import('electron');
      const webContentsCreated = (app.on as Mock).mock.calls.find(
        (c: unknown[]) => c[0] === 'web-contents-created'
      );
      expect(webContentsCreated).toBeDefined();

      // A fresh fake contents standing in for a non-main window (e.g. PiP).
      const pipContents = createMockContents();
      webContentsCreated![1]({}, pipContents);

      expect(pipContents.setWindowOpenHandler).toHaveBeenCalled();
      const handler = pipContents.setWindowOpenHandler.mock.calls[0][0] as (details: {
        url: string;
      }) => { action: string };
      expect(handler({ url: 'https://example.com' })).toEqual({ action: 'deny' });
    });
  });

  describe('navigation guard', () => {
    it('blocks external navigation in dev mode', async () => {
      const { app } = await import('electron');
      const webContentsCreated = (app.on as Mock).mock.calls.find(
        (c: unknown[]) => c[0] === 'web-contents-created'
      );
      expect(webContentsCreated).toBeDefined();

      // Invoke web-contents-created to get the will-navigate handler
      const mockContents = createMockContents();
      webContentsCreated![1]({}, mockContents);

      const willNavigateCall = mockContents.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'will-navigate'
      );
      expect(willNavigateCall).toBeDefined();
      const willNavigate = willNavigateCall![1] as (
        event: { preventDefault: () => void },
        url: string
      ) => void;

      // Localhost should be allowed (dev mode, isPackaged=false)
      const event1 = { preventDefault: vi.fn() };
      willNavigate(event1, 'http://localhost:3001/some/path');
      expect(event1.preventDefault).not.toHaveBeenCalled();

      // External URL should be blocked in dev
      const event2 = { preventDefault: vi.fn() };
      willNavigate(event2, 'https://evil.com/steal');
      expect(event2.preventDefault).toHaveBeenCalled();
    });

    it('leaves the billing launcher view to its own Stripe gate (#1305)', async () => {
      const { app, shell } = await import('electron');
      const { isBillingWebContents } = await import('../../../src/main/billing/billingWindow');
      const webContentsCreated = (app.on as Mock).mock.calls.find(
        (c: unknown[]) => c[0] === 'web-contents-created'
      );
      const mockContents = createMockContents();
      webContentsCreated![1]({}, mockContents);
      const willNavigate = mockContents.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'will-navigate'
      )![1] as (event: { preventDefault: () => void }, url: string) => void;

      (shell.openExternal as Mock).mockClear();
      (isBillingWebContents as Mock).mockReturnValueOnce(true);
      const event = { preventDefault: vi.fn() };
      willNavigate(event, 'https://pay.concordvoice.com/c/pay/cs_test_a1');
      expect(isBillingWebContents).toHaveBeenCalledWith(mockContents);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(shell.openExternal).not.toHaveBeenCalled();
    });

    it('externalizes https: navigation in dev mode after preventDefault', async () => {
      const { app } = await import('electron');
      const { shell } = await import('electron');
      const webContentsCreated = (app.on as Mock).mock.calls.find(
        (c: unknown[]) => c[0] === 'web-contents-created'
      );
      const mockContents = createMockContents();
      webContentsCreated![1]({}, mockContents);
      const willNavigate = mockContents.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'will-navigate'
      )![1] as (event: { preventDefault: () => void }, url: string) => void;

      (shell.openExternal as Mock).mockClear();
      const event = { preventDefault: vi.fn() };
      willNavigate(event, 'https://external.example/foo');
      expect(event.preventDefault).toHaveBeenCalled();
      expect(shell.openExternal).toHaveBeenCalledWith('https://external.example/foo');
    });

    it('blocks but does not externalize http: navigation in dev mode', async () => {
      const { app } = await import('electron');
      const { shell } = await import('electron');
      const webContentsCreated = (app.on as Mock).mock.calls.find(
        (c: unknown[]) => c[0] === 'web-contents-created'
      );
      const mockContents = createMockContents();
      webContentsCreated![1]({}, mockContents);
      const willNavigate = mockContents.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'will-navigate'
      )![1] as (event: { preventDefault: () => void }, url: string) => void;

      (shell.openExternal as Mock).mockClear();
      const event = { preventDefault: vi.fn() };
      willNavigate(event, 'http://external.example/foo');
      expect(event.preventDefault).toHaveBeenCalled();
      expect(shell.openExternal).not.toHaveBeenCalled();
    });

    it('blocks but does not externalize javascript: URL', async () => {
      const { app } = await import('electron');
      const { shell } = await import('electron');
      const webContentsCreated = (app.on as Mock).mock.calls.find(
        (c: unknown[]) => c[0] === 'web-contents-created'
      );
      const mockContents = createMockContents();
      webContentsCreated![1]({}, mockContents);
      const willNavigate = mockContents.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'will-navigate'
      )![1] as (event: { preventDefault: () => void }, url: string) => void;

      (shell.openExternal as Mock).mockClear();
      const event = { preventDefault: vi.fn() };
      willNavigate(event, 'javascript:alert(1)');
      expect(event.preventDefault).toHaveBeenCalled();
      expect(shell.openExternal).not.toHaveBeenCalled();
    });

    it('blocks but does not externalize data: URL', async () => {
      const { app } = await import('electron');
      const { shell } = await import('electron');
      const webContentsCreated = (app.on as Mock).mock.calls.find(
        (c: unknown[]) => c[0] === 'web-contents-created'
      );
      const mockContents = createMockContents();
      webContentsCreated![1]({}, mockContents);
      const willNavigate = mockContents.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'will-navigate'
      )![1] as (event: { preventDefault: () => void }, url: string) => void;

      (shell.openExternal as Mock).mockClear();
      const event = { preventDefault: vi.fn() };
      willNavigate(event, 'data:text/html,<script>alert(1)</script>');
      expect(event.preventDefault).toHaveBeenCalled();
      expect(shell.openExternal).not.toHaveBeenCalled();
    });

    it('does not throw on malformed URL — preventDefault called, no externalization', async () => {
      const { app } = await import('electron');
      const { shell } = await import('electron');
      const webContentsCreated = (app.on as Mock).mock.calls.find(
        (c: unknown[]) => c[0] === 'web-contents-created'
      );
      const mockContents = createMockContents();
      webContentsCreated![1]({}, mockContents);
      const willNavigate = mockContents.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'will-navigate'
      )![1] as (event: { preventDefault: () => void }, url: string) => void;

      (shell.openExternal as Mock).mockClear();
      const event = { preventDefault: vi.fn() };
      // Should not throw
      expect(() => willNavigate(event, '')).not.toThrow();
      expect(event.preventDefault).toHaveBeenCalled();
      expect(shell.openExternal).not.toHaveBeenCalled();
    });

    it('packaged mode (no SPA loaded): externalizes https navigation after preventDefault', async () => {
      const electron = await import('electron');
      const { app, shell } = electron;
      // Temporarily flip isPackaged to exercise packaged-mode branch.
      // The mock's `isPackaged` is a plain boolean property, so direct
      // mutation works (no vi.spyOn needed).
      (app as unknown as { isPackaged: boolean }).isPackaged = true;
      try {
        // Re-derive the will-navigate handler under packaged mode.
        // Note: web-contents-created callbacks were registered at module
        // init time (before isPackaged was flipped) — but the handler
        // body reads app.isPackaged at runtime, so the flip takes effect
        // when the handler fires.
        const webContentsCreated = (app.on as Mock).mock.calls.find(
          (c: unknown[]) => c[0] === 'web-contents-created'
        );
        const mockContents = createMockContents();
        webContentsCreated![1]({}, mockContents);
        const willNavigate = mockContents.on.mock.calls.find(
          (c: unknown[]) => c[0] === 'will-navigate'
        )![1] as (event: { preventDefault: () => void }, url: string) => void;

        // Note: remoteSpaBaseUrl is null in test mock because the file-level
        // spaLoader mock returns {mode: 'bundled'} (see line ~224). With no
        // SPA origin set, the SPA-origin early-return path at main.ts L864
        // is unreachable from this test fixture. The test below verifies
        // that with no SPA loaded, packaged-mode externalizes https as
        // expected. Coverage of the SPA-origin allow-path itself would
        // require either a test-only setter export from main.ts or full
        // mock re-isolation via vi.resetModules — both add complexity
        // disproportionate to the value, since the allow-path is
        // structurally equivalent to the dev-mode `localhost` early-return
        // exercised by the dev-mode tests above. Documented as #775's
        // sibling concern; revisit if the allow-path semantics ever diverge
        // from the localhost path.
        (shell.openExternal as Mock).mockClear();
        const event = { preventDefault: vi.fn() };
        willNavigate(event, 'https://external.example/foo');
        expect(event.preventDefault).toHaveBeenCalled();
        expect(shell.openExternal).toHaveBeenCalledWith('https://external.example/foo');
      } finally {
        (app as unknown as { isPackaged: boolean }).isPackaged = false;
      }
    });

    it('packaged mode: blocks but does not externalize http: URL', async () => {
      const electron = await import('electron');
      const { app, shell } = electron;
      (app as unknown as { isPackaged: boolean }).isPackaged = true;
      try {
        const webContentsCreated = (app.on as Mock).mock.calls.find(
          (c: unknown[]) => c[0] === 'web-contents-created'
        );
        const mockContents = createMockContents();
        webContentsCreated![1]({}, mockContents);
        const willNavigate = mockContents.on.mock.calls.find(
          (c: unknown[]) => c[0] === 'will-navigate'
        )![1] as (event: { preventDefault: () => void }, url: string) => void;

        (shell.openExternal as Mock).mockClear();
        const event = { preventDefault: vi.fn() };
        willNavigate(event, 'http://external.example/foo');
        expect(event.preventDefault).toHaveBeenCalled();
        expect(shell.openExternal).not.toHaveBeenCalled();
      } finally {
        (app as unknown as { isPackaged: boolean }).isPackaged = false;
      }
    });

    it('packaged mode: handles malformed URL without throwing', async () => {
      const electron = await import('electron');
      const { app, shell } = electron;
      (app as unknown as { isPackaged: boolean }).isPackaged = true;
      try {
        const webContentsCreated = (app.on as Mock).mock.calls.find(
          (c: unknown[]) => c[0] === 'web-contents-created'
        );
        const mockContents = createMockContents();
        webContentsCreated![1]({}, mockContents);
        const willNavigate = mockContents.on.mock.calls.find(
          (c: unknown[]) => c[0] === 'will-navigate'
        )![1] as (event: { preventDefault: () => void }, url: string) => void;

        (shell.openExternal as Mock).mockClear();
        const event = { preventDefault: vi.fn() };
        expect(() => willNavigate(event, 'not-a-valid-url-at-all')).not.toThrow();
        expect(event.preventDefault).toHaveBeenCalled();
        expect(shell.openExternal).not.toHaveBeenCalled();
      } finally {
        (app as unknown as { isPackaged: boolean }).isPackaged = false;
      }
    });

    // #1870 Finding D: the signed LKG cache serves from spa-cache://concord and
    // (like bundled app://concord) leaves the SPA origin empty. A same-origin
    // full-page reload within the cache (error-boundary "Reload", crash recovery)
    // must be ALLOWED through the packaged will-navigate gate; without the branch
    // it would hit preventDefault() and strand the user in the very degraded state
    // the cache exists for. These mirror the app://concord same-origin allow case
    // and prove the new branch did NOT widen the gate to other origins / hosts.
    it('packaged mode: ALLOWS same-origin spa-cache://concord navigation (no preventDefault)', async () => {
      const electron = await import('electron');
      const { app, shell } = electron;
      (app as unknown as { isPackaged: boolean }).isPackaged = true;
      try {
        const webContentsCreated = (app.on as Mock).mock.calls.find(
          (c: unknown[]) => c[0] === 'web-contents-created'
        );
        const mockContents = createMockContents();
        webContentsCreated![1]({}, mockContents);
        const willNavigate = mockContents.on.mock.calls.find(
          (c: unknown[]) => c[0] === 'will-navigate'
        )![1] as (event: { preventDefault: () => void }, url: string) => void;

        (shell.openExternal as Mock).mockClear();
        const event = { preventDefault: vi.fn() };
        willNavigate(event, 'spa-cache://concord/index.html');
        // Allowed in-window: the handler returns WITHOUT preventDefault, and does
        // not externalize to the OS browser.
        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(shell.openExternal).not.toHaveBeenCalled();
      } finally {
        (app as unknown as { isPackaged: boolean }).isPackaged = false;
      }
    });

    it('packaged mode: BLOCKS spa-cache:// with a non-concord host (host-exactness)', async () => {
      const electron = await import('electron');
      const { app, shell } = electron;
      (app as unknown as { isPackaged: boolean }).isPackaged = true;
      try {
        const webContentsCreated = (app.on as Mock).mock.calls.find(
          (c: unknown[]) => c[0] === 'web-contents-created'
        );
        const mockContents = createMockContents();
        webContentsCreated![1]({}, mockContents);
        const willNavigate = mockContents.on.mock.calls.find(
          (c: unknown[]) => c[0] === 'will-navigate'
        )![1] as (event: { preventDefault: () => void }, url: string) => void;

        // spa-cache://evil and spa-cache://concord.evil are NOT the exact host
        // SPA_CACHE_HOST ('concord'), so the allow branch must not match → blocked.
        for (const url of ['spa-cache://evil/index.html', 'spa-cache://concord.evil/index.html']) {
          (shell.openExternal as Mock).mockClear();
          const event = { preventDefault: vi.fn() };
          willNavigate(event, url);
          expect(event.preventDefault).toHaveBeenCalled();
          // Non-https scheme → silently dropped after preventDefault (no externalize).
          expect(shell.openExternal).not.toHaveBeenCalled();
        }
      } finally {
        (app as unknown as { isPackaged: boolean }).isPackaged = false;
      }
    });
  });

  describe('second-instance handler', () => {
    it('focuses existing window', () => {
      const secondInstance = appOnCallbacks.get('second-instance');
      expect(secondInstance).toBeDefined();
      // Note: mainWindow might be null from the 'closed' test above,
      // but the handler checks for it gracefully
      secondInstance!();
      // Just verify it doesn't throw
    });
  });

  describe('restoreSession deduplication', () => {
    it('dedup cache returns same promise on repeated calls', async () => {
      // The restoreSession handler caches its promise — calling it twice
      // should return the same result without re-invoking performRefresh.
      const handler = handlers.get('auth:restoreSession')!;
      const event = trustedIpcEvent;
      const result1 = await handler(event);
      const result2 = await handler(event);
      expect(result1).toEqual(result2);
    });

    it('restoreSession handler exists and returns an object', async () => {
      const handler = handlers.get('auth:restoreSession')!;
      const result = await handler({
        sender: { id: 1 },
        senderFrame: { url: 'app://concord/index.html' },
      });
      expect(result).toHaveProperty('status');
    });
  });

  describe('IPC handler registration', () => {
    it('registers all expected IPC channels', () => {
      const expected = [
        'app:getVersion',
        'app:getPlatform',
        'app:getIpcContract',
        'app:getSystemInfo',
        'app:getHardwareAcceleration',
        'app:setHardwareAcceleration',
        'app:relaunch',
        'app:quit',
        'media:getDesktopSources',
        'clipboard:writeText',
        'gpu:getInfo',
        'screen:getDisplayInfo',
        'auth:storeRefreshToken',
        'auth:restoreSession',
        'auth:storeE2EEKeys',
        'auth:storeE2EEKeysIfOwner',
        'auth:refreshToken',
        'auth:logout',
        'auth:clearTokens',
        'auth:clearTokensIfOwner',
        'auth:getCapabilities',
        'auth:getMachineId',
        'update:check',
        'update:download',
        'update:install',
        'update:getAllowPrerelease',
        'update:setAllowPrerelease',
        'update:getLogPath',
        'pip:open',
        'pip:close',
        'pip:setAlwaysOnTop',
        'tray:setStatus',
        'app:setBadgeCount',
        'app:flashFrame',
        'app:focusWindow',
      ];
      for (const channel of expected) {
        expect(handlers.has(channel), `missing handler: ${channel}`).toBe(true);
      }
    });
  });

  // ── KLIPY media proxy webRequest interceptor (#626) ──────────────────

  describe('KLIPY media proxy interceptor', () => {
    it('registers onBeforeSendHeaders with the correct URL filter', () => {
      expect(klipyInterceptor).not.toBeNull();
      // #86 invariant 3: pinned to the saas service's own origin, not any host.
      expect(klipyInterceptor!.filter.urls).toEqual(['http://localhost:8080/api/v1/klipy/media*']);
    });

    it.each(['1.0.0', '1.1.0-pilot.2'])(
      'injects Authorization header when token and matching origin are available (%s)',
      async (version) => {
        const tokenManager = await import('../../../src/main/tokenManager');
        const { app } = await import('electron');
        (tokenManager.getCachedAccessToken as Mock).mockReturnValueOnce('test-jwt-token');
        (app.getVersion as Mock).mockReturnValueOnce(version);

        const details = {
          url: 'http://localhost:8080/api/v1/klipy/media?url=https%3A%2F%2Fstatic.klipy.com%2Fimg.gif',
          requestHeaders: {} as Record<string, string>,
        };
        const callback = vi.fn();

        klipyInterceptor!.callback(details, callback);

        expect(callback).toHaveBeenCalledWith({
          requestHeaders: {
            Authorization: 'Bearer test-jwt-token',
            'X-Concord-Client-Version': version,
          },
        });
      }
    );

    it.each(['1.0.0-beta.1', 'custom-build', '1.1.1-pilot.2', '1.1.0-pilot.01', '1.1.0-pilot.1\n'])(
      'omits the client-version header for app version %s',
      async (version) => {
        const tokenManager = await import('../../../src/main/tokenManager');
        const { app } = await import('electron');
        (tokenManager.getCachedAccessToken as Mock).mockReturnValueOnce('test-jwt-token');
        (app.getVersion as Mock).mockReturnValueOnce(version);

        const details = {
          url: 'http://localhost:8080/api/v1/klipy/media?url=test',
          requestHeaders: {} as Record<string, string>,
        };
        const callback = vi.fn();

        klipyInterceptor!.callback(details, callback);

        expect(callback).toHaveBeenCalledWith({
          requestHeaders: { Authorization: 'Bearer test-jwt-token' },
        });
      }
    );

    it('does not inject header when token is null (pre-login)', async () => {
      const tokenManager = await import('../../../src/main/tokenManager');
      (tokenManager.getCachedAccessToken as Mock).mockReturnValueOnce(null);

      const details = {
        url: 'http://localhost:8080/api/v1/klipy/media?url=https%3A%2F%2Fstatic.klipy.com%2Fimg.gif',
        requestHeaders: {} as Record<string, string>,
      };
      const callback = vi.fn();

      klipyInterceptor!.callback(details, callback);

      expect(callback).toHaveBeenCalledWith({ requestHeaders: {} });
      expect(details.requestHeaders['X-Concord-Client-Version']).toBeUndefined();
    });

    it.each(['1.0.0', '1.1.0-pilot.2'])(
      'does not inject header when request origin does not match API base (%s)',
      async (version) => {
        const { app } = await import('electron');
        (app.getVersion as Mock).mockReturnValue(version);
        const tokenManager = await import('../../../src/main/tokenManager');
        // Held (not Once): the origin check runs before the custody read, so a
        // queued value would never be consumed and would leak into the next test.
        (tokenManager.getCachedAccessToken as Mock).mockReturnValue('test-jwt-token');

        const details = {
          url: 'https://attacker.tld/api/v1/klipy/media?steal=true',
          requestHeaders: {} as Record<string, string>,
        };
        const callback = vi.fn();

        try {
          klipyInterceptor!.callback(details, callback);
        } finally {
          (tokenManager.getCachedAccessToken as Mock).mockReturnValue(null);
        }

        expect(callback).toHaveBeenCalledWith({ requestHeaders: {} });
        expect(details.requestHeaders['Authorization']).toBeUndefined();
        expect(details.requestHeaders['X-Concord-Client-Version']).toBeUndefined();
      }
    );

    // #86: there is no "API base" to be null any more — the interceptor is bound to
    // the saas service's origin. Another first-party origin (a self-hosted server
    // the renderer once used) gets no saas token either.
    it('does not inject the saas token into another first-party origin', async () => {
      const tokenManager = await import('../../../src/main/tokenManager');
      (tokenManager.getCachedAccessToken as Mock).mockReturnValue('test-jwt-token');

      const details = {
        url: 'https://api.concordvoice.chat/api/v1/klipy/media?url=test',
        requestHeaders: {} as Record<string, string>,
      };
      const callback = vi.fn();

      try {
        klipyInterceptor!.callback(details, callback);
      } finally {
        (tokenManager.getCachedAccessToken as Mock).mockReturnValue(null);
      }

      expect(callback).toHaveBeenCalledWith({ requestHeaders: {} });
    });
  });

  describe('SPA reload IPC (spa:reloadLatest / spa:checkForUpdate)', () => {
    it('spa:reloadLatest rejects an untrusted sender frame and does NOT navigate', async () => {
      // The renderer never supplies a URL; an untrusted frame must be refused at
      // the boundary FIRST — before any state check, resolveSpaSource, or loadURL.
      (mockWebContents.loadURL as Mock).mockClear();
      const result = await handlers.get('spa:reloadLatest')!({
        senderFrame: { url: 'https://evil.example/' },
      });
      expect(result).toEqual({ mode: 'bundled', changed: false, rejected: true });
      expect(mockWebContents.loadURL).not.toHaveBeenCalled();
    });

    it('spa:reloadLatest is inert (no navigation) in dev/unpackaged mode', async () => {
      const { app } = await import('electron');
      (app as unknown as { isPackaged: boolean }).isPackaged = false;
      (mockWebContents.loadURL as Mock).mockClear();
      const result = await handlers.get('spa:reloadLatest')!(trustedIpcEvent);
      expect(result).toEqual({ mode: 'bundled', changed: false });
      expect(mockWebContents.loadURL).not.toHaveBeenCalled();
    });

    it('spa:reloadLatest loads remote SPA with no-cache headers in packaged mode', async () => {
      const { app } = await import('electron');
      const { BrowserWindow } = await import('electron');
      const { resolveSpaSource } = await import('../../../src/main/spaLoader');
      (app as unknown as { isPackaged: boolean }).isPackaged = true;
      (
        (BrowserWindow as unknown as { getAllWindows: Mock }).getAllWindows as Mock
      ).mockReturnValueOnce([]);
      appOnCallbacks.get('activate')!();
      (resolveSpaSource as unknown as Mock).mockResolvedValueOnce({
        mode: 'remote',
        url: 'https://spa.concordvoice.chat/index.html',
        reason: 'remote SPA compatible',
      });
      (mockWebContents.loadURL as Mock).mockClear();

      const result = await handlers.get('spa:reloadLatest')!(saasAppFrameEvent);

      expect(mockWebContents.loadURL).toHaveBeenCalledWith(
        'https://spa.concordvoice.chat/index.html',
        expect.objectContaining({
          extraHeaders: expect.stringContaining('Cache-Control: no-cache'),
        })
      );
      expect(result).toEqual({ mode: 'remote', changed: false });
    });

    it('spa:checkForUpdate rejects an untrusted sender frame', async () => {
      const result = await handlers.get('spa:checkForUpdate')!({
        senderFrame: { url: 'https://evil.example/' },
      });
      expect(result).toEqual({
        currentMode: 'bundled',
        remoteAvailable: false,
        newerBytesAvailable: null,
        reason: 'rejected',
      });
    });

    it('spa:checkForUpdate returns an inert result in dev/unpackaged mode (permitted frame)', async () => {
      const { app } = await import('electron');
      (app as unknown as { isPackaged: boolean }).isPackaged = false;
      const result = await handlers.get('spa:checkForUpdate')!(trustedIpcEvent);
      expect(result).toEqual({
        currentMode: 'remote',
        remoteAvailable: false,
        newerBytesAvailable: null,
        reason: 'dev mode',
      });
    });
  });

  describe('bundled SPA load failure visibility', () => {
    function getDidFailLoadHandler(): CallbackFn {
      const webContentsCreated = appOnCallbacks.get('web-contents-created');
      expect(webContentsCreated).toBeDefined();
      const mockContents = createMockContents();
      webContentsCreated!({}, mockContents);

      const call = mockContents.on.mock.calls.find(([event]) => event === 'did-fail-load');
      expect(call).toBeTruthy();
      return call![1] as CallbackFn;
    }

    it('reveals a real main-frame bundled app load failure', () => {
      mockRevealLoadFailure.mockClear();

      getDidFailLoadHandler()({}, -6, 'ERR_FILE_NOT_FOUND', 'app://concord/index.html', true);

      expect(mockRevealLoadFailure).toHaveBeenCalledOnce();
      expect(mockRevealLoadFailure.mock.calls[0]?.[1]).toBe(
        'Could not load application — please reinstall'
      );
    });

    it('does not reveal ERR_ABORTED app:// failures', () => {
      mockRevealLoadFailure.mockClear();

      getDidFailLoadHandler()({}, -3, 'ERR_ABORTED', 'app://concord/index.html', true);

      expect(mockRevealLoadFailure).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // THE APP-START CAPABILITY PROBE (#3195, ADR-0043)
  //
  // This is the case that distinguishes #3195 from #3194: the host is reachable
  // from app start, not only from a test. The whole suite around it is the
  // second half of the claim -- every other case in this file exercises work the
  // same `whenReady` handler did, so their passing IS the evidence that the
  // probe neither delayed nor broke startup.
  // ─────────────────────────────────────────────────────────────────────
  describe('concord-audiocap capability probe', () => {
    it('forks the capture child exactly once during app start', () => {
      // The outermost observable: an OS process was spawned by the ready path.
      // A spy on our own module boundary would pass against a probe that main
      // imported and never called.
      expect(mockUtilityFork).toHaveBeenCalledTimes(1);
    });

    it('records the capability the child reported, and kills it', async () => {
      const { audiocapProbeResult, currentAudiocapGeneration } =
        await import('../../../src/main/audiocapHost');

      // Settled during beforeAll's drain: `null` here would mean the probe was
      // never driven, which is the "shipped code with no caller" condition.
      expect(audiocapProbeResult()).toEqual({ ok: true, perProcessAudio: true });
      // P3 -- the probe child is short-lived by construction. A validated hello
      // deliberately does NOT kill the child (that is the share path's contract),
      // so a surviving child here would be a leak with nothing to reap it.
      expect(audiocapChildStub.kill).toHaveBeenCalled();
      expect(currentAudiocapGeneration()).toBe(0);
    });
  });

  // ── the contract-28 DELIVERY legs (#3198 Phase-8 review) ──────────────────
  //
  // Both legs shipped untested: `grep -rn "did-finish-load" desktop/tests/` returned
  // zero hits repo-wide, and this file was not in the PR's diff. The coverage-exclusion
  // defence does not apply -- `vite.config.ts` excludes `src/main` from the Istanbul INCLUDE
  // globs, which is a SonarCloud metric fact, not a testing-policy one, and this 5,000-line
  // suite tests `main.ts` behaviourally throughout. The harness for both shapes already
  // existed here (a push extracted from `mockWebContents.send.mock.calls`, an event handler
  // extracted from `mockWebContents.on.mock.calls`).
  describe('audiocap:capability delivery (#3198, IPC contract 28)', () => {
    /** The `did-finish-load` listener `createWindow` registered on the window's webContents. */
    function didFinishLoadHandler(): () => void {
      const entry = mockWebContents.on.mock.calls.find((c) => c[0] === 'did-finish-load');
      expect(entry, 'no did-finish-load listener was registered').toBeDefined();
      return entry![1] as () => void;
    }

    function capabilityPushes() {
      return mockWebContents.send.mock.calls.filter((c) => c[0] === 'audiocap:capability');
    }

    beforeEach(() => {
      mockWebContents.send.mockClear();
    });

    it('re-pushes the snapshot on did-finish-load', () => {
      // THE RE-PUSH'S ONLY REASON TO EXIST: a renderer created or reloaded after the
      // snapshot settled hears nothing from the change-listener path, so without this an
      // SPA-loader swap strands it on the pre-addon rungs for the session.
      didFinishLoadHandler()();

      expect(capabilityPushes()).toEqual([['audiocap:capability', { perProcessAudio: true }]]);
    });

    it('sends NOTHING on did-finish-load while the snapshot is null', async () => {
      // THE FAIL-CLOSED ARM, and the half that matters. Absence IS the fail-closed state;
      // deleting the `if (capability !== null)` guard ships `{ perProcessAudio: null }` to a
      // renderer whose subscriber then drops it silently -- degraded, invisible, and until
      // now untested on both sides.
      const hostModule = await import('../../../src/main/audiocapHost');
      const snapshot = vi.spyOn(hostModule, 'audiocapMachineCapability').mockReturnValue(null);

      didFinishLoadHandler()();

      // Synchronous assertion, never inside waitFor: a negative wrapped in waitFor passes on
      // its first poll whether or not the state ever settled (`tests.md` § Async assertions).
      expect(capabilityPushes()).toEqual([]);
      snapshot.mockRestore();
    });

    it('pushes the exact channel and payload when the host reports a change', async () => {
      // Pins the listener BODY. Nothing previously proved it sends this channel with this
      // shape -- a typo in either was invisible.
      const { setAudiocapCapabilityListener } = await import('../../../src/main/audiocapHost');
      // The registered callback is main's; re-registering would replace it, so drive the
      // real one by re-reading it is not possible. Instead assert main registered ITS
      // callback by observing the push the host produced during beforeAll's drain.
      expect(typeof setAudiocapCapabilityListener).toBe('function');

      didFinishLoadHandler()();
      const [channel, payload] = capabilityPushes()[0]!;
      expect(channel).toBe('audiocap:capability');
      expect(payload).toEqual({ perProcessAudio: true });
      expect(Object.keys(payload as object)).toEqual(['perProcessAudio']);
    });

    it('does not push into a destroyed window', () => {
      // `mainWindow?.` is a NULL check, not an `isDestroyed()` check. Measured on real
      // Electron 44.1.1 in the Phase-8 adversarial pass: reading `.webContents` off a
      // DESTROYED BrowserWindow throws `Object has been destroyed` on the property access,
      // before `.send` -- and a disposed render FRAME does not throw at all. So this guard,
      // not the optional chain, is what stands between a teardown race and
      // `uncaughtException` -> `app.exit(1)`.
      mockWebContents.isDestroyed.mockReturnValueOnce(true);

      didFinishLoadHandler()();

      expect(capabilityPushes()).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // audiocap:interrupted PUSH (#3394 PR 2, IPC contract 30).
  //
  // A live per-process capture ending involuntarily is reported to main via
  // `setAudiocapInterruptListener`, registered beside `setAudiocapCapabilityListener`
  // during app start. That registration is a one-time call, not a per-invocation read
  // like `audiocapMachineCapability()` above -- so, exactly like the renderer-loss block
  // below, capturing the listener main registers needs a FRESH import: the shared
  // `beforeAll` import already ran (or, pre-T4, never calls this at all), and a spy
  // installed afterward cannot retroactively intercept a registration that already
  // happened. Each case therefore resets modules for itself rather than relying on the
  // one shared import the rest of this file uses.
  // ─────────────────────────────────────────────────────────────────────
  describe('audiocap:interrupted delivery (#3394 PR 2, IPC contract 30)', () => {
    /**
     * Resets modules, spies on the real `setAudiocapInterruptListener` export so main's
     * registration call is intercepted rather than wired to the live host, imports
     * `main.ts` fresh, and returns the captured listener. `spy` is returned too so a
     * caller can assert the registration itself happened (the non-vacuity check every
     * other case in this block relies on).
     */
    // #86 Task 7B: the listener delivers to the share's OWNER connection only, so every
    // case hands it the owner binding of the saas view (this file's main window), read
    // from the fresh registry. `staleOwner` is the same connection one generation back.
    type InterruptListener = (interrupt: Record<string, unknown>, owner?: unknown) => void;
    async function captureInterruptListener(): Promise<{
      listener: InterruptListener;
      spy: ReturnType<typeof vi.spyOn>;
      owner: unknown;
      staleOwner: unknown;
    }> {
      vi.resetModules();
      const hostModule = await import('../../../src/main/audiocapHost');
      let captured: InterruptListener | null = null;
      const spy = vi
        .spyOn(hostModule, 'setAudiocapInterruptListener')
        .mockImplementation((listener) => {
          captured = listener as InterruptListener;
        });

      mockWebContents.send.mockClear();
      await import('../../../src/main/main');
      // Real `setTimeout` drain, matching this file's own `beforeAll` pattern -- lets
      // every microtask up to app-start setup settle, with no dependency on guessing a
      // tick count.
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(
        spy,
        'main never registered a listener via setAudiocapInterruptListener'
      ).toHaveBeenCalledOnce();
      expect(captured, 'no listener was captured from the registration call').toBeTypeOf(
        'function'
      );

      const reg = await import('../../../src/main/connectionRegistry');
      const binding = reg.bindingFor(mockWebContents as never);
      const record = binding ? reg.recordFor(binding.connectionId) : undefined;
      expect(record, 'the saas view is not a bound connection').toBeDefined();
      const ref = reg.refOf(record!);
      return {
        listener: captured!,
        spy,
        owner: { kind: 'audiocap', ref },
        staleOwner: { kind: 'audiocap', ref: { ...ref, generation: ref.generation - 1 } },
      };
    }

    function interruptPushes() {
      return mockWebContents.send.mock.calls.filter((c) => c[0] === 'audiocap:interrupted');
    }

    it('sends the exact channel and payload when the host reports an interrupt', async () => {
      const { listener, spy, owner } = await captureInterruptListener();

      listener({ generation: 4, reason: 'child-crash' }, owner);

      expect(interruptPushes()).toEqual([
        ['audiocap:interrupted', { generation: 4, reason: 'child-crash' }],
      ]);

      spy.mockRestore();
    });

    it('pushes nothing with no owner, or to an owner whose generation has moved on', async () => {
      // #86 Task 7B: owner-only. Before #86 an ownerless interrupt went to the main
      // window; now nobody hears it, and neither does the owner's previous document.
      const { listener, spy, owner, staleOwner } = await captureInterruptListener();

      listener({ generation: 4, reason: 'child-crash' });
      listener({ generation: 4, reason: 'child-crash' }, staleOwner);
      expect(interruptPushes()).toEqual([]);

      // Control: the same harness does deliver to the current owner.
      listener({ generation: 4, reason: 'child-crash' }, owner);
      expect(interruptPushes()).toHaveLength(1);

      spy.mockRestore();
    });

    it('sends a NEW object, never the input reference, and carries no extra field', async () => {
      const { listener, spy, owner } = await captureInterruptListener();

      const input = { generation: 4, reason: 'child-crash', extra: 'nope' };
      listener(input, owner);

      const pushes = interruptPushes();
      expect(pushes).toHaveLength(1);
      const sent = pushes[0]![1];
      expect(sent).not.toBe(input);
      expect(sent).toEqual({ generation: 4, reason: 'child-crash' });
      expect(Object.keys(sent as object)).toEqual(['generation', 'reason']);

      spy.mockRestore();
    });

    it('does not push into a destroyed main window', async () => {
      // Non-vacuity: `captureInterruptListener` already asserts the listener was
      // registered, so this case's zero pushes cannot be explained by "nothing was ever
      // wired" -- only by the `isDestroyed()` guard this case exists to pin.
      const { listener, spy, owner } = await captureInterruptListener();

      mockWebContents.isDestroyed.mockReturnValueOnce(true);
      listener({ generation: 4, reason: 'child-crash' }, owner);

      expect(interruptPushes()).toEqual([]);

      spy.mockRestore();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // AUDIOCAP REGISTRATION ORDER (#3394 PR 2).
  //
  // `setAudiocapInterruptListener` and `setAudiocapPortSink` must both register BEFORE
  // `registerAudiocapIpc`, which installs the `audiocap:start` handler -- the only way a
  // capture can begin. Reusing the `audiocap:interrupted delivery` block's harness and
  // mocks above: same `vi.resetModules()` + fresh `main.ts` import shape, same reason
  // (a one-time registration call cannot be spied on after the fact).
  // ─────────────────────────────────────────────────────────────────────
  describe('audiocap registration order (#3394 PR 2)', () => {
    it('registers setAudiocapInterruptListener and setAudiocapPortSink before registerAudiocapIpc', async () => {
      vi.resetModules();
      const hostModule = await import('../../../src/main/audiocapHost');
      const ipcModule = await import('../../../src/main/ipc/audiocap');

      // Call-through spies: both host setters are trivial variable assignments and
      // `registerAudiocapIpc` only calls the already-mocked `ipcMain.handle`, so letting
      // each run for real costs nothing and keeps this test about ORDER, not stubbing.
      const interruptSpy = vi.spyOn(hostModule, 'setAudiocapInterruptListener');
      const portSinkSpy = vi.spyOn(hostModule, 'setAudiocapPortSink');
      const registerSpy = vi.spyOn(ipcModule, 'registerAudiocapIpc');

      await import('../../../src/main/main');
      // Real `setTimeout` drain, matching this file's own `beforeAll` pattern -- lets every
      // microtask up to app-start setup settle.
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Non-vacuity: each registration call happened exactly once before asserting order --
      // an order assertion over a mock never called is vacuously satisfied by
      // `invocationCallOrder[0]` reading `undefined` on both sides.
      expect(
        interruptSpy,
        'main never registered a listener via setAudiocapInterruptListener'
      ).toHaveBeenCalledOnce();
      expect(
        portSinkSpy,
        'main never registered a sink via setAudiocapPortSink'
      ).toHaveBeenCalledOnce();
      expect(registerSpy, 'main never called registerAudiocapIpc').toHaveBeenCalledOnce();

      const interruptOrder = interruptSpy.mock.invocationCallOrder[0]!;
      const portSinkOrder = portSinkSpy.mock.invocationCallOrder[0]!;
      const registerOrder = registerSpy.mock.invocationCallOrder[0]!;

      expect(interruptOrder).toBeLessThan(registerOrder);
      expect(portSinkOrder).toBeLessThan(registerOrder);

      interruptSpy.mockRestore();
      portSinkSpy.mockRestore();
      registerSpy.mockRestore();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // RENDERER-LOSS WIRING ORDER (#3394 PR 1, R3).
  //
  // `createWindow` calls `wireAudiocapRendererLoss(mainWindow.webContents)` AFTER
  // `await loadPackagedRenderer(...)` / `await loadDevRendererWithFallback(...)`. The
  // renderer is live, shown (`ready-to-show`), and able to invoke `audiocap:start` long
  // before that await resolves -- so a renderer loss (crash / reload) landing inside that
  // window reaches NO audiocap listener, and the capture child keeps its OS tap for a
  // document that no longer exists. Nothing later can see those events, because the wire
  // that eventually registers only sees FUTURE ones.
  //
  // DELIBERATELY THE LAST DESCRIBE BLOCK IN THIS FILE. It is the LAST place in this
  // suite that calls `vi.resetModules()` and re-imports `main.ts` -- the
  // `audiocap:interrupted delivery` block above also does, for the same reason (a
  // one-time registration call cannot be spied on after the fact); every OTHER test in
  // this file shares the SINGLE `beforeAll` import. A second import re-runs every
  // module-scope side effect against the SAME hoisted `mockMainWindow` /
  // `mockWebContents` singletons this file already uses, so ordering the reset-module
  // blocks last (and this one last among them) means no later test can observe the
  // mutated mock state they produce.
  // ─────────────────────────────────────────────────────────────────────
  describe('audiocap renderer-loss wiring order (#3394 PR 1, R3)', () => {
    it('RED: a did-navigate landing before the initial load resolves still reaches the audiocap wire', async () => {
      vi.resetModules();

      // Hold the initial `loadFile` pending -- exactly as a real `loadFile`/`loadURL`
      // stays pending until `did-finish-load`. `mockImplementationOnce` consumes exactly
      // one call, so this does not affect any later use of the shared mock.
      let releaseLoad!: () => void;
      const pendingLoad = new Promise<void>((resolve) => {
        releaseLoad = resolve;
      });
      (mockWebContents.loadFile as Mock).mockImplementationOnce(() => pendingLoad);

      // Snapshot the SHARED mocks' call histories before the second import, so only
      // registrations made by THIS import are inspected below.
      const onCallsBefore = mockWebContents.on.mock.calls.length;

      await import('../../../src/main/main');
      // createWindow is now parked awaiting the still-pending initial load. A real
      // setTimeout drain (matching this file's own beforeAll pattern) lets every
      // microtask up to that hung await settle, with no dependency on guessing a tick
      // count.
      await new Promise((resolve) => setTimeout(resolve, 100));

      const host = await import('../../../src/main/audiocapHost');
      const epochBefore = host.audiocapRendererLossEpoch();

      const newOnCalls = mockWebContents.on.mock.calls.slice(onCallsBefore);
      const didNavigateHandler = newOnCalls.find((c) => c[0] === 'did-navigate')?.[1] as
        ((...a: unknown[]) => void) | undefined;

      // THE RED ASSERTION. Today `wireAudiocapRendererLoss` runs only after the awaited
      // load resolves, so with the load still pending no `did-navigate` handler has been
      // registered from THIS import yet, and firing one (if it existed) could not reach
      // the wire. Once the fix moves the wire ahead of the load, this handler exists
      // while the load is still pending, and firing it bumps the epoch.
      expect(
        didNavigateHandler,
        'no did-navigate listener was registered before the initial load resolved'
      ).toBeTypeOf('function');
      didNavigateHandler!({}, 'https://example.invalid/', 200, 'OK');
      expect(host.audiocapRendererLossEpoch()).toBe(epochBefore + 1);

      // Release the held load so this import does not leave a permanently-pending
      // promise hanging off the shared mock past this test.
      releaseLoad();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    it('CONTROL (non-vacuity): the same did-navigate reaches the wire once the load has already resolved', async () => {
      vi.resetModules();
      const onCallsBefore = mockWebContents.on.mock.calls.length;

      await import('../../../src/main/main');
      await new Promise((resolve) => setTimeout(resolve, 100));

      const host = await import('../../../src/main/audiocapHost');
      const epochBefore = host.audiocapRendererLossEpoch();

      const newOnCalls = mockWebContents.on.mock.calls.slice(onCallsBefore);
      const didNavigateHandler = newOnCalls.find((c) => c[0] === 'did-navigate')?.[1] as (
        ...a: unknown[]
      ) => void;
      expect(didNavigateHandler).toBeTypeOf('function');
      didNavigateHandler({}, 'https://example.invalid/', 200, 'OK');
      // Proves the harness itself can observe an epoch bump when the wire IS registered --
      // so the RED case above is a genuine finding, not a broken assertion.
      expect(host.audiocapRendererLossEpoch()).toBe(epochBefore + 1);
    });
  });
});

// ── #86 Task 7B (RED): per-connection main-process semantics ─────────────────
describe('#86 connection-isolated main semantics', () => {
  type Registry = typeof import('../../../src/main/connectionRegistry');
  const APP_FRAME = 'app://concord/index.html';
  let nextFrame = 9100;

  /** A fake self-hosted primary registered and bound exactly like shellWindow does. */
  function openFakeSelfHosted(origin: string) {
    const reg: Registry = connectionRegistry;
    const svc = reg.registerService(origin, {
      makeSession: () => ({}) as never,
      makeCustody: () => ({}) as never,
      isValidatedSelfHostedApiBase: () => true,
    });
    if (!svc.ok) throw new Error(`registerService refused ${origin}`);
    const frameTreeNodeId = (nextFrame += 1);
    const wc = {
      id: frameTreeNodeId,
      send: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      getURL: vi.fn(() => APP_FRAME),
      loadURL: vi.fn().mockResolvedValue(undefined),
      isDestroyed: vi.fn(() => false),
      mainFrame: { url: APP_FRAME, frameTreeNodeId },
    };
    const opened = reg.openConnection(svc.service.serviceId, wc as never, null);
    if (!opened.ok) throw new Error(`openConnection refused ${origin}`);
    reg.bindSender(wc as never, opened.record.connectionId, 'primary');
    return {
      wc,
      record: opened.record,
      event: { sender: wc, senderFrame: { url: APP_FRAME, frameTreeNodeId, parent: null } },
    };
  }

  const saasEvent = () => ({
    sender: mockWebContents,
    senderFrame: { url: 'http://localhost:3001/', frameTreeNodeId: 77, parent: null },
  });

  describe('app:setBadgeCount is a per-connection sum', () => {
    const lastBadge = async () => {
      const { app } = await import('electron');
      const calls = (app.setBadgeCount as Mock).mock.calls;
      return calls[calls.length - 1]?.[0];
    };

    afterEach(async () => {
      // Leave the saas contribution at zero for later suites.
      await handlers.get('app:setBadgeCount')!(saasEvent(), 0);
    });

    it('A=3 and B=4 show 7, and disposing a connection drops only its share', async () => {
      const A = openFakeSelfHosted('https://badge-a.lan');
      const B = openFakeSelfHosted('https://badge-b.lan');
      try {
        await handlers.get('app:setBadgeCount')!(saasEvent(), 0);
        await handlers.get('app:setBadgeCount')!(A.event, 3);
        await handlers.get('app:setBadgeCount')!(B.event, 4);
        expect(await lastBadge()).toBe(7);

        connectionRegistry.disposeConnection(A.record.connectionId);
        expect(await lastBadge()).toBe(4);
      } finally {
        connectionRegistry.disposeConnection(A.record.connectionId);
        connectionRegistry.disposeConnection(B.record.connectionId);
      }
    });

    it('clamps the summed total (9000 + 9000) to 9999', async () => {
      const A = openFakeSelfHosted('https://clamp-a.lan');
      const B = openFakeSelfHosted('https://clamp-b.lan');
      try {
        await handlers.get('app:setBadgeCount')!(A.event, 9000);
        await handlers.get('app:setBadgeCount')!(B.event, 9000);
        expect(await lastBadge()).toBe(9999);
      } finally {
        connectionRegistry.disposeConnection(A.record.connectionId);
        connectionRegistry.disposeConnection(B.record.connectionId);
      }
    });
  });

  // #86 RT6/RT7 (Phase-4 red-team WIN-1 and WIN-2; WIN-3 is the badge suite above).
  describe('RT6/RT7: window chrome from a background connection', () => {
    const fireWindow = (name: 'focus' | 'blur') => {
      for (const [event, listener] of mockMainWindow.on.mock.calls as Array<[string, () => void]>) {
        if (event === name) listener();
      }
    };

    beforeEach(() => {
      // Start with no flash request outstanding: the window's focus answers them all.
      fireWindow('focus');
      mockMainWindow.flashFrame.mockClear();
    });

    afterEach(() => {
      fireWindow('blur');
      mockMainWindow.isFocused.mockReturnValue(false);
      mockMainWindow.isMinimized.mockReturnValue(false);
    });

    it('WIN-1: a background self-hosted view cannot restore and focus the shell window', async () => {
      const B = openFakeSelfHosted('https://win-1.lan');
      try {
        expect(connectionRegistry.foreground()?.connectionId).not.toBe(B.record.connectionId);
        mockMainWindow.isMinimized.mockReturnValue(true);
        mockMainWindow.restore.mockClear();
        mockMainWindow.focus.mockClear();
        await handlers.get('app:focusWindow')!(B.event);
        expect({
          restore: mockMainWindow.restore.mock.calls.length,
          focus: mockMainWindow.focus.mock.calls.length,
        }).toEqual({ restore: 0, focus: 0 });

        // The foreground primary still can: its notification click focuses the window.
        await handlers.get('app:focusWindow')!(saasEvent());
        expect({
          restore: mockMainWindow.restore.mock.calls.length,
          focus: mockMainWindow.focus.mock.calls.length,
        }).toEqual({ restore: 1, focus: 1 });
      } finally {
        connectionRegistry.disposeConnection(B.record.connectionId);
      }
    });

    it("WIN-2: a background self-hosted view cannot cancel CVNet's taskbar flash", async () => {
      const B = openFakeSelfHosted('https://win-2.lan');
      try {
        await handlers.get('app:flashFrame')!(saasEvent(), true); // CVNet: a mention
        await handlers.get('app:flashFrame')!(B.event, false); // B, in the background
        expect(mockMainWindow.flashFrame.mock.calls).toEqual([[true]]);
      } finally {
        connectionRegistry.disposeConnection(B.record.connectionId);
      }
    });

    it('the window flashes while any connection asks and stops when the last one withdraws', async () => {
      const B = openFakeSelfHosted('https://win-any.lan');
      try {
        await handlers.get('app:flashFrame')!(saasEvent(), true);
        await handlers.get('app:flashFrame')!(B.event, true);
        await handlers.get('app:flashFrame')!(saasEvent(), false);
        expect(mockMainWindow.flashFrame.mock.calls).toEqual([[true]]);
        await handlers.get('app:flashFrame')!(B.event, false);
        expect(mockMainWindow.flashFrame.mock.calls).toEqual([[true], [false]]);
      } finally {
        connectionRegistry.disposeConnection(B.record.connectionId);
      }
    });

    it("a disposed connection's request leaves with it, and the window's focus answers every request", async () => {
      const B = openFakeSelfHosted('https://win-dispose.lan');
      await handlers.get('app:flashFrame')!(B.event, true);
      connectionRegistry.disposeConnection(B.record.connectionId);
      expect(mockMainWindow.flashFrame.mock.calls).toEqual([[true], [false]]);

      await handlers.get('app:flashFrame')!(saasEvent(), true);
      fireWindow('focus');
      expect(mockMainWindow.flashFrame.mock.calls).toEqual([[true], [false], [true], [false]]);
      // Answered: the next request starts a new flash.
      fireWindow('blur');
      await handlers.get('app:flashFrame')!(saasEvent(), true);
      expect(mockMainWindow.flashFrame.mock.calls.at(-1)).toEqual([true]);
    });

    it('a request made while the window is focused is dropped, not left outstanding', async () => {
      const B = openFakeSelfHosted('https://win-focused.lan');
      try {
        mockMainWindow.isFocused.mockReturnValue(true);
        await handlers.get('app:flashFrame')!(B.event, true); // hidden B cannot see the focus
        expect(mockMainWindow.flashFrame).not.toHaveBeenCalled();

        mockMainWindow.isFocused.mockReturnValue(false);
        await handlers.get('app:flashFrame')!(saasEvent(), true);
        await handlers.get('app:flashFrame')!(saasEvent(), false);
        expect(mockMainWindow.flashFrame.mock.calls).toEqual([[true], [false]]);
      } finally {
        connectionRegistry.disposeConnection(B.record.connectionId);
      }
    });
  });

  describe('selfHosted:probeServer from the saas view', () => {
    it('opens an approved other origin in its own connection and never re-homes saas', async () => {
      const { probeSelfHostedServer } = await import('../../../src/main/selfHostedProbe');
      const { WebContentsView } = await import('electron');
      const { serviceIdForApiBase } = await import('../../../src/main/selfHostedProfile');
      const origin = new URL('https://other-approved.lan').origin;
      const { commitSelfHostedApproval } = await import('../../../src/main/selfHostedProfile');
      approvalStore.records.length = 0;
      // Approved for real: the in-memory mint gate AND a durable record with its tier.
      // A bare `{ origin }` record is no approval (approvalTierForApiBase fails closed),
      // so the probe re-ran the ceremony against a resolve mock with no addresses.
      commitSelfHostedApproval(origin, '10.0.0.5');
      (probeSelfHostedServer as Mock).mockResolvedValue({ status: 'ok', apiBase: origin });
      mockResolveForDisplay.mockResolvedValue({
        ok: true,
        address: '10.0.0.5',
        addresses: ['10.0.0.5'],
        decision: { tier: 'tier2' },
      } as never);

      // A fresh view for the new connection (the shared mock view is the saas one).
      const newWc = {
        send: vi.fn(),
        on: vi.fn(),
        once: vi.fn(),
        getURL: vi.fn(() => ''),
        loadURL: vi.fn().mockResolvedValue(undefined),
        loadFile: vi.fn().mockResolvedValue(undefined),
        isDestroyed: vi.fn(() => false),
        close: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        mainFrame: { url: APP_FRAME, frameTreeNodeId: 9001 },
      };
      (WebContentsView as unknown as Mock).mockImplementationOnce(function () {
        return {
          webContents: newWc,
          setBounds: vi.fn(),
          setVisible: vi.fn(),
          setBackgroundColor: vi.fn(),
        };
      });
      mockWebContents.loadURL.mockClear();
      const saasBefore = connectionRegistry.foreground()?.connectionId;

      const result = await handlers.get('selfHosted:probeServer')!(saasEvent(), origin);

      try {
        expect(result).toEqual({
          status: 'opened-in-connection',
          serviceId: serviceIdForApiBase(origin),
        });
        // Activated: the new connection is foreground, the saas view was not navigated.
        const opened = connectionRegistry
          .liveConnections()
          .find((r) => r.serviceId === serviceIdForApiBase(origin));
        expect(opened).toBeDefined();
        expect(connectionRegistry.foreground()?.connectionId).toBe(opened!.connectionId);
        expect(connectionRegistry.foreground()?.connectionId).not.toBe(saasBefore);
        expect(mockWebContents.loadURL).not.toHaveBeenCalledWith(
          expect.stringContaining('other-approved')
        );
        expect(mockWebContents.loadURL).not.toHaveBeenCalled();
      } finally {
        for (const r of connectionRegistry.liveConnections()) {
          if (r.serviceId === serviceIdForApiBase(origin)) {
            connectionRegistry.disposeConnection(r.connectionId);
          }
        }
        if (saasBefore) connectionRegistry.setForeground(saasBefore);
        mockResolveForDisplay.mockReset();
      }
    });
  });

  describe('deep links are delivered to the saas connection only', () => {
    it('a self-hosted primary signalling ready neither receives nor drains a deep link', async () => {
      const { ipcMain } = await import('electron');
      const S = openFakeSelfHosted('https://deeplink-self.lan');
      const onCall = (ch: string): CallbackFn => {
        const call = (ipcMain.on as Mock).mock.calls.find((c: unknown[]) => c[0] === ch);
        expect(call, `ipcMain.on('${ch}') was never registered`).toBeDefined();
        return call![1] as CallbackFn;
      };
      const openUrl = appOnCallbacks.get('open-url')!;
      try {
        // Drop both readiness flags the way a reload does, then queue a link.
        const reload = mockWebContents.on.mock.calls.find(
          (c: unknown[]) => c[0] === 'did-start-loading'
        )?.[1] as CallbackFn;
        reload();
        mockWebContents.send.mockClear();
        openUrl({ preventDefault: vi.fn() }, 'concord://invite/AbCdEfGj');

        onCall('invite:renderer-ready')(S.event);
        onCall('deeplink:renderer-ready')(S.event);
        // Never to the self-hosted primary, and its signal must not count as saas readiness.
        expect(S.wc.send).not.toHaveBeenCalled();
        expect(mockWebContents.send).not.toHaveBeenCalledWith('invite:received', expect.anything());

        // The first saas primary load/ready drains the queued link to saas.
        onCall('invite:renderer-ready')(saasEvent());
        expect(mockWebContents.send).toHaveBeenCalledWith('invite:received', { code: 'AbCdEfGj' });
        expect(S.wc.send).not.toHaveBeenCalled();
      } finally {
        connectionRegistry.disposeConnection(S.record.connectionId);
        reload_cleanup();
      }

      function reload_cleanup(): void {
        const r = mockWebContents.on.mock.calls.find(
          (c: unknown[]) => c[0] === 'did-start-loading'
        )?.[1] as CallbackFn;
        r();
        mockWebContents.send.mockClear();
      }
    });

    // Two ways the saas connection can be gone: its window closed (readiness reset), or
    // the connection disposed while its renderer had last said ready. In both the link
    // must wait in the queue: not reach the self-hosted primary, and not be lost.
    it.each([
      ['its window closed', true, 'QrStUvWx'],
      ['its connection disposed while ready', false, 'HjKmNpQr'],
    ] as const)(
      'with NO live saas connection (%s) a link is queued, never sent to a self-hosted primary, and reaches the first saas primary to load',
      async (_label, windowClosed, code) => {
        const { ipcMain } = await import('electron');
        const onCall = (ch: string): CallbackFn => {
          const call = (ipcMain.on as Mock).mock.calls.find((c: unknown[]) => c[0] === ch);
          expect(call, `ipcMain.on('${ch}') was never registered`).toBeDefined();
          return call![1] as CallbackFn;
        };
        const reset = mockWebContents.on.mock.calls.find(
          (c: unknown[]) => c[0] === 'did-start-loading'
        )?.[1] as CallbackFn;
        const openUrl = appOnCallbacks.get('open-url')!;
        const saasBinding = connectionRegistry.bindingFor(mockWebContents as never);
        expect(saasBinding, 'the saas view is not bound').toBeTruthy();
        const saasServiceId = connectionRegistry.recordFor(saasBinding!.connectionId)!.serviceId;

        // The saas connection goes away while a self-hosted primary stays live.
        reset();
        if (!windowClosed) onCall('invite:renderer-ready')(saasEvent());
        connectionRegistry.disposeConnection(saasBinding!.connectionId);
        const S = openFakeSelfHosted('https://deeplink-nosaas.lan');
        let reopenedId: string | null = null;
        try {
          expect(
            connectionRegistry.liveConnections().some((r) => r.serviceId === saasServiceId),
            'precondition: no live saas connection'
          ).toBe(false);
          mockWebContents.send.mockClear();

          openUrl({ preventDefault: vi.fn() }, `concord://invite/${code}`);
          onCall('invite:renderer-ready')(S.event);
          onCall('deeplink:renderer-ready')(S.event);
          expect(S.wc.send).not.toHaveBeenCalled();
          expect(mockWebContents.send).not.toHaveBeenCalledWith(
            'invite:received',
            expect.anything()
          );

          // The first saas primary loads: opened and bound the way shellWindow does, then
          // its renderer signals ready. The queued link reaches it, and only it.
          const reopened = connectionRegistry.openConnection(
            saasServiceId,
            mockWebContents as never,
            null
          );
          if (!reopened.ok) throw new Error(`saas re-open refused: ${reopened.reason}`);
          reopenedId = reopened.record.connectionId;
          connectionRegistry.bindSender(mockWebContents as never, reopenedId, 'primary');
          connectionRegistry.setForeground(reopenedId);
          onCall('invite:renderer-ready')(saasEvent());

          expect(mockWebContents.send).toHaveBeenCalledWith('invite:received', { code });
          expect(S.wc.send).not.toHaveBeenCalled();
        } finally {
          connectionRegistry.disposeConnection(S.record.connectionId);
          if (reopenedId) connectionRegistry.setForeground(reopenedId);
          reset();
          mockWebContents.send.mockClear();
        }
      }
    );
  });

  describe('X1: a packaged build restores views onto the bundled app, not the dev server', () => {
    it('does not pass the dev server URL to the shell unconditionally', async () => {
      const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
      const src = realFs.readFileSync(
        new URL('../../../src/main/main.ts', import.meta.url),
        'utf8'
      );
      const m = /devConnectionUrl:\s*([^\n]+)/.exec(src);
      expect(m, 'main.ts must pass devConnectionUrl').not.toBeNull();
      const value = m![1];
      expect(value).not.toMatch(/^DEV_SERVER_URL\s*,?\s*$/);
      expect(value).toMatch(/isPackaged/);
      expect(value).toContain('app://concord/index.html');
    });
  });

  // #86 RT3 (Phase-4 red-team HEAL-1). Self-heal reloads the saas view and, on its second
  // trigger, drops it to bundled and clears the app-wide remote-SPA origin (which destroys
  // CVNet's pinned PiPs). A did-fail-load is evidence about its OWN contents only, so a
  // self-hosted view framing an SPA asset must not reach it.
  describe('RT3: SPA self-heal acts only on a failed load in the saas view', () => {
    const SPA_URL = 'https://spa.concordvoice.chat/index.html';
    const SPA_ORIGIN = 'https://spa.concordvoice.chat';

    function didFailLoadOf(contents: { on: Mock }): (...args: unknown[]) => void {
      const created = appOnCallbacks.get('web-contents-created');
      expect(created).toBeDefined();
      const first = contents.on.mock.calls.length;
      created!({}, contents);
      const call = contents.on.mock.calls.slice(first).find((c) => c[0] === 'did-fail-load');
      expect(call).toBeDefined();
      return call![1] as (...args: unknown[]) => void;
    }

    async function withSelfHealState(
      body: (markPackaged: () => void) => Promise<void>
    ): Promise<void> {
      const { setRemoteSpaState } = await import('../../../src/main/spaState');
      const { __resetSelfHealState } = await import('../../../src/main/spaSelfHeal');
      const { app } = await import('electron');
      const testApp = app as unknown as { isPackaged: boolean };
      __resetSelfHealState();
      setRemoteSpaState(SPA_URL); // CVNet is on the remote SPA (the packaged saas default)
      try {
        // isPackaged gates the bundled fallback; the body sets it once its PiP is open.
        await body(() => {
          testApp.isPackaged = true;
        });
      } finally {
        testApp.isPackaged = false;
        setRemoteSpaState(null);
        __resetSelfHealState();
      }
    }

    it("a self-hosted view's own failed subframe load does not reload or re-home the saas view", async () => {
      const { getRemoteSpaBaseUrl } = await import('../../../src/main/spaState');
      const { resolveSpaSource } = await import('../../../src/main/spaLoader');
      const evil = openFakeSelfHosted('https://evil-selfhost.example');
      Object.assign(evil.wc, { setWindowOpenHandler: vi.fn() });
      expect(connectionRegistry.foreground()?.connectionId).not.toBe(evil.record.connectionId);
      const warn = vi.spyOn(console, 'warn');
      const closers: Array<() => void> = [];
      try {
        await withSelfHealState(async (markPackaged) => {
          // CVNet's own pop-out, pinned to the SPA origin.
          const firstPipOn = mockPipWindow.on.mock.calls.length;
          await handlers.get('pip:open')!(saasEvent() as never, { id: 'controls-main' });
          for (const call of mockPipWindow.on.mock.calls.slice(firstPipOn)) {
            if (call[0] === 'closed') closers.push(call[1] as () => void);
          }
          expect(closers.length).toBeGreaterThan(0);
          markPackaged();
          const didFailLoad = didFailLoadOf(evil.wc);
          mockWebContents.loadURL.mockClear();
          mockPipWindow.destroy.mockClear();
          warn.mockClear();
          // No *Once fixture: a refused trigger never reads one, and it would leak.
          const resolveCallsBefore = (resolveSpaSource as Mock).mock.calls.length;
          // The attacker renderer inserts <iframe src="https://spa.concordvoice.chat/assets/x.js">.
          // Chromium refuses the frame and reports it on the attacker's OWN webContents.
          didFailLoad({}, -30, 'ERR_BLOCKED_BY_CSP', `${SPA_ORIGIN}/assets/redteam-1.js`, false);
          await new Promise((resolve) => setTimeout(resolve, 900));
          didFailLoad(
            {},
            -27,
            'ERR_BLOCKED_BY_RESPONSE',
            `${SPA_ORIGIN}/assets/redteam-2.js`,
            false
          );
          // A main-frame failure at the SPA URL in the attacker's view is refused too.
          didFailLoad({}, -105, 'ERR_NAME_NOT_RESOLVED', SPA_URL, true);
          await new Promise((resolve) => setTimeout(resolve, 200));
          expect({
            cvnetViewLoads: mockWebContents.loadURL.mock.calls.map((call) => call[0]),
            remoteSpaOrigin: getRemoteSpaBaseUrl(),
            cvnetPipsDestroyed: mockPipWindow.destroy.mock.calls.length,
            resolveSpaSourceCalls:
              (resolveSpaSource as Mock).mock.calls.length - resolveCallsBefore,
            // The main.ts gate refuses before self-heal is reached at all.
            selfHealLogs: warn.mock.calls.filter((c) => String(c[0]).startsWith('[spaSelfHeal]')),
          }).toEqual({
            cvnetViewLoads: [],
            remoteSpaOrigin: SPA_ORIGIN,
            cvnetPipsDestroyed: 0,
            resolveSpaSourceCalls: 0,
            selfHealLogs: [],
          });
        });
      } finally {
        warn.mockRestore();
        for (const close of closers) close();
        connectionRegistry.disposeConnection(evil.record.connectionId);
      }
    });

    it("control: a main-frame SPA load failure in the saas view's own primary still self-heals", async () => {
      const { resolveSpaSource } = await import('../../../src/main/spaLoader');
      await withSelfHealState(async () => {
        const didFailLoad = didFailLoadOf(mockWebContents);
        mockWebContents.loadURL.mockClear();
        (resolveSpaSource as Mock).mockResolvedValueOnce({ mode: 'remote', url: SPA_URL });
        didFailLoad({}, -105, 'ERR_NAME_NOT_RESOLVED', SPA_URL, true);
        await new Promise((resolve) => setTimeout(resolve, 900));
        expect(mockWebContents.loadURL.mock.calls.map((call) => call[0])).toEqual([SPA_URL]);
      });
    });
  });
});

// #86 exit criterion S2 (Task 7B pass 2). Keys staged through auth:storeE2EEKeys land in
// the SENDER's own custody, chosen by the main-held binding, so another connection's next
// credential can never adopt them: the only custody that credential reaches is its own,
// and that custody never received the keys. Driven through main.ts's real handlers with
// one spy custody per connection.
describe('#86 S2: E2EE keys staged by one connection reach only its own custody', () => {
  const APP_FRAME = 'app://concord/index.html';
  let nextFrame = 9600;

  function openWithSpyCustody(origin: string) {
    const custody = {
      storeE2EEKeys: vi.fn(async () => true),
      storeE2EEKeysIfOwner: vi.fn(async () => true),
      storeRefreshToken: vi.fn(() => 77),
    };
    const svc = connectionRegistry.registerService(origin, {
      makeSession: () => ({}) as never,
      makeCustody: () => custody as never,
      isValidatedSelfHostedApiBase: () => true,
    });
    if (!svc.ok) throw new Error(`registerService refused ${origin}`);
    const frameTreeNodeId = (nextFrame += 1);
    const wc = {
      id: frameTreeNodeId,
      send: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      getURL: vi.fn(() => APP_FRAME),
      isDestroyed: vi.fn(() => false),
      mainFrame: { url: APP_FRAME, frameTreeNodeId },
    };
    const opened = connectionRegistry.openConnection(svc.service.serviceId, wc as never, null);
    if (!opened.ok) throw new Error(`openConnection refused ${origin}`);
    connectionRegistry.bindSender(wc as never, opened.record.connectionId, 'primary');
    return {
      custody,
      origin,
      record: opened.record,
      event: { sender: wc, senderFrame: { url: APP_FRAME, frameTreeNodeId, parent: null } },
    };
  }

  it("A's staged keys reach A's custody alone, and B's next credential reaches B's custody alone", async () => {
    const A = openWithSpyCustody('https://s2-a.lan');
    const B = openWithSpyCustody('https://s2-b.lan');
    try {
      const keysA = {
        wrappingKeyBase64: 'wa',
        preferencesKeyBase64: 'pa',
        wrappedPrivateKeyBase64: 'ka', // pragma: allowlist secret
      };
      await expect(handlers.get('auth:storeE2EEKeys')!(A.event, keysA)).resolves.toBe(true);
      expect(A.custody.storeE2EEKeys).toHaveBeenCalledTimes(1);
      expect(A.custody.storeE2EEKeys).toHaveBeenCalledWith(keysA);
      expect(B.custody.storeE2EEKeys).not.toHaveBeenCalled();
      expect(B.custody.storeE2EEKeysIfOwner).not.toHaveBeenCalled();

      // B signs in: its credential is published into B's custody, the only place B's
      // adoption of staged keys can happen, and that custody never saw A's keys.
      await handlers.get('auth:storeRefreshToken')!(B.event, {
        refreshToken: 'tok-b',
        rememberMe: true,
        apiBase: B.origin,
      });
      expect(B.custody.storeRefreshToken).toHaveBeenCalledTimes(1);
      expect(A.custody.storeRefreshToken).not.toHaveBeenCalled();
      expect(B.custody.storeE2EEKeys).not.toHaveBeenCalled();
    } finally {
      connectionRegistry.disposeConnection(A.record.connectionId);
      connectionRegistry.disposeConnection(B.record.connectionId);
    }
  });
});

// #86 Task 7B pass 2: the PiP window renders App's main tree, and ChangelogModalHost
// (rendered there unconditionally) asks for app:getVersion on mount. A primary-only row
// answered the PiP with the refusal ''. The row is pip-scoped, so a PiP bound to a live
// connection gets the real version and an unbound sender still gets ''.
describe('#86 app:getVersion is pip-scoped (the PiP SPA calls it)', () => {
  const PIP_FRAME = 'app://concord/index.html#/pip/1';

  it("a bound PiP gets the app version; an unbound sender gets ''", async () => {
    const { app } = await import('electron');
    const svc = connectionRegistry.registerService('https://pip-version.lan', {
      makeSession: () => ({}) as never,
      makeCustody: () => ({}) as never,
      isValidatedSelfHostedApiBase: () => true,
    });
    if (!svc.ok) throw new Error('registerService refused');
    const primary = { id: 9701, mainFrame: { url: PIP_FRAME, frameTreeNodeId: 9701 } };
    const opened = connectionRegistry.openConnection(svc.service.serviceId, primary as never, null);
    if (!opened.ok) throw new Error('openConnection refused');
    connectionRegistry.bindSender(primary as never, opened.record.connectionId, 'primary');
    const pip = { id: 9702, mainFrame: { url: PIP_FRAME, frameTreeNodeId: 9702 } };
    connectionRegistry.bindSender(pip as never, opened.record.connectionId, 'pip');
    const frame = (id: number) => ({ url: PIP_FRAME, frameTreeNodeId: id, parent: null });
    try {
      const version = app.getVersion();
      expect(version).not.toBe('');
      const fromPip = await handlers.get('app:getVersion')!({
        sender: pip,
        senderFrame: frame(9702),
      });
      expect(fromPip).toBe(version);
      const stranger = { id: 9703, mainFrame: { url: PIP_FRAME, frameTreeNodeId: 9703 } };
      const fromStranger = await handlers.get('app:getVersion')!({
        sender: stranger,
        senderFrame: frame(9703),
      });
      expect(fromStranger).toBe('');
    } finally {
      connectionRegistry.disposeConnection(opened.record.connectionId);
    }
  });
});
