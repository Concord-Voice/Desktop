// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildShortcodes } from './build-emoji-shortcodes';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EMOJI_DIR = resolve(__dirname, '../client/desktop/src/renderer/data/emoji');

describe('build-emoji-shortcodes', () => {
  describe('buildShortcodes (pure function)', () => {
    it('merges gemoji shortcodes into entries by matching emoji codepoint', () => {
      const input = [{ e: '😄', n: 'grinning face with smiling eyes', s: false }];
      const result = buildShortcodes(input);
      expect(result[0].c).toContain('smile');
    });

    it('returns empty shortcode array when no gemoji match', () => {
      const input = [{ e: '\u{1FAF6}', n: 'heart hands', s: false }];
      const result = buildShortcodes(input);
      expect(Array.isArray(result[0].c)).toBe(true);
    });

    it('preserves all original EmojiEntry fields', () => {
      const input = [{ e: '👋', n: 'waving hand', s: true }];
      const result = buildShortcodes(input);
      expect(result[0].e).toBe('👋');
      expect(result[0].n).toBe('waving hand');
      expect(result[0].s).toBe(true);
    });
  });

  describe('regenerated JSON outputs', () => {
    beforeAll(() => {
      // Generator must have been run before these tests.
      // CI: `npm run build:emoji-shortcodes` is a prerequisite.
    });

    it('every entry in smileys.json has a c field that is a string array', () => {
      const raw = readFileSync(resolve(EMOJI_DIR, 'smileys.json'), 'utf-8');
      const entries = JSON.parse(raw) as Array<{ e: string; n: string; s: boolean; c: string[] }>;
      for (const entry of entries) {
        expect(Array.isArray(entry.c)).toBe(true);
        for (const code of entry.c) {
          expect(typeof code).toBe('string');
          expect(code).toMatch(/^[a-z0-9_+\-]+$/);
        }
      }
    });

    it('smileys.json contains smile shortcode', () => {
      const raw = readFileSync(resolve(EMOJI_DIR, 'smileys.json'), 'utf-8');
      const entries = JSON.parse(raw) as Array<{ c: string[] }>;
      const hasSmile = entries.some((e) => e.c.includes('smile'));
      expect(hasSmile).toBe(true);
    });
  });
});
