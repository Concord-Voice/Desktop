// MUST be the first import: pins userData before tokenManager/machineId/updater
// capture app.getPath('userData') at module-load time. See pinUserDataPath.ts.
import './pinUserDataPath';
import { registerOpenExternalHandler } from './ipc/openExternal';
import { registerSaveImageHandler } from './ipc/saveImage';
import { registerSSOIPC } from './ipc/sso';
import { cancelActiveAppleFlow } from './oauth/apple/appleFlow';
import { cancelActiveGoogleFlow } from './oauth/google/googleFlow';
import { registerAttestationIpc } from './ipc/attestation';
import {
  openApprovedConnection,
  registerConnectionIpc,
  type ConnectionCeremonyVerdict,
} from './ipc/connection';
import { registerIpc, setRemoteSpaOriginSource } from './ipc/registry';
import { crossCheckApiBase, type ConnectionSender } from './ipc/connectionSender';
import { registerAudiocapIpc } from './ipc/audiocap';
import { registerBillingIpc } from './ipc/billing';
import { registerWindowControlsIpc, getCachedClientBehavior } from './ipc/windowControls';
import {
  initTray,
  destroyTray,
  isTrayActive,
  notifyTrayUpdate,
  setTrayActionSender,
  setTrayWindowFocused,
} from './tray';
import { attachTrayResetHooks, registerTrayStatusIpc } from './ipc/trayStatus';
import { TRAY_ACTION } from '../shared/trayStatus';
import {
  audiocapMachineCapability,
  killAudiocapHost,
  probeAudiocapCapability,
  setAudiocapCapabilityListener,
  setAudiocapInterruptListener,
  setAudiocapPortSink,
  wireAudiocapRendererLoss,
} from './audiocapHost';
import { registerVersionInfoIpc } from './ipc/versionInfo';
import { buildBrowserWindowConfig } from './browserWindowConfig';
import { PRODUCTION_API_BASE } from './apiBaseUrl';
import { revealLoadFailure } from './loadFailureVisibility';
import { loadWindowState, attachWindowState } from './windowState';
import { isWayland } from './waylandDetect';
import { deriveCloseAction, deriveMinimizeAction } from '../shared/clientBehavior';
import { SPA_FALLBACK_MESSAGE } from '../shared/spaIpcTypes';
import {
  app,
  autoUpdater as electronAutoUpdater,
  clipboard,
  desktopCapturer,
  dialog,
  nativeImage,
  powerMonitor,
  protocol,
  screen,
  type BaseWindow,
  type BrowserWindow,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
// #86: custody is per service and reached only through the sender's binding or the
// service record; main never picks one from a pointer.
import { makeServiceCustody } from './serviceCustody';
import { getMachineId } from './machineId';
import { normalizeSelfHostedUrl, probeSelfHostedServer } from './selfHostedProbe';
import { consumeCeremonyToken } from './selfHostedCeremonyBudget';
import {
  approvalTierForApiBase,
  beginPendingApproval,
  clearPendingApproval,
  commitSelfHostedApproval,
  isValidatedSelfHostedApiBase,
  loadApprovedSelfHostedOrigins,
} from './selfHostedProfile';
import { resolveForDisplay, type ResolveForDisplayResult } from './guardedRequest';
import type { EgressDecision } from './egressPolicy';
import {
  initAutoUpdater,
  stopAutoUpdater,
  setUpdateFeedUrl,
  checkForUpdates,
  forceCheckForUpdates,
  downloadUpdate,
  safeQuitAndInstall,
  getAllowPrerelease,
  setAllowPrerelease,
  getUpdateLogger,
  getUpdateLogPath,
} from './updater';
import { getBuildTag } from './buildInfo';
import {
  checkUpdateSentinel,
  finalizeUpdate,
  finalizeRollback,
  runDeferredCleanup,
  type SentinelResult,
} from './updateSafety';
import {
  resolveSpaSource,
  isUnexpectedBundled,
  classifyFallbackReason,
  isTransientRemoteFailure,
  captureSpaHash,
  hashEntryHtml,
  SPA_NO_CACHE_LOAD_OPTIONS,
  type SpaLoadDecision,
} from './spaLoader';
import { CONFIG_TIMEOUT_MS, SPA_RETRY_DELAYS_MS } from './spaTiming';
import { getLiveDir } from './spaCache/cacheStore';
import { populateCacheFromRemote } from './spaCache/populateCache';
import { resolveCachedSpa } from './spaCache/resolveCachedSpa';
import { SPA_CACHE_HOST, SPA_CACHE_SCHEME } from './spaCache/manifestSchema';
import { handleDidFailLoad, handleSpaRequestSelfHeal } from './spaSelfHealMainFrame';
import { buildRemotePipUrl, isValidPipOpenSender } from './pipUrl';
import { mintPipSessionToken } from './pipSession';
import {
  extractInviteDeepLinkFromArgv,
  normalizeInviteDeepLink,
  type DeepLinkKind,
} from './deepLink';
import {
  getRemoteSpaBaseDir,
  getRemoteSpaBaseUrl,
  getRemoteSpaUrl,
  getSpaHash,
  setRemoteSpaState,
} from './spaState';
import {
  bindingFor,
  foreground,
  getService,
  liveConnections,
  onGenerationAdvanced,
  recordFor,
  refOf,
  registerService,
  type RegisterServiceDeps,
  type ServiceRecord,
} from './connectionRegistry';
import { isOwnerCurrent } from './connectionCapability';
import {
  configureConnectionSession,
  installNavigationGate,
  sessionForService,
  type ConnectionSessionDeps,
} from './connectionSession';
import {
  activateConnection,
  broadcastToPrimaries,
  createPipWindow,
  createShellWindow,
  foregroundPrimaryHandle,
  foregroundWebContents,
  installDevConnectionMenu,
  openConnectionView,
  persistAddedConnections,
  restorePersistedConnections,
  saasPrimary,
  sendToConnection,
  shellWindow,
} from './shellWindow';
import { runConnectionMigration } from './connectionMigration';
import { readApprovalsFile } from './selfHostedApprovals';
import { SAAS_SERVICE_ID, type ConnectionRef } from '../shared/connectionIdentity';
import {
  IPC_CONTRACT_VERSION,
  type CredentialOwner,
  type SelfHostedProbeResult,
} from './ipcContract';
import { registerIpcHandlers as registerPermissionHandlers } from './permissionManager';
import { migrateUserData } from './userDataMigration';
import { showSplash, closeSplash, updateSplashError } from './splashWindow';
import { maybePromptMove } from './applicationsFolderGate';
import { cleanupSquirrelResidue } from './squirrelCleanup';

// One-time migration: consolidate any legacy userData tree into the pinned
// "ConcordVoice" dir (#1291). Runs after pinUserDataPath.ts has set the path,
// before any userData read below.
//
// Note: this runs before the single-instance lock (acquired later, in
// app.whenReady). A rare concurrent double-launch could race two migrations,
// but every fs op is guarded + idempotent and archives rather than deletes, and
// promoteLegacy rolls back a failed move — so the worst case is a caught warn,
// never data loss (#1314 review, Gitar). Acquiring the lock this early would
// reorder unrelated startup and isn't worth the risk.
migrateUserData();

// Hydrate the in-memory validated-origin set from the durable approval store (#2354).
// Trust is minted only by the native ceremony below; this replays prior decisions.
loadApprovedSelfHostedOrigins();

// #86 §3.6: P0/P1 once, read-only on the legacy files; then connections.json alone.
// After the approvals load (a self-hosted entry needs the ledger) and before any
// window or custody restore. It never throws: a malformed entry is dropped.
const startupConnections = runConnectionMigration(app.getPath('userData'), {
  isValidatedSelfHostedApiBase,
}).entries;

// Hardware acceleration preference — must be checked before app.whenReady()
const hwAccelPrefPath = path.join(app.getPath('userData'), 'hw-accel.json');
function readHwAccelPref(): boolean {
  try {
    const data = JSON.parse(fs.readFileSync(hwAccelPrefPath, 'utf-8'));
    return data.enabled !== false;
  } catch {
    return true; // Default: enabled
  }
}

const contentProtectionPrefPath = path.join(app.getPath('userData'), 'content-protection.json');
const contentProtectionPrefTempPath = `${contentProtectionPrefPath}.${process.pid}.tmp`;

type ContentProtectionPreference =
  { enabled: boolean } | { enabled: boolean; previousEnabled: boolean; staged: true };

function isContentProtectionPreference(value: unknown): value is ContentProtectionPreference {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.enabled === true || record.enabled === false) {
    const keys = Object.keys(record);
    if (keys.length === 1 && keys[0] === 'enabled') return true;
    return (
      record.staged === true &&
      (record.previousEnabled === true || record.previousEnabled === false) &&
      keys.length === 3 &&
      keys.includes('enabled') &&
      keys.includes('previousEnabled') &&
      keys.includes('staged')
    );
  }
  return false;
}

function readContentProtectionPref(): boolean {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(contentProtectionPrefPath, 'utf-8'));
    if (!isContentProtectionPreference(data)) {
      // A file that parses but does not match the shape is the same event as an
      // unreadable one — an enabled control silently going OFF — and it was the
      // one path out of this function that still said nothing. No value is
      // logged: the rejected object is attacker-adjacent user-writable content.
      console.warn('[ContentProtection] preference has an unrecognized shape — treating as OFF');
      return false;
    }
    return 'staged' in data && data.staged ? data.previousEnabled : data.enabled;
  } catch (error) {
    // ENOENT is the opt-in default: the preference was never set, and OFF is
    // correct. Anything else — corrupt JSON, EACCES, a torn read — is a privacy
    // control the user turned ON being silently turned OFF. Same return value,
    // very different event, so only the second one is worth saying out loud.
    //
    // Log the errno CODE, never the message: Node builds fs error messages as
    // `EACCES: permission denied, open '<full path>'`, and this path is under
    // app.getPath('userData') — which on macOS and Windows contains the OS
    // account name. The code carries every bit of the diagnostic value and none
    // of the identity. (#2990 review, Codex P2.)
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== 'ENOENT') {
      console.warn(
        '[ContentProtection] preference unreadable — treating as OFF:',
        code ?? 'unknown'
      );
    }
    return false;
  }
}

function writeContentProtectionPref(preference: ContentProtectionPreference): boolean {
  try {
    fs.writeFileSync(contentProtectionPrefTempPath, JSON.stringify(preference), 'utf-8');
    fs.renameSync(contentProtectionPrefTempPath, contentProtectionPrefPath);
    return true;
  } catch {
    try {
      fs.unlinkSync(contentProtectionPrefTempPath);
    } catch {
      // The failed temp file never becomes the preference authority.
    }
    return false;
  }
}

// BrowserWindow.setContentProtection is macOS/Windows only; everywhere else the
// call is a silent no-op that neither throws nor protects. Main owns this truth
// so no caller is ever told a protection applied that did not. The renderer also
// hides the toggle off-platform, but a UI gate is not the last line — the remote
// SPA reaches this bridge directly, and an older build of it does not know.
function contentProtectionSupported(): boolean {
  return process.platform === 'darwin' || process.platform === 'win32';
}

// Applying at window creation cannot fail loudly — refusing to open the window
// would be worse than an unprotected one. But the two directions are not
// symmetric: failing to apply `false` leaves a window over-protected and
// visible, while failing to apply `true` leaves it UNPROTECTED while the stored
// preference says otherwise. Only the second is a privacy downgrade.
function applyContentProtectionAtCreation(
  window: BaseWindow,
  enabled: boolean,
  label: string
): void {
  if (!contentProtectionSupported()) return;
  try {
    window.setContentProtection(enabled);
  } catch (error) {
    if (enabled) {
      console.error(
        `[ContentProtection] ${label} is UNPROTECTED — preference is ON but apply failed:`,
        (error as Error).message
      );
    } else {
      console.warn(
        `[ContentProtection] failed to clear protection on ${label}:`,
        (error as Error).message
      );
    }
  }
}

function getContentProtectionWindows(): BaseWindow[] {
  const shell = shellWindow();
  const windows: BaseWindow[] = shell ? [shell] : [];
  for (const { window } of pipWindows.values()) windows.push(window);
  return windows.filter((window) => !window.isDestroyed());
}

// Developer Mode preference (#TBD) — gates DevTools access in packaged builds.
// MUST be removed before BETA release per security review.
const devModePrefPath = path.join(app.getPath('userData'), 'developer-mode.json');
function readDeveloperModePref(): boolean {
  try {
    const data = JSON.parse(fs.readFileSync(devModePrefPath, 'utf-8'));
    return data.enabled === true;
  } catch {
    return false;
  }
}
function writeDeveloperModePref(enabled: boolean): void {
  try {
    fs.writeFileSync(devModePrefPath, JSON.stringify({ enabled }), 'utf-8');
  } catch (err) {
    console.error('[DeveloperMode] Failed to persist preference:', (err as Error).message);
  }
}

if (readHwAccelPref()) {
  // Hardware acceleration flags for video encode/decode (IGNIS insight: fastest preset wins)
  app.commandLine.appendSwitch(
    'enable-features',
    'AcceleratedVideoEncoder,AcceleratedVideoDecodeLinuxGL,WebRtcAV1HWEncode'
  );
} else {
  app.disableHardwareAcceleration();
}

// Allow autoplay for all media — Concord is a real-time communication app that
// dynamically creates <audio>/<video> elements for voice/video calls.  The default
// 'document-user-activation-required' policy can silently block these elements.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Handle creating/removing shortcuts on Windows when installing/uninstalling
if (require('electron-squirrel-startup')) {
  app.quit();
}

// app:// scheme registration (#830) — the bundled-fallback renderer loads
// from app://concord/index.html instead of file:// so it has a non-null
// Origin header that the server's CORS allowlist can match. Must run
// BEFORE app.whenReady per Electron API contract. Only registered for
// packaged builds; dev mode uses the existing Vite + file fallback.
if (app.isPackaged) {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'app',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
    // spa-cache:// scheme (#1870) — serves the signed last-known-good SPA cache
    // from a DEDICATED privileged origin, distinct from app://concord (bundled).
    // Same privileges as app:// (non-null Origin for server CORS, secure context
    // for WebCrypto/ServiceWorker, fetch + CORS). Packaged-only: dev uses Vite.
    {
      scheme: SPA_CACHE_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
}

// #86 Task 4: there is no `mainWindow`. The shell is a `BaseWindow` (`shellWindow()`)
// and each connection is a view; see the consumer table at the top of shellWindow.ts.
// Two INDEPENDENT readiness flags, never one shared flag: a pre-22 SPA signals
// only 'invite:renderer-ready', and a shared flag would make main believe the
// friend subscription is live when it is not (#945).
let inviteRendererReady = false;
let friendRendererReady = false;

type PendingDeepLink = { kind: DeepLinkKind; code: string };

const DEEP_LINK_KINDS: readonly DeepLinkKind[] = ['invite', 'friend'];

// Bounded because every argv/open-url deep link arriving before renderer-ready
// appends here, and #945 doubles the write sites. Drop-oldest: a stale queued
// code is worth less than the one the user just clicked.
//
// One queue PER KIND, never one shared array. Both kinds arrive from the same
// untrusted surfaces but wait on independent readiness flags, so on a shared
// queue a burst of friend codes spends the invite allowance: the invite the
// user actually clicked during cold start is evicted and silently never
// delivered. Same reasoning the friend arm already applies at the edge, where
// its WAF rule carries its own ref and counter.
export const PENDING_DEEP_LINK_CAP = 8;
const pendingDeepLinks: Record<DeepLinkKind, string[]> = { invite: [], friend: [] };

// Delivery after renderer-ready is otherwise unbounded: a page the user merely
// visits can fire N concord:// links and get N IPC sends, N forced modal
// re-opens, and N authenticated preview calls — each modal prefilled with an
// attacker-chosen code, one click from sending. emitDeepLink is the single
// choke point every delivery crosses (live and drained, invite and friend), so
// the bound lives here and neither renderer arm has to defend itself. Per kind:
//   - the first delivery goes out immediately — a single click must feel instant;
//   - anything arriving inside the window is HELD in a bounded FIFO and released
//     one per window edge. A different code is deferred, never dropped, so a user
//     who clicks invite A then B then C lands on all three in order. A repeat of
//     the code already showing (or already queued behind) collapses to nothing,
//     because re-sending it would change nothing it displays.
//
// The FIFO replaced a single newest-wins slot (#945, M0): three codes inside one
// window lost the middle one with no log and no trace, and a queue DRAIN of
// eight delivered #1 and #8 while silently discarding six user actions the
// 8-deep queue exists to preserve — while both this comment and spec §6a
// asserted the opposite, and §6a used that invariant as the stated reason a hard
// per-session cap was rejected. Bounded, so it cannot grow without limit; an
// overflow drops the OLDEST and SAYS SO, which is what "never silently" means.
// Short on purpose: long enough to collapse a burst, short enough that
// re-clicking the same link after closing its modal still opens it again.
export const DEEP_LINK_EMIT_WINDOW_MS = 1_000;

type DeepLinkEmitGate = {
  /** Code last sent — what this renderer lifecycle is currently showing. */
  lastCode: string | null;
  /** When it was sent; 0 means nothing sent yet this renderer lifecycle. */
  lastAt: number;
  /**
   * When the code currently in flight was FIRST delivered to any document, on the
   * MONOTONIC clock (`performance.now()`), not wall time. `Date.now()` moves under
   * NTP correction, resume-time synchronisation and manual clock changes: a
   * backward jump kept a dismissed invite eligible past the window, and a forward
   * jump during cold-start recovery made a FRESH invite look expired and
   * reproduced the delivery loss this fence exists to prevent (CODEX P2). The
   * asymmetry decides the trade-off — a monotonic clock may not advance across
   * system SUSPEND on every platform, so a laptop closed mid-window can resume
   * with the code still eligible; that is the F3 direction, which still needs a
   * main-owned swap and an explicit Join click, whereas the wall-clock failure
   * silently discards a live invite. 0
   * means nothing is in flight. Distinct from `lastAt` — which is wall time, used
   * only by the 1-second emit window — and which EVERY delivery refreshes — a carry's replay included. Measuring the recency fence off
   * `lastAt` made it a SLIDING window: each carry reset the clock, so a
   * dismissed code stayed eligible forever as long as main-initiated swaps
   * kept landing inside the window (CODEX P2).
   */
  originAt: number;
  /**
   * The code `resetDeepLinkDelivery` carried and that is awaiting its replay;
   * null otherwise. It is what tells `sendDeepLink` that an incoming code is a
   * REPLAY (clock keeps running) rather than a fresh send (clock restarts) —
   * see there. NOT cleared unconditionally on reset: it survives a reset that
   * carries nothing while its code is still in `pendingDeepLinks`, and is cleared
   * once that code has drained or been evicted. An unconditional clear at reset
   * start is exactly the defect that erased the marker for a still-queued code,
   * which then drained as a fresh delivery and restarted its own window.
   */
  carriedCode: string | null;
  /**
   * The code exempt from `PENDING_DEEP_LINK_CAP` eviction, until it is delivered.
   *
   * SEPARATE from `carriedCode` on purpose (CODEX P2). They started as one field
   * and answer different questions: `carriedCode` means "this queued entry is a
   * REPLAY", which drives the clock preservation and the drain-time expiry;
   * `reservedCode` means "this entry must not be the eviction victim". A
   * deliberate re-click retires the replay marker — it is a fresh delivery, not an
   * echo — but it must KEEP the reservation, or the fresh click becomes the oldest
   * unexempt entry and the next link evicts it. One field could not express both,
   * and collapsing them loses whichever property is not being thought about.
   */
  reservedCode: string | null;
  /** Codes held back by the window, oldest first; one is released per edge. */
  held: string[];
  timer: ReturnType<typeof setTimeout> | null;
};

/** Matches the per-kind pending-queue depth: the gate must not be the narrower bound. */
export const DEEP_LINK_HELD_MAX = 8;

const deepLinkEmitGates: Record<DeepLinkKind, DeepLinkEmitGate> = {
  invite: {
    lastCode: null,
    lastAt: 0,
    originAt: 0,
    carriedCode: null,
    reservedCode: null,
    held: [],
    timer: null,
  },
  friend: {
    lastCode: null,
    lastAt: 0,
    originAt: 0,
    carriedCode: null,
    reservedCode: null,
    held: [],
    timer: null,
  },
};

// A COUNT, not a boolean (#2363). Two main-owned swaps can overlap — a
// `spa:reloadLatest` click can land while a background `scheduleSpaSourceRetry`
// is still awaiting, and `applySpaDecision` itself navigates twice on its
// remote->cache->bundled fallback. A boolean is spent by the FIRST reset inside
// that await, so main's own navigation carried nothing and #2363 reproduced
// silently, fail-open. The count is owned by applySpaDecisionCarryingDeepLink:
// incremented on entry, released in its `finally`.
//
// The EPOCH is what makes the pairing structural rather than absorbed.
// forgetDeliveredDeepLinks zeroes the depth while release closures from
// still-in-flight swaps are outstanding; without the epoch a PRE-logout token
// firing after a LATER swap armed would disarm that swap mid-await (A,B arm ->
// logout -> A releases -> C arms -> B's stale release zeroes C). Fail-closed —
// a repair is lost, nothing leaks — but a `Math.max` clamp there would absorb
// broken pairing instead of preventing it, which is exactly the shape rejected
// when the boolean became a count.
let deepLinkCarryDepth = 0;
let deepLinkCarryEpoch = 0;

/**
 * How recent a DELIVERED code must be for the carry to re-deliver it
 * (RED-TEAM F3). The carry's own justification is "the modal is destroyed
 * before the user could act on it" — a RECENCY condition the original
 * implementation never encoded, so a code the user had already read and
 * DISMISSED was re-presented by every later main-initiated swap, including a
 * "Load latest UI" click minutes afterwards.
 *
 * DERIVED, not chosen (CODEX P1). A hand-picked 15 s was stated to cover the
 * retry schedule "with margin" and did not cover it at all: the delays are
 * SEQUENTIAL and each attempt first awaits resolveSpaSource, so the second
 * attempt's swap lands at 4 s + T + 10 s + T where T is the config timeout —
 * 24 s at worst and 14 s even when both fetches return instantly. The fence
 * then declined the carry on the exact cold-start recovery it exists to
 * repair, silently, presenting as the original bug. Deriving it means editing
 * either input cannot silently re-open that gap.
 *
 * The budget covers the WHOLE chain, not only the delays (CODEX P2, round 6).
 * `scheduleSpaSourceRetry` is first called AFTER the initial `applySpaDecision`
 * resolves, and each attempt schedules its successor only after its own
 * `applySpaDecision` resolves — and every `applySpaDecision` awaits a
 * `captureSpaHash` bounded by the same CONFIG_TIMEOUT_MS. So each attempt costs
 * up to TWO timeouts (one config fetch, one hash capture), plus one hash capture
 * before the chain starts.
 *
 * BEST-EFFORT CEILING, not a proof: `window.loadURL` inside `applySpaDecision`
 * has no deadline of its own, so a pathologically slow document load can still
 * push a swap past this fence. Every step that CAN be bounded is counted here;
 * the one that cannot is named rather than silently assumed to be fast.
 */
export const DEEP_LINK_CARRY_MAX_AGE_MS =
  SPA_RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0) +
  (2 * SPA_RETRY_DELAYS_MS.length + 1) * CONFIG_TIMEOUT_MS +
  5_000;

/**
 * Arm the carry for the next renderer-lifecycle reset (#2363): the code this
 * renderer has already been SENT is re-queued for its successor document
 * instead of being discarded. Only a navigation MAIN itself initiates may arm
 * it, and only via applySpaDecisionCarryingDeepLink, whose `finally` releases
 * it even when applySpaDecision resolves without navigating at all.
 *
 * Returns its OWN release function — idempotent, and inert once
 * forgetDeliveredDeepLinks has advanced the epoch (see `deepLinkCarryEpoch`).
 * Every caller, including tests, must release.
 */
export function carryDeepLinkAcrossNextLoad(): () => void {
  const epoch = deepLinkCarryEpoch;
  deepLinkCarryDepth += 1;
  let released = false;
  return () => {
    // A token from a superseded epoch has already been accounted for by the
    // forget that advanced it; decrementing again would disarm a later swap.
    if (released || epoch !== deepLinkCarryEpoch) return;
    released = true;
    deepLinkCarryDepth -= 1;
  };
}

// Both readiness flags drop together at every renderer-lifecycle boundary
// (window creation, reload, crash, close), and the emit gate resets with them:
// a fresh renderer displays nothing, so it must be able to receive the same
// code again and must not inherit the previous lifecycle's window.
//
// The timer and the held FIFO are cleared here too (#945, Md3). Leaving them
// live was not exploitable — the boundary is driven by navigation, close or
// crash, never by the external concord:// surface — but it was wrong in two
// visible ways: a stale timer SUPPRESSED the fresh lifecycle's immediate send
// (`gate.timer !== null` short-circuits the fast path), delaying a click by up
// to a second after any reload; and a code the previous renderer had already
// consumed could be re-delivered into the new one, re-opening the modal.
//
// Held codes are re-QUEUED rather than discarded: readiness is already false
// above, so each falls through emitDeepLink into the pending queue and the next
// drain hands it to the new renderer. Snapshot before queueing — queueDeepLink
// re-enters this module's state.
//
// A code that was already SENT is carried too, but ONLY when main itself
// initiated the navigation (#2363). Discarding it is right for an ordinary
// reload — the renderer consumed that code — and wrong for the two source swaps
// main performs on its own initiative (scheduleSpaSourceRetry, spa:reloadLatest),
// where the modal is destroyed before the user could act on it.
function resetDeepLinkDelivery(): void {
  // NO owner fence here, deliberately. It would be redundant: everything this
  // re-queues lands in pendingDeepLinks and meets the fence in
  // drainPendingDeepLinks before it can be delivered — measured by mutation,
  // dropping either one alone leaves the cross-owner test green and dropping both
  // turns it red. One fence per delivery path, not two per path.
  inviteRendererReady = false;
  friendRendererReady = false;
  // Read ONCE for the whole reset, not per kind. NOT cleared here (RED-TEAM
  // F2): the arming belongs to whichever applySpaDecisionCarryingDeepLink call
  // took it out and is released by that call's `finally`. Clearing it on the
  // first reset let an unrelated navigation inside the await spend it, so
  // main's own navigation carried nothing. Leaving it armed for the whole
  // window self-bounds — a second reset finds gate.lastCode === null unless a
  // genuine new send happened in between.
  //
  // "Read once" scopes the ARMING, not the number of codes: the loop below
  // applies this single reading to BOTH gates, so one navigation can re-deliver
  // up to two codes — one invite and one friend, each on its own channel. That
  // is intended (the kinds are independent and never share a queue or a gate);
  // an earlier wording said "one navigation is one carry", which read as a
  // one-code bound and was wrong.
  const carry = deepLinkCarryDepth > 0;
  for (const kind of DEEP_LINK_KINDS) resetDeepLinkGate(kind, carry);
}

/**
 * The per-kind half of `resetDeepLinkDelivery`, lifted out to keep that function
 * under the cognitive-complexity limit. `carry` is read ONCE by the caller and
 * passed in, so both gates see the same reading — see there for why.
 */
function resetDeepLinkGate(kind: DeepLinkKind, carry: boolean): void {
  const gate = deepLinkEmitGates[kind];
  const delivered = gate.lastCode;
  // RED-TEAM F3: only a code the user has NOT had a fair chance to act on.
  // Measured from the FIRST delivery, never from the last (CODEX P2) — see
  // `originAt`.
  const deliveredAge = performance.now() - gate.originAt;
  // TWO fences stop emitDeepLink's same-code collapse (`entry.code ===
  // previous`) from swallowing the carried code, and NEITHER is covered by a
  // test — reordering this block stays green — so keep both:
  //   1. readiness is already false above, so the queueDeepLink calls below
  //      cannot reach the window logic at all; the code lands in the pending
  //      queue and the next drain emits it;
  //   2. the gate is cleared BEFORE anything is re-queued, so a caller that
  //      did reach the window sees `previous === null` and an unbounded
  //      `waited`.
  // A collapse here is silent — no send, no error, no log — and presents
  // exactly as the bug this carry repairs.
  gate.lastCode = null;
  gate.lastAt = 0;
  // NOT cleared unconditionally. A SECOND reset before the renderer signals
  // ready — two main-owned swaps overlapping, which is the case the depth count
  // exists for — sees `lastCode === null` because the FIRST reset cleared it,
  // so it does not carry, and an unconditional clear here erased the marker and
  // the clock for a code still sitting in the pending queue. That code then
  // drained as a "fresh" delivery and restarted its own window, defeating the
  // recency bound exactly as the two earlier versions of it did (CODEX P2).
  // The marker is cleared below only when its code is no longer pending.
  if (gate.timer !== null) {
    clearTimeout(gate.timer);
    gate.timer = null;
  }
  const carried = gate.held;
  gate.held = [];
  // The delivered code predates everything in `held`, so it re-queues first:
  // oldest-first preserves the FIFO ordering documented above.
  const carrying = carry && delivered !== null && deliveredAge <= DEEP_LINK_CARRY_MAX_AGE_MS;
  // A carried code awaiting its replay keeps the clock and the marker alive
  // across resets that carry nothing. Once it is gone from the queue — drained,
  // or evicted at PENDING_DEEP_LINK_CAP — the marker must go too, or a much
  // later genuine delivery of the same code would inherit a long-expired clock.
  const carriedStillPending =
    gate.carriedCode !== null && pendingDeepLinks[kind].includes(gate.carriedCode);
  // Tracked SEPARATELY from carriedStillPending, because the two fields have
  // different lifetimes and tying them was the bug (CODEX P2). queueDeepLink
  // retires `carriedCode` on a re-click while deliberately KEEPING
  // `reservedCode` — the entry is still one queued occurrence and still needs
  // its eviction exemption. An intervening reset then found carriedStillPending
  // false *because carriedCode was null*, and cleared the reservation of a code
  // that was still queued; eight later links could evict the user's own fresh
  // re-click as the oldest unreserved entry. A reservation ends when ITS code
  // leaves the queue, not when some other marker is retired.
  const reservedStillPending =
    gate.reservedCode !== null && pendingDeepLinks[kind].includes(gate.reservedCode);
  if (carrying) {
    gate.carriedCode = delivered;
    gate.reservedCode = delivered;
    queueDeepLink({ kind, code: delivered });
    // RED-TEAM F1: the carried code is the one the user ACTED ON, so it must
    // not be the eviction victim. queueDeepLink drops the OLDEST at
    // PENDING_DEEP_LINK_CAP and the delivered code is re-queued FIRST, which
    // made it the guaranteed victim whenever a hostile page had filled `held`
    // to DEEP_LINK_HELD_MAX — the carry destroying exactly the code it exists
    // to preserve, and handing the user eight attacker-chosen prefilled join
    // modals in its place. Trim the OLDEST HELD codes instead: same
    // drop-oldest policy, applied to the codes the user did not act on.
    const room = PENDING_DEEP_LINK_CAP - pendingDeepLinks[kind].length;
    if (carried.length > room) {
      const dropped = carried.length - room;
      carried.splice(0, dropped);
      // Never silently, and never the code itself — bearer material
      // (internal-reference). Scope: this reports dropped HELD
      // codes only. queueDeepLink's own drop-oldest at PENDING_DEEP_LINK_CAP
      // (below) stays silent, so a full pending queue can still shed one
      // without a line here — reachable only if the renderer never drained it.
      console.warn(
        `Deep-link carry preserved the delivered code for kind=${kind}; dropped ${dropped} older held code(s)`
      );
    }
  } else if (!carriedStillPending) {
    // No carry armed, nothing delivered, or the age fence declining — and no
    // earlier carry still in flight. This code's life ends here, so the next
    // delivery starts a fresh clock instead of inheriting a stale one and
    // being refused on arrival.
    gate.originAt = 0;
    gate.carriedCode = null;
    if (!reservedStillPending) gate.reservedCode = null;
  }
  for (const code of carried) queueDeepLink({ kind, code });
}

// #945 M4 ("a held code does not outlive its session") extended from the
// renderer into main: the carry above can re-deliver a code AFTER the renderer's
// accessToken -> null clear has already run, so main must forget it at the same
// edge. Without this, user A's invite is re-delivered into user B's session by
// the renderer-invokable spa:reloadLatest — see spec
// internal-reference §5.2.
// Silent by construction: codes are bearer material, so nothing here logs one.
//
// EVERYTHING still deliverable goes, not just the carry: the delivered code, the
// hold FIFO and its pending flush, and the pending queue. A code sitting in
// gate.held at logout is the same cross-account replay bounded to the <=1s until
// flushDeepLinkGate releases it, and gate.lastAt is a previous session's
// timestamp — so after this the gates are indistinguishable from a fresh
// process. Idempotent by construction, so the logout paths that reach it may
// overlap freely.
//
// Reached from `auth:logout` and `auth:clearTokens` — the two owner-blind
// credential-ending handlers — and nowhere else. NOT from
// `auth:clearTokensIfOwner`, whose callers are all login-side (see there), and
// NOT from a `rememberMe` refresh failure, which runs gracefulReset() WITHOUT
// electron.clearTokens() (apiClient.ts) and so deliberately keeps deliverable
// codes for the remembered session to resume with. The claim is "every LOGOUT
// path forgets", never "every credential wipe forgets".
// The credential owner that was current when main last accepted a deliverable
// code, or null when none has arrived under a credential. `credentialGeneration`
// (which this reads through getCredentialCustodyState) is stable across a
// session's own token refreshes and advances only when a credential is MINTED or
// CLEARED — so it means "which account", not "which token", which is exactly the
// question here.
let deepLinkOwner: CredentialOwner | null = null;

// The main-side half of the teardown fence, and the half that does not care what
// the renderer is. `deeplink:forget` (v25) needs an SPA new enough to call it,
// and spaLoader loads an older one indefinitely by design; this reads the
// credential store every SPA must go through regardless of contract version.
//
// Fires ONLY on a different NON-NULL owner, and both halves of that are
// load-bearing carve-outs documented in internal-reference:
//
//   tag null    — the code was queued before anyone signed in. It belongs to
//                 nobody, and handing it to the account that signs in next IS
//                 the feature (click invite → sign in → join).
//   current null— credentials are gone but no owner has replaced them: an
//                 aborted SSO, a cancelled account-link, an interrupted email
//                 verification. Those are login-side and must NOT forget, or the
//                 retry lands with the invite silently missing.
//
// Called at the three delivery entry points rather than inside emitDeepLink,
// because drainPendingDeepLinks takes a `queue.splice(0)` snapshot first: a
// forget from inside the loop empties the live queue while the snapshot it is
// iterating survives, and every retained code delivers anyway.
// #86: deep links are saas-only (§3.7), so the owner that fences them is the saas
// custody's, never another connection's.
function liveCredentialOwner(): CredentialOwner | null {
  return getService(SAAS_SERVICE_ID)?.custody.getCredentialCustodyState().credentialOwner ?? null;
}

function fenceDeepLinksOnOwnerChange(atArrival = false, known?: CredentialOwner | null): void {
  // `known` lets a caller that has ALREADY read custody pass its reading in.
  // auth:restoreSession is the one that must: it re-verifies the owner across an
  // await for its own reasons, and an extra read here would both be redundant and
  // change how many times it observes custody.
  const current = known === undefined ? liveCredentialOwner() : known;
  if (deepLinkOwner === null || current === deepLinkOwner) return;
  // `current === null` means credentials are gone with no successor. At a DRAIN
  // or FLUSH that is the login-side carve-out above and the queue must survive.
  // At an ARRIVAL it is separable without per-entry ownership, and separating it
  // is required: on a pre-v25 SPA the teardown leaves A's tag in place, a link
  // clicked while logged out cannot clear it (noteDeepLinkOwner refuses to write
  // null, deliberately), so the fresh code joined A's queue under A's tag and the
  // next owner change swept the link the user had just opened (CODEX P2).
  //
  // Arrival is the boundary that makes them distinguishable: everything ALREADY
  // queued belongs to the retained tag, and the arriving code does not.
  if (current === null && !atArrival) return;
  forgetDeliveredDeepLinks();
}

// Claim the codes now in flight for whoever is signed in. Called at OS arrival
// AND at delivery: arrival binds a code that will sit in the queue, delivery
// spends the pre-login carve-out on the account that actually receives it.
// Deliberately does not clear the tag when logged out — a pre-login code must
// stay null-tagged so the carve-out above still applies to it at sign-in, and
// resetting it would extend that exemption to a retained code (see the test).
function noteDeepLinkOwner(known?: CredentialOwner | null): void {
  const current = known === undefined ? liveCredentialOwner() : known;
  if (current !== null) deepLinkOwner = current;
}

function forgetDeliveredDeepLinks(): void {
  deepLinkOwner = null;
  // Advance BEFORE zeroing: outstanding release tokens are now stale and must
  // no longer decrement (see carryDeepLinkAcrossNextLoad).
  deepLinkCarryEpoch += 1;
  deepLinkCarryDepth = 0;
  for (const kind of DEEP_LINK_KINDS) {
    const gate = deepLinkEmitGates[kind];
    gate.lastCode = null;
    gate.lastAt = 0;
    gate.originAt = 0;
    gate.carriedCode = null;
    gate.reservedCode = null;
    gate.held = [];
    if (gate.timer !== null) {
      clearTimeout(gate.timer);
      gate.timer = null;
    }
    pendingDeepLinks[kind].length = 0;
  }
}

function isRendererReadyFor(kind: DeepLinkKind): boolean {
  return kind === 'friend' ? friendRendererReady : inviteRendererReady;
}

function registerInviteProtocolClient(): void {
  if (!app.isPackaged) return;
  if (typeof app.setAsDefaultProtocolClient !== 'function') return;
  try {
    if (process.platform === 'win32') {
      app.setAsDefaultProtocolClient('concord', process.execPath, []);
    } else {
      app.setAsDefaultProtocolClient('concord');
    }
  } catch {
    console.warn('[DeepLink] protocol registration failed');
  }
}

// Friend codes ride their own channel; 'invite:received' keeps emitting a bare
// { code } forever. spaLoader refuses an SPA NEWER than the shell but loads an
// older one indefinitely, and SPA_IPC_CONTRACT is an operator-set, hot-reloadable
// var — so a contract-22 shell can host a 19-era SPA with no bound. A widened
// { kind, code } payload would reach that SPA, which ignores the unknown field
// and opens the SERVER-join modal with a friend code. On a second channel the
// same SPA simply never subscribes and the deep link no-ops (#945, spec X1).
function sendDeepLink(kind: DeepLinkKind, code: string): void {
  // Bind the code to whoever is RECEIVING it, not only to whoever was signed in
  // when it arrived. A code clicked before sign-in arrives ownerless on purpose
  // — that carve-out is the click-invite-then-sign-in feature — but tagging it
  // only at arrival left it ownerless FOREVER, so the exemption outlived the
  // delivery that spent it and the primary flow produced a code any later
  // account could still be handed (CODEX P2). No-op when nobody is signed in.
  noteDeepLinkOwner();
  const gate = deepLinkEmitGates[kind];
  // A carry REPLAYS a code whose origin clock must keep running; every OTHER
  // delivery starts a fresh one (CODEX P2, twice). The replay is identified by
  // `carriedCode`, which resetDeepLinkDelivery set for exactly the code it
  // carried — not by "same code as last time", which was the first attempt and
  // was wrong in a way that mattered: a user who dismisses an invite and then
  // DELIBERATELY re-opens the same link is making a fresh delivery, and
  // inheriting the old clock meant their new modal was already stale and would
  // not be carried across a swap.
  // Only when THIS code is the reserved one, mirroring the carriedCode check
  // below. Clearing unconditionally meant a different code draining first — the
  // reserved code plus a newer click both queued, readiness flipping — released
  // the reservation before the reserved code was delivered, reopening the
  // eviction window F1 and the round-11 dedupe exist to close (Gitar).
  if (code === gate.reservedCode) gate.reservedCode = null;
  if (code === gate.carriedCode) {
    gate.carriedCode = null;
  } else {
    // Monotonic, deliberately — see `originAt`.
    gate.originAt = performance.now();
  }
  gate.lastCode = code;
  gate.lastAt = Date.now();
  // Deep links are saas-only (§3.7): never delivered to a self-hosted view.
  const saas = saasPrimary();
  if (!saas) return;
  if (kind === 'friend') {
    sendToConnection(refOf(saas), 'deeplink:friend-code', { code });
    return;
  }
  sendToConnection(refOf(saas), 'invite:received', { code });
}

/** The saas view's contents while it is live; deep-link delivery's only target. */
function saasDeliveryTarget(): WebContents | null {
  const contents = saasPrimary()?.webContents;
  return contents && !contents.isDestroyed() ? contents : null;
}

/** Window edge: deliver whatever the window held back, newest only. */
function flushDeepLinkGate(kind: DeepLinkKind): void {
  fenceDeepLinksOnOwnerChange();
  const gate = deepLinkEmitGates[kind];
  gate.timer = null;
  const code = gate.held.shift();
  if (code === undefined) return;
  // Re-arm BEFORE any early return below, so a collapsed repeat or a departed
  // renderer cannot strand the rest of the FIFO unreleased.
  if (gate.held.length > 0) {
    gate.timer = setTimeout(() => flushDeepLinkGate(kind), DEEP_LINK_EMIT_WINDOW_MS);
  }
  if (code === gate.lastCode) return;
  if (!saasDeliveryTarget() || !isRendererReadyFor(kind)) {
    // The renderer went away inside the window — hand the code back to its
    // queue instead of dropping it; the next drain delivers it.
    queueDeepLink({ kind, code });
    return;
  }
  sendDeepLink(kind, code);
}

/** True once the entry is accounted for: sent, or held for the window edge. */
function emitDeepLink(entry: PendingDeepLink): boolean {
  if (!saasDeliveryTarget()) return false;
  if (!isRendererReadyFor(entry.kind)) return false;

  const gate = deepLinkEmitGates[entry.kind];
  const waited = Date.now() - gate.lastAt;
  if (gate.timer !== null || waited < DEEP_LINK_EMIT_WINDOW_MS) {
    // Collapse only an immediate repeat — of the code showing now, or of the one
    // already queued last. A DIFFERENT code always takes its own slot.
    const previous = gate.held.length > 0 ? gate.held.at(-1) : gate.lastCode;
    if (entry.code !== previous) {
      if (gate.held.length >= DEEP_LINK_HELD_MAX) {
        // Oldest out, and never silently: kind and reason only, never the code —
        // it is bearer material (see internal-reference).
        gate.held.shift();
        console.warn(
          `Deep-link hold buffer full for kind=${entry.kind}; dropped the oldest held code`
        );
      }
      gate.held.push(entry.code);
    }
    gate.timer ??= setTimeout(
      () => flushDeepLinkGate(entry.kind),
      DEEP_LINK_EMIT_WINDOW_MS - waited
    );
    return true;
  }
  sendDeepLink(entry.kind, entry.code);
  return true;
}

function queueDeepLink(entry: PendingDeepLink): void {
  if (emitDeepLink(entry)) return;
  const queue = pendingDeepLinks[entry.kind];
  // Collapse duplicates (CODEX P2). A second copy of a code already waiting adds
  // nothing — it opens the same modal twice — and it multiplies the carried
  // code's reservation below into as many exemptions as there are copies. A page
  // that knows the carried code (its own, if it fired the link that got carried)
  // could then fill every slot with duplicates, making any later LEGITIMATE link
  // the only non-reserved entry and therefore the immediate eviction victim.
  // With duplicates collapsed, at most one entry can ever match, so the
  // reservation is exactly one occurrence by construction.
  if (queue.includes(entry.code)) {
    // ...with ONE exception: a duplicate of the CARRIED code is not a duplicate.
    // The queued copy is a REPLAY awaiting delivery; this is the user deliberately
    // opening the same link again. Dropping it silently and leaving the replay in
    // place means the drain-time expiry can then discard the stale copy and the
    // fresh click produces no modal at all — the two fences cancelling each other
    // (CODEX P2). Retire the replay's identity and restart the clock instead: the
    // single queue entry stays, but it is now a fresh delivery with its own window.
    const gate = deepLinkEmitGates[entry.kind];
    if (entry.code === gate.carriedCode) {
      gate.carriedCode = null;
      gate.originAt = performance.now();
      // `reservedCode` deliberately SURVIVES. Retiring only the replay marker is
      // what makes this a fresh delivery; retiring the reservation too would leave
      // the fresh click as the oldest UNEXEMPT entry, and the next different link
      // would evict it (CODEX P2). Moving it to the FIFO tail does not fix that —
      // at this moment it is usually the queue's only entry, so the move is a
      // no-op and the later links still append after it.
    }
    return;
  }
  queue.push(entry.code);
  // Drop-oldest at the cap, EXCEPT the carried code (RED-TEAM F1, second queue).
  // F1 fixed this for the hold buffer and left the pending queue open: the
  // carried code is re-queued FIRST, so it is the oldest entry and therefore the
  // guaranteed eviction victim once eight links arrive while the successor
  // document is still loading — a burst any page can fire, silently replacing
  // the invite the swap existed to preserve with eight of the attacker's own.
  // The reservation lasts until its first successor delivery, which is exactly
  // when sendDeepLink clears carriedCode.
  const carried = deepLinkEmitGates[entry.kind].reservedCode;
  while (queue.length > PENDING_DEEP_LINK_CAP) {
    const victim = queue.findIndex((code) => code !== carried);
    // Every entry is the carried code (it can only be queued once, so this means
    // the cap itself is 0 or the queue is a single reserved entry): drop the
    // oldest rather than growing without bound.
    queue.splice(victim === -1 ? 0 : victim, 1);
  }
}

// Must FILTER, not blind-re-queue. This runs from three sites, and with per-kind
// readiness flags a blind re-push of an unemittable entry re-enters the queue
// within the same tick — forever.
function drainPendingDeepLinks(): void {
  // Before the splice below, never inside the loop — see fenceDeepLinksOnOwnerChange.
  fenceDeepLinksOnOwnerChange();
  for (const kind of DEEP_LINK_KINDS) {
    const gate = deepLinkEmitGates[kind];
    const queue = pendingDeepLinks[kind];
    for (const code of queue.splice(0)) {
      // Re-check the CARRIED code's age here, not only where it was queued
      // (CODEX P2). Queue residence is unbounded: the successor renderer signals
      // readiness when it is ready, and a stalled initialisation can leave a
      // carried code sitting here long past DEEP_LINK_CARRY_MAX_AGE_MS. Treating
      // the marker as standing proof of freshness let a dismissed invite reappear
      // hours later — the fence passing once and then never being asked again.
      // Only the carried code is re-checked: an ordinary queued code is one the
      // user just clicked and has never been shown.
      if (
        code === gate.carriedCode &&
        performance.now() - gate.originAt > DEEP_LINK_CARRY_MAX_AGE_MS
      ) {
        gate.carriedCode = null;
        gate.originAt = 0;
        continue;
      }
      if (!emitDeepLink({ kind, code })) queue.push(code);
    }
  }
}

// Only result.reason is logged. Invite and friend codes are bearer material and
// never reach a log line.
function handleInviteDeepLink(raw: string | undefined, source: string): void {
  const result = normalizeInviteDeepLink(raw);
  if (result.ok) {
    // The only place a code ENTERS main. queueDeepLink is not it — resetDeepLinkGate
    // and flushDeepLinkGate both re-queue through it, and claiming ownership on a
    // re-queue launders a retained code into whoever is signed in now.
    fenceDeepLinksOnOwnerChange(true);
    noteDeepLinkOwner();
    queueDeepLink({ kind: result.kind, code: result.code });
    return;
  }
  if (result.reason !== 'empty') {
    console.warn('[DeepLink] rejected deep link', 'source', source, 'reason', result.reason);
  }
}

function handleInviteDeepLinksFromArgv(argv: readonly string[] | undefined, source: string): void {
  const result = extractInviteDeepLinkFromArgv(argv);
  if (result.ok) {
    // The SECOND OS entry point, and it needs the same treatment as
    // handleInviteDeepLink: on Windows and Linux a protocol activation against a
    // running app arrives here via `second-instance`, not via `open-url`. Without
    // the fence, a new owner's own click is queued under the PREVIOUS owner's tag
    // and the drain fence then forgets the whole queue — including the link that
    // user just opened (CODEX P2). The startup `process.argv` caller reaches this
    // too and is unaffected: at cold start both the tag and the current owner are
    // null, so each of these is a no-op there.
    fenceDeepLinksOnOwnerChange(true);
    // Redundant TODAY -- sendDeepLink's bind already covers a code that gets
    // delivered, and dropping this line alone leaves the suite green. It stays
    // for symmetry with the other OS entry point: an asymmetry here reads as a
    // deliberate exemption, and it is the only thing that would keep argv bound
    // if sendDeepLink's bind were ever narrowed.
    noteDeepLinkOwner();
    queueDeepLink({ kind: result.kind, code: result.code });
  } else if (result.reason !== 'empty') {
    console.warn('[DeepLink] rejected deep link argv', 'source', source, 'reason', result.reason);
  }
}

// Set true by the before-quit handler so the [X] close intercept can
// distinguish a genuine app quit (⌘Q, Dock→Quit, window:quit/app:quit, the
// updater relaunch) from the user clicking the window close button. Without
// this guard the intercept's preventDefault() cancels Electron's app.quit()
// sequence and the app becomes unquittable — force-quit only (#1383).
let isQuitting = false;
// SPA-load state lives in ./spaState so spaSelfHeal.ts can mutate it on
// fallback/recovery paths. See that module for the lockstep invariant and
// reader/writer enumeration.

/**
 * Probe the Vite dev server, then load it. Falls back to the bundled
 * renderer on any failure (timeout, ECONNREFUSED, etc.). Extracted from
 * createWindow to keep cognitive complexity in check.
 */
async function loadDevRendererWithFallback(
  contents: WebContents,
  bundledPath: string
): Promise<void> {
  const devServerUrl = 'http://localhost:3001';
  const http = await import('node:http');
  const httpGet = (http.default?.get ?? http.get) as typeof import('node:http').get;
  try {
    await new Promise<void>((resolve, reject) => {
      const req = httpGet(devServerUrl, { timeout: 1000 }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('timeout'));
      });
    });
    await contents.loadURL(devServerUrl);
  } catch {
    await contents.loadFile(bundledPath);
  }
}

/** Effective SPA load outcome: remote, the signed LKG cache (#1870), or bundled. */
type SpaLoadOutcome = 'remote' | 'cache' | 'bundled';

/**
 * Load the terminal bundled `app://concord` renderer. #830: app:// gives the
 * renderer a non-null Origin for server CORS. Bundled is the terminal load
 * layer, so a failure here leaves a blank window with no further fallback —
 * surface it to the splash error overlay. Always clears remote-SPA state first.
 */
async function loadBundledFallback(contents: WebContents): Promise<'bundled'> {
  // Clear state so PiP and origin-only consumers see a consistent "not in
  // remote-SPA mode" signal even on re-entry.
  setRemoteSpaState(null);
  try {
    await contents.loadURL('app://concord/index.html');
    // Covers genuine bundled mode AND the remote→bundled fallback, so the
    // effective mode is always reflected accurately. Best-effort: never throws.
    await captureSpaHash('bundled');
  } catch (err) {
    console.error('[SpaLoader] bundled app:// loadURL failed:', (err as Error).message);
    revealLoadFailure(shellWindow(), 'Could not load application — please reinstall');
  }
  return 'bundled';
}

/**
 * Attempt to serve the signed last-known-good cache (#1870). Returns 'cache'
 * iff a valid live cache verified AND the cache URL loaded; otherwise null so
 * the caller falls through to the bundled path. The cache is a LOCAL privileged
 * origin (spa-cache://concord), NOT a remote SPA — so we clear remote-SPA state
 * and treat it like bundled for origin/attestation purposes (captureSpaHash
 * fetches the cache's index.html via the protocol handler, which serves it).
 */
async function tryCacheLoad(contents: WebContents): Promise<'cache' | null> {
  const cached = resolveCachedSpa();
  if (!cached) {
    return null;
  }
  try {
    setRemoteSpaState(null);
    await contents.loadURL(cached.url);
    await captureSpaHash('bundled');
    console.debug('[SpaLoader] served signed last-known-good cache');
    return 'cache';
  } catch (err) {
    console.warn('[SpaLoader] cache load failed, falling back to bundled:', (err as Error).message);
    return null;
  }
}

/**
 * Apply a resolved SPA decision to a live window. Sets the remote-SPA state
 * BEFORE loadURL — load-bearing so the will-navigate gate, PiP, openExternal,
 * SSO, and versionInfo origin consumers key on the ACTUAL loaded origin — then
 * navigates and best-effort-captures the entry HTML hash.
 *
 * Fallback order on a remote failure:
 *   1. signed LKG cache (#1870) — ONLY when the remote `loadURL` threw, or the
 *      decision is bundled for a TRANSIENT remote reason (config fetch failed /
 *      5xx). NOT for expected-bundled reasons (no apiBase / non-hosted server /
 *      no spaUrl / contract zero) or an IPC-mismatch — those must not be masked by a stale cache.
 *   2. bundled app://concord (terminal).
 *
 * On a successful remote load, fires a best-effort cache refresh (fire-and-
 * forget; never awaited, never throws into the load path).
 *
 * Shared by the launch path (loadPackagedRenderer) and the runtime
 * `spa:reloadLatest` handler so the two can never drift. Returns the effective
 * mode actually loaded.
 */
async function applySpaDecision(
  contents: WebContents,
  decision: SpaLoadDecision
): Promise<SpaLoadOutcome> {
  if (decision.mode === 'remote' && decision.url) {
    try {
      setRemoteSpaState(decision.url);
      await contents.loadURL(decision.url, SPA_NO_CACHE_LOAD_OPTIONS);
      // Capture the entry HTML hash for client attestation (#677). Best-effort:
      // captureSpaHash never throws, so this cannot break the load path.
      await captureSpaHash('remote', decision.url);
      // #1870: best-effort refresh the signed LKG cache from the live origin.
      // Fire-and-forget — must NOT delay the visible load; swallow rejections.
      try {
        const origin = new URL(decision.url).origin + '/';
        void populateCacheFromRemote(origin).catch(() => {});
      } catch {
        // Malformed decision.url — already loaded fine; just skip the refresh.
      }
      return 'remote';
    } catch {
      console.warn('[SpaLoader] Failed to load remote SPA, trying cache then bundled');
      setRemoteSpaState(null);
      // The remote loadURL threw — a genuine remote failure, so the cache may
      // bridge the gap (#1870).
      const cacheMode = await tryCacheLoad(contents);
      if (cacheMode) {
        return cacheMode;
      }
      return loadBundledFallback(contents);
    }
  }

  // Bundled decision. Consult the signed cache ONLY for a transient remote
  // failure (config fetch failed / 5xx) — never for expected-bundled reasons or
  // an IPC-mismatch (those must not be masked by a stale cache).
  if (isTransientRemoteFailure(decision.reason)) {
    const cacheMode = await tryCacheLoad(contents);
    if (cacheMode) {
      return cacheMode;
    }
  }

  return loadBundledFallback(contents);
}

// ponytail: a wrapper rather than an exported arm/disarm pair — a caller that
// armed the flag and then returned early would re-deliver a stale code on the
// next unrelated load. The `finally` makes that unreachable at every PRODUCTION
// call site; carryDeepLinkAcrossNextLoad is exported for the tests, so an
// importer can still write the unbalanced form and must release itself. Covers
// the paths where applySpaDecision resolves without navigating at all. Fail-closed
// by construction: forgetting to disarm is not expressible at a call site.
async function applySpaDecisionCarryingDeepLink(
  contents: WebContents,
  decision: SpaLoadDecision
): Promise<SpaLoadOutcome> {
  const releaseCarry = carryDeepLinkAcrossNextLoad();
  try {
    return await applySpaDecision(contents, decision);
  } finally {
    releaseCarry();
  }
}

// #1742 follow-up: the SPA-source decision is made once at launch with a 5s
// config-fetch timeout (spaLoader CONFIG_TIMEOUT_MS) and no retry. A cold-start
// network (DNS/TLS/CF edge not yet warm) loses that race and strands the client
// on the bundled SPA for the whole session. When the bundled fallback was
// UNEXPECTED (config fetch failed — not a logged-out / non-hosted server /
// no-spaUrl / contract case), retry resolveSpaSource a few seconds later, on a now-warm network, and
// switch to the remote SPA if it resolves. Bounded; stops on success or once
// the delays are exhausted. The manual "Load latest UI" button (spa:reloadLatest)
// remains the fallback. Mirrors the WebSocket onlineFallbackTimer pattern (#1768).
// (SPA_RETRY_DELAYS_MS is declared beside DEEP_LINK_CARRY_MAX_AGE_MS, which is
// derived from it.)

function scheduleSpaSourceRetry(contents: WebContents, attempt = 0): void {
  if (attempt >= SPA_RETRY_DELAYS_MS.length) return;
  setTimeout(() => {
    void (async () => {
      // Abort if the window is gone, or if we are already in remote mode (a
      // prior retry or a manual reload succeeded — getRemoteSpaUrl is non-null
      // only when the remote SPA is loaded).
      if (contents.isDestroyed() || getRemoteSpaUrl() !== null) return;
      const decision = await resolveSpaSource();
      if (decision.mode === 'remote' && decision.url) {
        console.debug('[SpaLoader/retry] remote SPA reachable on warm network — switching');
        // Use the EFFECTIVE mode: resolveSpaSource can return remote (config
        // host reachable) while the remote SPA host itself is still down, in
        // which case applySpaDecision falls back to bundled. Only stop retrying
        // when we actually reached remote; otherwise keep retrying.
        // Main initiated this swap, so a code already delivered to the outgoing
        // document is carried into its successor (#2363).
        const mode = await applySpaDecisionCarryingDeepLink(contents, decision);
        if (mode === 'remote') return;
      }
      scheduleSpaSourceRetry(contents, attempt + 1);
    })();
  }, SPA_RETRY_DELAYS_MS[attempt]);
}

/**
 * Load the packaged renderer: try the remote SPA first (Tier 3), fall back
 * to the bundled file on any failure. Extracted to keep createWindow simple.
 */
async function loadPackagedRenderer(contents: WebContents): Promise<void> {
  const decision = await resolveSpaSource();
  console.debug(`[SpaLoader] ${decision.mode}: ${decision.reason}`);
  await applySpaDecision(contents, decision);

  // #830 Option C: surface a non-blocking diagnostic event if the bundled
  // fallback fired for an unexpected reason (config fetch failed, network
  // issue, spaUrl rejected, etc.). Expected fallbacks (first launch, a
  // non-hosted server, no spaUrl, contract zero) do NOT trigger it.
  // Delay 2000ms to ensure renderer listeners are registered.
  //
  // The payload carries a CLASS, not just prose (#2401). Six distinct reasons
  // reach this branch and only one of them ("config fetch failed" / 5xx) means
  // the servers were unreachable — the rest fire against a perfectly reachable
  // server that sent something this client refused, or that this shell is too
  // old for. Sending one hardcoded "Could not reach Concord servers" for all
  // six was wrong on five of them, and left the renderer unable to tell which
  // it had received — so it could not know whether proof of reachability
  // falsified the claim. The class decides both the copy and whether the
  // banner may be retracted; see SpaFallbackKind in shared/spaIpcTypes.ts.
  if (decision.mode === 'bundled' && isUnexpectedBundled(decision.reason)) {
    const kind = classifyFallbackReason(decision.reason);
    // The document this load produced; a push to a successor is dropped (#86 §3.7).
    const binding = bindingFor(contents);
    const record = binding ? recordFor(binding.connectionId) : undefined;
    const ref = record ? refOf(record) : null;
    setTimeout(() => {
      if (ref === null) return;
      sendToConnection(ref, 'app:configFetchFailed', {
        reason: SPA_FALLBACK_MESSAGE[kind],
        kind,
      });
    }, 2000);
    // Self-heal the cold-start race: retry on a warm network and switch to
    // remote if it becomes reachable (#1742 follow-up launch-time retry).
    scheduleSpaSourceRetry(contents);
  }
}

const DEV_SERVER_URL = 'http://localhost:3001';
const bundledRendererPath = path.join(__dirname, '../renderer/index.html');

/** What every connection session is configured from (connectionSession.ts). */
const connectionSessionDeps: ConnectionSessionDeps = {
  // Read at each use, as the pre-#86 gates did, rather than snapshotted at import.
  get isPackaged(): boolean {
    return app.isPackaged;
  },
  bundleRoot: path.resolve(__dirname, '../renderer'),
  getLiveDir,
  remoteSpaOrigin: getRemoteSpaBaseUrl,
  bindingFor,
  recordFor,
  getService,
};

/** `saas` keeps `defaultSession`; a self-hosted service gets its own `fromPath` session. */
const connectionServiceDeps: RegisterServiceDeps = {
  makeSession: (base) => sessionForService(base.kind, base.dirKey, app.getPath('userData')),
  // Proactive token refresh (#254): a refresh this custody makes (timer or
  // sleep/wake) reaches this service's own view only, so its authStore stays
  // current and no other connection ever sees the token.
  makeCustody: (serviceId, origin) =>
    makeServiceCustody(serviceId, origin, (owner, accessToken, sessionId, previousSessionId) => {
      for (const record of liveConnections()) {
        if (record.serviceId !== owner) continue;
        sendToConnection(refOf(record), 'auth:token-refreshed', {
          accessToken,
          sessionId,
          previousSessionId,
        });
      }
    }),
  isValidatedSelfHostedApiBase,
};

function prepareConnectionSession(service: ServiceRecord): void {
  configureConnectionSession(service.session, service, connectionSessionDeps);
}

/**
 * Register (or find) the service for `origin` and configure its session (#86 §3.3).
 * Null, with a fixed warning, when it is refused or its session cannot be created
 * (Review Focus 2: a profile directory that cannot be created must not stop `saas`).
 */
function registerConnectionService(origin: string): ServiceRecord | null {
  try {
    const result = registerService(origin, connectionServiceDeps);
    if (!result.ok) {
      console.warn(`[connections] service not registered (${result.reason})`);
      return null;
    }
    prepareConnectionSession(result.service);
    return result.service;
  } catch {
    // Fixed text: the error can carry a path under the user's profile.
    console.warn('[connections] service session unavailable; service not registered');
    return null;
  }
}

/**
 * main.ts's own listeners on every connection view. shellWindow.ts runs this before
 * the view's first load (its invariant 1), with the view already bound.
 */
function wireConnectionView(contents: WebContents, service: ServiceRecord): void {
  // A RENDERER CREATED OR RELOADED AFTER THE SNAPSHOT SETTLED HEARS NOTHING FROM THE
  // change listener in the ready path — the push already happened. Re-send on every load:
  // the value is a machine fact, identical on every hello, so a duplicate is idempotent
  // and ordering-insensitive. Without this, an SPA-loader swap leaves the renderer on the
  // pre-addon rungs for the life of the session (spec §4.1 delivery). `null` sends
  // nothing: absence IS the fail-closed state, and the renderer's initial store value
  // already represents it.
  //
  // GUARDED WITH `isDestroyed()`. #3198's Phase-8 pass measured on real Electron that a
  // `?.` null check does not cover a destroyed object; the try/catch stays as the
  // backstop for the state no synchronous check can exclude, and swallowing is safe
  // because the next load re-pushes. `contents`, not a module-scope variable: this
  // listener belongs to THIS view.
  contents.on('did-finish-load', () => {
    const capability = audiocapMachineCapability();
    if (capability === null) return;
    if (contents.isDestroyed()) return;
    try {
      contents.send('audiocap:capability', { perProcessAudio: capability });
    } catch {
      /* destroyed between the check and the send; the next load re-pushes. See above. */
    }
  });

  // Cmd/Ctrl+Opt+I toggles DevTools when Developer Mode is enabled.
  // (TEMPORARY — remove before BETA along with Developer Mode feature.)
  // `detach`: a view has no BrowserWindow to dock DevTools into.
  contents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return;
    const isToggleCombo =
      input.key.toLowerCase() === 'i' && input.alt && (input.meta || input.control);
    if (!isToggleCombo) return;
    if (!readDeveloperModePref()) return;
    if (contents.isDevToolsOpened()) {
      contents.closeDevTools();
    } else {
      contents.openDevTools({ mode: 'detach' });
    }
  });

  // Log renderer crashes to diagnose voice join segfaults. Deep links are saas-only.
  contents.on('render-process-gone', (_event, details) => {
    if (service.kind === 'saas') resetDeepLinkDelivery();
    console.error('[MAIN] Renderer process gone:', details.reason, 'exitCode:', details.exitCode);
  });
}

// Client Behavior [X] close intercept (#806). When the user clicks the
// native close button, route based on the cached Client Behavior:
//   - 'tray'    -> hide() (stays running, accessed from system tray, #1099)
//   - 'toolbar' -> minimize() (stays running in the OS taskbar)
//   - 'quit'    -> app.quit() (graceful full-app shutdown)
// event.preventDefault() suppresses the default close -> destroy path so the
// hide/minimize fall-throughs can take over. The 'quit' branch also calls
// preventDefault so app.quit can run its before-quit hooks without racing
// a window-destroy mid-shutdown.
//
// isQuitting guard (#1383): createShellWindow's 'close' listener returns before
// calling this once a genuine quit is underway — before-quit has already set
// isQuitting = true — so this close proceeds (no preventDefault) and Electron's own
// app.quit() sequence is never vetoed. This also resolves the 'quit' branch's
// re-entrancy: app.quit() -> before-quit sets the flag -> re-fired close ->
// early return -> window destroys -> quit completes.
//
// Trayless fallback (#1099): if action='tray' but the tray failed to
// initialize (sandboxed env, missing StatusNotifier host, etc.),
// hide() would strand an invisible, unrecoverable resident
// process on Windows/Linux (macOS still has Dock activate). Quit instead so
// a trayless session degrades to a recoverable state. window-all-closed's
// !isTrayActive() branch alone is not enough: preventDefault()+hide() means
// the window never actually closes, so window-all-closed never fires.
function interceptShellClose(event: Electron.Event): void {
  const win = shellWindow();
  if (!win) return;
  const action = deriveCloseAction(getCachedClientBehavior());

  if (action === 'tray') {
    event.preventDefault();
    if (isTrayActive()) {
      win.hide();
    } else {
      app.quit();
    }
  } else if (action === 'toolbar') {
    event.preventDefault();
    win.minimize();
  } else {
    // action === 'quit'
    event.preventDefault();
    app.quit();
  }
}

/** TRANSITIONAL (#86 Task 4 → 7B): updater and SPA-version pushes reach every primary. */
const broadcastPushTarget = {
  isDestroyed: (): boolean => false,
  webContents: { send: broadcastToPrimaries },
};

const createWindow = async (): Promise<void> => {
  // Build the per-platform window config (#806). Pure factory so
  // each platform gets the correct titleBarStyle / titleBarOverlay shape:
  //   - darwin → hiddenInset (preserves traffic-light controls)
  //   - win32 / linux → hidden + titleBarOverlay (native min/max/close)
  // #86: the chrome options go to the BaseWindow; `webPreferences` go, unchanged,
  // to every connection view (plus that service's session).
  const preloadPath = path.join(__dirname, '../preload/preload.js');
  const { webPreferences, ...windowConfig } = buildBrowserWindowConfig({
    platform: process.platform,
    isWayland: isWayland(),
    preloadPath,
    isPackaged: app.isPackaged,
  });

  // Restore the user's last window placement (#806). loadWindowState returns
  // the saved bounds if window-state.json exists and the validator accepts
  // them; otherwise defaults to centered (x/y undefined → OS default placement).
  const savedState = loadWindowState();
  const contentProtectionEnabled = readContentProtectionPref();

  // Content protection is applied inside createShellWindow, before any view exists.
  const win = createShellWindow({
    windowOptions: {
      ...windowConfig,
      x: savedState.x,
      y: savedState.y,
      width: savedState.width,
      height: savedState.height,
    },
    preloadPath,
    webPreferences,
    viewBackgroundColor: windowConfig.backgroundColor,
    contentProtectionEnabled,
    applyContentProtectionAtCreation,
    // #3394 C15: wired by openConnectionView BEFORE the first load — the renderer is
    // live long before the awaited load resolves, and a wire registered later sees
    // only future events. `killAudiocapCapture` spares the windowless probe.
    wireAudiocapRendererLoss,
    // Status-aware tray (tray-status spec §3/§4): a renderer reload / crash / hang
    // drops the tray back to neutral (R17).
    attachTrayResetHooks,
    resetDeepLinkDelivery,
    prepareSession: prepareConnectionSession,
    isQuitting: () => isQuitting,
    onClose: interceptShellClose,
    onClosed: () => {
      // #974/#975: a window-less SSO flow (apple or google) has no UI to deliver
      // its result to — tear both down so the loopback listener and 5-minute
      // deadline don't outlive the renderer (teardown trigger (b) in each flow's
      // documented lifecycle).
      cancelActiveAppleFlow();
      cancelActiveGoogleFlow();
      resetDeepLinkDelivery();
    },
    wireView: wireConnectionView,
    // X1 (#86): a packaged build restores views onto the bundled app, never the dev server.
    devConnectionUrl: app.isPackaged ? 'app://concord/index.html' : DEV_SERVER_URL,
  });

  if (savedState.isMaximized) {
    win.maximize();
  }

  // Wire resize/move/maximize/unmaximize/close listeners that persist
  // bounds to window-state.json with 500ms debounce (#806).
  attachWindowState(win);

  // Register the window-control + version-info IPC surfaces (#806). The
  // factory closures defer the window lookup so the late-bind window
  // reference is always current (handles the brief teardown window).
  registerWindowControlsIpc(shellWindow);
  registerVersionInfoIpc(() => broadcastPushTarget);

  // Client Behavior [-] minimize intercept (#806). When the user clicks the
  // native minimize button AND their Client Behavior config routes minimize
  // to the system tray, redirect the post-fact minimize to hide(). Brief
  // flicker is accepted per spec §3.2 trade-off; minimize is a post-fact
  // event, not interceptible-before-the-OS-acts the way close is.
  //
  // Trayless fallback (#1099): if tray init failed, calling restore()+hide()
  // would strand the window invisibly with no taskbar entry. Skip the
  // redirect so the native minimize stands and the window stays recoverable
  // from the taskbar.
  win.on('minimize', () => {
    const action = deriveMinimizeAction(getCachedClientBehavior());
    if (action === 'tray' && isTrayActive()) {
      win.restore();
      win.hide();
    }
    // else: leave native minimize -> toolbar as-is
  });

  // Status-aware tray (tray-status spec §3/§4): window focus gates the mention burst.
  win.on('focus', () => setTrayWindowFocused(true));
  win.on('blur', () => setTrayWindowFocused(false));

  installDevConnectionMenu();

  // The splash closes and the window shows on the saas view's first finished load.
  // A BaseWindow has no 'ready-to-show' (BrowserWindow alone declares it), so the
  // view's own `did-finish-load` stands in. A bundled load that fails reveals the
  // window through revealLoadFailure instead.
  const loadSaasView = async (contents: WebContents): Promise<void> => {
    contents.once('did-finish-load', () => {
      closeSplash();
      shellWindow()?.show();
    });
    if (app.isPackaged) {
      await loadPackagedRenderer(contents);
    } else {
      await loadDevRendererWithFallback(contents, bundledRendererPath);
    }
  };

  const saas = getService(SAAS_SERVICE_ID) ?? registerConnectionService(PRODUCTION_API_BASE);
  const opened = saas
    ? await openConnectionView(saas.serviceId, 'app://concord/index.html', loadSaasView)
    : null;
  if (!opened?.ok) {
    console.error('[MAIN] the saas connection could not be opened');
    revealLoadFailure(win, 'Could not load application — please reinstall');
    return;
  }
  const contents = opened.record.webContents;

  // One view per other persisted connection, then the last-foreground one is shown.
  void restorePersistedConnections(
    app.getPath('userData'),
    startupConnections,
    registerConnectionService
  );

  // Always open DevTools in dev mode regardless of load path.
  if (!app.isPackaged && process.env.DEVTOOLS !== '0') {
    contents.openDevTools({ mode: 'detach' });
  }

  // Open DevTools at startup if Developer Mode preference is enabled.
  // Applies to packaged builds (bundled or remote SPA) and to dev fallback.
  if (readDeveloperModePref() && !contents.isDevToolsOpened()) {
    contents.openDevTools({ mode: 'detach' });
  }
};

// Track rollback result so we can notify the renderer after window creation
let rollbackResult: SentinelResult | null = null;

// App lifecycle handlers
app.whenReady().then(async () => {
  if (maybePromptMove()) return;

  // ADR-0043's capability probe is NOT called here. It is scheduled off the ready
  // path with `setImmediate` at the end of this handler -- one call site, not two.
  //
  // There were two until PR #3245 review. `probeInFlight ??= runCapabilityProbe()`
  // memoizes, so the second was a harmless no-op and nothing failed; what it did do
  // was start `utilityProcess.fork` HERE, on the critical path of every launch,
  // which contradicts the probe's own documented P1 ("it never delays app start.
  // Nothing awaits it; `main.ts` schedules it OFF the ready path"). The redundant
  // call was the one that broke the property, so removing it fixes the contradiction
  // rather than merely tidying a duplicate.
  registerInviteProtocolClient();

  // #86 §3.3: every session — `saas`'s `defaultSession` and each self-hosted
  // service's `fromPath` session — is configured by configureConnectionSession when
  // its service is registered: `app://` (#830) and, for `saas` only, `spa-cache://`
  // (#1870), the permission/device/HID handlers and the KLIPY injector (#626).
  // Registering `saas` here configures `defaultSession` before any window exists.
  registerConnectionService(PRODUCTION_API_BASE);
  // Development builds only: every approved self-hosted origin, so the dev
  // Connections menu can open it. Packaged builds open nothing but `saas` until the
  // connections file restores more (#86 Task 6).
  if (!app.isPackaged) {
    for (const { origin } of readApprovalsFile()) registerConnectionService(origin);
  }

  registerOpenExternalHandler(getRemoteSpaBaseUrl);
  // #1729 — native Save-As for decrypted image attachments. Lazy window provider
  // (mirrors registerPermissionHandlers) so the dialog parents to the live window.
  registerSaveImageHandler(shellWindow, getRemoteSpaBaseUrl);
  registerSSOIPC();
  registerAttestationIpc(getRemoteSpaBaseUrl);
  // #86 §3.7, contract v34. The remote-SPA origin every registerIpc admission reads, then
  // connection:whoAmI/create/activate and the connection:generation push. Before
  // createWindow, so the first view's preload finds its whoAmI handler.
  setRemoteSpaOriginSource(getRemoteSpaBaseUrl);
  registerConnectionIpc({
    openConnectionView,
    activateConnection,
    probe: probeConnectionOrigin,
    ceremony: runConnectionCeremony,
    writeConnections: persistAddedConnections,
    serviceDeps: connectionServiceDeps,
    viewUrl: () => (app.isPackaged ? 'app://concord/index.html' : DEV_SERVER_URL),
  });
  // A LIVE per-process capture ended without the user asking (#3394 PR 2, contract 30):
  // the tap faulted mid-share, the child crashed, or it broke protocol after `started`.
  // `audiocapHost`'s `retire()` is the only caller, and it never calls this for a stop, a
  // kill, a supersede or the probe -- so every push here is news the renderer cannot
  // learn any other way, and there is no re-push to fall back on.
  //
  // A PUSH, like `'audiocap:capability'`: no sender to validate, and the same
  // `isDestroyed()` guard for the same measured reason (see the `did-finish-load`
  // re-push). The payload is RE-MINTED from the two fields, never forwarded: the host
  // already mints it from main-owned values, but passing the reference on would make
  // what reaches the renderer depend on every future edit to that object rather than
  // on this line.
  //
  // ORDERING, BY CONSTRUCTION. This and the port sink below are registered ABOVE
  // `registerAudiocapIpc`, which installs the `audiocap:start` handler -- the only way a
  // capture can begin. A capture that interrupts with no listener is silently dropped
  // (`retire()` treats `null` as "nobody to tell"), and a start with no port sink
  // retires the session. Both setters only capture the late-bound `mainWindow` and guard
  // it, so registering them first costs nothing and no later `await` can reorder them.
  setAudiocapInterruptListener((interrupt, owner) => {
    // #86 Task 7B: owner-only. The share is bound to the connection that started it;
    // sendToConnection no-ops unless that ref is still the record's current generation,
    // so another connection, or the owner's next document, never hears of it.
    if (!owner) return;
    sendToConnection(owner.ref, 'audiocap:interrupted', {
      generation: interrupt.generation,
      reason: interrupt.reason,
    });
  });

  // Hand the renderer end of a capture channel to the preload relay (#3198 PR 3).
  //
  // `postMessage`, NOT `send`: this carries a `MessagePortMain` in a transfer list, and
  // `webContents.send` has no transfer list. The channel name is spelled here rather
  // than imported because `AUDIOCAP_PORT_CHANNEL` lives in `src/preload/audiocapRelay.ts`,
  // which imports `ipcRenderer` — pulling a preload module into main to borrow a string
  // constant is a worse trade than the literal. Same choice the two
  // `'audiocap:capability'` sends in this file already make.
  //
  // THIS SINK THROWS RATHER THAN RETURNING, and that is the contract `audiocapHost`
  // expects: a port that cannot reach the renderer means the child is capturing into
  // nothing, so the host retires the session instead of reporting a started share. That
  // is the opposite of the capability push (below), which swallows because its value is
  // monotone and re-pushed on the next `did-finish-load`. A port is neither.
  setAudiocapPortSink((generation, port, owner) => {
    // #86 Task 7B: owner-only, and only while the owner binding is current. Throwing
    // retires the session, so a stale or foreign owner gets no capture at all.
    const record = owner && isOwnerCurrent(owner) ? recordFor(owner.ref.connectionId) : undefined;
    if (!record || record.state === 'disposed' || record.webContents.isDestroyed()) {
      throw new Error('audiocap port sink: no live owner');
    }
    record.webContents.postMessage('audiocap:port', { generation }, [port]);
  });

  // #3198 PR 3 — the `audiocap:start` invoke. This is the ONE audiocap handler the
  // sender-frame criterion binds; `audiocap:capability` is a push and has no sender
  // to validate. Same DI shape as its four siblings above, so the origin getter is
  // stubbable in tests rather than reached through a module import.
  //
  // The window provider (#3394 PR 1, R5) narrows admission from "a permitted origin" to
  // "the main window's own main frame" -- a PiP shares the origin. Late-bound like
  // `registerWindowControlsIpc(() => mainWindow)`: `createWindow` has not run yet here, and
  // the `closed` handler nulls the variable. #86 Task 4: "the main window" is the saas
  // view until Task 7B binds the share's owner connection.
  registerAudiocapIpc();
  // Billing launcher (#1305): sender-fenced, Stripe-host-validated, opens a modal sheet.
  registerBillingIpc(getRemoteSpaBaseUrl, shellWindow);
  // Status-aware tray (tray-status spec §4): the binding-admitted primary main frame of
  // trayOwner() or, with none, the foreground connection + 20/s bucket + exact shape.
  registerTrayStatusIpc();
  // NO TLS certificate pinning on api.concordvoice.chat — deliberate, do not
  // re-add (#658 reverted). Cloudflare serves that host from a MANAGED edge
  // certificate that it rotates on its own schedule with a NEW keypair. The pin
  // design assumed Concord uploaded its own origin keypair via Cloudflare's
  // Custom SSL Certificates API; that endpoint is Business/Enterprise-only and
  // this account is on Pro, so the upload never ran even once. Every rotation
  // therefore locked the ENTIRE installed base out of the API with
  // net::ERR_FAILED, with no server-side remedy possible because the rejection
  // happens client-side before the request leaves the machine. That is five
  // fleet outages between 2026-04 and 2026-08, and zero detections.
  //
  // API TLS now uses Chromium's default validation (public CA + Certificate
  // Transparency) — the same anchor the browser SPA at spa.concordvoice.chat
  // and the deliberately-unpinned update feed (#2020) already rely on.
  // Mis-issuance is caught out-of-band by CT monitoring, which alerts instead
  // of bricking the fleet. Only ever pin a keypair Concord controls end to end.
  // See docs/policies/api-tls-trust-model.md.

  // OS permission management (#197) — JIT prompting replaces proactive startup requests.
  // Camera/mic/screen/notifications are requested when the feature is first used.
  registerPermissionHandlers(foregroundPrimaryHandle, getRemoteSpaBaseUrl);

  // ─── Update safety: startup validation (#384) ─────────────────────
  // Must run before createWindow() so we can stash rollback info,
  // but after initAutoUpdater() so the logger is available.
  initAutoUpdater(
    () => broadcastPushTarget,
    () => {
      isQuitting = true;
    },
    notifyTrayUpdate
  );

  const updateLogger = getUpdateLogger();
  if (updateLogger) {
    // Check for deferred cleanup from a previous incomplete finalization
    runDeferredCleanup(updateLogger).catch(() => {});

    const sentinelResult = checkUpdateSentinel(updateLogger);
    if (sentinelResult.type === 'success') {
      updateLogger.info(
        `Update validated: v${sentinelResult.fromVersion} → v${sentinelResult.toVersion}`
      );
      finalizeUpdate(updateLogger, sentinelResult).catch((err) => {
        updateLogger.error(`Post-update cleanup failed: ${(err as Error).message}`);
      });
    } else if (sentinelResult.type === 'rollback') {
      updateLogger.warn(
        `Update to v${sentinelResult.toVersion} failed, rolled back to v${sentinelResult.fromVersion}`
      );
      finalizeRollback(updateLogger, sentinelResult).catch((err) => {
        updateLogger.error(`Rollback cleanup failed: ${(err as Error).message}`);
      });
      rollbackResult = sentinelResult;
    }
  }

  // Show branded splash while the main window loads (#387)
  if (app.isPackaged) {
    const iconPath = path.join(app.getAppPath(), 'build', 'icon.png');
    const icon = nativeImage.createFromPath(iconPath);
    showSplash(icon.isEmpty() ? undefined : icon.toDataURL());

    // If a rollback was detected, show error state on the splash while main window loads
    if (rollbackResult) {
      updateSplashError(
        `Update to v${rollbackResult.toVersion} failed — rolled back to v${rollbackResult.fromVersion}`
      );
    }
  }

  void createWindow().then(() => {
    drainPendingDeepLinks();
    setTimeout(drainPendingDeepLinks, 1000);

    // Remove orphaned Squirrel.Windows residue left by the NSIS migration (#2402).
    //
    // Runs from the INSTALLED APP on a later launch, never from the installer. An
    // installer executing from %LOCALAPPDATA%\ConcordVoice\pending\ cannot delete
    // %LOCALAPPDATA%\ConcordVoice\ — it would be deleting its own locked image,
    // which IS the bug this migration fixes (Squirrel died exactly that way with
    // UnauthorizedAccessException).
    //
    // Deliberately AFTER the window exists and deferred a further tick: the sweep is
    // SYNCHRONOUS recursive rmSync over app-* directories that can total hundreds of
    // MB, so running it during whenReady would block the main-process event loop
    // before first paint. It is allowlist-scoped, never throws, and never touches
    // ConcordVoice\app (the running install) or ConcordVoice\pending (the updater
    // cache). No-op on non-win32.
    //
    // app.isPackaged-gated: without it, a developer running `npm start` on a real
    // Windows machine would have their genuine %LOCALAPPDATA%\ConcordVoice profile
    // swept — Update.exe, packages\, SquirrelTemp\, the Start Menu folder and the
    // uninstall registry key deleted as a side effect of local development. Matches
    // the packaged-gating of the other startup side effects in this file.
    //
    // Reuses the logger initAutoUpdater() already created rather than calling
    // createUpdateLogger() again: each construction re-runs mkdirSync plus a full
    // readdirSync + pruneOldLogs sweep of the log directory (updateLogger.ts), so a
    // second one doubles that filesystem work on every launch.
    if (app.isPackaged) {
      const squirrelLogger = getUpdateLogger();
      if (squirrelLogger) {
        setTimeout(() => cleanupSquirrelResidue(squirrelLogger), 0);
      }
    }
  });

  // System tray (#1099): init after the first window exists so the activate
  // handler has a window to reveal. Init failure is non-fatal — the app runs
  // trayless and window-all-closed keeps its quit (see handler below).
  // Open/Quit and the two update rows are main-direct (spec §4); everything that
  // changes client state goes to the renderer as a closed-enum `tray:action`.
  setTrayActionSender((action) => {
    const contents = foregroundWebContents();
    if (!contents) return;
    contents.send(TRAY_ACTION, action);
  });
  initTray({
    getMainWindow: shellWindow,
    createWindow,
    downloadUpdate,
    installUpdate: safeQuitAndInstall,
  });

  // Notify renderer of rollback after window is created (#384)
  if (rollbackResult) {
    // Capture to local const so TypeScript narrows through the setTimeout closure.
    const rollback = rollbackResult;
    // Delay slightly to ensure renderer IPC listeners are registered
    setTimeout(() => {
      broadcastToPrimaries('update:rollback', {
        fromVersion: rollback.fromVersion,
        toVersion: rollback.toVersion,
        message: `Update to v${rollback.toVersion} failed. You are still on v${rollback.fromVersion}.`,
      });
    }, 2000);
  }

  // Refresh token immediately on system wake — main process timers may have
  // drifted past the token's expiry window during sleep (#248).
  // #86: every live service's custody refreshes its own token, once per service.
  powerMonitor.on('resume', () => {
    const resumed = new Set<ServiceRecord['serviceId']>();
    for (const record of liveConnections()) {
      if (resumed.has(record.serviceId)) continue;
      resumed.add(record.serviceId);
      try {
        getService(record.serviceId)?.custody.onSystemResume();
      } catch {
        console.warn('[powerMonitor] a connection custody failed to resume');
      }
    }
  });

  app.on('activate', () => {
    // On macOS, re-create window when dock icon is clicked
    if (shellWindow() === null) {
      void createWindow();
    }
  });

  // Publish the machine-capability snapshot to the renderer whenever it changes (#3198,
  // contract 28). Registered BEFORE the probe is scheduled so a fast handshake cannot
  // settle before there is a listener to hear it.
  // Same `isDestroyed()` guard as the `did-finish-load` re-push, for the same measured
  // reason (see that comment). `audiocapHost.ts` already wraps its call to this listener in
  // a try/catch, so a throw here cannot wedge the handshake -- but relying on the CALLER's
  // catch is what left the two copies asymmetric in the first place, and the check is one
  // line. #86: a machine fact grants nothing, so it reaches every live view.
  setAudiocapCapabilityListener((perProcessAudio) => {
    broadcastToPrimaries('audiocap:capability', { perProcessAudio });
  });

  // ─── concord-audiocap capability probe (#3195, ADR-0043) ──────────
  // Fork the capture child once, take its handshake, record the rung it implies,
  // and kill it. This is the production caller that makes the host reachable on a
  // path a user actually takes rather than only from a test.
  //
  // NOTHING AWAITS IT, and it is scheduled off the ready path with setImmediate:
  // the fork is a process spawn, and a child that never answers costs
  // HANDSHAKE_TIMEOUT_MS. Neither may sit between whenReady and first paint.
  // Same reasoning as the Squirrel sweep above, one tick later than the window.
  //
  // It cannot reject and cannot surface anything to the user — every outcome,
  // including an unsupported OS or a fork that could not be issued, becomes a
  // recorded degrade mechanism inside audiocapHost. C9 holds: a fault is
  // video-only with a reason, never a system mix.
  //
  // The answer deliberately stays in main. #3198 adds the renderer-facing rung
  // and the channel that carries it.
  setImmediate(() => {
    void probeAudiocapCapability();
  });
});

// Quit when all windows are closed — except on macOS (platform convention)
// and except when the tray is active: the tray is the persistent affordance
// to reopen or quit (#1099). If tray init FAILED, isTrayActive() is false and
// the pre-#1099 quit-on-all-closed behavior is preserved, so a trayless
// session can never strand an invisible resident process.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !isTrayActive()) {
    app.quit();
  }
});

// autoUpdater.quitAndInstall() closes windows before the normal before-quit
// event, so release the close-to-tray veto at the update-specific hook too (#1897).
electronAutoUpdater.on('before-quit-for-update', () => {
  isQuitting = true;
  destroyPipWindowsForQuit();
  // Reap the concord-audiocap capture child (#3195). Synchronous and
  // fire-and-forget: utilityProcess.kill() takes no handshake, and an await
  // anywhere on a quit path re-enters the #1383 veto window.
  killAudiocapHost();
});

// Clean up scheduled update checks on quit; flush update log (#383)
app.on('before-quit', () => {
  // Release the [X] close intercept's veto so the window can actually close and
  // the quit can complete — without this, app.quit() deadlocks (#1383).
  isQuitting = true;
  destroyPipWindowsForQuit();
  // Reap the concord-audiocap capture child (#3195), on the same no-await terms
  // as the update hook above.
  killAudiocapHost();
  // Release the OS tray resource so no orphaned icon outlives the app (#1099).
  destroyTray();
  const ul = getUpdateLogger();
  ul?.info('Application quitting');
  ul?.flush();
  stopAutoUpdater();
});

// REDUNDANCY, NOT A DISTINCT PATH (#3195). Electron's own docs recommend
// reaping a utilityProcess at 'will-quit', and it is registered here so a reader
// who checks against those docs finds it. In THIS app it covers no case the two
// hooks above miss: 'will-quit' always follows 'before-quit', and it would miss
// quitAndInstall() outright — the exact gap #1897 patched with the
// 'before-quit-for-update' hook. Do not go hunting for the case it uniquely
// closes; there isn't one. killAudiocapHost() is idempotent, so a second call
// on the ordinary quit path is a no-op.
app.on('will-quit', () => {
  killAudiocapHost();
});

// Crash-safe logging: flush update log before unhandled exceptions terminate the process (#383).
// Registering this listener disables Node's default crash behavior, so we must exit explicitly.
process.on('uncaughtException', (error) => {
  const ul = getUpdateLogger();
  ul?.error(`Uncaught exception: ${error.message}\n${error.stack ?? ''}`);
  ul?.flush();
  // THE LOAD-BEARING HOOK (#3195). app.exit() fires NEITHER 'before-quit' NOR
  // 'will-quit', so without this line an unhandled exception orphans the capture
  // child by construction — a native-code process outliving the app that forked
  // it. Must precede setImmediate: the exit is scheduled, the kill is not.
  killAudiocapHost();
  setImmediate(() => app.exit(1));
});

// IPC Handlers. #86: every channel goes through registerIpc (ipc/registry.ts), which
// admits the sender by its CHANNEL_CLASSES class before the handler runs. A refused
// call answers the channel's own fail-closed value, never the payload it asked for.
registerIpc('app:getVersion', 'app-global-read', () => app.getVersion(), {
  refusal: () => '',
});

registerIpc('app:getPlatform', 'app-global-read', (): string => process.platform, {
  refusal: () => '',
});

registerIpc('app:getIpcContract', 'app-global-read', (): number | null => IPC_CONTRACT_VERSION, {
  refusal: () => null,
});

// Forensic build-tag observability (#920 §5.13, #939). Returns the CI
// build tag baked into the packaged app (via forge extraResource
// buildtag.json) or 'unknown' for local dev builds. Read-only,
// information-only — knowing the tag does not unlock any capability.
registerIpc('app:getBuildTag', 'app-global-read', () => getBuildTag(), {
  refusal: () => 'unknown',
});

// Screen capture sources for voice/video screen share picker (#44)
registerIpc(
  'media:getDesktopSources',
  'app-global-mutate',
  async () => {
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 320, height: 180 },
      // Load-bearing, NOT a nicety: DesktopCapturerSource exposes no application name
      // and no PID, so the picker's Applications tab groups windows by appIcon identity
      // (groupDesktopSources). With this false every appIcon is null and grouping silently
      // degrades to a title-suffix heuristic. Do not remove it to save thumbnail work.
      fetchWindowIcons: true,
    });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      thumbnail: s.thumbnail.toDataURL(),
      appIcon: s.appIcon?.toDataURL() || null,
    }));
  },
  // A hidden view must not read thumbnails of every window (#86 Task 7B ruling).
  { refusal: async () => [] }
);

// Clipboard write (navigator.clipboard.writeText is blocked in Electron)
registerIpc(
  'clipboard:writeText',
  'app-global-mutate',
  (_sender, _event, text: string) => {
    clipboard.writeText(text);
  },
  { refusal: () => undefined }
);

// GPU info
const GPU_VENDORS: Record<number, string> = {
  0x106b: 'Apple',
  0x8086: 'Intel',
  0x10de: 'NVIDIA',
  0x1002: 'AMD',
  0x1022: 'AMD',
  0x5143: 'Qualcomm',
  0x13b5: 'ARM',
};

const VIDEO_CODEC_PROFILE_MIMES = new Map<number, string>([
  ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((profile) => [profile, 'video/H264'] as const),
  [11, 'video/VP8'],
  ...[12, 13, 14, 15].map((profile) => [profile, 'video/VP9'] as const),
  // Chromium 148 VideoCodecProfile: 19-22/27-28/37-38 are Dolby Vision, 23 is Theora.
  ...[16, 17, 18, 29, 30, 31, 32, 33, 34, 35, 36].map(
    (profile) => [profile, 'video/HEVC'] as const
  ),
  ...[24, 25, 26].map((profile) => [profile, 'video/AV1'] as const),
]);

function extractEncodeProfiles(info: unknown): string[] {
  if (!isRecord(info)) return [];
  const profiles = info.videoEncodeAcceleratorSupportedProfiles;
  if (profiles === undefined) return [];
  if (!Array.isArray(profiles)) {
    console.warn('[gpu:getInfo] unexpected videoEncodeAcceleratorSupportedProfiles shape');
    return [];
  }

  const mimes = new Set<string>();
  for (const entry of profiles) {
    const profile = isRecord(entry) ? entry.profile : entry;
    if (typeof profile !== 'number') continue;
    const mime = VIDEO_CODEC_PROFILE_MIMES.get(profile);
    if (mime) mimes.add(mime);
  }
  return [...mimes];
}

registerIpc(
  'gpu:getInfo',
  'app-global-read',
  async () => {
    try {
      // Read-only GPU metadata: no filesystem/network/keychain/OS mutation, bounded
      // shape parsing below, so this fits internal-reference's low-stakes IPC exception.
      const info = await app.getGPUInfo('complete');
      const gpu = (
        info as {
          gpuDevice?: Array<{
            vendorId: number;
            deviceId: number;
            driverVendor?: string;
            driverDescription?: string;
          }>;
        }
      ).gpuDevice?.[0];
      if (gpu) {
        // driverVendor on macOS often contains the hex vendorId as a string — skip it
        const driverName =
          gpu.driverVendor && !/^0x[0-9a-f]+$/i.test(gpu.driverVendor) ? gpu.driverVendor : '';
        const vendor =
          driverName || GPU_VENDORS[gpu.vendorId] || `Unknown (0x${gpu.vendorId.toString(16)})`;
        const device =
          gpu.driverDescription || (gpu.deviceId ? `Device 0x${gpu.deviceId.toString(16)}` : '');
        return { vendor, device, encodeProfiles: extractEncodeProfiles(info) };
      }
      return null;
    } catch {
      return null;
    }
  },
  { refusal: async () => null }
);

// Display info for resolution/refresh rate awareness
registerIpc(
  'screen:getDisplayInfo',
  'app-global-read',
  () => {
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    return displays.map((d) => ({
      width: d.size.width * d.scaleFactor,
      height: d.size.height * d.scaleFactor,
      refreshRate: d.displayFrequency,
      scaleFactor: d.scaleFactor,
      isPrimary: d.id === primary.id,
      colorDepth: d.colorDepth, // 24 = SDR, 30/48 = HDR
      colorSpace: d.colorSpace, // "srgb" = SDR, "p3"/"rec2020" = wide gamut
    }));
  },
  { refusal: () => [] }
);

// Hardware acceleration preference
registerIpc(
  'app:getHardwareAcceleration',
  'app-global-read',
  (): boolean | null => readHwAccelPref(),
  { refusal: () => null }
);

registerIpc(
  'app:setHardwareAcceleration',
  'app-global-mutate',
  (_sender, _event, enabled: boolean) => {
    fs.writeFileSync(hwAccelPrefPath, JSON.stringify({ enabled }), 'utf-8');
  },
  { refusal: () => undefined }
);

registerIpc(
  'app:getContentProtection',
  'app-global-read',
  async () => {
    // Off-platform the effective protection is OFF whatever the file says, so
    // report the truth rather than a preference that cannot take effect.
    if (!contentProtectionSupported()) return false;
    return readContentProtectionPref();
  },
  { refusal: async () => false }
);

registerIpc(
  'app:setContentProtection',
  'app-global-mutate',
  async (_sender, _event, enabled: unknown): Promise<boolean> => {
    if (typeof enabled !== 'boolean') return false;
    // Reporting success for a no-op is the one outcome worse than refusing: it
    // tells the caller a screen-capture protection is in force when nothing is.
    if (!contentProtectionSupported()) return false;

    const previous = readContentProtectionPref();
    if (!writeContentProtectionPref({ enabled, previousEnabled: previous, staged: true })) {
      return false;
    }

    const updated: BaseWindow[] = [];
    try {
      for (const window of getContentProtectionWindows()) {
        window.setContentProtection(enabled);
        updated.push(window);
      }
      if (!writeContentProtectionPref({ enabled }))
        throw new Error('content protection preference');
      return true;
    } catch {
      for (const window of updated) {
        try {
          window.setContentProtection(previous);
        } catch {
          // Preserve rollback attempts for every previously updated window.
        }
      }
      return false;
    }
  },
  { refusal: async () => false }
);

// Relaunch (for hardware acceleration toggle)
registerIpc(
  'app:relaunch',
  'app-global-mutate',
  () => {
    app.relaunch();
    app.quit();
  },
  { refusal: () => undefined }
);

// Hot SPA reload — main process re-runs the spaLoader safety chain and points
// the live window at the freshly-resolved remote SPA URL (or bundled on
// fallback). Powers the Settings ▸ About "Load latest UI" button: lets a client
// stranded on the bundled SPA (the cold-start config-fetch race) escape to
// remote WITHOUT an app restart. SECURITY: the renderer only TRIGGERS this; the
// URL is derived entirely in main from resolveSpaSource (getPersistedApiBase +
// the authenticated /api/v1/client/config fetch). NO URL is accepted from the
// renderer, so a compromised renderer cannot choose the origin. Reuses
// applySpaDecision so launch and runtime cannot drift.
type SpaReloadResult = { mode: 'remote' | 'bundled'; changed: boolean; rejected?: true };

registerIpc(
  'spa:reloadLatest',
  'saas-only',
  // Privileged: this reaches a top-frame navigation. registerIpc admits only the
  // saas primary's own document (#86 §3.4: the remote SPA runs only there) BEFORE
  // any window/packaged state check, so a compromised or self-hosted frame is
  // refused regardless of state. Its document set spans both states this feature
  // covers: app://concord (the stranded bundled state) and the active remote origin.
  async (): Promise<SpaReloadResult> => {
    const saasContents = saasPrimary()?.webContents;
    if (!saasContents || saasContents.isDestroyed() || !app.isPackaged) {
      return { mode: 'bundled', changed: false };
    }
    const before = getSpaHash();
    const decision = await resolveSpaSource();
    console.debug(`[SpaLoader/reload] ${decision.mode}: ${decision.reason}`);
    // Main initiated this swap (the renderer only TRIGGERED it), so a code already
    // delivered to the outgoing document is carried into its successor (#2363).
    const outcome = await applySpaDecisionCarryingDeepLink(saasContents, decision);
    // Collapse the internal 'cache' outcome to 'bundled' for the renderer-facing
    // IPC contract (#1870): the signed LKG cache is a local fallback origin, not a
    // remote SPA, and no renderer consumer distinguishes it — checkForUpdate's
    // currentMode already reports 'bundled' when serving from cache (remote-SPA
    // state is null). Keeps the preload `mode: 'remote' | 'bundled'` type honest
    // without leaking the internal selection detail to the renderer.
    const mode: 'remote' | 'bundled' = outcome === 'remote' ? 'remote' : 'bundled';
    return { mode, changed: getSpaHash() !== before };
  },
  {
    refusal: async (): Promise<SpaReloadResult> => ({
      mode: 'bundled',
      changed: false,
      rejected: true,
    }),
  }
);

// SPA (UI) update check — the SECOND update axis, distinct from the
// electron-updater desktop-binary axis (update:*). Reports whether the renderer
// is on the bundled fallback vs remote, and whether NEWER remote-SPA bytes are
// live (a SHA-256 diff of the served index.html — /client/config exposes no SPA
// build id and the SPA URL is constant post-#976, so there is no version number
// to show, only "newer bytes available"). Read-only and best-effort (never
// throws); the network target is server-derived, not renderer-supplied.
type SpaUpdateCheck = {
  currentMode: 'remote' | 'bundled';
  remoteAvailable: boolean;
  newerBytesAvailable: boolean | null;
  reason: string;
};

registerIpc(
  'spa:checkForUpdate',
  'saas-only',
  // Read-only, but admitted like spa:reloadLatest (the saas primary only) for
  // defense-in-depth — closes the (minor) redundant-self-fetch surface a
  // compromised, sandboxed or self-hosted frame could otherwise trigger.
  async (): Promise<SpaUpdateCheck> => {
    if (!app.isPackaged) {
      return {
        currentMode: 'remote',
        remoteAvailable: false,
        newerBytesAvailable: null,
        reason: 'dev mode',
      };
    }
    const currentMode = getRemoteSpaUrl() === null ? 'bundled' : 'remote';
    const decision = await resolveSpaSource();
    const remoteAvailable = decision.mode === 'remote' && !!decision.url;
    let newerBytesAvailable: boolean | null = null;
    if (remoteAvailable && decision.url) {
      const available = await hashEntryHtml(decision.url);
      // null (re-fetch failed) → unknown; the UI degrades to an unconditional offer.
      newerBytesAvailable = available === null ? null : available !== getSpaHash();
    }
    return { currentMode, remoteAvailable, newerBytesAvailable, reason: decision.reason };
  },
  {
    refusal: async (): Promise<SpaUpdateCheck> => ({
      currentMode: 'bundled',
      remoteAvailable: false,
      newerBytesAvailable: null,
      reason: 'rejected',
    }),
  }
);

// Clean app exit (preserves persisted auth/remember-me state)
registerIpc(
  'app:quit',
  'app-global-mutate',
  () => {
    app.quit();
  },
  { refusal: () => undefined }
);

// ─── Desktop Notification Helpers (#175) ────────────────────────────

// Hardened in IPC contract 33 (tray-status spec §4 T7): sender frame first, then
// the payload shape. Each refusal is a silent no-op, as before for bad input.
const MAX_BADGE_COUNT = 9999;

// #86: one count per connection, shown as their sum, so a connection's badge is only
// ever its own share. A disposed connection's share leaves the sum with it.
const badgeByConnection = new Map<ConnectionRef['connectionId'], number>();

function applyBadgeTotal(): void {
  let sum = 0;
  for (const count of badgeByConnection.values()) sum += count;
  // A real total can exceed the cap (it sums every channel and DM); clamp, don't drop.
  app.setBadgeCount(Math.min(sum, MAX_BADGE_COUNT));
}

onGenerationAdvanced((id, _from, _to, reason) => {
  if (reason !== 'disposed' || !badgeByConnection.delete(id)) return;
  applyBadgeTotal();
});

registerIpc(
  'app:setBadgeCount',
  'connection-bound',
  (sender, _event, count: unknown) => {
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return;
    badgeByConnection.set(sender.ref.connectionId, Math.min(count, MAX_BADGE_COUNT));
    applyBadgeTotal();
  },
  { refusal: () => undefined }
);

registerIpc(
  'app:flashFrame',
  'connection-bound',
  (_sender, _event, flash: unknown) => {
    if (typeof flash !== 'boolean') return;
    shellWindow()?.flashFrame(flash);
  },
  { refusal: () => undefined }
);

registerIpc(
  'app:focusWindow',
  'connection-bound',
  () => {
    const win = shellWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  },
  { refusal: () => undefined }
);

// ─── Auto-Update IPC ──────────────────────────────────────────────────

const NO_RESULT = { refusal: () => undefined };

registerIpc('update:check', 'app-global-mutate', () => checkForUpdates(), NO_RESULT);
registerIpc('update:download', 'app-global-mutate', () => downloadUpdate(), NO_RESULT);
registerIpc('update:install', 'app-global-mutate', () => safeQuitAndInstall(), NO_RESULT);
registerIpc('update:getAllowPrerelease', 'app-global-read', () => getAllowPrerelease(), {
  refusal: () => false,
});
registerIpc(
  'update:setAllowPrerelease',
  'app-global-mutate',
  (_sender, _event, enabled: boolean) => setAllowPrerelease(enabled),
  NO_RESULT
);
registerIpc('update:getLogPath', 'app-global-read', () => getUpdateLogPath(), {
  refusal: () => null,
});
registerIpc(
  'updater:force-check',
  'app-global-mutate',
  (_sender, _event, reason: 'attestation_required' | 'user_triggered') =>
    forceCheckForUpdates(reason),
  NO_RESULT
);

// Developer Mode (gates DevTools in packaged builds — REMOVE BEFORE BETA)
registerIpc('app:getDeveloperMode', 'app-global-read', () => readDeveloperModePref(), {
  refusal: () => false,
});
registerIpc(
  'app:setDeveloperMode',
  'app-global-mutate',
  (_sender, _event, enabled: boolean) => {
    writeDeveloperModePref(enabled);
    // app-global-mutate (#86 §3.7): the foreground view's DevTools.
    const contents = foregroundWebContents();
    if (!contents) return;
    if (enabled) {
      if (!contents.isDevToolsOpened()) {
        contents.openDevTools({ mode: 'detach' });
      }
    } else if (contents.isDevToolsOpened()) {
      contents.closeDevTools();
    }
  },
  NO_RESULT
);

// System info for About page (#155 Tier 4)
registerIpc(
  'app:getSystemInfo',
  'app-global-read',
  () => ({
    platform: process.platform,
    arch: process.arch,
    electronVersion: process.versions.electron,
    chromiumVersion: process.versions.chrome,
    nodeVersion: process.versions.node,
  }),
  { refusal: () => null }
);

// ─── Secure Auth Token Management (safeStorage) ──────────────────────

export interface ApprovalDialogParams {
  host: string;
  address: string;
  decision: EgressDecision;
}

function addressClassSuffix(decision: EgressDecision): string {
  if (decision.tier === 'tier2') {
    if (decision.reason === 'loopback') return 'on this device';
    if (decision.reason === 'cgnat') return "on your provider's network";
    return 'on your network'; // private / ula
  }
  return 'on the internet'; // public (tier1 never reaches the ceremony)
}

/** Exported for unit test. Copy is verbatim per spec §7.2; punycode is never decoded. */
export function buildApprovalDialogCopy(p: ApprovalDialogParams): {
  message: string;
  detail: string;
} {
  const suffix = addressClassSuffix(p.decision);
  const message = `Trust ${p.host}?`;
  const detail =
    `Host:         ${p.host}\n` +
    `Resolves to:  ${p.address}, ${suffix}\n\n` +
    `If you trust it, Concord Voice will store your sign-in on this device and ` +
    `use ${p.host} to sign you in from now on.\n\n` +
    `Concord Voice will remember this choice on this device.`;
  return { message, detail };
}

const defaultShowMessageBox = (w: unknown, o: unknown): Promise<{ response: number }> =>
  w
    ? dialog.showMessageBox(w as BaseWindow, o as Electron.MessageBoxOptions)
    : dialog.showMessageBox(o as Electron.MessageBoxOptions);

/** Exported for unit test. showMessageBox is injected (the applicationsFolderGate pattern). */
export async function requestSelfHostedApproval(
  win: unknown,
  p: ApprovalDialogParams,
  {
    showMessageBox = defaultShowMessageBox,
  }: { showMessageBox?: (w: unknown, o: unknown) => Promise<{ response: number }> } = {}
): Promise<boolean> {
  const { message, detail } = buildApprovalDialogCopy(p);
  const { response } = await showMessageBox(win, {
    type: 'warning',
    title: 'Concord Voice',
    message,
    detail,
    buttons: ['Cancel', 'Trust This Server'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return response === 1;
}

// One probe at a time per CONNECTION (#86: keyed on the main-held binding, never on
// anything the renderer supplies). This is a REJECTING single-flight, not the
// promise-sharing kind used by the restoreSession dedupe / spaSelfHeal: two concurrent
// probes of DIFFERENT urls must never share one result.
//
// It gates the whole handler because resolveForDisplay's dns.lookup is a
// libuv-threadpool job that cannot be cancelled. The default pool is 4, so N
// concurrent probes of unresolvable names queue N getaddrinfo jobs against those
// slots and head-of-line-block every async fs operation in the main process —
// credential IO and the approvals-file read included — with zero dialogs shown.
// The threadpool is process-global while this bound is per connection, so the
// protection rests on each renderer holding at most one probe and the number of
// connections being capped (MAX_LIVE_CONNECTIONS) and user-approved.
// A per-request timeout (resolveForDisplay's race) does not free the slot; only
// not starting the lookup does. ServerInput already disables Connect while busy,
// so the refused concurrency has no legitimate caller.
const probesInFlight = new Set<ConnectionRef['connectionId']>();

function probeRejected(): SelfHostedProbeResult {
  return {
    status: 'error',
    code: 'rejected',
    message: 'Self-hosted server probing is not available from this frame.',
  };
}

registerIpc(
  'selfHosted:probeServer',
  'connection-bound',
  async (sender, _event, url: unknown): Promise<SelfHostedProbeResult> => {
    // Set synchronously, before the handler's first await, so a burst dispatched in
    // one tick cannot all observe an empty set.
    const key = sender.ref.connectionId;
    if (probesInFlight.has(key)) {
      console.warn('[selfHosted:probeServer] refused — a probe is already in flight');
      return { status: 'error', code: 'busy', message: '' };
    }
    probesInFlight.add(key);
    try {
      return await handleProbeSelfHostedServer(url, sender);
    } finally {
      probesInFlight.delete(key);
    }
  },
  { refusal: async () => probeRejected() }
);

/**
 * #86: a probe of the sender's OWN service returns as before. A successful probe of
 * any OTHER origin opens that origin in its own connection and activates it, so the
 * probing view (saas included) is never re-homed and receives no apiBase to load.
 */
async function settleProbe(
  sender: ConnectionSender,
  apiBase: string,
  result: SelfHostedProbeResult
): Promise<SelfHostedProbeResult> {
  if (result?.status !== 'ok') return result;
  const origin = new URL(apiBase).origin;
  if (origin === sender.service.origin) return result;
  if (!isSenderCurrent(sender)) return probeRejected();
  const opened = await openApprovedConnection(sender, origin);
  if (opened.status !== 'opened') {
    // Closed enum only: never the origin.
    console.warn(`[selfHosted:probeServer] not opened in a connection (${opened.reason})`);
    return probeRejected();
  }
  return { status: 'opened-in-connection', serviceId: opened.serviceId };
}

async function handleProbeSelfHostedServer(
  url: unknown,
  sender: ConnectionSender
): Promise<SelfHostedProbeResult> {
  if (typeof url !== 'string') {
    return {
      status: 'error',
      code: 'invalid_url',
      message: 'Enter a self-hosted server URL.',
    };
  }

  const normalized = normalizeSelfHostedUrl(url);
  if (!normalized.ok) {
    return { status: 'error', code: normalized.code, message: normalized.message };
  }

  const parsed = new URL(normalized.apiBase);
  const resolved: ResolveForDisplayResult = await resolveForDisplay(parsed.hostname);
  if (!resolved.ok && resolved.kind === 'tier1') {
    // Reason token only; the renderer owns the user-facing copy.
    return { status: 'error', code: 'address_not_allowed', message: resolved.reason };
  }
  if (!resolved.ok) {
    return { status: 'error', code: 'unreachable', message: 'Could not reach the server.' };
  }

  // Consent is scoped to the address class the ceremony displayed. An origin approved
  // against a public address has NOT authorized a tier-2 dial under that name, so a
  // server that has genuinely moved onto a LAN re-runs the ceremony once — showing the
  // private address this time — instead of stranding. An origin already approved at
  // tier 2, or one still resolving public, never re-prompts.
  const approvalTier = approvalTierForApiBase(normalized.apiBase);
  const needsApproval =
    approvalTier === null || (resolved.decision.tier === 'tier2' && approvalTier !== 'tier2');

  if (needsApproval) {
    // The dialog speaks for the view the user is looking at: a hidden connection's
    // view never raises it (#86).
    if (!isForegroundSender(sender)) return probeRejected();
    // Rations the DIALOG, not the probe: an approved origin never reaches this
    // branch, so re-probing it stays unthrottled. The token is taken before the
    // modal opens because a declined ceremony cost the user the same interruption
    // an approved one did.
    if (!consumeCeremonyToken()) {
      console.warn('[selfHosted:probeServer] refused — approval prompt budget exhausted');
      return { status: 'error', code: 'too_many_prompts', message: '' };
    }
    // The shell window is read HERE, at ceremony time — not at handler registration,
    // when the auth window does not yet exist.
    const approved = await requestSelfHostedApproval(shellWindow(), {
      host: parsed.hostname,
      // Every resolved address, not just the representative: the user consents to the
      // whole set the name answers with, so the whole set is what the dialog states.
      address: resolved.addresses.join(', '),
      decision: resolved.decision,
    });
    // After every await: the view that asked must still be the one that is live.
    if (!isSenderCurrent(sender)) return probeRejected();
    if (!approved) {
      return { status: 'error', code: 'approval_declined', message: 'Connection cancelled.' };
    }
    // Consent is not proof. The grant is PROVISIONAL until the probe shows this origin
    // answers like a Concord server: beginPendingApproval authorizes only the dial the
    // probe itself needs, and the durable record is written after. Committing first meant
    // any post-consent failure — non-Concord server, TLS, ECONNREFUSED, HTTP 500 — still
    // left a permanent grant gating auth:storeRefreshToken and the SSO exchange.
    beginPendingApproval(normalized.apiBase, resolved.address);
    let result: SelfHostedProbeResult;
    try {
      result = await probeSelfHostedServer(normalized.apiBase);
    } finally {
      clearPendingApproval();
    }
    if (result?.status !== 'ok') return result;
    if (!isSenderCurrent(sender)) return probeRejected();
    if (!commitSelfHostedApproval(normalized.apiBase, resolved.address)) {
      return {
        status: 'error',
        code: 'approval_not_saved',
        message: "Concord couldn't save your choice.",
      };
    }
    return settleProbe(sender, normalized.apiBase, result);
  }

  return settleProbe(sender, normalized.apiBase, await probeSelfHostedServer(normalized.apiBase));
}

/** `connection:create`'s pre-ceremony step (#86 §3.7): what the dialog will state. */
type ConnectionOriginProbe =
  | { readonly status: 'error' }
  | {
      readonly status: 'ok';
      readonly needsApproval: boolean;
      readonly apiBase: string;
      readonly address: string;
      readonly dialog: Parameters<typeof requestSelfHostedApproval>[1];
    };

/**
 * The same normalisation, resolution and tier rule as `handleProbeSelfHostedServer`,
 * stopping before the dialog. `origin` is already canonical; a value the self-hosted
 * normaliser would change is refused rather than silently re-homed.
 */
async function probeConnectionOrigin(origin: string): Promise<ConnectionOriginProbe> {
  const normalized = normalizeSelfHostedUrl(origin);
  if (!normalized.ok || new URL(normalized.apiBase).origin !== origin) return { status: 'error' };
  const host = new URL(origin).hostname;
  const resolved: ResolveForDisplayResult = await resolveForDisplay(host);
  if (!resolved.ok) return { status: 'error' };
  const approvalTier = approvalTierForApiBase(normalized.apiBase);
  const needsApproval =
    approvalTier === null || (resolved.decision.tier === 'tier2' && approvalTier !== 'tier2');
  return {
    status: 'ok',
    needsApproval,
    apiBase: normalized.apiBase,
    address: resolved.address,
    dialog: { host, address: resolved.addresses.join(', '), decision: resolved.decision },
  };
}

/**
 * The native ceremony, then the provisional probe it authorises (the same
 * consent-is-not-proof rule as `handleProbeSelfHostedServer`). `connection.ts` spends
 * the ceremony budget before calling this and commits the approval after it.
 */
async function runConnectionCeremony(
  _origin: string,
  probe: ConnectionOriginProbe
): Promise<ConnectionCeremonyVerdict> {
  if (probe.status !== 'ok') return { approved: false };
  if (!(await requestSelfHostedApproval(shellWindow(), probe.dialog))) return { approved: false };
  beginPendingApproval(probe.apiBase, probe.address);
  let result: SelfHostedProbeResult;
  try {
    result = await probeSelfHostedServer(probe.apiBase);
  } finally {
    clearPendingApproval();
  }
  return result?.status === 'ok' ? { approved: true, address: probe.address } : { approved: false };
}

registerIpc('auth:storeRefreshToken', 'connection-bound', (sender, _event, data: unknown) => {
  // D3 (#86): a supplied apiBase may only NAME the sender's own service. It is refused
  // before any custody call; the custody and the stored origin come from the binding.
  if (isRecord(data) && !crossCheckApiBase(sender, data.apiBase)) {
    return rejectWrongOwner('auth:storeRefreshToken');
  }
  if (!isStoreRefreshTokenPayload(data)) {
    return rejectInvalidAuthPayload('auth:storeRefreshToken');
  }

  const credentialOwner = sender.custody.storeRefreshToken({
    ...data,
    apiBase: sender.service.origin,
  });
  // Main learns of a sign-in HERE and, for a cold start, nowhere else. App.tsx
  // signals invite-readiness from a mount effect before anyone has signed in, so
  // a startup code is DELIVERED while the owner is still null and the renderer's
  // later replay into the modal is local and sends no IPC back. Without this the
  // tag stayed null for the life of the process and the pre-login exemption never
  // expired (CODEX P2). Fence first: if a PREVIOUS owner's codes are still
  // retained they must go rather than be adopted by whoever just signed in.
  // Deep links reach the saas connection only, so only its owner tags them (#86).
  if (sender.service.serviceId === SAAS_SERVICE_ID) {
    fenceDeepLinksOnOwnerChange(false, credentialOwner);
    noteDeepLinkOwner(credentialOwner);
  }
  // Clear any cached restore result so subsequent restoreSession calls
  // (e.g. after HMR or renderer reload) use the fresh token, not a stale
  // 'refresh_failed' from a previous attempt.
  restoreSessionByConnection.delete(sender.ref.connectionId);

  // Activate auto-updater now that we have an API base
  // (first-launch users won't have this until login)
  setUpdateFeedUrl(sender.service.origin);
  return credentialOwner;
});

// Deduplicate restoreSession: React Strict Mode can fire the renderer's
// useEffect twice, causing two IPC calls.  Without dedup each call would
// trigger a separate token rotation, wasting rotations and widening the
// window for race conditions.
type RestoreSessionResult = {
  status: string;
  accessToken?: string;
  sessionId?: string;
  e2eeKeys?: unknown;
  rememberMe?: boolean;
  credentialOwner?: CredentialOwner;
  pendingE2EEUnlock?: boolean;
};
// Keyed by connection (#86): a shared promise would hand one connection's restored
// access token to another connection's renderer.
const restoreSessionByConnection = new Map<
  ConnectionRef['connectionId'],
  Promise<RestoreSessionResult>
>();

function rejectWrongOwner(channel: string): { status: 'rejected'; reason: 'wrong-owner' } {
  console.warn(`[${channel}] rejected — apiBase names a different service`);
  return { status: 'rejected', reason: 'wrong-owner' };
}

/** #86: the sender's connection is still live at the generation it was admitted at. */
function isSenderCurrent(sender: ConnectionSender): boolean {
  const record = recordFor(sender.ref.connectionId);
  return (
    record !== undefined &&
    record.state !== 'disposed' &&
    record.generation === sender.ref.generation
  );
}

/** ...and it is the foreground connection. */
function isForegroundSender(sender: ConnectionSender): boolean {
  return isSenderCurrent(sender) && foreground() === recordFor(sender.ref.connectionId);
}

function rejectInvalidAuthPayload(channel: string): { status: 'rejected' } {
  console.warn(`[${channel}] rejected — invalid payload`);
  return { status: 'rejected' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isValidApiBase(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  try {
    const parsed = new URL(value);
    const wellFormed =
      (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.origin !== 'null';
    if (!wellFormed) return false;
    // Defense-in-depth (#1872 review): a packaged client only ever talks to the
    // single SaaS control-plane the updater already TLS-pins, so pin the
    // renderer-supplied apiBase to that origin too. This denies a
    // compromised-but-correctly-framed renderer the ability to steer the update
    // feed / persisted API origin at an attacker host — the one path
    // code-signing doesn't cover on Linux (no publisher verification). Dev/LAN
    // builds (isPackaged=false) keep the host-agnostic check.
    if (app.isPackaged) {
      return (
        parsed.origin === new URL(PRODUCTION_API_BASE).origin ||
        isValidatedSelfHostedApiBase(parsed.origin)
      );
    }
    return true;
  } catch {
    return false;
  }
}

// Caps on credential IPC fields, matching ipc/sso.ts. They bound what each
// queued tokenManager disk write can hold: a refresh token is 44 characters,
// a symmetric key 44, a wrapped RSA-4096 key about 3.2 KB.
const MAX_TOKEN_LENGTH = 8192;
const MAX_SYMMETRIC_KEY_LENGTH = 1024;
const MAX_WRAPPED_KEY_LENGTH = 16_384;

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isStoreRefreshTokenPayload(data: unknown): data is {
  refreshToken: string;
  rememberMe: boolean;
  apiBase: string;
  accessToken?: string;
} {
  return (
    isRecord(data) &&
    isBoundedString(data.refreshToken, MAX_TOKEN_LENGTH) &&
    typeof data.rememberMe === 'boolean' &&
    isValidApiBase(data.apiBase) &&
    (data.accessToken === undefined ||
      (typeof data.accessToken === 'string' && data.accessToken.length <= MAX_TOKEN_LENGTH))
  );
}

function isStoreE2EEKeysPayload(data: unknown): data is {
  wrappingKeyBase64: string;
  preferencesKeyBase64: string;
  wrappedPrivateKeyBase64: string;
} {
  return (
    isRecord(data) &&
    isBoundedString(data.wrappingKeyBase64, MAX_SYMMETRIC_KEY_LENGTH) &&
    isBoundedString(data.preferencesKeyBase64, MAX_SYMMETRIC_KEY_LENGTH) &&
    isBoundedString(data.wrappedPrivateKeyBase64, MAX_WRAPPED_KEY_LENGTH)
  );
}

function isLogoutPayload(data: unknown): data is { accessToken?: string } | undefined {
  if (data === undefined) return true;
  if (!isRecord(data)) return false;
  return data.accessToken === undefined || typeof data.accessToken === 'string';
}

function isCredentialOwner(value: unknown): value is CredentialOwner {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

registerIpc('auth:restoreSession', 'connection-bound', (sender) => {
  const connectionId = sender.ref.connectionId;
  const inFlight = restoreSessionByConnection.get(connectionId);
  if (inFlight) return inFlight;

  const isSaas = sender.service.serviceId === SAAS_SERVICE_ID;
  const restore: Promise<RestoreSessionResult> = (async () => {
    // The sender's own custody (#86), and every read below stays on it. Each await
    // is followed by a check that the connection is still at the generation that
    // asked, so a reload or a dispose in between abandons the restore.
    const custody = sender.custody;
    const ownerIfActive = (): CredentialOwner | null =>
      isSenderCurrent(sender) ? custody.getCredentialCustodyState().credentialOwner : null;
    const restored = await custody.restoreRefreshToken();
    if (restored.status !== 'ok') {
      return { status: restored.status };
    }
    const restoreOwner = ownerIfActive();
    if (restoreOwner === null) {
      return { status: 'refresh_failed' };
    }
    // The other point at which main learns who is signed in — a remembered
    // session restored at launch, where a startup deep link is likeliest of all.
    // Same order as the login path: fence a previous owner's retained codes, then
    // claim what remains.
    //
    // The FENCE half is unproven here and says so rather than pretending: at cold
    // start the tag is null, so it is a no-op, and every path that would leave a
    // previous owner's tag live before a restore also forgets. Dropping it alone
    // leaves the suite green. It stays because the two auth points must behave
    // identically — an asymmetry between them is a trap, and this is the ordering
    // whose inverse is a cross-account leak on the login path (covered there).
    if (isSaas) {
      fenceDeepLinksOnOwnerChange(false, restoreOwner);
      noteDeepLinkOwner(restoreOwner);
    }
    // Token restored from disk or main-process memory — refresh it to get a
    // fresh access token.
    const refreshResult = await custody.performRefresh();
    if (refreshResult.status === 'ok' && refreshResult.accessToken) {
      // A fresh login may have replaced the restored credential after refresh
      // resolved but before this continuation resumed. Verify the owner before
      // reading keys so an old access token can never be paired with a
      // successor's E2EE custody.
      if (ownerIfActive() !== restoreOwner) {
        return { status: 'refresh_failed' };
      }
      // Also restore E2EE keys if available. The restore awaits a decrypt, so a
      // login can land inside it: the owner re-check after it is what keeps
      // these keys paired with the access token above.
      const e2eeKeys = await custody.restoreE2EEKeys();
      const state = custody.getCredentialCustodyState();
      if (!isSenderCurrent(sender) || state.credentialOwner !== restoreOwner) {
        return { status: 'refresh_failed' };
      }
      return {
        status: 'restored',
        accessToken: refreshResult.accessToken,
        sessionId: refreshResult.sessionId,
        e2eeKeys,
        rememberMe: restored.rememberMe,
        credentialOwner: state.credentialOwner,
        pendingE2EEUnlock: state.pendingE2EEUnlock,
      };
    }
    return { status: 'refresh_failed' };
  })().finally(() => {
    if (restoreSessionByConnection.get(connectionId) === restore) {
      restoreSessionByConnection.delete(connectionId);
    }
  });
  restoreSessionByConnection.set(connectionId, restore);
  return restore;
});

registerIpc('auth:storeE2EEKeys', 'connection-bound', (sender, _event, data: unknown) => {
  if (!isStoreE2EEKeysPayload(data)) {
    return rejectInvalidAuthPayload('auth:storeE2EEKeys');
  }

  // Surface persistence success/failure to the renderer (#1288) — a genuine
  // keychain/disk write failure returns false rather than being swallowed.
  // Staged in the SENDER's custody (#86 S2), so keys staged by one connection can only
  // ever be adopted by that connection's own next credential, never by another's.
  return sender.custody.storeE2EEKeys(data);
});

registerIpc(
  'auth:storeE2EEKeysIfOwner',
  'connection-bound',
  (sender, _event, data: unknown, owner: unknown) => {
    if (!isStoreE2EEKeysPayload(data) || !isCredentialOwner(owner)) {
      return rejectInvalidAuthPayload('auth:storeE2EEKeysIfOwner');
    }

    // S3 (#86): owner numbers are not unique across custodies, so the number is checked
    // only against the sender's own custody and a colliding number reaches no other.
    return sender.custody.storeE2EEKeysIfOwner(data, owner);
  }
);

registerIpc('auth:refreshToken', 'connection-bound', async (sender) => {
  return sender.custody.performRefresh();
});

registerIpc(
  'auth:logout',
  'connection-bound',
  async (sender, _event, data?: { accessToken?: string }) => {
    if (!isLogoutPayload(data)) {
      return rejectInvalidAuthPayload('auth:logout');
    }

    // The renderer's real logout path is userStore.logout() -> electron.logout(),
    // which lands HERE and never reaches the auth:clearTokens handler. It happens
    // to reach it later, through nuclearReset()'s optional-chained
    // `globalThis.electron?.clearTokens?.()` (resetService.ts) — a renderer-side
    // call ordering that no main-process test can observe and that a refactor
    // could drop silently. The §5.2 fence therefore holds at THIS edge on its own.
    //
    // BEFORE the await, not after: performLogout clears the credentials on its
    // first line and only then issues an unbounded network POST, so anything after
    // the await leaves the clear open for the width of that request.
    forgetDeliveredDeepLinks();
    await sender.custody.performLogout(data?.accessToken);
    return undefined;
  }
);

registerIpc('auth:clearTokens', 'connection-bound', (sender, _event, opts: unknown) => {
  // Renderer-supplied, so read strictly: only the exact literal `true` opts OUT,
  // and anything else — absent, malformed, truthy-but-not-true — forgets.
  //
  // The default direction is load-bearing (CODEX P2, round 12). An OLDER SPA on
  // this shell — spaLoader loads one indefinitely — predates this argument and
  // sends nothing, so whatever "no argument" means is what those SPAs get. Keep
  // by default would leave user A's delivered invite alive through a forced
  // logout and replay it into user B's session; forget by default costs such an
  // SPA an invite at SSO start, which the user recovers by clicking the link
  // again. Lose an invite, never cross an account.
  const keepDeepLinks =
    typeof opts === 'object' &&
    opts !== null &&
    (opts as { keepDeepLinks?: unknown }).keepDeepLinks === true;

  // Deliberately does NOT forget deep links (CODEX P2, round 8). This handler
  // has three renderer callers and NOT ONE of them is unambiguously a logout:
  //   - useSSOFlow.begin() calls it immediately BEFORE starting SSO, so
  //     forgetting here destroys a `concord://invite/CODE` queued while the app
  //     was closed — the click-invite-then-sign-in flow, which is the PRIMARY
  //     path this whole change exists to repair;
  //   - App.tsx's clearOwnerlessRestoredCredential rejects a restored credential
  //     at cold start, after which the user logs in and should still get it;
  //   - resetService.gracefulReset() reaches it on a rememberMe refresh failure,
  //     which deliberately keeps codes for the resuming session.
  // Real logout has its own handler, `auth:logout`, which forgets — so nothing
  // is lost by narrowing this one. The claim is "every LOGOUT path forgets", and
  // this is the second handler to have been wrongly read as one.
  //
  // `keepDeepLinks` is what the login-side callers pass: useSSOFlow before
  // starting SSO, App.tsx rejecting an ownerless restored credential, and
  // gracefulReset's shared clear (whose remembered-session path resumes). The one
  // caller that does NOT pass it is `nuclearReset()` — a refresh failure with
  // `rememberMe === false`, documented in resetService as "ends the authenticated
  // lifecycle", which reaches this handler through gracefulReset and never calls
  // `auth:logout`.
  // Only the sender's own custody: an owner-blind wipe never reaches another
  // connection's profile, nor one chosen from disk or by default (the double-clear
  // class above, #86).
  sender.custody.clearTokens();
  if (!keepDeepLinks) forgetDeliveredDeepLinks();
  return undefined;
});

// FORGET-ONLY, and that is the whole reason it exists (#2363). Every other edge
// that forgets also destroys credentials, and the one teardown that must forget
// WITHOUT destroying them is a `rememberMe` refresh failure: the session has ended
// and the user must re-authenticate, but the disk tokens stay so the next launch
// can retry. `gracefulReset` had no way to say "the session ended" without also
// saying "delete the credentials", so main kept `gate.lastCode` alive and a swap
// inside the carry window replayed user A's invite into user B's renderer.
//
// The renderer-side `deep-link-session-ended` fence is necessary and NOT
// sufficient: it clears the copy App holds, and main holds its own.
//
// Sender-fenced like the auth channels it sits beside. Forgetting is the fail-safe
// direction — the worst a hostile caller achieves is losing its own pending invite
// — but a renderer-reachable channel that mutates main's delivery state gets the
// same guard as its neighbours regardless, rather than an argument for why it does
// not need one. #86: deep links are saas-only, so only the saas primary may forget.
registerIpc('deeplink:forget', 'saas-only', () => {
  forgetDeliveredDeepLinks();
  return undefined;
});

registerIpc('auth:clearTokensIfOwner', 'connection-bound', (sender, _event, owner: unknown) => {
  if (!isCredentialOwner(owner)) {
    return rejectInvalidAuthPayload('auth:clearTokensIfOwner');
  }

  // Deliberately does NOT forget deep links, despite ending credentials.
  // Every caller is LOGIN-side, not logout: aborted SSO (useSSOFlow), an
  // interrupted email verification, a cancelled account-link or passphrase
  // setup, an aborted login continuation (Login.tsx), and the eager-unlock
  // re-persist cleanup. Forgetting here is exactly the asymmetry the deep-link
  // rules warn against, and the loss is concrete: a `concord://invite/CODE`
  // opened while the app was closed sits in `pendingDeepLinks` before any
  // window exists — main holds the ONLY copy — so an SSO sign-in that aborts
  // would erase it and the retry would land with the invite silently gone.
  // That is #2363's own symptom on a new path.
  // S3 (#86): checked only against the sender's own custody, as for E2EE keys above.
  return sender.custody.clearTokensIfOwner(owner);
});

registerIpc(
  'auth:getCapabilities',
  'app-global-read',
  // A machine fact (is OS-protected storage available), the same from any custody.
  (sender) => sender.custody.getCapabilities(),
  // Fail closed with this handler's own shape (not the {status:'rejected'}
  // reject shape) so callers always get a valid, safe default.
  { refusal: async () => ({ persistAvailable: false }) }
);

registerIpc(
  'auth:getMachineId',
  'connection-bound',
  (sender, _event, apiBase?: unknown) => {
    // The id is per service (#1618), so it is the sender's own whatever apiBase names.
    // A supplied apiBase is only a cross-check, refused before any id is read or minted.
    if (!crossCheckApiBase(sender, apiBase)) {
      console.warn('[auth:getMachineId] rejected — apiBase names a different service');
      return '';
    }
    return getMachineId(sender.service.origin);
  },
  { refusal: () => '' }
);

// ─── PiP (Picture-in-Picture) Window Management ──────────────────────
type PipWindowEntry = {
  window: BrowserWindow;
  /** The opener's document when the PiP opened; its pushes go there or nowhere. */
  ownerRef: ConnectionRef;
  ownerFrameTreeNodeId: number;
  remoteSpaUrl: string | null;
  /**
   * #3104 D6 — the per-window capability that authenticates this PiP on the
   * renderer-side `concord-pip` RPC channel. Minted here because the main
   * process is the only out-of-band path between two renderers, and disclosed
   * only by `pip:opened` (to the main window) and `pip:session` (to this PiP's
   * own main frame). Never log it: the private reply channel is NAMED from it.
   */
  sessionToken: string;
};
const pipWindows = new Map<string, PipWindowEntry>();

/** Force-close PiP children during full-app shutdown so renderer unload guards cannot veto quit. */
function destroyPipWindowsForQuit(): void {
  for (const { window: pip } of pipWindows.values()) {
    if (!pip.isDestroyed()) pip.destroy();
  }
}

/**
 * Resolve the PiP `id` names together with WHICH of the two permitted
 * relationships the sender holds. `pip:close` / `pip:setAlwaysOnTop` accept
 * either; `pip:session` accepts only the PiP's own main frame, because the
 * token it returns is a working capability rather than a window mutation.
 */
type PipIpcEvent = Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>;

function resolvePipSender(
  event: PipIpcEvent,
  id: unknown
): { entry: PipWindowEntry; isPipMainFrame: boolean } | null {
  if (typeof id !== 'string' || id.length === 0) return null;
  const senderFrame = event.senderFrame;
  if (!senderFrame) return null;
  const entry = pipWindows.get(id);
  if (!entry || entry.window.isDestroyed()) return null;
  const isPipMainFrame =
    event.sender === entry.window.webContents &&
    senderFrame.frameTreeNodeId === entry.window.webContents.mainFrame.frameTreeNodeId;
  if (
    !isValidPipOpenSender(
      senderFrame.url,
      app.isPackaged,
      isPipMainFrame ? entry.remoteSpaUrl : getRemoteSpaUrl()
    )
  ) {
    return null;
  }
  const isOwnerFrame = entry.ownerFrameTreeNodeId === senderFrame.frameTreeNodeId;
  if (!isOwnerFrame && !isPipMainFrame) return null;
  return { entry, isPipMainFrame };
}

/**
 * #86: the PiP `id` names, resolved as above AND owned by the sender's own
 * connection. The binding is main-held, so a document of connection B can never
 * reach a PiP connection A opened, whatever frame ids the two happen to share.
 */
function resolveOwnedPip(
  sender: ConnectionSender,
  event: PipIpcEvent,
  id: unknown
): { entry: PipWindowEntry; isPipMainFrame: boolean } | null {
  const resolved = resolvePipSender(event, id);
  if (!resolved || resolved.entry.ownerRef.connectionId !== sender.ref.connectionId) return null;
  return resolved;
}

registerIpc(
  'pip:open',
  'connection-bound',
  (sender, event, opts: { id: string; width?: number; height?: number; title?: string }) => {
    // Defense-in-depth: only accept pip:open from the active SPA, the dev
    // server, or the bundled renderer. Without validation any frame loaded
    // in any window could spawn PiP windows.
    const senderFrame = event.senderFrame;
    const remoteUrl = getRemoteSpaUrl();
    if (!senderFrame || !isValidPipOpenSender(senderFrame.url, app.isPackaged, remoteUrl)) {
      console.warn('[pip:open] rejected — sender frame validation failed');
      return;
    }

    const existing = pipWindows.get(opts.id);
    if (existing) {
      if (existing.ownerFrameTreeNodeId === senderFrame.frameTreeNodeId) {
        existing.window.focus();
      }
      return;
    }

    // #86 R8: built by shellWindow on the OPENER's session and bound 'pip' to its
    // connection. Only a bound primary may open one: registerIpc admitted exactly
    // that, and the opener is the sender's own record.
    const opener = sender.record;
    const contentProtectionEnabled = readContentProtectionPref();
    const pip = createPipWindow(event.sender, {
      width: opts.width || 320,
      height: opts.height || 240,
      minWidth: 160,
      minHeight: 120,
      frame: false,
      // #806: opt out of the OS-drawn drop shadow so the lightweight chrome
      // visually reads as "floating glass" rather than "compact app window".
      // On macOS this drops the standard window shadow; on Wayland and X11
      // the compositor decides regardless. Safe on Windows (no-op).
      hasShadow: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: true,
      title: opts.title || 'Concord Voice PiP',
      webPreferences: {
        preload: path.join(__dirname, '../preload/preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
      backgroundColor: '#000',
    });
    if (!pip) return;
    applyContentProtectionAtCreation(pip, contentProtectionEnabled, 'PiP window');
    // The remote SPA and its LKG cache are saas-only (C7): a self-hosted opener's
    // PiP loads the bundled renderer whatever the remote-SPA state says.
    const pipRemoteUrl = opener.serviceId === SAAS_SERVICE_ID ? remoteUrl : null;

    // Load PiP route (hash-based routing)
    if (!app.isPackaged) {
      pip.loadURL(`http://localhost:3001#/pip/${opts.id}`);
    } else if (pipRemoteUrl) {
      // Tier 3: PiP windows load from the remote SPA, including the
      // `/spa/<sha>/` path component. Origin-only would fall through to
      // nginx's catch-all and redirect to the marketing site (#802).
      pip.loadURL(buildRemotePipUrl(pipRemoteUrl, opts.id));
    } else if (
      opener.serviceId === SAAS_SERVICE_ID &&
      opener.webContents.getURL().startsWith(`${SPA_CACHE_SCHEME}://${SPA_CACHE_HOST}/`)
    ) {
      // #1870: the opener is serving from the signed last-known-good cache
      // (setRemoteSpaState(null) means remoteUrl is null, but the cache origin is
      // the active shell). Load the PiP child from the SAME cache origin so it
      // renders the cached shell, not the possibly-older bundled asset. The
      // will-navigate gate + spa-cache protocol handler permit and
      // integrity-verify it. Derived from the live main-window URL (stateless) so
      // it cannot drift from the actual effective mode.
      pip.loadURL(`${SPA_CACHE_SCHEME}://${SPA_CACHE_HOST}/index.html#/pip/${opts.id}`);
    } else {
      // #830: PiP bundled mode loads via app:// for consistent origin.
      pip.loadURL(`app://concord/index.html#/pip/${opts.id}`);
    }

    const sessionToken = mintPipSessionToken();
    const ownerRef = refOf(opener);
    pipWindows.set(opts.id, {
      window: pip,
      ownerRef,
      ownerFrameTreeNodeId: senderFrame.frameTreeNodeId,
      remoteSpaUrl: pipRemoteUrl,
      sessionToken,
    });

    pip.on('closed', () => {
      pipWindows.delete(opts.id);
      sendToConnection(ownerRef, 'pip:closed', { id: opts.id });
    });

    // #3104 D6 — deliberately a PUSH, symmetric with 'pip:closed' above. The
    // main renderer's signaling proxy must already know the capability when the
    // PiP's own renderer finishes booting and issues its first RPC; a pull would
    // race that boot. The PiP window gets its copy by pulling 'pip:session'.
    sendToConnection(ownerRef, 'pip:opened', { id: opts.id, token: sessionToken });
  },
  { refusal: () => undefined }
);

registerIpc(
  'pip:close',
  'pip-scoped',
  (sender, event, opts: { id: string }) => {
    resolveOwnedPip(sender, event, opts.id)?.entry.window.close();
  },
  { refusal: () => undefined }
);

registerIpc(
  'pip:setAlwaysOnTop',
  'pip-scoped',
  (sender, event, opts: { id: string; flag: boolean }) => {
    resolveOwnedPip(sender, event, opts.id)?.entry.window.setAlwaysOnTop(opts.flag);
  },
  { refusal: () => undefined }
);

/**
 * #3104 D6 — disclose one PiP's session capability to that PiP alone.
 *
 * This is the whole trust boundary for the renderer-side `concord-pip` RPC
 * channel: `BroadcastChannel` reaches every same-origin document, so the proxy
 * in the main renderer can only distinguish a real PiP by a secret the PiP
 * could not have obtained on its own. `resolvePipSender` proves the caller is
 * this window's main frame (same `webContents`, same `frameTreeNodeId` as its
 * `mainFrame`, and a permitted frame URL), which no other document can forge.
 *
 * The OPENER frame is refused even though it passes the ownership check used by
 * `pip:close`: it already received the token on the `pip:opened` push, so a
 * second disclosure path would widen the surface for nothing.
 *
 * Fails closed to `null` on every other input. The renderer treats `null` as
 * "this window gets no PiP voice", never as "proceed unauthenticated".
 *
 * The token is never logged — the private reply channel is NAMED from it, so
 * printing it is equivalent to publishing it.
 */
registerIpc(
  'pip:session',
  'pip-scoped',
  (sender, event, opts: unknown): { token: string } | null => {
    const id = (opts as { id?: unknown } | null | undefined)?.id;
    const resolved = resolveOwnedPip(sender, event, id);
    if (!resolved?.isPipMainFrame) return null;
    return { token: resolved.entry.sessionToken };
  },
  { refusal: () => null }
);

registerIpc(
  'spa:requestSelfHeal',
  'connection-bound',
  async (_sender, event, payload: unknown) => {
    // Thin adapter: unpack Electron's event-args, delegate to the pure-data
    // handler body. The handler itself does sender-frame validation,
    // payload validation, and dispatches to attemptSelfHeal. Extracted for
    // unit-testability per #753 reconciliation finding TA3.
    await handleSpaRequestSelfHeal({
      senderFrameUrl: event.senderFrame?.url ?? '',
      payload,
      remoteSpaBaseUrl: getRemoteSpaBaseUrl(),
      remoteSpaBaseDir: getRemoteSpaBaseDir(),
    });
  },
  { refusal: async () => undefined }
);

// Deep links are saas-only (#86 §3.7): registerIpc admits only the saas primary, so
// a self-hosted view can neither arm delivery nor drain the queue. A link that came
// in while no saas view was live waits in `pendingDeepLinks` for this signal.
function saasRendererReady(sender: ConnectionSender): boolean {
  const saasContents = saasDeliveryTarget();
  return saasContents !== null && sender.record.webContents === saasContents;
}

registerIpc(
  'invite:renderer-ready',
  'saas-only',
  (sender) => {
    if (!saasRendererReady(sender)) return;
    inviteRendererReady = true;
    drainPendingDeepLinks();
  },
  { method: 'on' }
);

// #945: the friend arm's own readiness signal. Deliberately separate from
// 'invite:renderer-ready' so an SPA that only knows the invite channel can never
// arm the friend one — see emitDeepLink above.
registerIpc(
  'deeplink:renderer-ready',
  'saas-only',
  (sender) => {
    if (!saasRendererReady(sender)) return;
    friendRendererReady = true;
    drainPendingDeepLinks();
  },
  { method: 'on' }
);

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();

if (gotTheLock) {
  handleInviteDeepLinksFromArgv(process.argv, 'argv');

  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleInviteDeepLink(url, 'open-url');
  });

  app.on('second-instance', (_event, argv: string[]) => {
    handleInviteDeepLinksFromArgv(argv, 'second-instance');
    // Someone tried to run a second instance, focus our window
    const win = shellWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
} else {
  app.quit();
}

// Security: validate navigation and window.open on EVERY web contents (#754, #86 §3.3).
// installNavigationGate resolves the contents' connection binding at each event:
// a bound view may navigate only to the targets of its connection kind (packaged:
// `app://concord` for every kind, the remote SPA origin and `spa-cache://concord`
// for `saas` only; dev: any localhost), an https: target goes to the OS browser,
// every in-app window.open is denied, and an unbound contents fails closed. The
// billing sheet's own Stripe-only gate stays first (billing/billingWindow.ts).
app.on('web-contents-created', (_, contents) => {
  installNavigationGate(contents, connectionSessionDeps);

  // SPA self-heal main-process detection (#753, ADR-0001) — runs outside
  // the renderer bundle, so it survives renderer-side corruption that
  // would silence the renderer-side listener in spaSelfHealClient.ts.
  // Thin adapter delegating to handleDidFailLoad (extracted for unit
  // testability per #753 reconciliation finding TA3).
  contents.on(
    'did-fail-load',
    (_event, errorCode, _errorDescription, validatedURL, isMainFrame) => {
      void handleDidFailLoad({
        errorCode,
        validatedURL,
        isMainFrame,
        remoteSpaBaseUrl: getRemoteSpaBaseUrl(),
        remoteSpaBaseDir: getRemoteSpaBaseDir(),
      });
      if (isMainFrame && validatedURL === 'app://concord/index.html' && errorCode !== -3) {
        revealLoadFailure(shellWindow(), 'Could not load application — please reinstall');
      }
    }
  );
});
