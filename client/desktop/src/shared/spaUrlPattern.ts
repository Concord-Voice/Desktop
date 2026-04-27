/**
 * Shared SPA URL patterns (#753, ADR-0001).
 *
 * Single source of truth for the regexes that identify SPA-served URLs.
 * Two granularities:
 *
 *   - `SPA_URL_PATTERN`        — any URL under `/spa/<7-hex-sha>/...`,
 *                                including index.html, chunks, and any other
 *                                path the SPA might serve. Used to filter
 *                                main-frame did-fail-load events and IPC
 *                                sender frames so non-SPA same-origin pages
 *                                (e.g., PiP windows loading `<origin>#/...`,
 *                                hash routes) cannot trigger self-heal.
 *
 *   - `SPA_CHUNK_URL_PATTERN`  — the narrower `/spa/<7-hex-sha>/assets/...`
 *                                chunk-asset shape, used by renderer-side
 *                                detection where only chunk loads are
 *                                interesting.
 *
 * Consumed by:
 *   - src/renderer/spaSelfHealClient.ts (chunk pattern only)
 *   - src/main/spaSelfHealMainFrame.ts (both patterns)
 *
 * Kept here rather than duplicated so a future deploy-path change
 * (e.g., SHA length 7 → 12, host migration) requires editing one place.
 * See ADR-0001 §Decision invariant 3.
 */
export const SPA_URL_PATTERN = /^https?:\/\/[^/]+\/spa\/[0-9a-f]{7}\/.+/;
export const SPA_CHUNK_URL_PATTERN = /^https?:\/\/[^/]+\/spa\/[0-9a-f]{7}\/assets\/.+/;
