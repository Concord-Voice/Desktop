// Byte-level detection of animated WebP / APNG (#2369, PR #3291), and the
// upload-path GIF check that decides whether a GIF keeps its animation (#1302).
// Fixtures are built from the real container layouts, not from mocks — the
// whole point of this module is that it reads actual bytes correctly.
import {
  detectAnimatedImage,
  isUploadableAnimatedGif,
  ANIMATION_SNIFF_BYTES,
} from '@/renderer/utils/ui/animatedImage';

function bytes(...parts: (number[] | string)[]): Uint8Array {
  const flat: number[] = [];
  for (const p of parts) {
    if (typeof p === 'string') for (const ch of p) flat.push(ch.charCodeAt(0));
    else flat.push(...p);
  }
  return new Uint8Array(flat);
}

const u32be = (n: number): number[] => [
  (n >>> 24) & 255,
  (n >>> 16) & 255,
  (n >>> 8) & 255,
  n & 255,
];

/** RIFF....WEBP VP8X <len> <flags> — flags bit 1 is ANIMATION. */
function webpVP8X(flags: number): Uint8Array {
  return bytes('RIFF', u32be(30), 'WEBP', 'VP8X', u32be(10), [flags], new Array(9).fill(0));
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** magic + IHDR(13) + the named chunk. */
function png(chunkType: string, extra: number[] = []): Uint8Array {
  return bytes(
    PNG_MAGIC,
    u32be(13),
    'IHDR',
    new Array(13).fill(0),
    u32be(0),
    extra,
    u32be(8),
    chunkType,
    new Array(8).fill(0),
    u32be(0)
  );
}

describe('detectAnimatedImage', () => {
  describe('WebP — the format MIME cannot decide', () => {
    it('VP8X with the ANIMATION bit set is animated', () => {
      expect(detectAnimatedImage(webpVP8X(0x02), 'image/webp')).toBe(true);
    });

    it('VP8X WITHOUT the animation bit is still — a static WebP must not be gated', () => {
      expect(detectAnimatedImage(webpVP8X(0x00), 'image/webp')).toBe(false);
    });

    it('a neighbouring flag bit is not mistaken for ANIMATION', () => {
      // 0x10 is ALPHA. Reading the byte as truthy rather than masking bit 1
      // would call every alpha WebP animated.
      expect(detectAnimatedImage(webpVP8X(0x10), 'image/webp')).toBe(false);
    });

    it('the simple VP8 / VP8L forms are still by definition', () => {
      expect(
        detectAnimatedImage(
          bytes('RIFF', u32be(20), 'WEBP', 'VP8 ', new Array(9).fill(0)),
          'image/webp'
        )
      ).toBe(false);
      expect(
        detectAnimatedImage(
          bytes('RIFF', u32be(20), 'WEBP', 'VP8L', new Array(9).fill(0)),
          'image/webp'
        )
      ).toBe(false);
    });

    it('bytes that are not RIFF/WEBP yield no opinion rather than a guess', () => {
      expect(
        detectAnimatedImage(
          bytes('NOPE', u32be(0), 'XXXX', 'VP8X', new Array(9).fill(0)),
          'image/webp'
        )
      ).toBeNull();
    });

    it('a truncated header yields no opinion', () => {
      expect(detectAnimatedImage(bytes('RIFF', u32be(0), 'WEBP'), 'image/webp')).toBeNull();
    });
  });

  describe('PNG / APNG — the mislabelled case', () => {
    it('acTL before IDAT is animated, under the common image/png label', () => {
      expect(detectAnimatedImage(png('acTL'), 'image/png')).toBe(true);
    });

    it('IDAT with no acTL is still', () => {
      expect(detectAnimatedImage(png('IDAT'), 'image/png')).toBe(false);
    });

    it('acTL is found past an intervening ancillary chunk', () => {
      const iccp = [
        ...u32be(20),
        ...'iCCP'.split('').map((c) => c.charCodeAt(0)),
        ...new Array(20).fill(0),
        ...u32be(0),
      ];
      expect(detectAnimatedImage(png('acTL', iccp), 'image/png')).toBe(true);
    });

    it('walks the chunk TABLE, so the literal acTL inside chunk data is not a match', () => {
      // `acTL` as ordinary bytes inside an IDAT payload. A naive indexOf scan
      // reports animated here; walking lengths does not.
      const idatWithLiteral = [
        ...u32be(8),
        ...'IDAT'.split('').map((c) => c.charCodeAt(0)),
        ...'acTL'.split('').map((c) => c.charCodeAt(0)),
        0,
        0,
        0,
        0,
        ...u32be(0),
      ];
      expect(
        detectAnimatedImage(
          bytes(PNG_MAGIC, u32be(13), 'IHDR', new Array(13).fill(0), u32be(0), idatWithLiteral),
          'image/png'
        )
      ).toBe(false);
    });

    it('running out of prefix before acTL or IDAT yields NULL, not false', () => {
      // A chunk whose declared length runs past the buffer. Answering `false`
      // here would silently mis-gate exactly the file this module exists for.
      const huge = bytes(
        PNG_MAGIC,
        u32be(13),
        'IHDR',
        new Array(13).fill(0),
        u32be(0),
        u32be(9_000_000),
        'iCCP'
      );
      expect(detectAnimatedImage(huge, 'image/png')).toBeNull();
    });

    it('bytes without the PNG magic yield no opinion', () => {
      expect(detectAnimatedImage(bytes('notapng!'), 'image/png')).toBeNull();
    });
  });

  it('formats this module does not judge yield null so the persisted file_type stands', () => {
    expect(detectAnimatedImage(bytes('GIF89a'), 'image/gif')).toBeNull();
    expect(detectAnimatedImage(bytes([0xff, 0xd8, 0xff]), 'image/jpeg')).toBeNull();
  });

  it('the sniff window is large enough for a PNG carrying an embedded colour profile', () => {
    expect(ANIMATION_SNIFF_BYTES).toBeGreaterThanOrEqual(64 * 1024);
  });
});

describe('isUploadableAnimatedGif (#1302)', () => {
  const lsd = (w: number, h: number, packed = 0x80): number[] => [
    w & 255,
    w >> 8,
    h & 255,
    h >> 8,
    packed,
    0,
    0,
  ];
  // 1×1 GIF89a with a 2-colour global table.
  const header = bytes('GIF89a', lsd(1, 1), [0, 0, 0, 255, 255, 255]);
  const loop = bytes([0x21, 0xff, 0x0b], 'NETSCAPE2.0', [3, 1, 0, 0, 0]);
  const gce = bytes([0x21, 0xf9, 4, 0, 10, 0, 0, 0]);
  /** Image descriptor (w×h, optional local table), LZW min code size, one data sub-block. */
  const frameOf = (w = 1, h = 1, lct: number[] = []): Uint8Array =>
    bytes(
      [0x2c, 0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8, lct.length ? 0x80 : 0],
      lct,
      [2, 2, 0x4c, 0x01, 0]
    );
  const frame = frameOf();
  const gif = (...parts: Uint8Array[]): Uint8Array =>
    bytes(...parts.map((p) => Array.from(p)), [0x3b]);
  const yes = (b: Uint8Array) => expect(isUploadableAnimatedGif(b)).toBe(true);
  const no = (b: Uint8Array) => expect(isUploadableAnimatedGif(b)).toBe(false);

  it('says yes for two frames', () => {
    yes(gif(header, loop, gce, frame, gce, frame));
  });

  it('walks local colour tables and GIF87a', () => {
    yes(gif(header, frameOf(1, 1, [1, 2, 3, 4, 5, 6]), gce, frameOf(1, 1, [1, 2, 3, 4, 5, 6])));
    yes(gif(bytes('GIF87a', Array.from(header.subarray(6))), frame, frame));
  });

  it('walks extensions with several sub-blocks', () => {
    const comment = bytes([0x21, 0xfe, 3], 'abc', [2], 'de', [0]);
    yes(gif(header, comment, frame, comment, frame));
  });

  it('says no for one frame, even with a loop extension', () => {
    no(gif(header, loop, gce, frame));
  });

  it('says no for non-GIF bytes or an unknown block', () => {
    no(bytes('PNG'));
    no(gif(header, bytes([0x99]), frame, frame));
  });

  it('says no for a truncated second frame or a missing trailer', () => {
    const two = gif(header, frame, frame);
    no(two.subarray(0, two.length - 3)); // cut inside the second frame's data
    no(two.subarray(0, two.length - 1)); // no trailer
    no(bytes(...[header, frame, bytes([0x2c, 0, 0])].map((p) => Array.from(p))));
  });

  it('says no where the server refuses the block sizes', () => {
    no(gif(header, bytes([0x21, 0xf9, 5, 0, 0, 0, 0, 0, 0]), frame, frame));
    no(gif(header, bytes([0x21, 0x01, 4, 0, 0, 0, 0, 0]), frame, frame));
  });

  it('says no past the server frame and pixel budgets', () => {
    yes(gif(header, ...Array.from({ length: 120 }, () => frame)));
    no(gif(header, ...Array.from({ length: 121 }, () => frame)));
    // 5000×5000 screen: 2 frames are 50M pixels (allowed), 3 are over.
    const big = bytes('GIF89a', lsd(5000, 5000), [0, 0, 0, 255, 255, 255]);
    yes(gif(big, frame, frame));
    no(gif(big, frame, frame, frame));
    // Summed descriptor area over 50M, even on a small screen.
    no(gif(header, frameOf(10_000, 3000), frameOf(10_000, 3000)));
    // Screen over a side limit or empty.
    no(gif(bytes('GIF89a', lsd(10_001, 1), [0, 0, 0, 255, 255, 255]), frame, frame));
    no(gif(bytes('GIF89a', lsd(0, 0), [0, 0, 0, 255, 255, 255]), frame, frame));
  });
});
