import { describe, it, expect } from 'vitest';
import {
  ALLOWED_BREADCRUMB_CATEGORY_DATA_KEYS,
  ALLOWED_CONTEXTS,
  ALLOWED_TAG_KEYS,
} from '../sentry-scrubbers';
import { ALLOWLIST_CATEGORIES, ALLOWLIST_META } from '../sentry-allowlist-descriptions';
import { TELEMETRY_POLICY_VERSION } from '../sentry-policy-version';

describe('sentry-allowlist-descriptions', () => {
  it('describes exactly the keys in ALLOWED_CONTEXTS (no missing, no orphans)', () => {
    const described = Object.keys(ALLOWLIST_CATEGORIES.contexts.fields).sort();
    const expected = [...ALLOWED_CONTEXTS].sort();
    expect(described).toEqual(expected);
  });

  it('describes exactly the keys in ALLOWED_TAG_KEYS (no missing, no orphans)', () => {
    const described = Object.keys(ALLOWLIST_CATEGORIES.tags.fields).sort();
    const expected = [...ALLOWED_TAG_KEYS].sort();
    expect(described).toEqual(expected);
  });

  it('describes exactly the keys in ALLOWED_BREADCRUMB_CATEGORY_DATA_KEYS (no missing, no orphans)', () => {
    // Breadcrumb data keys are documented as `<category>.<key>` in the
    // disclosure so users can see which specific signals are emitted for each
    // category. The allowlist lives in sentry-scrubbers.ts as a nested map;
    // flattening here enforces 1:1 correspondence per #658.
    const described = Object.keys(ALLOWLIST_CATEGORIES.breadcrumbs.fields).sort();
    const expected = Object.entries(ALLOWED_BREADCRUMB_CATEGORY_DATA_KEYS)
      .flatMap(([category, keys]) => [...keys].map((k) => `${category}.${k}`))
      .sort();
    expect(described).toEqual(expected);
  });

  it('meta version matches bundled policy version', () => {
    expect(ALLOWLIST_META.version).toBe(TELEMETRY_POLICY_VERSION);
  });

  it('every description is non-trivial (>=15 chars, ends with period, no placeholders, has real words)', () => {
    const all = [
      ...Object.values(ALLOWLIST_CATEGORIES.contexts.fields),
      ...Object.values(ALLOWLIST_CATEGORIES.tags.fields),
      ...Object.values(ALLOWLIST_CATEGORIES.breadcrumbs.fields),
    ];
    const placeholderRe = /TODO|FIXME|XXX|lorem|ipsum/i;
    for (const d of all) {
      expect(d.length).toBeGreaterThanOrEqual(15);
      expect(d).toMatch(/\.$/);
      expect(d).not.toMatch(placeholderRe);
      // At least one word of >=4 chars that isn't a single repeated character.
      const realWords = d.split(/\s+/).filter((w) => w.length >= 4 && !/^(.)\1+$/.test(w));
      expect(realWords.length).toBeGreaterThan(0);
    }
  });

  it('changelog contains an entry for the current bundled version', () => {
    const entry = ALLOWLIST_META.changelog.find((c) => c.version === TELEMETRY_POLICY_VERSION);
    expect(entry).toBeDefined();
    expect(entry?.change.length).toBeGreaterThan(10);
  });
});
