import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gemoji } from 'gemoji';

export interface EmojiEntryInput {
  e: string;
  n: string;
  s: boolean;
}

export interface EmojiEntryWithShortcodes extends EmojiEntryInput {
  c: string[];
}

const CATEGORIES = [
  'smileys',
  'people',
  'animals',
  'food',
  'travel',
  'activities',
  'objects',
  'symbols',
  'flags',
];

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EMOJI_DIR = resolve(__dirname, '../client/desktop/src/renderer/data/emoji');

function buildGemojiIndex(): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const entry of gemoji) {
    const existing = index.get(entry.emoji);
    const names = entry.names ?? [];
    if (existing) {
      for (const name of names) if (!existing.includes(name)) existing.push(name);
    } else {
      index.set(entry.emoji, [...names]);
    }
  }
  return index;
}

export function buildShortcodes(
  entries: EmojiEntryInput[],
  gemojiIndex: Map<string, string[]> = buildGemojiIndex()
): EmojiEntryWithShortcodes[] {
  return entries.map((entry) => ({
    ...entry,
    c: gemojiIndex.get(entry.e) ?? [],
  }));
}

function processCategory(category: string, gemojiIndex: Map<string, string[]>): void {
  const path = resolve(EMOJI_DIR, `${category}.json`);
  const raw = readFileSync(path, 'utf-8');
  const entries = JSON.parse(raw) as EmojiEntryInput[];
  const augmented = buildShortcodes(entries, gemojiIndex);
  writeFileSync(path, JSON.stringify(augmented) + '\n', 'utf-8');
  const withShortcodes = augmented.filter((e) => e.c.length > 0).length;
  console.log(`${category}: ${augmented.length} entries, ${withShortcodes} with shortcodes`);
}

// Entry point — runs when invoked directly via tsx CLI.
// Normalize both sides to absolute filesystem paths so a relative
// `process.argv[1]` (e.g. when invoked via `tsx ../../scripts/foo.ts`)
// still matches `import.meta.url` (always an absolute `file://` URL).
function isDirectInvocation(): boolean {
  if (!process.argv[1]) return false;
  const invokedPath = resolve(process.argv[1]);
  const thisFilePath = fileURLToPath(import.meta.url);
  return invokedPath === thisFilePath;
}

if (isDirectInvocation()) {
  const gemojiIndex = buildGemojiIndex();
  for (const category of CATEGORIES) {
    processCategory(category, gemojiIndex);
  }
  console.log('Done.');
}
