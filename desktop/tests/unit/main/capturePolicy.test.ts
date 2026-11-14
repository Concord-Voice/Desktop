// @vitest-environment node
//
// capturePolicy — the #87 arbiter over `media` / `display-capture` (spec §3.5, plan
// Task 4). The lease module is mocked: its own decisions (who holds, whether a legacy
// implicit lease is free) are captureLease.test.ts's concern. What this file proves is
// the ORDER of the arbiter's checks: role, main frame and currency come before any
// lease question, so `legacyAcquire` (whose contract is "the caller proved a primary
// main frame") is never reached by a PiP, a subframe, an unbound or a stale document.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const mk = (name: string) => ({
    name,
    protocol: { handle: vi.fn() },
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
    setDisplayMediaRequestHandler: vi.fn(),
    webRequest: { onBeforeSendHeaders: vi.fn() },
    on: vi.fn(),
    fetch: vi.fn(),
  });
  return {
    mk,
    defaultSession: mk('default'),
    isHolder: vi.fn<(ref: unknown) => boolean>(() => false),
    legacyAcquire: vi.fn<(ref: unknown) => boolean>(() => false),
    recordFor: vi.fn<(id: string) => unknown>(),
  };
});

vi.mock('electron', () => ({
  app: { getVersion: () => '1.2.3', isPackaged: true },
  net: { fetch: vi.fn() },
  shell: { openExternal: vi.fn(() => Promise.resolve()) },
  session: { defaultSession: h.defaultSession, fromPath: vi.fn() },
}));
vi.mock('../../../src/main/billing/billingWindow', () => ({ isBillingWebContents: () => false }));
vi.mock('../../../src/main/captureLease', () => ({
  isHolder: h.isHolder,
  legacyAcquire: h.legacyAcquire,
}));
vi.mock('../../../src/main/connectionRegistry', () => ({ recordFor: h.recordFor }));

import {
  CAPTURE_CHECK_POLICY,
  CAPTURE_PERMISSIONS,
  captureLeaseArbiter,
  installCaptureLeaseArbiter,
  type CaptureCheckPolicy,
} from '../../../src/main/capturePolicy';
import {
  _resetConnectionSessionForTesting,
  captureArbiter,
  configureConnectionSession,
  defaultCaptureArbiter,
  type ArbiterContext,
  type CaptureArbiter,
  type ConnectionSessionDeps,
} from '../../../src/main/connectionSession';
import type { ConnectionRef } from '../../../src/shared/connectionIdentity';

const LIVE_GENERATION = 2;
const ref = (generation = LIVE_GENERATION): ConnectionRef =>
  Object.freeze({ connectionId: 'c1', generation }) as ConnectionRef;

interface Row {
  name: string;
  ref: ConnectionRef | null;
  role: ArbiterContext['role'];
  isMainFrame: boolean;
  holder: boolean;
  legacy: boolean;
  // expected: [request, check] per policy
  bound: [boolean, boolean];
  holderPolicy: [boolean, boolean];
}

// `holder: true` on pip / subframe / stale (and `legacy: true` on stale) is deliberate:
// a mock that would grant proves the arbiter refused before asking it.
const ROWS: Row[] = [
  {
    name: 'holder',
    ref: ref(),
    role: 'primary',
    isMainFrame: true,
    holder: true,
    legacy: false,
    bound: [true, true],
    holderPolicy: [true, true],
  },
  {
    name: 'non-holder',
    ref: ref(),
    role: 'primary',
    isMainFrame: true,
    holder: false,
    legacy: false,
    bound: [false, true],
    holderPolicy: [false, false],
  },
  {
    name: 'unbound',
    ref: null,
    role: null,
    isMainFrame: true,
    holder: true,
    legacy: true,
    bound: [false, false],
    holderPolicy: [false, false],
  },
  {
    name: 'pip',
    ref: ref(),
    role: 'pip',
    isMainFrame: true,
    holder: true,
    legacy: true,
    bound: [false, false],
    holderPolicy: [false, false],
  },
  {
    name: 'subframe',
    ref: ref(),
    role: 'primary',
    isMainFrame: false,
    holder: true,
    legacy: true,
    bound: [false, false],
    holderPolicy: [false, false],
  },
  {
    name: 'stale',
    ref: ref(LIVE_GENERATION - 1),
    role: 'primary',
    isMainFrame: true,
    holder: true,
    legacy: true,
    bound: [false, false],
    holderPolicy: [false, false],
  },
  {
    name: 'legacy-free-foreground',
    ref: ref(),
    role: 'primary',
    isMainFrame: true,
    holder: false,
    legacy: true,
    bound: [true, true],
    holderPolicy: [false, false],
  },
  {
    name: 'legacy-free-background',
    ref: ref(),
    role: 'primary',
    isMainFrame: true,
    holder: false,
    legacy: false,
    bound: [false, true],
    holderPolicy: [false, false],
  },
  {
    name: 'legacy-during-handoff',
    ref: ref(),
    role: 'primary',
    isMainFrame: true,
    holder: false,
    legacy: false,
    bound: [false, true],
    holderPolicy: [false, false],
  },
];

const POLICIES: CaptureCheckPolicy[] = ['bound-primary-main-frame', 'holder'];
const PHASES = ['request', 'check'] as const;

const CASES = POLICIES.flatMap((policy) =>
  ROWS.flatMap((row) =>
    CAPTURE_PERMISSIONS.flatMap((permission) =>
      PHASES.map((phase, i) => ({
        policy,
        row,
        permission,
        phase,
        expected: (policy === 'holder' ? row.holderPolicy : row.bound)[i],
      }))
    )
  )
);

beforeEach(() => {
  vi.clearAllMocks();
  _resetConnectionSessionForTesting();
  h.isHolder.mockReturnValue(false);
  h.legacyAcquire.mockReturnValue(false);
  h.recordFor.mockImplementation((id: string) => ({
    connectionId: id,
    generation: LIVE_GENERATION,
    state: 'live',
  }));
});

describe('CAPTURE_CHECK_POLICY', () => {
  it('is the Task 0 decision (results/macos-arm64.md)', () => {
    expect(CAPTURE_CHECK_POLICY).toBe('bound-primary-main-frame');
    expect(CAPTURE_PERMISSIONS).toEqual(['media', 'display-capture']);
  });
});

describe('captureLeaseArbiter table', () => {
  it.each(CASES)(
    '$policy · $row.name · $permission · $phase → $expected',
    ({ policy, row, permission, phase, expected }) => {
      h.isHolder.mockReturnValue(row.holder);
      h.legacyAcquire.mockReturnValue(row.legacy);
      const fallback: CaptureArbiter = { decide: vi.fn(() => true) };
      const arbiter = captureLeaseArbiter(fallback, policy);
      const ctx: ArbiterContext = { phase, role: row.role, isMainFrame: row.isMainFrame };
      expect(arbiter.decide(row.ref, permission, {}, ctx)).toBe(expected);
      // Capture permissions never reach the fallback (it would grant).
      expect(fallback.decide).not.toHaveBeenCalled();
    }
  );

  it('never asks legacyAcquire before proving a current primary main frame', () => {
    h.isHolder.mockReturnValue(false);
    h.legacyAcquire.mockReturnValue(true);
    const arbiter = captureLeaseArbiter(defaultCaptureArbiter, 'bound-primary-main-frame');
    for (const row of ROWS.filter((r) =>
      ['unbound', 'pip', 'subframe', 'stale'].includes(r.name)
    )) {
      const ctx: ArbiterContext = {
        phase: 'request',
        role: row.role,
        isMainFrame: row.isMainFrame,
      };
      expect(arbiter.decide(row.ref, 'media', {}, ctx)).toBe(false);
    }
    expect(h.legacyAcquire).not.toHaveBeenCalled();
  });

  it('a check never takes a legacy lease', () => {
    h.legacyAcquire.mockReturnValue(true);
    for (const policy of POLICIES) {
      const arbiter = captureLeaseArbiter(defaultCaptureArbiter, policy);
      arbiter.decide(ref(), 'media', {}, { phase: 'check', role: 'primary', isMainFrame: true });
    }
    expect(h.legacyAcquire).not.toHaveBeenCalled();
  });

  it('the legacy lease is never asked for under the holder policy', () => {
    h.legacyAcquire.mockReturnValue(true);
    const arbiter = captureLeaseArbiter(defaultCaptureArbiter, 'holder');
    expect(
      arbiter.decide(ref(), 'media', {}, { phase: 'request', role: 'primary', isMainFrame: true })
    ).toBe(false);
    expect(h.legacyAcquire).not.toHaveBeenCalled();
  });

  it('a capture permission with no context fails closed', () => {
    h.isHolder.mockReturnValue(true);
    const arbiter = captureLeaseArbiter(defaultCaptureArbiter);
    expect(arbiter.decide(ref(), 'media', {})).toBe(false);
    expect(arbiter.decide(ref(), 'display-capture', {})).toBe(false);
  });

  it('a disposed record is stale', () => {
    h.isHolder.mockReturnValue(true);
    h.recordFor.mockReturnValue({
      connectionId: 'c1',
      generation: LIVE_GENERATION,
      state: 'disposed',
    });
    const arbiter = captureLeaseArbiter(defaultCaptureArbiter);
    const ctx: ArbiterContext = { phase: 'request', role: 'primary', isMainFrame: true };
    expect(arbiter.decide(ref(), 'media', {}, ctx)).toBe(false);
  });

  it('other permissions go to the fallback with every argument', () => {
    const arbiter = captureLeaseArbiter(defaultCaptureArbiter);
    const ctx: ArbiterContext = { phase: 'request', role: 'primary', isMainFrame: true };
    expect(arbiter.decide(ref(), 'geolocation', {}, ctx)).toBe(false);
    expect(arbiter.decide(ref(), 'notifications', {}, ctx)).toBe(true);
    const spy: CaptureArbiter = { decide: vi.fn(() => true) };
    const details = { isMainFrame: true };
    captureLeaseArbiter(spy).decide(ref(), 'notifications', details, ctx);
    expect(spy.decide).toHaveBeenCalledWith(ref(), 'notifications', details, ctx);
  });
});

describe('installCaptureLeaseArbiter', () => {
  it('installs the lease arbiter over the default and restores it', () => {
    const uninstall = installCaptureLeaseArbiter();
    expect(captureArbiter()).not.toBe(defaultCaptureArbiter);
    uninstall();
    expect(captureArbiter()).toBe(defaultCaptureArbiter);
  });

  it('gates the real request handler end to end and installs no display-media handler', () => {
    const ses = h.mk('e2e');
    const wc = { id: 1 } as never;
    const deps: ConnectionSessionDeps = {
      isPackaged: true,
      bundleRoot: '/bundle',
      getLiveDir: () => null,
      remoteSpaOrigin: () => null,
      bindingFor: (c) =>
        c === wc ? ({ connectionId: 'c1', role: 'primary' } as never) : undefined,
      recordFor: (id) =>
        ({ connectionId: id, generation: LIVE_GENERATION, state: 'live' }) as never,
      getService: () => undefined,
      foreground: () => null,
    };
    configureConnectionSession(
      ses as never,
      {
        kind: 'selfhost',
        origin: 'https://a.example',
        custody: { getCachedAccessToken: () => null },
      } as never,
      deps
    );
    installCaptureLeaseArbiter();
    const request = ses.setPermissionRequestHandler.mock.calls[0][0];
    const answer = (permission: string, details: object) => {
      const cb = vi.fn();
      request(wc, permission, cb, details);
      return cb.mock.calls[0][0] as boolean;
    };
    expect(answer('media', { isMainFrame: true })).toBe(false);
    h.isHolder.mockReturnValue(true);
    expect(answer('media', { isMainFrame: true })).toBe(true);
    expect(answer('display-capture', { isMainFrame: true })).toBe(true);
    expect(answer('media', { isMainFrame: false })).toBe(false);
    expect(ses.setDisplayMediaRequestHandler).not.toHaveBeenCalled();
    expect(h.defaultSession.setDisplayMediaRequestHandler).not.toHaveBeenCalled();
  });
});
