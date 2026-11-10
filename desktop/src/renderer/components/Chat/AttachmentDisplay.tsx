import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Download,
  FileText,
  Film,
  Music,
  File,
  ImageOff,
  Loader2,
  Maximize2,
  Pause,
} from 'lucide-react';
import { apiFetch } from '../../services/system/apiClient';
import { e2eeService } from '../../services/e2ee/e2eeService';
import {
  parseKeyVersionHeader,
  AttachmentKeyEpochError,
  decryptAttachmentStream,
  UnsupportedAttachmentFormatError,
  AttachmentIntegrityError,
  expectedBlobLength,
  ENVELOPE_VERSION_V3,
} from '../../utils/crypto/attachmentChunkedCrypto';
import { formatFileSize } from '../../utils/crypto/attachmentCrypto';
import {
  AttachmentTooLargeError,
  parseContentLength,
  tooLargeMessage,
} from '../../utils/runtime/boundedResponseBody';
import {
  IMAGE_STRIP_MAX_BYTES,
  MAX_DECRYPTABLE_ATTACHMENT_BYTES,
} from '../../utils/policy/entitlementLimits';
import type { AttachmentSummary } from '../../types/chat';
import { useSettingsStore } from '../../stores/ui/settingsStore';
import { usePrivacyStore } from '../../stores/ui/privacyStore';
import { useWindowFocus } from '../../hooks/ui/useWindowFocus';
import { resolveGifPlayback } from '../../utils/ui/gifPlayback';
import { detectAnimatedImage, ANIMATION_SNIFF_BYTES } from '../../utils/ui/animatedImage';
import OverflowMarkdownAttachment from './OverflowMarkdownAttachment';
import ThemedMediaPlayer from './ThemedMediaPlayer';
import ImageLightbox from './ImageLightbox';
import ContextMenu from '../ui/ContextMenu';
import './GifEmbed.css';
import './AttachmentDisplay.css';

interface AttachmentDisplayProps {
  readonly attachments: AttachmentSummary[];
  readonly channelId: string;
  /** Already-decrypted message body — used as preview for text/markdown attachments. */
  readonly messageBody?: string;
}

interface AttachmentItemProps {
  readonly attachment: AttachmentSummary;
  readonly channelId: string;
}

// LRU cache for decrypted blob URLs — evicts oldest entries to bound memory.
/** Secondary entry-count cap: keeps a channel full of thumbnails from growing
 *  the Map without limit even when the byte budget is nowhere near. */
const BLOB_CACHE_MAX = 50;

/** 256 MiB — total decrypted bytes held live across the whole cache (#2157 A1).
 *  The entry cap alone made retained memory scale with the download guard
 *  (50 x 256 MiB = ~12.8 GB), because up to BLOB_CACHE_MAX decrypted blobs are
 *  alive simultaneously — the dominant memory term, not the per-file transient. */
const BLOB_CACHE_MAX_BYTES = 268_435_456;

/** Largest decrypted blob worth RETAINING, as HALF the budget.
 *
 *  A single entry at or near the whole budget is pathological: admitting it
 *  drains every other entry on the way in and then occupies all of it, so one
 *  large attachment empties the cache for everything else on screen. Capping
 *  admission at half guarantees two entries can always coexist, so no single
 *  admission can ever drain the cache. Anything larger is shown but never
 *  cached -- one re-fetch if the reader scrolls back, against evicting
 *  everything else exactly once.
 *
 *  Chunked uploads make this reachable: before them the upload ceiling held
 *  attachments to 128 MiB, and files up to 1 GiB are now normal uploads.
 *
 *  A QUARTER was tried first and rejected on evidence. At 64 MiB the existing
 *  100 MiB eviction fixtures stopped being cached at all, which broke one test
 *  and — worse — made several neighbours pass VACUOUSLY: "never revokes a url
 *  while a surface is rendering it" holds trivially when nothing was cached.
 *  A threshold that converts working tests into vacuous ones is too aggressive
 *  for this budget, not a reason to rewrite the tests. */
export const BLOB_CACHE_RETAIN_MAX_BYTES = Math.floor(BLOB_CACHE_MAX_BYTES / 2);

interface CachedBlob {
  readonly url: string;
  readonly bytes: number;
  /** Whether the BYTES animate; `null` when they could not say. See
   *  `utils/ui/animatedImage`. Cached with the url so a second surface
   *  showing the same file inherits the answer rather than re-deciding. */
  readonly animated: boolean | null;
}

/** What a completed load hands back. The animation flag cannot be derived from
 *  `file_type`, so it travels with the url instead of being looked up later. */
interface LoadedAttachment {
  readonly url: string;
  readonly animated: boolean | null;
  readonly bytes: number;
}

const blobUrlCache = new Map<string, CachedBlob>();
// Oversized blobs cannot join the retained LRU, but overlapping surfaces of
// the same file must still share one URL until the final surface releases it.
const uncachedLiveBlobs = new Map<string, CachedBlob>();
let cachedBytes = 0;

/**
 * File ids currently rendered by at least one active surface, with a count.
 *
 * Deliberately NOT a refcount stored on the cache entry. A handoff scheme —
 * loader retains, component releases — leaks a permanent reference whenever a
 * surface unmounts while its load is still in flight, because the release never
 * runs. Keying on "is anything mounted showing this?" is derived state owned
 * entirely by the effect below, so an abandoned load simply never registers.
 */
const liveSurfaces = new Map<string, number>();

// Intersection callbacks update this synchronously, before React flushes an
// effect for the URL. It also covers a visible surface whose load is in flight.
const viewportSurfaces = new Map<string, number>();

function setViewportSurface(fileId: string, entering: boolean): void {
  const next = (viewportSurfaces.get(fileId) ?? 0) + (entering ? 1 : -1);
  if (next > 0) viewportSurfaces.set(fileId, next);
  else viewportSurfaces.delete(fileId);
}

function revokeUnshownUrl(fileId: string, url: string): void {
  if (blobUrlCache.get(fileId)?.url === url) return;
  if (liveSurfaces.has(fileId) || viewportSurfaces.has(fileId)) return;
  if (uncachedLiveBlobs.get(fileId)?.url === url) uncachedLiveBlobs.delete(fileId);
  URL.revokeObjectURL(url);
}

function releaseOffscreenBlob(fileId: string, url: string): void {
  if (liveSurfaces.has(fileId) || viewportSurfaces.has(fileId)) return;
  const cached = blobUrlCache.get(fileId);
  if (cached?.url === url) {
    blobUrlCache.delete(fileId);
    cachedBytes -= cached.bytes;
  }
  if (uncachedLiveBlobs.get(fileId)?.url === url) uncachedLiveBlobs.delete(fileId);
  URL.revokeObjectURL(url);
}

/**
 * Hold this file id for as long as a surface renders its url, so eviction
 * cannot revoke a blob out from under a mounted `<img>` (#2157 review,
 * VULN-002-C). A revoked url on screen is a silently broken image, and
 * `handleSaveImage`'s fetch of it fails into a swallowed catch.
 *
 * Known narrow window: a surface is protected from the moment its effect runs,
 * not from the moment its bytes are admitted. Several loads resolving inside a
 * single tick, before React flushes any effect, can still evict one another.
 * The realistic case — images already on screen when another arrives — is
 * covered, and the residual is a broken image rather than anything unsafe.
 */
function useRetainedBlobUrl(
  fileId: string,
  url: string | null,
  active = true,
  releaseOnExitRef?: { current: boolean }
): void {
  useEffect(() => {
    if (!url || !active) return;
    liveSurfaces.set(fileId, (liveSurfaces.get(fileId) ?? 0) + 1);
    return () => {
      const remaining = (liveSurfaces.get(fileId) ?? 1) - 1;
      if (remaining > 0) {
        liveSurfaces.set(fileId, remaining);
        return;
      }
      liveSurfaces.delete(fileId);
      // Nothing in the cache means nothing will ever evict it, and eviction is
      // the only other revoker. An entry above BLOB_CACHE_RETAIN_MAX_BYTES is
      // deliberately never cached, so the last surface to let go owns the
      // revoke -- otherwise declining to cache would trade an eviction storm
      // for a permanent leak.
      // The observer changes this flag when the surface exits; the latest
      // value, not the value at effect setup, decides whether to evict.
      // eslint-disable-next-line @eslint-react/exhaustive-deps -- Read the observer's latest exit state during cleanup.
      if (releaseOnExitRef?.current) releaseOffscreenBlob(fileId, url);
      else revokeUnshownUrl(fileId, url);
    };
  }, [fileId, url, active, releaseOnExitRef]);
}

/**
 * Drops the least-recently-used entry that no mounted surface is showing.
 *
 * Returns false when every candidate is on screen — which terminates the
 * eviction loop and is the correct answer: the budget bounds cache RETENTION,
 * not what the user is currently looking at, so it is exceeded rather than
 * breaking a live image.
 */
function evictOldestBlob(): boolean {
  for (const [fileId, entry] of blobUrlCache) {
    if (liveSurfaces.has(fileId) || viewportSurfaces.has(fileId)) continue;
    URL.revokeObjectURL(entry.url);
    cachedBytes -= entry.bytes;
    blobUrlCache.delete(fileId);
    return true;
  }
  return false;
}

/**
 * Drop every cached blob and all derived accounting.
 *
 * Exported for tests ONLY. `blobUrlCache`, `cachedBytes`, `liveSurfaces` and
 * `inFlightLoads` are module scope, and Vitest isolates modules per FILE rather
 * than per test — so without this, every test in a file shares one cache and
 * the byte-budget assertions silently depend on what earlier tests left behind.
 * Production code must never call it: revoking urls a surface still renders is
 * exactly what `liveSurfaces` exists to prevent.
 */
export function __resetBlobCacheForTests(): void {
  for (const entry of blobUrlCache.values()) URL.revokeObjectURL(entry.url);
  blobUrlCache.clear();
  for (const entry of uncachedLiveBlobs.values()) URL.revokeObjectURL(entry.url);
  uncachedLiveBlobs.clear();
  liveSurfaces.clear();
  viewportSurfaces.clear();
  inFlightLoads.clear();
  cachedBytes = 0;
}

function cacheBlobUrl(fileId: string, url: string, bytes: number, animated: boolean | null): void {
  // Too large for the retained LRU: share its URL only while a surface needs
  // it. The final surface release removes this transient entry and revokes it.
  if (bytes > BLOB_CACHE_RETAIN_MAX_BYTES) {
    uncachedLiveBlobs.set(fileId, { url, bytes, animated });
    return;
  }

  const superseded = blobUrlCache.get(fileId);
  if (superseded !== undefined) {
    // Unreachable while loads are coalesced, but it must not leak if it ever
    // is: dropping an entry from the Map without revoking puts its url beyond
    // eviction's reach forever. Only safe to revoke when nothing is showing it.
    if (!liveSurfaces.has(fileId)) URL.revokeObjectURL(superseded.url);
    cachedBytes -= superseded.bytes;
    blobUrlCache.delete(fileId);
  }

  // Evict oldest-first until the incoming entry fits both bounds. Map preserves
  // insertion order, so the iteration order is LRU-first.
  while (
    (cachedBytes + bytes > BLOB_CACHE_MAX_BYTES || blobUrlCache.size >= BLOB_CACHE_MAX) &&
    evictOldestBlob()
  ) {
    /* eviction happens in the condition */
  }
  blobUrlCache.set(fileId, { url, bytes, animated });
  cachedBytes += bytes;
}

/** Loads in progress, keyed by file id. */
const inFlightLoads = new Map<string, Promise<LoadedAttachment>>();

/** An automatic preview needs consent before consuming a larger body. */
class PreviewNeedsConsentError extends Error {}

/** Why an attachment could not be shown.
 *
 *  A format this build cannot read, bytes that failed authentication, and a
 *  fault on THIS side are different situations calling for different responses
 *  from the reader, and collapsing them into "failed to load" tells them
 *  nothing. Only `generic` offers a retry, because only `generic` covers
 *  something a retry can change -- a dropped connection, a 5xx. The other three
 *  are terminal: retrying re-fetches identical bytes through identical code.
 *
 *  `client` is the one that is NOT the file's fault. A key the browser refused
 *  to use, an unavailable algorithm, an epoch header that arrived mangled --
 *  reporting any of those as damage sends the reader hunting a corrupted file
 *  over a bug on our side. */
type AttachmentFailure = null | 'generic' | 'unsupported' | 'integrity' | 'client';

function failureOf(err: unknown): Exclude<AttachmentFailure, null> {
  if (err instanceof UnsupportedAttachmentFormatError) return 'unsupported';
  if (err instanceof AttachmentIntegrityError) return 'integrity';
  if (err instanceof AttachmentKeyEpochError) return 'client';
  // A WebCrypto rejection that is NOT an authentication failure reaches here
  // untouched by decryptAttachmentBlob (see isAuthenticationFailure). It is a
  // fault in our call -- a key without the `decrypt` usage, a missing
  // algorithm -- and a retry cannot fix it.
  if (typeof err === 'object' && err !== null && (err as Error).name === 'InvalidAccessError') {
    return 'client';
  }
  return 'generic';
}

const FAILURE_COPY: Record<Exclude<AttachmentFailure, null>, string> = {
  generic: 'Failed to load image',
  unsupported: 'This attachment needs a newer version of Concord to open.',
  integrity: 'This attachment could not be verified — it may be damaged or altered.',
  client: 'Concord could not decrypt this attachment on this device.',
};

/** The ciphertext length to frame against: the stored `file_size`, else a
 *  Content-Length that describes the bytes we will read. A compressed response
 *  reports its COMPRESSED length, which would misframe the envelope, so that
 *  header is ignored unless the response is uncompressed. */
function attachmentLength(response: Response, declaredSize: number, autoLimit?: number): number {
  const encoding = (response.headers.get('Content-Encoding') ?? 'identity').trim().toLowerCase();
  const transport =
    encoding === 'identity'
      ? parseContentLength(response.headers.get('Content-Length'))
      : undefined;
  const length = declaredSize > 0 ? declaredSize : (transport ?? 0);
  // Either claim above the guard refuses before a byte of the body is read.
  const largest = Math.max(length, transport ?? 0);
  if (largest > MAX_DECRYPTABLE_ATTACHMENT_BYTES) throw new AttachmentTooLargeError(largest);
  if (
    autoLimit !== undefined &&
    (!Number.isSafeInteger(length) || length < 1 || largest > autoLimit)
  )
    throw new PreviewNeedsConsentError();
  return length;
}

async function decryptResponse(
  response: Response,
  channelId: string,
  declaredSize: number,
  mimeType: string,
  autoLimit?: number
): Promise<Blob> {
  if (!response.ok) throw new Error(`Failed to fetch attachment (${response.status})`);
  const length = attachmentLength(response, declaredSize, autoLimit);
  // SELECT THE KEY BY EPOCH, not "whatever is current".
  //
  // Every revocation rotates the CSK, so decrypting with the latest key
  // permanently orphaned every attachment uploaded before the most recent
  // rotation -- and reported it as "damaged or altered", i.e. tampering. The
  // upload has attested this epoch since #2832; it just never reached the
  // client. Absent header = a row predating the attestation, where the current
  // key IS the right one.
  const keyVersion = parseKeyVersionHeader(response.headers.get('X-File-Key-Version'));
  const channelKey =
    keyVersion === null
      ? await e2eeService.getChannelKey(channelId)
      : await e2eeService.getChannelKeyByVersion(channelId, keyVersion);
  // Handles BOTH formats, straight off the stream. Dispatch is deterministic and
  // decided before any key is used -- see classifyEnvelope. Neither the
  // ciphertext nor the plaintext is ever held whole: one sealed chunk at a time
  // is decrypted into its own Blob part, which is what lets a 1 GiB file open.
  // decryptAttachmentStream refuses a body that does not end at exactly
  // `length` bytes, so it bounds the transfer too. Electron always supplies a
  // body; a response without one is a transport failure, not tampering.
  if (!response.body) throw new Error('Attachment response has no body');
  let received = 0;
  const body =
    autoLimit === undefined
      ? response.body
      : response.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              received += chunk.byteLength;
              if (received > autoLimit) throw new PreviewNeedsConsentError();
              controller.enqueue(chunk);
            },
          })
        );
  return decryptAttachmentStream(body, length, channelKey, mimeType);
}

async function loadAndCache(
  fileId: string,
  channelId: string,
  declaredSize: number,
  autoLimit?: number
): Promise<LoadedAttachment> {
  // Guards run BEFORE the allocating operation, not between two of them.
  // `file_size` rides on the summary, so an oversized attachment costs no
  // network at all. It is server-supplied metadata though, so it is a fast
  // path, never the real bound — decryptAttachmentStream measures the actual bytes.
  if (declaredSize > MAX_DECRYPTABLE_ATTACHMENT_BYTES) {
    throw new AttachmentTooLargeError(declaredSize);
  }

  const response = await apiFetch(`/api/v1/media/attachments/${fileId}`);
  const mimeType = response.headers.get('X-File-Mime-Type') || 'application/octet-stream';
  let blob: Blob;
  try {
    blob = await decryptResponse(response, channelId, declaredSize, mimeType, autoLimit);
  } catch (err) {
    // Release the connection on every early exit (a locked body rejects the
    // cancel, which is fine: decryptAttachmentStream already released it).
    await response.body?.cancel().catch(() => undefined);
    throw err;
  }

  // Decide from the BYTES whether this actually animates, because `file_type`
  // cannot: it is MIME-derived and persisted at upload, so an animated WebP or
  // an APNG sent as `image/png` is stored as `photo` forever. Reads a bounded
  // prefix via `slice`, never the whole blob — holding a Blob rather than an
  // ArrayBuffer on this path is deliberate (a 1 GiB attachment must never be
  // materialised contiguously) and sniffing must not undo that.
  // Images only: a prefix read of a video buys nothing.
  let animated: boolean | null = null;
  if (mimeType.toLowerCase().startsWith('image/')) {
    try {
      const head = await blob.slice(0, ANIMATION_SNIFF_BYTES).arrayBuffer();
      animated = detectAnimatedImage(new Uint8Array(head), mimeType);
    } catch {
      // A failed prefix read must not fail the attachment: the image is fine,
      // we simply have no opinion, and `null` already means exactly that.
      animated = null;
    }
  }

  const url = URL.createObjectURL(blob);
  cacheBlobUrl(fileId, url, blob.size, animated);
  return { url, animated, bytes: blob.size };
}

async function fetchAndDecrypt(
  fileId: string,
  channelId: string,
  declaredSize: number,
  autoLimit?: number
): Promise<LoadedAttachment> {
  const requireConsent = (loaded: LoadedAttachment) => {
    if (autoLimit !== undefined && loaded.bytes > autoLimit) throw new PreviewNeedsConsentError();
    return loaded;
  };
  const cached = blobUrlCache.get(fileId);
  if (cached) {
    // Move to end for LRU freshness
    blobUrlCache.delete(fileId);
    blobUrlCache.set(fileId, cached);
    return requireConsent(cached);
  }
  const uncached = uncachedLiveBlobs.get(fileId);
  if (uncached) return requireConsent(uncached);

  // Coalesce concurrent loads of one attachment onto a single fetch + decrypt.
  // The same file legitimately appears on several surfaces at once (a message
  // and the pinned-message list, or repeated posts of one upload — the server
  // does not restrict a file to one message), and IntersectionObserver's 200px
  // rootMargin brings them in together. Without coalescing each surface minted
  // its own blob url, and every one but the last was dropped from the cache
  // WITHOUT being revoked: an unreachable, un-revokable Blob pinned for the
  // life of the document, and a byte budget that under-reported live memory by
  // a growing margin. Coalescing removes the duplicates rather than trying to
  // clean up after them, and saves N-1 fetches and decrypts besides.
  const existing = inFlightLoads.get(fileId);
  if (existing) return requireConsent(await existing);

  const load = loadAndCache(fileId, channelId, declaredSize, autoLimit).finally(() => {
    inFlightLoads.delete(fileId);
  });
  inFlightLoads.set(fileId, load);
  return requireConsent(await load);
}

/** Guard copy, rendered in the chip footprint so the refusal sits where the
 *  file is. Assertive because the user asked for this file and it will not
 *  arrive — the alternative to the sentence is an OOM. */
function AttachmentTooLargeNotice({
  bytes,
  truncated = false,
}: {
  readonly bytes: number;
  readonly truncated?: boolean;
}) {
  return (
    <div className="attachment-error" role="alert">
      {tooLargeMessage(bytes, truncated, formatFileSize)}
    </div>
  );
}

function FileIcon({ fileType }: { readonly fileType: string }) {
  switch (fileType) {
    case 'video':
      return <Film size={20} />;
    case 'audio':
      return <Music size={20} />;
    case 'photo':
    case 'animated':
      return <FileText size={20} />;
    default:
      return <File size={20} />;
  }
}

/** The largest uploadable image, including its v3 ciphertext framing. */
const IMAGE_PRELOAD_MAX_BYTES = expectedBlobLength(IMAGE_STRIP_MAX_BYTES, ENVELOPE_VERSION_V3);
// A sender-controlled video label cannot grant a larger automatic download.
export const VIDEO_PRELOAD_MAX_BYTES = Math.min(256 * 1024 * 1024, IMAGE_PRELOAD_MAX_BYTES);

// Display constraints for image attachments — must match AttachmentDisplay.css
// (.attachment-image-container max-width / .attachment-image max-height).
// Kept in sync with the CSS so the JS clamp matches what the browser paints.
const ATTACHMENT_MAX_W = 400;
const ATTACHMENT_MAX_H = 300;

/** Clamps an attachment's natural pixel dimensions into the display box,
 *  preserving aspect ratio. Returns null if dimensions aren't known so the
 *  caller can fall back to intrinsic sizing on first load. */
function clampAttachmentSize(
  w: number | undefined,
  h: number | undefined
): { width: number; height: number } | null {
  if (!w || !h) return null;
  const ratio = Math.min(ATTACHMENT_MAX_W / w, ATTACHMENT_MAX_H / h, 1);
  return { width: Math.round(w * ratio), height: Math.round(h * ratio) };
}

/** Image MIME → file extension for the Save-As default filename. */
const IMAGE_EXT: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
};

/** Returns the extension for an image MIME type, or '' when unmapped/absent. */
export function extFromMime(mime: string | undefined): string {
  return (mime && IMAGE_EXT[mime]) || '';
}

/**
 * First frame of an animated image as its own small object url, so a paused
 * attachment shows a still exactly like a paused KLIPY GIF instead of a blank
 * box. `createImageBitmap` decodes only the first frame. Returns null until the
 * still exists, and whenever the platform cannot make one (jsdom), which keeps
 * the blank-box fallback.
 */
function useStillFrame(url: string | null, enabled: boolean): string | null {
  const [still, setStill] = useState<{ readonly from: string; readonly url: string } | null>(null);
  // Made the first time the image pauses, then kept across play/pause until
  // the url changes or the surface unmounts, so toggling never re-decodes.
  const hasStill = still?.from === url;
  useEffect(() => {
    if (!url || !enabled || hasStill || typeof createImageBitmap !== 'function') return;
    let cancelled = false;
    // A fresh element decodes from frame one; no fetch of the blob url needed.
    const img = new Image();
    img.src = url;
    img
      .decode()
      // Decoded at display size: a huge declared GIF must not cost a
      // full-resolution bitmap and canvas just to show a 400px still.
      .then(() => {
        const dpr = globalThis.devicePixelRatio || 1;
        const scale = Math.min(
          (ATTACHMENT_MAX_W * dpr) / img.naturalWidth,
          (ATTACHMENT_MAX_H * dpr) / img.naturalHeight,
          1
        );
        return createImageBitmap(img, {
          resizeWidth: Math.max(1, Math.round(img.naturalWidth * scale)),
          resizeHeight: Math.max(1, Math.round(img.naturalHeight * scale)),
          resizeQuality: 'low',
        });
      })
      .then(
        (bitmap) =>
          new Promise<Blob | null>((resolve) => {
            const canvas = document.createElement('canvas');
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
            bitmap.close();
            canvas.toBlob(resolve);
          })
      )
      .then((frame) => {
        if (cancelled || !frame) return;
        setStill({ from: url, url: URL.createObjectURL(frame) });
      })
      .catch(() => undefined); // No still: the paused box falls back to the hint.
    return () => {
      cancelled = true;
    };
  }, [url, enabled, hasStill]);
  // A still for a url that is gone (scrolled out, replaced) is dropped now,
  // not held until the next pause.
  useEffect(() => {
    // eslint-disable-next-line @eslint-react/set-state-in-effect -- intentional: releases a still whose url no longer exists; the next render sees null and does not loop
    if (still && still.from !== url) setStill(null);
  }, [still, url]);
  // The one revoker: a replaced still, or the last one at unmount.
  useEffect(
    () => () => {
      if (still) URL.revokeObjectURL(still.url);
    },
    [still]
  );
  // A still made for an earlier url is never shown for the current one.
  return hasStill ? still.url : null;
}

function imageNeedsConsent(size: number, previewNeedsConsent: boolean): boolean {
  return (
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    (size > IMAGE_PRELOAD_MAX_BYTES && size <= MAX_DECRYPTABLE_ATTACHMENT_BYTES) ||
    previewNeedsConsent
  );
}

function imageContainerStyle(
  awaitingClick: boolean,
  clamped: ReturnType<typeof clampAttachmentSize>,
  naturalRatio: number | null
): React.CSSProperties | undefined {
  if (awaitingClick) return undefined;
  if (clamped) return { width: `${clamped.width}px`, height: `${clamped.height}px` };
  if (naturalRatio) return { aspectRatio: String(naturalRatio), maxWidth: `${ATTACHMENT_MAX_W}px` };
  return undefined;
}

function ImageAttachment({ attachment, channelId }: AttachmentItemProps) {
  // Declared above the focus hook, which now takes it as its `enabled` gate.
  // `file_type` is MIME-derived and PERSISTED at upload, so it is wrong for two
  // formats it cannot distinguish: an animated WebP and an APNG sent under the
  // common `image/png` label both land as `photo`. Both therefore escaped the
  // hover gate and the unfocus pause entirely, and because the value is stored,
  // no classifier fix reaches attachments already in a channel. The decrypted
  // bytes decide instead, and fall back to the persisted value whenever they
  // have no opinion (`null`) — which is the case for every format the sniffer
  // does not judge, GIF included, where `file_type` is already right.
  // Found by Codex review on PR #3291.
  const [sniffedAnimated, setSniffedAnimated] = useState<boolean | null>(null);
  const isAnimated = sniffedAnimated ?? attachment.file_type === 'animated';
  const reduceAnimations = useSettingsStore((s) => s.appearance.reduceAnimations);
  const gifPlayback = useSettingsStore((s) => s.appearance.gifPlayback);
  // Gated on `isAnimated`: a static JPEG or PNG ignores the verdict entirely
  // (`showLiveImage` short-circuits on `!isAnimated`), so subscribing it to the
  // focus store only bought a re-render on every alt-tab — and message history
  // is unvirtualized, so a photo-heavy channel paid that for every mounted
  // image. Found by Codex review on PR #3291.
  const windowFocused = useWindowFocus(isAnimated);
  // Animated GIF attachments obey the shared two-axis verdict (#2369); the
  // hover half of it originates in QA bug #571 item #6B. Static photos ignore
  // both axes — a still JPEG has nothing to pause.
  // Two booleans for two independent conditions — see GifEmbed. One boolean
  // stopped playback when the pointer left an element the keyboard still held,
  // and when focus left an element the pointer still rested on.
  const [pointerOver, setPointerOver] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const hovering = pointerOver || focusWithin;
  const verdict = resolveGifPlayback({
    mode: gifPlayback,
    reduceAnimations,
    hovering,
    windowFocused,
  });
  const [url, setUrl] = useState<string | null>(blobUrlCache.get(attachment.id)?.url ?? null);
  // Same gate as a KLIPY GIF: with "load GIFs automatically" off, an attachment
  // declared animated waits for a click. An APNG or animated WebP stored as
  // `photo` is only known after download, so only the declared type can wait.
  const loadGifsAutomatically = usePrivacyStore((s) => s.settings.loadGifsAutomatically);
  const [userClicked, setUserClicked] = useState(false);
  const userClickedRef = useRef(false);
  const [previewNeedsConsent, setPreviewNeedsConsent] = useState(false);
  const sizeNeedsConsent = imageNeedsConsent(attachment.file_size, previewNeedsConsent);
  const awaitingClick =
    !userClicked &&
    url === null &&
    (sizeNeedsConsent || (attachment.file_type === 'animated' && !loadGifsAutomatically));
  const sizeNeedsConsentRef = useRef(sizeNeedsConsent);
  sizeNeedsConsentRef.current = sizeNeedsConsent;
  const awaitingClickRef = useRef(awaitingClick);
  awaitingClickRef.current = awaitingClick;
  const [loading, setLoading] = useState(!url);
  const [error, setError] = useState<AttachmentFailure>(null);
  // Byte count of a refusal, or null when the attachment was never refused.
  const [tooLarge, setTooLarge] = useState<{ bytes: number; truncated: boolean } | null>(null);
  // Aspect ratio learned from <img onLoad> as a fallback for messages whose
  // summary lacks pre-known width/height (e.g. older history rows fetched
  // from the server before the dim-plumbing was in place).
  const [naturalRatio, setNaturalRatio] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [inView, setInView] = useState(false);
  // null means the observer has not delivered its initial viewport result.
  const visibleRef = useRef<boolean | null>(null);
  const urlRef = useRef(url);
  const loadingRef = useRef(false);
  const pinnedRef = useRef(false);
  const releaseOnExitRef = useRef(false);
  const loadRef = useRef<() => void>(() => undefined);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  urlRef.current = url;
  pinnedRef.current = focusWithin || lightboxOpen || menuPos !== null;

  // Save the decrypted image to disk via the native Save-As dialog (#1729).
  // The blob is already decrypted in-renderer; read its bytes and hand them to
  // the main process, which owns the dialog + write (the renderer cannot reach
  // a native "Save Image As…" on a blob: URL). User-cancel is a no-op success.
  // Sync wrapper whose promise chain ends in `.catch`, so the promise is handled
  // (not floating) without the `void` operator, and callers invoke it directly.
  const handleSaveImage = useCallback((): void => {
    if (!url) return;
    fetch(url)
      .then((r) => r.arrayBuffer())
      .then((bytes) =>
        globalThis.electron.saveImageAs(
          bytes,
          `image-${attachment.id}${extFromMime(attachment.mime_type)}`
        )
      )
      .catch(() => undefined); // Non-fatal: blob read or Save-As IPC failed.
  }, [url, attachment.id, attachment.mime_type]);

  const load = useCallback(async () => {
    if (loadingRef.current || urlRef.current || awaitingClickRef.current) return;
    loadingRef.current = true;
    let retryWithConsent = false;
    try {
      setError(null);
      setLoading(true);
      const loaded = await fetchAndDecrypt(
        attachment.id,
        channelId,
        attachment.file_size,
        userClickedRef.current ? undefined : IMAGE_PRELOAD_MAX_BYTES
      );
      if (!visibleRef.current && !pinnedRef.current) {
        releaseOffscreenBlob(attachment.id, loaded.url);
        return;
      }
      // Set the animation verdict BEFORE the url. `showLiveImage` gates on
      // `url !== null`, so nothing is rendered until the url lands — sequencing
      // it this way means the first paint already knows whether to pause,
      // rather than flashing one animated frame and then correcting itself.
      if (loaded.animated !== null) setSniffedAnimated(loaded.animated);
      urlRef.current = loaded.url;
      setUrl(loaded.url);
    } catch (err) {
      // A refusal is a different failure from a broken fetch or decrypt: the
      // bytes were never requested, so say so instead of "failed to load".
      if (err instanceof PreviewNeedsConsentError && userClickedRef.current) {
        retryWithConsent = true;
      } else if (err instanceof PreviewNeedsConsentError) {
        awaitingClickRef.current = true;
        setPreviewNeedsConsent(true);
      } else if (err instanceof AttachmentTooLargeError)
        setTooLarge({ bytes: err.byteLength, truncated: err.truncated });
      else setError(failureOf(err));
    } finally {
      loadingRef.current = false;
      setLoading(false);
      if (retryWithConsent && mountedRef.current && (visibleRef.current || pinnedRef.current))
        loadRef.current();
    }
  }, [attachment.id, attachment.file_size, channelId]);
  loadRef.current = load;

  // Turning "Load GIFs automatically" on lifts the gate while the image is
  // already on screen; the observer only reports changes, so load here.
  useEffect(() => {
    if (!awaitingClick && visibleRef.current) loadRef.current();
  }, [awaitingClick]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting === visibleRef.current) return;
        const wasVisible = visibleRef.current === true;
        visibleRef.current = entry.isIntersecting;
        if (entry.isIntersecting) setViewportSurface(attachment.id, true);
        else if (wasVisible) setViewportSurface(attachment.id, false);
        setInView(entry.isIntersecting);
        if (entry.isIntersecting) {
          releaseOnExitRef.current = false;
          loadRef.current();
        } else {
          releaseOnExitRef.current = true;
          if (!pinnedRef.current) {
            urlRef.current = null;
            setUrl(null);
            if (sizeNeedsConsentRef.current) {
              userClickedRef.current = false;
              awaitingClickRef.current = true;
              setUserClicked(false);
            }
          }
        }
      },
      { rootMargin: '200px' }
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (visibleRef.current) {
        visibleRef.current = false;
        setViewportSurface(attachment.id, false);
      }
    };
  }, [attachment.id]);
  // Unmounted history rows are released by the cache's byte budget. A row that
  // remains mounted after scrolling out releases its decrypted bytes promptly.
  useRetainedBlobUrl(
    attachment.id,
    url,
    inView || pinnedRef.current || !releaseOnExitRef.current,
    releaseOnExitRef
  );
  useEffect(() => {
    if (releaseOnExitRef.current && !inView && !pinnedRef.current && url) {
      urlRef.current = null;
      setUrl(null);
    }
  }, [inView, focusWithin, lightboxOpen, menuPos, url]);

  // Compute the reserved box from pre-known summary dims when available, so
  // the optimistic message paints at the final size with no layout shift.
  // Falls back to a learned aspect ratio (from a previous onLoad in this
  // session) for legacy messages without dims, and finally to a min-height
  // skeleton for the very first paint of a dim-less attachment.
  const clamped = clampAttachmentSize(attachment.width, attachment.height);
  // The click-to-load chip sizes itself, like GifEmbed's placeholder.
  const containerStyle = imageContainerStyle(awaitingClick, clamped, naturalRatio);

  // No browser API pauses an animated <img>, and the server only ever holds
  // ciphertext so there is no still frame to swap in either: on THIS surface
  // "stopped" can only mean the <img> is not mounted. Both axes therefore
  // collapse onto `playing`, which already implies `surface === 'animated'`.
  // That is a property of this surface, not a simplification of the model —
  // `GifEmbed` keeps them apart because it has a still frame and a real
  // `HTMLMediaElement.pause()`. The browser restarts the animation on every
  // mount; §5 residual 1 records that as accepted and unfixable here.
  const showLiveImage = url !== null && (!isAnimated || verdict.playing);
  // Only a paused image shows its still, so only a paused image makes one.
  const stillUrl = useStillFrame(url, isAnimated && url !== null && !verdict.playing);
  // The two copies are never merged: one names an action available right now,
  // the other names a cause hovering cannot fix. Unfocus wins when both hold,
  // because moving the pointer onto a background window does nothing.
  const pausedByPlayback = isAnimated && url !== null && !verdict.playing;
  const pausedCause: 'unfocused' | 'hover' = windowFocused ? 'hover' : 'unfocused';
  // A still frame needs no hint, exactly like a paused KLIPY GIF with a still.
  const pausedReason: 'unfocused' | 'hover' | null =
    pausedByPlayback && stillUrl === null ? pausedCause : null;
  // Tracked UNCONDITIONALLY, not only while the hover gate is active. Attaching
  // them conditionally means a pointer or focus that leaves during an inactive spell
  // never fires its matching leave handler, so the flag stays stuck true and the
  // next time the gate turns on the attachment believes it is being hovered when
  // it is not. React delegates all four of these at the root, so always passing
  // them adds fiber props rather than four DOM listeners per attachment.
  // CodeRabbit review, PR #3291.
  //
  // NO `tabIndex` here. §2.5 invariant 2 keeps a native <button> mounted whenever
  // `url` is non-null, so the container stop was a SECOND stop that activates
  // nothing — and while `url` is null (loading, failed, too large) it was a stop
  // on nothing at all. Keyboard reach is unaffected: React's onFocus is focusin,
  // which bubbles, so tabbing to that button still sets `focusWithin`. Predates
  // this PR (50b871f69, QA #571); fixed here under the boy-scout rule because
  // this PR is what put a playback gate behind that flag. CodeRabbit, PR #3291.
  const hoverHandlers = {
    onMouseEnter: () => setPointerOver(true),
    onMouseLeave: () => setPointerOver(false),
    onFocus: () => setFocusWithin(true),
    onBlur: () => setFocusWithin(false),
  };

  return (
    <div
      ref={containerRef}
      className={
        awaitingClick
          ? 'attachment-image-container attachment-image-container--click-to-load'
          : 'attachment-image-container'
      }
      style={containerStyle}
      {...hoverHandlers}
    >
      {awaitingClick && (
        <button
          type="button"
          className="gif-embed-placeholder"
          aria-label={sizeNeedsConsent ? 'Click to load image' : 'Click to load GIF'}
          onClick={() => {
            userClickedRef.current = true;
            awaitingClickRef.current = false;
            // This button unmounts while focused, and an unmounted element
            // never fires blur: clear the flag here or the GIF stays "hovered"
            // and pinned after the pointer leaves.
            setFocusWithin(false);
            setUserClicked(true);
            loadRef.current();
          }}
        >
          <ImageOff size={24} />
          <span>
            {sizeNeedsConsent ? 'Click to load image' : 'Click to load GIF'}
            {sizeNeedsConsent &&
            !previewNeedsConsent &&
            Number.isSafeInteger(attachment.file_size) &&
            attachment.file_size > 0
              ? ` (${formatFileSize(attachment.file_size)})`
              : ''}
          </span>
        </button>
      )}
      {loading && !awaitingClick && (
        <div className="attachment-loading">
          <Loader2 size={20} className="spinner" />
        </div>
      )}
      {error !== null && (
        <div className="attachment-error" role="alert">
          {FAILURE_COPY[error]}
        </div>
      )}
      {tooLarge !== null && (
        <AttachmentTooLargeNotice bytes={tooLarge.bytes} truncated={tooLarge.truncated} />
      )}
      {/* §2.5 invariant 2: the button is mounted whenever `url` is non-null, and
          the playback gate lives strictly INSIDE it. Gating the button itself —
          the obvious one-boolean implementation — destroys keyboard focus on
          every alt-tab, so on return focus is on <body> and the user has lost
          their place in the message list. Its aria-label never depends on the
          <img>'s alt, so the accessible name survives the paused state. */}
      {url !== null && (
        <button
          type="button"
          className="attachment-image-btn"
          aria-label="Open image in viewer"
          onClick={() => setLightboxOpen(true)}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenuPos({ x: e.clientX, y: e.clientY });
          }}
        >
          {!showLiveImage && stillUrl !== null && (
            <img
              src={stillUrl}
              alt={`Attachment ${attachment.id}`}
              className="attachment-image"
              draggable={false}
            />
          )}
          {!showLiveImage && stillUrl === null && (
            <div className="attachment-image-placeholder" aria-hidden="true" />
          )}
          {showLiveImage && (
            <img
              src={url}
              alt={`Attachment ${attachment.id}`}
              className="attachment-image"
              loading="lazy"
              onLoad={(e) => {
                if (clamped) return;
                const img = e.currentTarget;
                if (img.naturalWidth && img.naturalHeight) {
                  setNaturalRatio(img.naturalWidth / img.naturalHeight);
                }
              }}
            />
          )}
        </button>
      )}
      {pausedReason !== null && !loading && !error && tooLarge === null && (
        <div className="attachment-reduced-motion-hint" aria-hidden="true">
          <Pause size={14} aria-hidden="true" />
          {pausedReason === 'hover' ? 'Hover to play' : 'Paused — Concord is in the background'}
        </div>
      )}
      {lightboxOpen && url && (
        <ImageLightbox
          src={url}
          alt={`Attachment ${attachment.id}`}
          // `!windowFocused`, NOT `!verdict.playing` — the latter folds in the
          // hover gate, which deliberately does not reach a viewer the user
          // opened on purpose. Static photos are never paused.
          paused={isAnimated && !windowFocused}
          onClose={() => setLightboxOpen(false)}
          onSave={handleSaveImage}
        />
      )}
      {menuPos && (
        <ContextMenu position={menuPos} onClose={() => setMenuPos(null)}>
          <ContextMenu.Item
            icon={<Maximize2 size={16} />}
            label="Open"
            onClick={() => {
              setMenuPos(null);
              setLightboxOpen(true);
            }}
          />
          <ContextMenu.Item
            icon={<Download size={16} />}
            label="Save image…"
            onClick={() => {
              setMenuPos(null);
              handleSaveImage();
            }}
          />
        </ContextMenu>
      )}
    </div>
  );
}

function MediaAttachment({ attachment, channelId }: AttachmentItemProps) {
  const [url, setUrl] = useState<string | null>(blobUrlCache.get(attachment.id)?.url ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<AttachmentFailure>(null);
  const [tooLarge, setTooLarge] = useState<{ bytes: number; truncated: boolean } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Videos up to VIDEO_PRELOAD_MAX_BYTES auto-lazy-load so the browser can
  // render the first frame as a natural poster — no separate thumbnail pipeline
  // needed. A larger video waits for the user to confirm the download
  // (attachment display policy, 2026-11-05). Audio stays click-to-load because
  // there's nothing visual to gain from prefetching the bytes.
  const isVideo = attachment.file_type === 'video';
  const [previewNeedsConsent, setPreviewNeedsConsent] = useState(false);
  const autoLoad =
    isVideo &&
    !previewNeedsConsent &&
    Number.isSafeInteger(attachment.file_size) &&
    attachment.file_size > 0 &&
    attachment.file_size <= VIDEO_PRELOAD_MAX_BYTES;
  const [inView, setInView] = useState(false);
  const [focused, setFocused] = useState(false);
  const [playing, setPlaying] = useState(false);
  // null means the observer has not delivered its initial viewport result.
  const visibleRef = useRef<boolean | null>(null);
  const urlRef = useRef(url);
  const loadingRef = useRef(false);
  const manuallyRequestedRef = useRef(false);
  const focusedRef = useRef(false);
  const playingRef = useRef(false);
  const pinnedRef = useRef(false);
  const releaseOnExitRef = useRef(false);
  const loadRef = useRef<() => void>(() => undefined);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const hasPictureInPicture = useCallback(() => {
    const video = containerRef.current?.querySelector('video');
    return !!video && document.pictureInPictureElement === video;
  }, []);
  urlRef.current = url;
  pinnedRef.current = focused || playing || manuallyRequestedRef.current || hasPictureInPicture();

  const load = useCallback(async () => {
    if (urlRef.current || loadingRef.current) return;
    loadingRef.current = true;
    let retryWithConsent = false;
    setError(null);
    setLoading(true);
    try {
      const { url: blobUrl } = await fetchAndDecrypt(
        attachment.id,
        channelId,
        attachment.file_size,
        manuallyRequestedRef.current ? undefined : VIDEO_PRELOAD_MAX_BYTES
      );
      if (!visibleRef.current && !pinnedRef.current) {
        releaseOffscreenBlob(attachment.id, blobUrl);
        return;
      }
      urlRef.current = blobUrl;
      setUrl(blobUrl);
    } catch (err) {
      if (err instanceof PreviewNeedsConsentError) {
        if (manuallyRequestedRef.current) retryWithConsent = true;
        else setPreviewNeedsConsent(true);
      } else if (err instanceof AttachmentTooLargeError)
        setTooLarge({ bytes: err.byteLength, truncated: err.truncated });
      else setError(failureOf(err));
    } finally {
      loadingRef.current = false;
      setLoading(false);
      if (retryWithConsent && mountedRef.current && (visibleRef.current || pinnedRef.current))
        loadRef.current();
    }
  }, [attachment.id, attachment.file_size, channelId]);
  loadRef.current = load;

  useEffect(() => {
    const video = containerRef.current?.querySelector('video');
    if (!video) return;
    const onLeavePictureInPicture = () => {
      if (!releaseOnExitRef.current) return;
      const hasFocus = containerRef.current?.contains(document.activeElement) ?? false;
      focusedRef.current = hasFocus;
      pinnedRef.current = hasFocus || playingRef.current;
      setFocused(hasFocus);
      if (!pinnedRef.current) {
        urlRef.current = null;
        setUrl(null);
      }
    };
    video.addEventListener('leavepictureinpicture', onLeavePictureInPicture);
    return () => video.removeEventListener('leavepictureinpicture', onLeavePictureInPicture);
  }, [url]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting === visibleRef.current) return;
        const wasVisible = visibleRef.current === true;
        visibleRef.current = entry.isIntersecting;
        if (entry.isIntersecting) setViewportSurface(attachment.id, true);
        else if (wasVisible) setViewportSurface(attachment.id, false);
        setInView(entry.isIntersecting);
        if (entry.isIntersecting) {
          releaseOnExitRef.current = false;
          if (autoLoad) loadRef.current();
        } else {
          releaseOnExitRef.current = true;
          manuallyRequestedRef.current = false;
          // Removing the focused Load button does not fire blur. Recheck the DOM
          // so a paused player cannot keep a stale focus pin after scrolling away.
          const hasFocus = el.contains(document.activeElement);
          if (focusedRef.current !== hasFocus) {
            focusedRef.current = hasFocus;
            setFocused(hasFocus);
          }
          pinnedRef.current = focusedRef.current || playingRef.current || hasPictureInPicture();
          if (!pinnedRef.current) {
            urlRef.current = null;
            setUrl(null);
          }
        }
      },
      { rootMargin: '200px' }
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (visibleRef.current) {
        visibleRef.current = false;
        setViewportSurface(attachment.id, false);
      }
    };
  }, [autoLoad, attachment.id, hasPictureInPicture]);
  useRetainedBlobUrl(
    attachment.id,
    url,
    inView || pinnedRef.current || !releaseOnExitRef.current,
    releaseOnExitRef
  );
  useEffect(() => {
    if (releaseOnExitRef.current && !inView && !pinnedRef.current && url) {
      urlRef.current = null;
      setUrl(null);
    }
  }, [inView, focused, playing, url]);

  const Icon = attachment.file_type === 'video' ? Film : Music;
  const label = attachment.file_type === 'video' ? 'video' : 'audio';
  const sizeLabel = formatFileSize(attachment.file_size);
  // A format this build cannot read, and bytes that failed authentication, are
  // TERMINAL: retrying re-fetches the same bytes and fails the same way. Only a
  // generic failure (a dropped fetch, a transient 5xx) is worth another go.
  const terminal = error !== null && error !== 'generic';
  let loadTitle = `Load ${label}`;
  if (previewNeedsConsent) loadTitle = 'Large video — download?';
  else if (
    isVideo &&
    !autoLoad &&
    Number.isSafeInteger(attachment.file_size) &&
    attachment.file_size > 0
  )
    loadTitle = `Large video — download ${sizeLabel}?`;
  if (error === 'generic') loadTitle = `Failed to load ${label} — retry`;
  else if (loading) loadTitle = `Loading ${label}…`;

  return (
    <div
      className="attachment-media-container"
      ref={containerRef}
      onFocusCapture={() => {
        focusedRef.current = true;
        pinnedRef.current = true;
        setFocused(true);
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          focusedRef.current = false;
          pinnedRef.current =
            playingRef.current || manuallyRequestedRef.current || hasPictureInPicture();
          setFocused(false);
        }
      }}
      onPlayCapture={() => {
        playingRef.current = true;
        pinnedRef.current = true;
        setPlaying(true);
      }}
      onPauseCapture={() => {
        playingRef.current = false;
        pinnedRef.current =
          focusedRef.current || manuallyRequestedRef.current || hasPictureInPicture();
        setPlaying(false);
      }}
      onEndedCapture={() => {
        playingRef.current = false;
        pinnedRef.current =
          focusedRef.current || manuallyRequestedRef.current || hasPictureInPicture();
        setPlaying(false);
      }}
    >
      {url && attachment.file_type === 'video' && (
        <ThemedMediaPlayer src={url} variant="video" className="attachment-video" />
      )}
      {url && attachment.file_type === 'audio' && (
        <ThemedMediaPlayer src={url} variant="audio" className="attachment-audio" />
      )}
      {tooLarge !== null && (
        <AttachmentTooLargeNotice bytes={tooLarge.bytes} truncated={tooLarge.truncated} />
      )}
      {terminal && error !== null && (
        <div className="attachment-error" role="alert">
          {FAILURE_COPY[error]}
        </div>
      )}
      {!url && tooLarge === null && !terminal && (
        <button
          className="attachment-load-btn attachment-load-btn-rich"
          onClick={() => {
            manuallyRequestedRef.current = true;
            pinnedRef.current = true;
            load();
          }}
          disabled={loading}
        >
          <Icon size={20} />
          <div className="attachment-load-info">
            <span className="attachment-load-title">{loadTitle}</span>
            <span className="attachment-load-meta">
              {attachment.mime_type} · {sizeLabel}
            </span>
          </div>
        </button>
      )}
    </div>
  );
}

function FileAttachment({ attachment, channelId }: AttachmentItemProps) {
  const [downloading, setDownloading] = useState(false);
  const [tooLarge, setTooLarge] = useState<{ bytes: number; truncated: boolean } | null>(null);
  // Holds the url the download is reading.
  //
  // An earlier version deliberately did NOT retain here, reasoning that no
  // eviction can interleave because there is no `await` between the load
  // resolving and `a.click()`. That covers the interval BEFORE the click and
  // not the one after it: `a.click()` starts an asynchronous browser download
  // that reads the blob over time, and for an attachment near the 1 GiB guard
  // that read is long-lived. Another attachment loading during it would evict
  // and revoke the url mid-read (#2837 review, row 1).
  const [downloadedUrl, setDownloadedUrl] = useState<string | null>(null);
  useRetainedBlobUrl(attachment.id, downloadedUrl);

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const { url: blobUrl } = await fetchAndDecrypt(
        attachment.id,
        channelId,
        attachment.file_size
      );
      setDownloadedUrl(blobUrl);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `attachment-${attachment.id}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      // A refusal is the one download failure worth surfacing on a file card:
      // retrying can never succeed, so the card says why.
      if (err instanceof AttachmentTooLargeError)
        setTooLarge({ bytes: err.byteLength, truncated: err.truncated });
      // Otherwise non-fatal: download failed, no UI feedback needed here.
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="attachment-file-card">
      <FileIcon fileType={attachment.file_type} />
      <div className="attachment-file-info">
        <span className="attachment-file-type">{attachment.mime_type}</span>
        <span className="attachment-file-size">{formatFileSize(attachment.file_size)}</span>
        {tooLarge !== null && (
          <AttachmentTooLargeNotice bytes={tooLarge.bytes} truncated={tooLarge.truncated} />
        )}
      </div>
      <button
        className="attachment-download-btn"
        onClick={handleDownload}
        disabled={downloading}
        aria-label="Download attachment"
      >
        {downloading ? <Loader2 size={16} className="spinner" /> : <Download size={16} />}
      </button>
    </div>
  );
}

/** Text MIME types that preload into the collapsible text space (attachment
 *  display policy, 2026-11-05). Anything else waits for a Download click. */
// A Map, not an object literal: `mime_type` is sender-chosen, and an object
// lookup would answer `constructor` or `__proto__` from the prototype.
const TEXT_FORMATS: ReadonlyMap<string, 'markdown' | 'text'> = new Map([
  ['text/markdown', 'markdown'],
  ['text/plain', 'text'],
]);

const AttachmentDisplay: React.FC<AttachmentDisplayProps> = ({
  attachments,
  channelId,
  messageBody,
}) => {
  if (!attachments || attachments.length === 0) return null;

  return (
    <div className="attachment-display">
      {attachments.map((attachment) => {
        const textFormat =
          attachment.file_type === 'file' && TEXT_FORMATS.get(attachment.mime_type);
        if (textFormat) {
          return (
            <OverflowMarkdownAttachment
              key={attachment.id}
              attachment={attachment}
              previewBody={textFormat === 'markdown' ? (messageBody ?? '') : ''}
              channelId={channelId}
              format={textFormat}
              downloadSlot={<FileAttachment attachment={attachment} channelId={channelId} />}
            />
          );
        }
        if (attachment.file_type === 'photo' || attachment.file_type === 'animated') {
          return (
            <ImageAttachment key={attachment.id} attachment={attachment} channelId={channelId} />
          );
        }
        if (attachment.file_type === 'video' || attachment.file_type === 'audio') {
          return (
            <MediaAttachment key={attachment.id} attachment={attachment} channelId={channelId} />
          );
        }
        return <FileAttachment key={attachment.id} attachment={attachment} channelId={channelId} />;
      })}
    </div>
  );
};

export default AttachmentDisplay;
