import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the recovery primitive — Phase 5's tests cover its internals.
vi.mock('@/main/spaSelfHeal', () => ({
  attemptSelfHeal: vi.fn().mockResolvedValue({ mode: 'recovered', retryCount: 1 }),
  __resetSelfHealState: vi.fn(),
}));

import { attemptSelfHeal } from '@/main/spaSelfHeal';
import {
  handleDidFailLoad,
  handleSpaRequestSelfHeal,
  shouldTriggerSelfHealForFailedLoad,
  validateSelfHealSenderFrame,
} from '@/main/spaSelfHealMainFrame';

const mockAttempt = attemptSelfHeal as unknown as ReturnType<typeof vi.fn>;

describe('shouldTriggerSelfHealForFailedLoad — did-fail-load filter', () => {
  beforeEach(() => vi.clearAllMocks());

  it('triggers on isMainFrame=true when validatedURL origin matches remoteSpaBaseUrl', () => {
    // remoteSpaBaseUrl in main.ts:117 stores the ORIGIN only (set via
    // new URL(decision.url).origin at line 162). Filter compares origins.
    const result = shouldTriggerSelfHealForFailedLoad({
      errorCode: -105,
      validatedURL: 'https://api.concordvoice.chat/spa/abc1234/index.html',
      isMainFrame: true,
      remoteSpaBaseUrl: 'https://api.concordvoice.chat',
    });
    expect(result).toBe(true);
  });

  it('triggers on isMainFrame=false when validatedURL matches SPA chunk pattern', () => {
    const result = shouldTriggerSelfHealForFailedLoad({
      errorCode: 404,
      validatedURL: 'https://api.concordvoice.chat/spa/abc1234/assets/Settings-Xyz.js',
      isMainFrame: false,
      remoteSpaBaseUrl: 'https://api.concordvoice.chat',
    });
    expect(result).toBe(true);
  });

  it('does NOT trigger on errorCode=-3 (ABORTED) — user-cancelled nav', () => {
    const result = shouldTriggerSelfHealForFailedLoad({
      errorCode: -3,
      validatedURL: 'https://api.concordvoice.chat/spa/abc1234/index.html',
      isMainFrame: true,
      remoteSpaBaseUrl: 'https://api.concordvoice.chat',
    });
    expect(result).toBe(false);
  });

  it('does NOT trigger when remoteSpaBaseUrl is null (bundled mode)', () => {
    const result = shouldTriggerSelfHealForFailedLoad({
      errorCode: -105,
      validatedURL: 'https://api.concordvoice.chat/spa/abc1234/index.html',
      isMainFrame: true,
      remoteSpaBaseUrl: null,
    });
    expect(result).toBe(false);
  });

  it('does NOT trigger on isMainFrame=true with cross-origin validatedURL', () => {
    const result = shouldTriggerSelfHealForFailedLoad({
      errorCode: -105,
      validatedURL: 'https://evil.example.com/spa/abc1234/index.html',
      isMainFrame: true,
      remoteSpaBaseUrl: 'https://api.concordvoice.chat',
    });
    expect(result).toBe(false);
  });

  it('does NOT trigger on isMainFrame=false with cross-origin chunk URL (Copilot review on PR #773)', () => {
    // SPA_CHUNK_URL_PATTERN is host-agnostic (it matches `/spa/<sha>/...`
    // regardless of host), so without the origin check a failed
    // cross-origin load like
    // `https://evil.example.com/spa/abc1234/assets/x.js` would falsely
    // consume self-heal budget. This mirrors the main-frame origin check
    // — both branches must reject cross-origin URLs even when the path
    // shape matches the SPA pattern.
    const result = shouldTriggerSelfHealForFailedLoad({
      errorCode: 404,
      validatedURL: 'https://evil.example.com/spa/abc1234/assets/Settings-Xyz.js',
      isMainFrame: false,
      remoteSpaBaseUrl: 'https://api.concordvoice.chat',
    });
    expect(result).toBe(false);
  });

  it('does NOT trigger on non-SPA sub-resource URL', () => {
    const result = shouldTriggerSelfHealForFailedLoad({
      errorCode: 404,
      validatedURL: 'https://api.concordvoice.chat/api/v1/messages',
      isMainFrame: false,
      remoteSpaBaseUrl: 'https://api.concordvoice.chat',
    });
    expect(result).toBe(false);
  });

  it('does NOT trigger when validatedURL is malformed', () => {
    const result = shouldTriggerSelfHealForFailedLoad({
      errorCode: -105,
      validatedURL: 'not-a-url',
      isMainFrame: true,
      remoteSpaBaseUrl: 'https://api.concordvoice.chat',
    });
    expect(result).toBe(false);
  });

  it('does NOT trigger on isMainFrame=true with same-origin but non-SPA pathname', () => {
    // Same-origin frames whose pathname is not SPA-shaped (e.g., the apex
    // `/`) must not consume the self-heal retry budget. Origin-only matching
    // would incorrectly accept these; the SPA path-shape filter rejects.
    // Originally this defended against PiP windows loading
    // `${remoteSpaBaseUrl}#/pip/...` (apex pathname). Post-#802 PiP loads
    // from the full SPA URL via remoteSpaUrl, but the filter still correctly
    // rejects any apex-pathname same-origin frame did-fail-load surfaces.
    // (Copilot review on PR #773.)
    const result = shouldTriggerSelfHealForFailedLoad({
      errorCode: -105,
      validatedURL: 'https://api.concordvoice.chat/',
      isMainFrame: true,
      remoteSpaBaseUrl: 'https://api.concordvoice.chat',
    });
    expect(result).toBe(false);
  });

  it('does NOT trigger on isMainFrame=true with same-origin hash-route URL', () => {
    // Hash routes are same-origin but not SPA-pathname-shaped. Origin-only
    // matching would have accepted these.
    const result = shouldTriggerSelfHealForFailedLoad({
      errorCode: -105,
      validatedURL: 'https://api.concordvoice.chat/#/pip/abc',
      isMainFrame: true,
      remoteSpaBaseUrl: 'https://api.concordvoice.chat',
    });
    expect(result).toBe(false);
  });

  it('does NOT trigger on isMainFrame=true with same-origin /api/* path', () => {
    // /api/v1/* is same-origin (the API and SPA share api.concordvoice.chat)
    // but is not SPA-shaped. A hypothetical did-fail-load on an /api URL
    // should not trigger self-heal.
    const result = shouldTriggerSelfHealForFailedLoad({
      errorCode: 404,
      validatedURL: 'https://api.concordvoice.chat/api/v1/something',
      isMainFrame: true,
      remoteSpaBaseUrl: 'https://api.concordvoice.chat',
    });
    expect(result).toBe(false);
  });
});

describe('validateSelfHealSenderFrame — IPC origin guard', () => {
  // remoteSpaBaseUrl in main.ts:117 is set to new URL(decision.url).origin —
  // it's the ORIGIN string, not the full URL. The validator parses senderFrameUrl
  // and compares its origin against the (already-origin) remoteSpaBaseUrl directly.
  it('accepts sender from the current SPA origin (full URL → origin)', () => {
    const ok = validateSelfHealSenderFrame({
      senderFrameUrl: 'https://api.concordvoice.chat/spa/abc1234/index.html',
      remoteSpaBaseUrl: 'https://api.concordvoice.chat',
    });
    expect(ok).toBe(true);
  });

  it('accepts sender from the same origin with a chunk-asset path', () => {
    const ok = validateSelfHealSenderFrame({
      senderFrameUrl: 'https://api.concordvoice.chat/spa/abc1234/assets/Settings.js',
      remoteSpaBaseUrl: 'https://api.concordvoice.chat',
    });
    expect(ok).toBe(true);
  });

  it('rejects sender from a different origin', () => {
    const ok = validateSelfHealSenderFrame({
      senderFrameUrl: 'https://evil.example.com/abc',
      remoteSpaBaseUrl: 'https://api.concordvoice.chat',
    });
    expect(ok).toBe(false);
  });

  it('rejects when remoteSpaBaseUrl is null (no SPA mode active)', () => {
    const ok = validateSelfHealSenderFrame({
      senderFrameUrl: 'https://api.concordvoice.chat/spa/abc1234/index.html',
      remoteSpaBaseUrl: null,
    });
    expect(ok).toBe(false);
  });

  it('rejects when senderFrameUrl is empty', () => {
    const ok = validateSelfHealSenderFrame({
      senderFrameUrl: '',
      remoteSpaBaseUrl: 'https://api.concordvoice.chat',
    });
    expect(ok).toBe(false);
  });

  it('rejects when senderFrameUrl is malformed', () => {
    const ok = validateSelfHealSenderFrame({
      senderFrameUrl: 'not-a-url',
      remoteSpaBaseUrl: 'https://api.concordvoice.chat',
    });
    expect(ok).toBe(false);
  });

  it('rejects sender on same origin but non-SPA pathname', () => {
    // Same-origin senders whose pathname is not SPA-shaped (e.g., the apex
    // `/`) must not be accepted as legitimate self-heal IPC triggers. The
    // SPA path-shape filter prevents any non-SPA same-origin code from
    // spoofing. Originally this defended against PiP windows loading
    // `${remoteSpaBaseUrl}#/pip/...` (apex pathname). Post-#802 PiP loads
    // from the full SPA URL via remoteSpaUrl, but the filter still correctly
    // rejects any apex-pathname same-origin frame.
    // (Copilot review on PR #773.)
    const ok = validateSelfHealSenderFrame({
      senderFrameUrl: 'https://api.concordvoice.chat/',
      remoteSpaBaseUrl: 'https://api.concordvoice.chat',
    });
    expect(ok).toBe(false);
  });

  it('rejects sender on same origin hash-route URL', () => {
    const ok = validateSelfHealSenderFrame({
      senderFrameUrl: 'https://api.concordvoice.chat/#/pip/xyz',
      remoteSpaBaseUrl: 'https://api.concordvoice.chat',
    });
    expect(ok).toBe(false);
  });

  it('rejects sender on same origin /api/* path', () => {
    const ok = validateSelfHealSenderFrame({
      senderFrameUrl: 'https://api.concordvoice.chat/api/v1/messages',
      remoteSpaBaseUrl: 'https://api.concordvoice.chat',
    });
    expect(ok).toBe(false);
  });
});

describe('handleSpaRequestSelfHeal — extracted IPC handler body', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects when sender frame fails origin/path validation, does not call attemptSelfHeal', async () => {
    const result = await handleSpaRequestSelfHeal({
      senderFrameUrl: 'https://evil.example.com/spa/abc1234/index.html',
      payload: { reason: 'chunk-load' },
      remoteSpaBaseUrl: 'https://api.concordvoice.chat',
    });
    expect(result).toBeNull();
    expect(mockAttempt).not.toHaveBeenCalled();
  });

  it('rejects when payload is not a valid renderer request, does not call attemptSelfHeal', async () => {
    // Sender frame OK, but payload has a main-process-only reason (trust-boundary breach attempt).
    const result = await handleSpaRequestSelfHeal({
      senderFrameUrl: 'https://api.concordvoice.chat/spa/abc1234/index.html',
      payload: { reason: 'main-frame-load' },
      remoteSpaBaseUrl: 'https://api.concordvoice.chat',
    });
    expect(result).toBeNull();
    expect(mockAttempt).not.toHaveBeenCalled();
  });

  it('rejects when payload is not an object', async () => {
    const result = await handleSpaRequestSelfHeal({
      senderFrameUrl: 'https://api.concordvoice.chat/spa/abc1234/index.html',
      payload: 'not-an-object',
      remoteSpaBaseUrl: 'https://api.concordvoice.chat',
    });
    expect(result).toBeNull();
    expect(mockAttempt).not.toHaveBeenCalled();
  });

  it('dispatches to attemptSelfHeal on valid request, returns the outcome', async () => {
    const result = await handleSpaRequestSelfHeal({
      senderFrameUrl: 'https://api.concordvoice.chat/spa/abc1234/index.html',
      payload: {
        reason: 'chunk-load',
        url: 'https://api.concordvoice.chat/spa/abc1234/assets/x.js',
      },
      remoteSpaBaseUrl: 'https://api.concordvoice.chat',
    });

    expect(mockAttempt).toHaveBeenCalledOnce();
    expect(mockAttempt).toHaveBeenCalledWith({
      reason: 'chunk-load',
      url: 'https://api.concordvoice.chat/spa/abc1234/assets/x.js',
    });
    expect(result).toEqual({ mode: 'recovered', retryCount: 1 });
  });

  it('dispatches with chunk-import-rejected reason and undefined url', async () => {
    await handleSpaRequestSelfHeal({
      senderFrameUrl: 'https://api.concordvoice.chat/spa/abc1234/index.html',
      payload: { reason: 'chunk-import-rejected' },
      remoteSpaBaseUrl: 'https://api.concordvoice.chat',
    });

    expect(mockAttempt).toHaveBeenCalledWith({ reason: 'chunk-import-rejected', url: undefined });
  });
});

describe('handleDidFailLoad — extracted listener body', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not dispatch when filter rejects (errorCode -3 ABORTED)', async () => {
    const result = await handleDidFailLoad({
      errorCode: -3,
      validatedURL: 'https://api.concordvoice.chat/spa/abc1234/index.html',
      isMainFrame: true,
      remoteSpaBaseUrl: 'https://api.concordvoice.chat',
    });
    expect(result).toBeNull();
    expect(mockAttempt).not.toHaveBeenCalled();
  });

  it('does not dispatch when filter rejects (no remoteSpaBaseUrl)', async () => {
    const result = await handleDidFailLoad({
      errorCode: -105,
      validatedURL: 'https://api.concordvoice.chat/spa/abc1234/index.html',
      isMainFrame: true,
      remoteSpaBaseUrl: null,
    });
    expect(result).toBeNull();
    expect(mockAttempt).not.toHaveBeenCalled();
  });

  it('dispatches main-frame-load on isMainFrame=true with SPA URL', async () => {
    await handleDidFailLoad({
      errorCode: -105,
      validatedURL: 'https://api.concordvoice.chat/spa/abc1234/index.html',
      isMainFrame: true,
      remoteSpaBaseUrl: 'https://api.concordvoice.chat',
    });

    expect(mockAttempt).toHaveBeenCalledOnce();
    expect(mockAttempt).toHaveBeenCalledWith({
      reason: 'main-frame-load',
      url: 'https://api.concordvoice.chat/spa/abc1234/index.html',
      errorCode: -105,
    });
  });

  it('dispatches sub-resource on isMainFrame=false with chunk URL', async () => {
    await handleDidFailLoad({
      errorCode: 404,
      validatedURL: 'https://api.concordvoice.chat/spa/abc1234/assets/Settings-x.js',
      isMainFrame: false,
      remoteSpaBaseUrl: 'https://api.concordvoice.chat',
    });

    expect(mockAttempt).toHaveBeenCalledWith({
      reason: 'sub-resource',
      url: 'https://api.concordvoice.chat/spa/abc1234/assets/Settings-x.js',
      errorCode: 404,
    });
  });

  it('returns the recovery outcome on dispatch', async () => {
    const result = await handleDidFailLoad({
      errorCode: -105,
      validatedURL: 'https://api.concordvoice.chat/spa/abc1234/index.html',
      isMainFrame: true,
      remoteSpaBaseUrl: 'https://api.concordvoice.chat',
    });
    expect(result).toEqual({ mode: 'recovered', retryCount: 1 });
  });
});
