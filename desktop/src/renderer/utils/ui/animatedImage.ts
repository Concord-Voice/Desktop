/**
 * Decide whether decrypted image bytes actually animate.
 *
 * WHY THIS EXISTS. `classifyFileType` maps a MIME type to the backend's
 * `file_type`, and that value is computed on the uploading client and then
 * PERSISTED. Two common formats are undecidable from MIME alone:
 *
 *   - `image/webp` covers both still and animated WebP, so every animated WebP
 *     was stored as `photo`.
 *   - An APNG is routinely reported by the OS as `image/png`, so it was stored
 *     as `photo` too. (`image/apng`, when it is reported, already classifies
 *     correctly — it is the mislabelled case that leaks.)
 *
 * Both therefore slipped the hover gate AND the unfocus pause, and because the
 * value is persisted, correcting the classifier would only ever fix uploads
 * made after the fix — every animated WebP already in a channel would stay
 * `photo` forever. The bytes are the only source of truth that covers history,
 * and the renderer has them: attachments are E2EE and decrypted here.
 *
 * WHAT THIS IS NOT. It does not replace `file_type`; it OVERRIDES it only when
 * it can actually decide. `null` means "no opinion", and the caller keeps the
 * persisted value — which is why GIF is deliberately absent below: `image/gif`
 * already classifies as `animated`, and walking LZW blocks to find a second
 * frame would buy nothing.
 */

/** Head bytes to read. A WebP decides inside 21; a PNG needs to walk chunks
 *  until `acTL` or `IDAT`, and a large `iCCP` profile can sit between them. */
export const ANIMATION_SNIFF_BYTES = 64 * 1024;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Callers must keep `at + len <= b.length`: `fromCodePoint` throws a
 *  RangeError on the `undefined` an out-of-bounds read returns. Both callers
 *  bound-check before reading. */
function ascii(b: Uint8Array, at: number, len: number): string {
  let out = '';
  for (let i = 0; i < len; i++) out += String.fromCodePoint(b[at + i]);
  return out;
}

/** RIFF/WEBP. Only the extended `VP8X` form can animate, and its ANIMATION bit
 *  is bit 1 of the flags byte — so this is decided inside the first 21 bytes
 *  and never needs the rest of the file. */
function webpAnimates(b: Uint8Array): boolean | null {
  if (b.length < 21) return null;
  if (ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP') return null;
  const fourcc = ascii(b, 12, 4);
  if (fourcc === 'VP8X') return (b[20] & 0x02) !== 0;
  // `VP8 ` (lossy) and `VP8L` (lossless) are the simple formats: single image
  // by definition. Anything else is a shape we do not know; say nothing.
  if (fourcc === 'VP8 ' || fourcc === 'VP8L') return false;
  return null;
}

/** PNG/APNG. `acTL` MUST precede the first `IDAT`, so finding `IDAT` first is a
 *  positive answer of "still", not a failure to find anything. Walks the chunk
 *  table rather than scanning for the literal, because the four bytes `acTL`
 *  can occur inside compressed image data. */
function pngAnimates(b: Uint8Array): boolean | null {
  if (b.length < 8) return null;
  for (let i = 0; i < 8; i++) if (b[i] !== PNG_MAGIC[i]) return null;

  let at = 8;
  // Each chunk is length(4) + type(4) + data + crc(4).
  while (at + 8 <= b.length) {
    const len = (b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3];
    const type = ascii(b, at + 4, 4);
    if (type === 'acTL') return true;
    if (type === 'IDAT') return false;
    if (len < 0) return null; // absurd length: stop rather than guess
    at += 8 + len + 4;
  }
  // Ran out of prefix before deciding. Deliberately `null`, not `false`: a
  // truncated walk has learned nothing, and claiming "still" here would be the
  // same silent mis-gating this module exists to close.
  return null;
}

/**
 * `true` animates, `false` does not, `null` when these bytes cannot say —
 * in which case the caller keeps the persisted `file_type`.
 */
export function detectAnimatedImage(head: Uint8Array, mimeType: string): boolean | null {
  const mime = mimeType.toLowerCase();
  if (mime === 'image/webp') return webpAnimates(head);
  if (mime === 'image/png' || mime === 'image/apng') return pngAnimates(head);
  return null;
}

/** Skip a run of GIF data sub-blocks (length byte, then that many bytes, until
 *  a zero length). Returns the offset after the terminator, or -1 if truncated. */
function skipGifSubBlocks(b: Uint8Array, at: number): number {
  while (at < b.length) {
    const len = b[at];
    at += 1 + len;
    if (len === 0) return at;
  }
  return -1;
}

/**
 * Whether a whole GIF file holds more than one frame — the same test the
 * control plane uses to decide an upload animates (#1302). A file that is not
 * a GIF, is truncated, or is malformed answers `false`: the caller then crops
 * it to a still, which is what it did before animation was possible.
 */
export function gifHasMultipleFrames(b: Uint8Array): boolean {
  if (b.length < 13) return false;
  const sig = ascii(b, 0, 6);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return false;
  // Logical screen descriptor: a global colour table follows when bit 7 is set.
  let at = 13 + ((b[10] & 0x80) === 0 ? 0 : 3 * (2 << (b[10] & 0x07)));
  let frames = 0;
  while (at < b.length) {
    const block = b[at];
    if (block === 0x3b) return false; // trailer
    if (block === 0x21) {
      // Extension: introducer, label, then sub-blocks.
      at = skipGifSubBlocks(b, at + 2);
    } else if (block === 0x2c) {
      if (++frames > 1) return true;
      if (at + 10 > b.length) return false;
      const packed = b[at + 9];
      at += 10 + ((packed & 0x80) === 0 ? 0 : 3 * (2 << (packed & 0x07)));
      // LZW minimum code size, then the image data sub-blocks.
      at = skipGifSubBlocks(b, at + 1);
    } else {
      return false;
    }
    if (at < 0) return false;
  }
  return false;
}
