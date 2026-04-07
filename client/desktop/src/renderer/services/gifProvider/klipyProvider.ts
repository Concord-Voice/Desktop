/**
 * KLIPY adapter that implements the vendor-neutral `GifProvider` interface.
 *
 * This is the only file that translates between KLIPY's response shapes and
 * the rest of Concord's GIF code. The picker, embed, and message composer talk
 * to `gifProvider` from `./index.ts` and never see KLIPY-specific types.
 *
 * Rendition selection follows the universal "MP4 over GIF" best practice:
 * if KLIPY returns an MP4 variant we use it (smaller, higher quality, plays in
 * a `<video>` element); otherwise we fall back to GIF or WEBP rendered in an
 * `<img>` element. The renderer chooses based on `GifResolved.animatedKind`.
 *
 * KLIPY ToS compliance:
 * - We pass through KLIPY's URLs verbatim — no construction or modification.
 * - We do NOT cache or store any KLIPY-derived metadata; the only field we
 *   persist anywhere is the slug (per-user bookmarks in `savedGifsStore`).
 * - "Powered by KLIPY" attribution is rendered in the picker footer (Section 4).
 * - Independence disclaimer is rendered next to the powered-by mark (Section 3).
 */

import type {
  GifProvider,
  GifResolved,
  GifSearchResult,
  GifSearchOpts,
  GifTrendingOpts,
  GifRecentOpts,
  GifCategoryOpts,
  GifCategory,
} from './types';
import { klipyClient, type KlipyGifItem, type KlipyListResponse } from './klipyClient';

/** Translate a single KLIPY GIF item into the vendor-neutral resolved shape.
 *  Defensive against missing fields — different KLIPY endpoints sometimes
 *  return slightly different shapes for the same GIF object. */
function toResolved(item: KlipyGifItem): GifResolved | null {
  if (!item.slug) return null;

  // Pick the best animated rendition: MP4 first (renders as <video>), then
  // WEBP/GIF (rendered as <img>). Default `image` covers both fallback cases
  // so we only need to override when MP4 is selected.
  const mp4Url = item.file?.mp4?.url ?? item.preview?.mp4?.url;
  const webpUrl = item.file?.webp?.url ?? item.preview?.webp?.url;
  const gifUrl = item.file?.gif?.url ?? item.preview?.gif?.url ?? item.url;

  const animatedUrl = mp4Url ?? webpUrl ?? gifUrl;
  if (!animatedUrl) return null;
  const animatedKind: 'video' | 'image' = mp4Url ? 'video' : 'image';

  // Still rendition: prefer the explicit still URL, fall back to the
  // animated URL (the still will autoplay when used as <video poster> too)
  const stillUrl = item.still?.url ?? animatedUrl;

  return {
    slug: item.slug,
    width: item.file?.mp4?.width ?? item.file?.gif?.width ?? item.width,
    height: item.file?.mp4?.height ?? item.file?.gif?.height ?? item.height,
    animatedUrl,
    animatedKind,
    stillUrl,
  };
}

function toSearchResult(resp: KlipyListResponse, page: number, perPage: number): GifSearchResult {
  const raw = resp.data ?? resp.result ?? [];
  const items = raw.map(toResolved).filter((g): g is GifResolved => g !== null);
  const hasMore = resp.has_more ?? resp.meta?.has_more ?? raw.length >= perPage;
  return {
    items,
    hasMore,
    nextOffset: hasMore ? page + 1 : undefined,
  };
}

export const klipyProvider: GifProvider = {
  name: 'KLIPY',
  searchPlaceholder: 'Search KLIPY',
  poweredByText: 'Powered by KLIPY',
  logoAsset: '/assets/klipy-logo.svg',
  independenceDisclaimer:
    'Concord is independently developed and not affiliated with or endorsed by KLIPY.',
  supportsRecent: true,
  supportsCategories: true,

  async trending(opts: GifTrendingOpts): Promise<GifSearchResult> {
    // KLIPY uses 1-indexed pages; we expose offset semantics to the rest of
    // the codebase. Compute the page from offset/limit.
    const page = Math.floor(opts.offset / opts.limit) + 1;
    const resp = await klipyClient.trending(page, opts.limit, opts.locale);
    return toSearchResult(resp, page, opts.limit);
  },

  async search(opts: GifSearchOpts): Promise<GifSearchResult> {
    const page = Math.floor(opts.offset / opts.limit) + 1;
    const resp = await klipyClient.search(opts.q, page, opts.limit, opts.locale);
    return toSearchResult(resp, page, opts.limit);
  },

  async recent(opts: GifRecentOpts): Promise<GifSearchResult> {
    const page = Math.floor(opts.offset / opts.limit) + 1;
    const resp = await klipyClient.recent(page, opts.limit);
    return toSearchResult(resp, page, opts.limit);
  },

  async categories(opts: GifCategoryOpts): Promise<GifCategory[]> {
    const resp = await klipyClient.categories(opts.locale);
    const raw = resp.data ?? resp.result ?? [];
    const result: GifCategory[] = [];
    for (const cat of raw) {
      const preview = cat.preview ? toResolved(cat.preview) : null;
      if (cat.name && preview) {
        result.push({ name: cat.name, preview });
      }
    }
    return result;
  },

  async getBySlug(slug: string): Promise<GifResolved> {
    const item = await klipyClient.getBySlug(slug);
    if (!item) {
      throw new Error(`GIF not found: ${slug}`);
    }
    const resolved = toResolved(item);
    if (!resolved) {
      throw new Error(`GIF has no usable rendition: ${slug}`);
    }
    return resolved;
  },

  async notifyShared(slug: string): Promise<void> {
    await klipyClient.notifyShared(slug);
  },

  async report(slug: string): Promise<void> {
    await klipyClient.report(slug);
  },

  setProxyEnabled(enabled: boolean): void {
    klipyClient.setProxyEnabled(enabled);
  },

  setPersonalizationEnabled(enabled: boolean): void {
    klipyClient.setPersonalizationEnabled(enabled);
  },
};
